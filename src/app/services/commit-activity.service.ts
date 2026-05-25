import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { HttpClient, HttpResponse } from '@angular/common/http';
import { isPlatformBrowser } from '@angular/common';
import { Observable, of, timer } from 'rxjs';
import { catchError, map, mergeMap, retry, shareReplay } from 'rxjs/operators';

/**
 * Result shape for a 52-week commit-activity trend on a GitHub repo.
 *
 * # Why "commit activity" instead of "stars over time"
 *
 * The original Phase 3 plan said "stars sparkline" — but the GitHub
 * API has no efficient way to fetch stars over time. Reconstructing
 * per-day star counts requires paginating `/stargazers` for the
 * entire history (5000+ pages for popular repos = thousands of API
 * calls, vastly over the 60-req/hr unauthenticated budget). The
 * standard workarounds are either a third-party aggregator
 * (star-history.com — extra dependency, privacy/trust hop) or
 * shipping our own scraper.
 *
 * Commit activity gives us a better aliveness signal anyway. Stars
 * accumulate and rarely decline — a popular library can be dead for
 * years and still look "growing" by star count alone. Recent commit
 * cadence is the actual ground truth for "is anyone still working on
 * this?". And GitHub exposes it in a single endpoint, one call, 52
 * weeks of weekly commit totals: `/repos/:slug/stats/commit_activity`.
 *
 * # The 202 dance
 *
 * GitHub's stats endpoints are computed lazily. First-ever request
 * for a repo's stats returns HTTP 202 + empty body while the worker
 * spins up. A subsequent request returns the data. We handle this by
 * retrying once with a short delay — if it's still 202 we just bail
 * and let the user see an empty sparkline (no telemetry hit).
 *
 * # Caching
 *
 * 24h localStorage cache. Stats endpoints return weekly counts that
 * only change once a week, so we don't need fresher data. Same TTL
 * as MaintainerVitalityService for consistency.
 */
export interface CommitActivity {
  /** GitHub owner/repo slug — used as cache key. */
  slug: string;
  /**
   * 52 weekly commit counts, oldest first. Empty array when we
   * couldn't fetch (no repo, rate-limited, or stats not ready).
   */
  weeklyTotals: number[];
  /** Sum of `weeklyTotals` — the headline number. */
  totalCommits: number;
  /** Number of weeks with at least one commit — proxy for cadence. */
  activeWeeks: number;
  /** The most recent week's commit count — current pace. */
  recentCommits: number;
}

interface GhCommitActivityWeek {
  days?: number[];
  total?: number;
  week?: number;
}

interface CacheEntry {
  result: CommitActivity;
  ts: number;
}

const CACHE_KEY = 'ngpc.commit-activity.v1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Fetches a 52-week commit-activity sparkline for a GitHub repo.
 *
 * Pairs with MaintainerVitalityService — they both read GitHub data
 * but they're independent services so a slow stats endpoint never
 * blocks the more critical vitality chip from rendering.
 */
@Injectable({ providedIn: 'root' })
export class CommitActivityService {
  private readonly http = inject(HttpClient);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** In-flight dedup. */
  private readonly inFlight = new Map<string, Observable<CommitActivity>>();

  /**
   * Fetch the 52-week commit activity for the repo at `repoUrl`.
   * Returns an empty-but-defined result on failure (never throws) so
   * the UI can render a zero-state sparkline.
   */
  forRepoUrl(repoUrl: string | undefined | null): Observable<CommitActivity> {
    const slug = this.parseGithubSlug(repoUrl);
    if (!slug) return of(this.empty(null));

    const cached = this.readCache(slug);
    if (cached) return of(cached);

    const existing = this.inFlight.get(slug);
    if (existing) return existing;

    const url = `https://api.github.com/repos/${slug}/stats/commit_activity`;
    const req$ = this.http
      .get<GhCommitActivityWeek[]>(url, { observe: 'response' })
      .pipe(
        // GitHub stats endpoints return 202 while computing — retry
        // ONCE after a short delay. If still 202, bail to empty.
        mergeMap((res) => this.handleResponse(res, slug)),
        retry({
          count: 1,
          // Only retry if we got a 202 ("computing") — anything else
          // is a real failure (rate limit, network, 404) and shouldn't
          // be retried.
          delay: (err) => (err === 'computing' ? timer(1500) : timer(0).pipe(map(() => { throw err; })))
        }),
        catchError(() => of(this.empty(slug))),
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

  private handleResponse(
    res: HttpResponse<GhCommitActivityWeek[]>,
    slug: string
  ): Observable<CommitActivity> {
    // 202 = stats are being computed. Retry once.
    if (res.status === 202) {
      throw 'computing';
    }
    const rows = res.body ?? [];
    if (!rows.length) return of(this.empty(slug));

    const weekly = rows.map((r) => Number.isFinite(r?.total) ? (r.total as number) : 0);
    const total = weekly.reduce((a, b) => a + b, 0);
    const activeWeeks = weekly.filter((n) => n > 0).length;
    const recent = weekly.length > 0 ? weekly[weekly.length - 1] : 0;

    return of({
      slug,
      weeklyTotals: weekly,
      totalCommits: total,
      activeWeeks,
      recentCommits: recent
    });
  }

  private empty(slug: string | null): CommitActivity {
    return {
      slug: slug ?? '',
      weeklyTotals: [],
      totalCommits: 0,
      activeWeeks: 0,
      recentCommits: 0
    };
  }

  /** Same parser used by MaintainerVitalityService. */
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

  private readCache(slug: string): CommitActivity | null {
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

  private writeCache(slug: string, result: CommitActivity): void {
    if (!this.isBrowser) return;
    try {
      const entry: CacheEntry = { result, ts: Date.now() };
      window.localStorage.setItem(`${CACHE_KEY}.${slug}`, JSON.stringify(entry));
    } catch {
      /* quota — silently no-op */
    }
  }
}
