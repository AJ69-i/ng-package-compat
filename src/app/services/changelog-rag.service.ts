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

/**
 * Bumped to v2 when we added heuristic monorepo-path lookup. Old v1
 * entries cached empty results for monorepo packages (rxjs, @angular/*,
 * @nestjs/*, every Lerna/Nx/Yarn-workspaces package) because we only
 * tried the repo root. v2 entries reflect the new search strategy.
 * Leaving v1 entries in localStorage is harmless — they're keyed under
 * a different prefix and the browser GC's them when localStorage
 * pressures arise.
 */
const CACHE_KEY = 'ngpc.changelog.v2';
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
    repoUrl: string | undefined | null,
    /**
     * When true, skip the cache READ. We still write the fresh
     * result to the cache so a subsequent non-bypass call benefits.
     * Used by the changelog-preview's "Try again" button to recover
     * after a transient failure (rate-limit, network blip) that
     * poisoned the cache with an empty entry.
     */
    bypassCache = false,
    /**
     * Monorepo subdirectory for this package's CHANGELOG, from the
     * npm packument's `repository.directory` field. Empty/null means
     * "look at the repo root" (the default).
     *
     * Real-world examples this fixes:
     *   - rxjs → packages/rxjs/CHANGELOG.md
     *   - @angular/core → packages/core/CHANGELOG.md (well, sort of —
     *     @angular's per-package CHANGELOGs are actually rolled up
     *     into a top-level one, but other monorepos use the pattern)
     *   - @nestjs/* → packages/<name>/CHANGELOG.md
     *   - every Storybook / Babel / Lerna / Nx workspace package
     *
     * Without this, our root-level fallback misses every changelog
     * that lives next to its package — which is the modern default.
     */
    repoDirectory: string | null = null
  ): Observable<ChangelogResult> {
    // Normalize semver so "v15.0.0" and "15.0.0" cache to the same key.
    const fromN = semver.valid(semver.coerce(fromVersion)) ?? fromVersion;
    const toN = semver.valid(semver.coerce(toVersion)) ?? toVersion;
    // Ensure from < to so the result is the same regardless of which
    // input the user typed on the A side.
    const [lo, hi] = semver.lt(fromN, toN) ? [fromN, toN] : [toN, fromN];

    const slug = this.parseGithubSlug(repoUrl);
    // Cache key includes the directory so monorepo packages that
    // share a slug (every @angular/* points at angular/angular) don't
    // collide — each package's CHANGELOG-fetch result is keyed per-
    // package by `pkg.toLowerCase()` already, so this is belt-and-
    // braces, but it also means a later schema/path change can be
    // bumped uniformly by extending the cache key.
    const dir = (repoDirectory ?? '').replace(/^\/+|\/+$/g, '');
    const cacheKey = `${pkg.toLowerCase()}@${lo}..${hi}${dir ? `#${dir}` : ''}`;

    if (!bypassCache) {
      const cached = this.readCache(cacheKey);
      if (cached) return of(cached);
    }

    if (!slug) {
      const empty = this.empty(pkg, lo, hi, null);
      this.writeCache(cacheKey, empty);
      return of(empty);
    }

    return this.fetchReleases(slug, pkg, lo, hi).pipe(
      switchMap((rel) =>
        rel.releases.length
          ? of(rel)
          : this.fetchChangelogMd(slug, pkg, lo, hi, dir || null)
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
    hi: string,
    directory: string | null = null
  ): Observable<ChangelogResult> {
    const paths = this.candidatePaths(pkg, directory);

    // Recursive try-each-path pattern. We bail to `empty` once all
    // candidates 404. raw.githubusercontent.com `/HEAD/` resolves to
    // the default branch (whether master or main) on the GitHub CDN
    // side — we don't need to know which.
    //
    // raw.githubusercontent.com is NOT subject to the 60-req/hr
    // GitHub API limit (that only applies to api.github.com), so
    // trying a handful of well-known monorepo locations here is
    // cheap. Each 404 is one fast CDN round-trip.
    const tryNext = (i: number): Observable<ChangelogResult> => {
      if (i >= paths.length) {
        return of(this.empty(pkg, lo, hi, slug));
      }
      const url = `https://raw.githubusercontent.com/${slug}/HEAD/${paths[i]}`;
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
   * Ordered list of GitHub-relative paths to try for the package's
   * CHANGELOG. Built from three sources of decreasing certainty:
   *
   *   1. **Explicit packument hint** — `repository.directory` if the
   *      maintainer set it (always correct, but often missing — rxjs
   *      doesn't ship one even though they're in `packages/rxjs/`).
   *
   *   2. **Heuristic monorepo conventions** — well-known location
   *      patterns used by Lerna, Nx, Yarn-workspaces, and
   *      pnpm-workspaces. Covers ~95% of real-world monorepos
   *      without any tree-walking:
   *
   *        - `packages/<unscoped-name>/`       ← Lerna / Nx default
   *        - `packages/<scope>__<unscoped>/`   ← scoped pkg pattern
   *        - `<scope>/<unscoped-name>/`        ← some Babel-style repos
   *        - `<unscoped-name>/`                ← flat-package layouts
   *
   *      For `rxjs` this yields `packages/rxjs/CHANGELOG.md` as the
   *      second probe — which is the actual location.
   *      For `@angular/core` it yields `packages/core/CHANGELOG.md`,
   *      which is the actual location.
   *
   *   3. **Repo root** — legacy single-package repos and monorepos
   *      that maintain a top-level CHANGELOG alongside per-package
   *      ones (e.g. ngx-sonner).
   *
   * Each directory is tried with all four filename variants
   * (CHANGELOG.md, CHANGES.md, HISTORY.md, changelog.md) before we
   * move on, so a project using CHANGES.md inside a monorepo
   * subdirectory still resolves cleanly.
   *
   * We deduplicate via a Set: if `directory` from the packument
   * happens to equal `packages/<unscoped>`, we don't probe twice.
   */
  private candidatePaths(pkgName: string, directory: string | null): string[] {
    const paths: string[] = [];
    const seenDirs = new Set<string>();
    const addDir = (raw: string) => {
      const dir = raw.replace(/^\/+|\/+$/g, '');
      if (seenDirs.has(dir)) return;
      seenDirs.add(dir);
      for (const file of CHANGELOG_FALLBACKS) {
        paths.push(dir ? `${dir}/${file}` : file);
      }
    };

    // 1) Packument-declared directory (if any) — first because it's
    // the only one the maintainer explicitly attested to.
    if (directory) addDir(directory);

    // 2) Heuristic monorepo locations.
    // Scoped packages decompose into `@<scope>/<unscoped>` — strip
    // the `@` and split. Unscoped packages keep the whole name as
    // the "unscoped" form.
    const scoped = pkgName.startsWith('@')
      ? pkgName.slice(1).split('/')
      : [null, pkgName];
    const scope = scoped[0]; // null for unscoped
    const unscoped = scoped[1] || pkgName;

    // Most common: Lerna / Nx default `packages/<name>` (rxjs lives
    // here, every Babel package, most @scoped packages — e.g.
    // @angular/core → packages/core).
    addDir(`packages/${unscoped}`);

    if (scope) {
      // Some repos preserve the scope as a flat subdirectory:
      // `packages/<scope>__<name>` or `<scope>/<name>`.
      addDir(`packages/${scope}__${unscoped}`);
      addDir(`${scope}/${unscoped}`);
    }

    // Less common but seen in flat-package layouts where each
    // package lives at the repo root in its own directory.
    addDir(unscoped);

    // 3) Repo root — legacy single-package repos and monorepos that
    // also keep a top-level CHANGELOG alongside per-package ones.
    addDir('');

    return paths;
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
