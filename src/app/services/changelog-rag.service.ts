import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { isPlatformBrowser } from '@angular/common';
import { Observable, of } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import * as semver from 'semver';

/**
 * Where the changelog text came from. We surface this in the AI prompt
 * so the model can phrase its output honestly — a GitHub-releases-backed
 * answer is more authoritative than a CHANGELOG.md-scraped answer, and
 * the model should hedge when neither source was available.
 */
export type ChangelogSource = 'releases' | 'changelog-md' | 'none';

export interface ReleaseEntry {
  /** Plain semver, normalized (no leading "v"). */
  version: string;
  /** ISO date of the release. */
  date: string | null;
  /** Raw markdown body of the release notes. May be empty. */
  body: string;
}

export interface ChangelogResult {
  /** Lowercase package name we requested context for. */
  pkg: string;
  fromVersion: string;
  toVersion: string;
  source: ChangelogSource;
  /** owner/repo if we resolved one. */
  slug: string | null;
  /**
   * Concatenated changelog text — already trimmed to MAX_CHARS so it
   * fits the AI provider's context window with room for the prompt.
   * Each entry is prefixed with a `## <version>` header so the model
   * can attribute changes to specific releases.
   */
  text: string;
  /** Structured per-release entries (may be empty when source = changelog-md). */
  releases: ReleaseEntry[];
}

interface GhRelease {
  tag_name?: string;
  name?: string;
  body?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
}

interface CacheEntry {
  result: ChangelogResult;
  ts: number;
}

/**
 * Hard upper bound on the changelog text we feed the model. Bigger than
 * the README budget in AiPayloadService (~12k) because changelogs are
 * the *entire* point of a migration prompt — if we truncate too
 * aggressively the model loses breaking-change entries. 24k characters
 * is roughly 6k tokens, well within the 16k+ context windows of every
 * provider we support, and leaves room for the system + user prompt.
 */
const MAX_CHARS = 24_000;

const CACHE_KEY = 'ngpc.changelog.v1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Filenames we'll try in order if there are no GitHub releases. */
const CHANGELOG_FALLBACKS = ['CHANGELOG.md', 'CHANGES.md', 'HISTORY.md', 'changelog.md'];

/**
 * Pulls changelog context for a self-version comparison ("ngx-toastr
 * 15.0.0 → 17.2.0"). The output is intentionally text-only — we don't
 * try to parse breaking-change structure on the client. That's the AI's
 * job; we just give it the most relevant raw material we can find.
 *
 * # Source resolution order
 *
 *   1. GitHub Releases API. Most npm packages publish per-version
 *      release notes here, and the body is already markdown and already
 *      scoped to one version per entry — ideal RAG input.
 *
 *   2. CHANGELOG.md / CHANGES.md / HISTORY.md raw from the default
 *      branch. Less structured but covers libraries that haven't
 *      adopted GitHub Releases (e.g. older RxJS, AngularFire).
 *
 *   3. `source: 'none'` — we couldn't find anything. The orchestrator
 *      tells the AI to fall back to "general knowledge of this
 *      package's migration story" with a clear caveat in the output.
 *
 * # Why we cap responses (not just memo'ize by key)
 *
 * The cache key includes `fromVersion` and `toVersion`. Two users
 * looking at the same pair share the cache, but the first one pays
 * the GitHub-API cost. With the 60-req/hr unauthenticated quota and
 * one request per package per pair, this is sustainable on the free
 * tier — but only if we never *re-fetch* the same pair within 24h.
 */
