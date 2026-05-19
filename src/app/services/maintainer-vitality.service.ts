import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { isPlatformBrowser } from '@angular/common';
import { Observable, of } from 'rxjs';
import { catchError, map, shareReplay } from 'rxjs/operators';

/**
 * Tier we assign to a repo's maintenance vitality. The mapping uses
 * `pushed_at` (last push to the default branch) plus the `archived`
 * flag — both surfaced in a single `GET /repos/{owner}/{repo}` call,
 * which keeps us at one request per package even on the free,
 * unauthenticated 60-req/hr GitHub budget.
 *
 *   - `active`     pushed within the last 90 days.
 *   - `maintained` pushed within the last year.
 *   - `slow`       pushed within the last 2 years.
 *   - `inactive`   not pushed in 2+ years.
 *   - `archived`   repo is archived (read-only).
 *   - `unknown`    couldn't resolve a GitHub repo or the API call failed.
 */
export type VitalityTier = 'active' | 'maintained' | 'slow' | 'inactive' | 'archived' | 'unknown';

export interface MaintainerVitality {
  tier: VitalityTier;
  /** Days since the last push to the default branch — null if unknown. */
  daysSinceLastPush: number | null;
  /** Open issues + PRs reported by the GitHub API. */
  openIssuesCount: number | null;
  /** Stars (popularity context). */
  stars: number | null;
  /** True if the repo is archived. */
  archived: boolean;
  /** "owner/repo" string, if we could parse one. */
  slug: string | null;
  /** i18n key for the chip label. */
  labelKey: string;
  /** i18n key for the long description / aria-label. */
  descKey: string;
}

interface GhRepoResponse {
  archived?: boolean;
  pushed_at?: string;
  open_issues_count?: number;
  stargazers_count?: number;
}

interface CacheEntry {
  result: MaintainerVitality;
  /** Epoch ms when this entry was written. */
  ts: number;
}

const CACHE_KEY = 'ngpc.vitality.v1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — well below the GitHub 60-req/hr limit when scaled.

/**
 * Maps a repo URL (in any of npm's many shapes) to a vitality tier.
 *
 * # Why we cache in localStorage
 *
 * The unauthenticated GitHub REST API caps at 60 requests per hour
 * per IP. A user browsing 5 packages would already burn 5 of those —
 * with no auth header we have to make every request count. A 24h
 * localStorage cache keyed by `owner/repo` means we re-fetch on at
 * most a daily cadence per repo, which is plenty fresh for a metric
 * that talks in 90-day buckets.
 *
 * # SSR safety
 *
 * `localStorage` and `fetch` both need `window`. The constructor
 * captures isBrowser and the cache helpers no-op on the server, so
 * SSR-rendered output simply omits the vitality pill rather than
 * crashing during prerender.
 */
@Injectable({ providedIn: 'root' })
export class MaintainerVitalityService {
  private readonly http = inject(HttpClient);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** In-flight request dedup so two simultaneous lookups for the same slug share a single fetch. */
  private readonly inFlight = new Map<string, Observable<MaintainerVitality>>();

  /**
   * Resolve vitality for a package given its npm `repository.url`
   * field. Returns `unknown` (without an HTTP call) if we can't parse
   * out a GitHub slug.
   */
  forRepoUrl(repoUrl: string | undefined | null): Observable<MaintainerVitality> {
    const slug = this.parseGithubSlug(repoUrl);
    if (!slug) return of(this.unknown(null));

    // localStorage cache.
    const cached = this.readCache(slug);
    if (cached) return of(cached);

    // In-flight dedup so concurrent renders of the same package
    // (e.g. nav + meta panel) share a single network call.
    const existing = this.inFlight.get(slug);
    if (existing) return existing;

    const url = `https://api.github.com/repos/${slug}`;
    const req$ = this.http.get<GhRepoResponse>(url).pipe(
      map((res) => this.fromResponse(slug, res)),
      catchError(() => of(this.unknown(slug))),
      // Persist + clear inFlight once the value lands.
      map((result) => {
        this.writeCache(slug, result);
        this.inFlight.delete(slug);
        return result;
      }),
      shareReplay(1)
    );
    this.inFlight.set(slug, req$);
    return req$;
  }