@Injectable({ providedIn: 'root' })
export class ChangelogRagService {
  private readonly http = inject(HttpClient);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /**
   * Resolve changelog context for `pkg` between `fromVersion` and
   * `toVersion`. The from is exclusive (we already have that version
   * installed), the to is inclusive (we want to know what's new at the
   * target). Order doesn't matter — if `from > to` we swap them so the
   * caller can pass either direction.
   *
   * @param repoUrl The npm `repository.url` field. Optional; if absent
   *                or non-GitHub we return `source: 'none'`.
   */
  between(
    pkg: string,
    fromVersion: string,
    toVersion: string,
    repoUrl: string | undefined | null
  ): Observable<ChangelogResult> {
    // Normalize semver so "v15.0.0" and "15.0.0" cache to the same key.
    const fromN = semver.valid(semver.coerce(fromVersion)) ?? fromVersion;
    const toN = semver.valid(semver.coerce(toVersion)) ?? toVersion;
    // Ensure from < to so the result is the same regardless of which
    // input the user typed on the A side.
    const [lo, hi] = semver.lt(fromN, toN) ? [fromN, toN] : [toN, fromN];

    const slug = this.parseGithubSlug(repoUrl);
    const cacheKey = `${pkg.toLowerCase()}@${lo}..${hi}`;

    const cached = this.readCache(cacheKey);
    if (cached) return of(cached);

    if (!slug) {
      const empty = this.empty(pkg, lo, hi, null);
      this.writeCache(cacheKey, empty);
      return of(empty);
    }

    return this.fetchReleases(slug, pkg, lo, hi).pipe(
      switchMap((rel) =>
        rel.releases.length
          ? of(rel)
          : this.fetchChangelogMd(slug, pkg, lo, hi)
      ),
      catchError(() => of(this.empty(pkg, lo, hi, slug))),
      map((result) => {
        this.writeCache(cacheKey, result);
        return result;
      })
    );
  }

  /**
   * Hit `/repos/{slug}/releases?per_page=100` and filter to entries
   * whose version sits in `(lo, hi]`. The 100-entry cap covers the vast
   * majority of libraries; very long-lived libraries with hundreds of
   * releases may miss some old ones — acceptable because users
   * comparing v15 → v17 don't care about v3 → v4 notes.
   */
  private fetchReleases(
    slug: string,
    pkg: string,
    lo: string,
    hi: string
  ): Observable<ChangelogResult> {
    const url = `https://api.github.com/repos/${slug}/releases?per_page=100`;
    return this.http.get<GhRelease[]>(url).pipe(
      map((rows): ChangelogResult => {
        const inRange: ReleaseEntry[] = rows
          .filter((r) => r && !r.draft)
          .map((r) => {
            const tag = r.tag_name ?? r.name ?? '';
            const v = semver.valid(semver.coerce(tag));
            return v && r ? { version: v, date: r.published_at ?? null, body: r.body ?? '' } : null;
          })
          .filter((e): e is ReleaseEntry => !!e)
          // Strictly greater than lo (we already have lo installed),
          // less than or equal to hi (we want everything up to target).
          .filter((e) => semver.gt(e.version, lo) && semver.lte(e.version, hi))
          // Newest first so the AI sees the breaking-change headlines
          // before the small-fry — also matches how humans read
          // changelogs.
          .sort((a, b) => semver.rcompare(a.version, b.version));

        if (!inRange.length) {
          return this.empty(pkg, lo, hi, slug);
        }
        return {
          pkg, fromVersion: lo, toVersion: hi,
          source: 'releases',
          slug,
          text: this.concatReleases(inRange),
          releases: inRange
        };
      }),
      catchError(() => of(this.empty(pkg, lo, hi, slug)))
    );
  }

  /**
   * Last-ditch fallback — pull the project's CHANGELOG.md (or close
   * cousin) raw from the default branch. We can't reliably segment by
   * version here so we send the whole truncated file and let the AI
   * parse out the relevant section. The prompt tells it which version
   * range to focus on.
   */
  private fetchChangelogMd(
    slug: string,
    pkg: string,
    lo: string,
    hi: string
  ): Observable<ChangelogResult> {
    // Recursive try-each-filename pattern. We bail to `empty` once all
    // candidates 404. raw.githubusercontent.com `/HEAD/` resolves to
    // the default branch so we don't need to know if it's main/master.
    const tryNext = (i: number): Observable<ChangelogResult> => {
      if (i >= CHANGELOG_FALLBACKS.length) {
        return of(this.empty(pkg, lo, hi, slug));
      }
      const file = CHANGELOG_FALLBACKS[i];
      const url = `https://raw.githubusercontent.com/${slug}/HEAD/${file}`;
      return this.http
        .get(url, { responseType: 'text' })
        .pipe(
          map((text): ChangelogResult => ({
            pkg, fromVersion: lo, toVersion: hi,
            source: 'changelog-md',
            slug,
            text: this.truncate(text ?? ''),
            releases: []
          })),
          catchError(() => tryNext(i + 1))
        );
    };
    return tryNext(0);
  }

  /**
   * Concatenate per-release bodies with a `## <version>` header so the
   * AI can attribute specific breaking changes to specific releases in
   * its output. Trimmed at MAX_CHARS — older releases are dropped first
   * (they're at the bottom of the rcompare-sorted list) since the most
   * recent ones tend to carry the most relevant breaks.
   */
  private concatReleases(releases: ReleaseEntry[]): string {
    const parts: string[] = [];
    let running = 0;
    for (const r of releases) {
      const header = `## ${r.version}${r.date ? ` (${r.date.slice(0, 10)})` : ''}`;
      const body = (r.body ?? '').trim();
      const chunk = `${header}\n\n${body || '_(no notes)_'}\n\n`;
      if (running + chunk.length > MAX_CHARS) {
        // Emit a truncation marker so the model knows there's more
        // history we couldn't include — better than silently lying.
        parts.push(`\n_(older releases omitted to fit context window)_\n`);
        break;
      }
      parts.push(chunk);
      running += chunk.length;
    }
    return parts.join('').trimEnd();
  }

  private truncate(text: string): string {
    if (text.length <= MAX_CHARS) return text;
    return text.slice(0, MAX_CHARS) + '\n\n_(truncated to fit context window)_';
  }

  private empty(
    pkg: string,
    fromVersion: string,
    toVersion: string,
    slug: string | null
  ): ChangelogResult {
    return {
      pkg, fromVersion, toVersion,
      source: 'none',
      slug,
      text: '',
      releases: []
    };
  }

  /**
   * Same parser MaintainerVitalityService uses. Duplicated rather than
   * extracted because both services own their full GitHub-source story
   * and a shared util would have to defend against partial-input cases
   * neither caller cares about.
   */
  private parseGithubSlug(input: string | undefined | null): string | null {
    if (!input) return null;
    const cleaned = input.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
    if (!cleaned) return null;
    const shortcut = /^github:([\w.-]+)\/([\w.-]+)$/i.exec(cleaned);
    if (shortcut) return `${shortcut[1]}/${shortcut[2]}`;
    const ssh = /^git@github\.com:([\w.-]+)\/([\w.-]+)$/i.exec(cleaned);
    if (ssh) return `${ssh[1]}/${ssh[2]}`;
    const url = /(?:^|:\/\/)(?:[^/]*@)?github\.com\/([\w.-]+)\/([\w.-]+)(?:[/?#]|$)/i.exec(cleaned);
    if (url) return `${url[1]}/${url[2]}`;
    const bare = /^([\w.-]+)\/([\w.-]+)$/.exec(cleaned);
    if (bare) return `${bare[1]}/${bare[2]}`;
    return null;
  }

  // ----- localStorage cache (SSR no-ops) -----

  private readCache(key: string): ChangelogResult | null {
    if (!this.isBrowser) return null;
    try {
      const blob = window.localStorage.getItem(`${CACHE_KEY}.${key}`);
      if (!blob) return null;
      const entry = JSON.parse(blob) as CacheEntry;
      if (!entry || typeof entry.ts !== 'number') return null;
      if (Date.now() - entry.ts > CACHE_TTL_MS) return null;
      return entry.result;
    } catch {
      return null;
    }
  }

  private writeCache(key: string, result: ChangelogResult): void {
    if (!this.isBrowser) return;
    try {
      const entry: CacheEntry = { result, ts: Date.now() };
      window.localStorage.setItem(`${CACHE_KEY}.${key}`, JSON.stringify(entry));
    } catch {
      // Quota or private-mode — accept the re-fetch on next call.
    }
  }
}