  /**
   * Parse a GitHub `owner/repo` out of an npm repository field.
   * Accepts every shape npm has been known to ship over the years:
   *   - "git+https://github.com/owner/repo.git"
   *   - "https://github.com/owner/repo"
   *   - "git://github.com/owner/repo.git"
   *   - "github:owner/repo"
   *   - "owner/repo" (npm shortcut form)
   *   - "git@github.com:owner/repo.git" (SSH)
   */
  private parseGithubSlug(input: string | undefined | null): string | null {
    if (!input) return null;
    const cleaned = input.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
    if (!cleaned) return null;

    // Shortcut "github:owner/repo"
    const shortcut = /^github:([\w.-]+)\/([\w.-]+)$/i.exec(cleaned);
    if (shortcut) return `${shortcut[1]}/${shortcut[2]}`;

    // SSH "git@github.com:owner/repo"
    const ssh = /^git@github\.com:([\w.-]+)\/([\w.-]+)$/i.exec(cleaned);
    if (ssh) return `${ssh[1]}/${ssh[2]}`;

    // HTTPS / git protocol URLs
    const url = /(?:^|:\/\/)(?:[^/]*@)?github\.com\/([\w.-]+)\/([\w.-]+)(?:[/?#]|$)/i.exec(cleaned);
    if (url) return `${url[1]}/${url[2]}`;

    // Bare "owner/repo" (no host, no slashes elsewhere)
    const bare = /^([\w.-]+)\/([\w.-]+)$/.exec(cleaned);
    if (bare) return `${bare[1]}/${bare[2]}`;

    return null;
  }

  private fromResponse(slug: string, res: GhRepoResponse): MaintainerVitality {
    const archived = !!res.archived;
    const pushedAt = res.pushed_at ? Date.parse(res.pushed_at) : NaN;
    const daysSince = Number.isFinite(pushedAt)
      ? Math.max(0, Math.floor((Date.now() - pushedAt) / (24 * 60 * 60 * 1000)))
      : null;

    let tier: VitalityTier;
    if (archived) {
      tier = 'archived';
    } else if (daysSince == null) {
      tier = 'unknown';
    } else if (daysSince <= 90) {
      tier = 'active';
    } else if (daysSince <= 365) {
      tier = 'maintained';
    } else if (daysSince <= 730) {
      tier = 'slow';
    } else {
      tier = 'inactive';
    }

    return {
      tier,
      daysSinceLastPush: daysSince,
      openIssuesCount: typeof res.open_issues_count === 'number' ? res.open_issues_count : null,
      stars: typeof res.stargazers_count === 'number' ? res.stargazers_count : null,
      archived,
      slug,
      labelKey: `packageMeta.vitality.tier.${tier}`,
      descKey: `packageMeta.vitality.desc.${tier}`
    };
  }

  private unknown(slug: string | null): MaintainerVitality {
    return {
      tier: 'unknown',
      daysSinceLastPush: null,
      openIssuesCount: null,
      stars: null,
      archived: false,
      slug,
      labelKey: 'packageMeta.vitality.tier.unknown',
      descKey: 'packageMeta.vitality.desc.unknown'
    };
  }

  // ----- localStorage cache helpers (no-op on server) -----

  private readCache(slug: string): MaintainerVitality | null {
    if (!this.isBrowser) return null;
    try {
      const blob = window.localStorage.getItem(`${CACHE_KEY}.${slug}`);
      if (!blob) return null;
      const entry = JSON.parse(blob) as CacheEntry;
      if (!entry || typeof entry.ts !== 'number') return null;
      if (Date.now() - entry.ts > CACHE_TTL_MS) return null;
      return entry.result;
    } catch {
      return null;
    }
  }

  private writeCache(slug: string, result: MaintainerVitality): void {
    if (!this.isBrowser) return;
    try {
      const entry: CacheEntry = { result, ts: Date.now() };
      window.localStorage.setItem(`${CACHE_KEY}.${slug}`, JSON.stringify(entry));
    } catch {
      // Quota or private-mode — silently fall back to re-fetching next time.
    }
  }
}
