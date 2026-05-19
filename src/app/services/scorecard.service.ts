import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { isPlatformBrowser } from '@angular/common';
import { Observable, of } from 'rxjs';
import { catchError, map, shareReplay } from 'rxjs/operators';

/**
 * Compact summary of an OpenSSF Scorecard result. We only keep the
 * fields the UI actually renders — the full API response includes
 * ~20 check-level details that we don't surface today.
 */
export interface ScorecardResult {
  /** "owner/repo" slug the scorecard is for. */
  slug: string;
  /** Aggregate score, 0–10 (the API returns floats with one decimal). */
  score: number;
  /** Banding for the chip color. See the `band()` helper for thresholds. */
  band: 'high' | 'medium' | 'low' | 'unknown';
  /** Number of subchecks that contributed to the score. */
  checkCount: number;
  /** Permalink to the full report on securityscorecards.dev. */
  reportUrl: string;
}

interface ScorecardApiResponse {
  date?: string;
  score?: number;
  checks?: Array<{ name: string; score: number; reason: string }>;
}

interface CacheEntry {
  result: ScorecardResult;
  ts: number;
}

const CACHE_KEY = 'ngpc.scorecard.v1';
/**
 * 7-day TTL. Scorecard scores change slowly — typically only when
 * the maintainer ships a release with new CI checks or rotates a
 * dependency-update tool. A weekly refresh is plenty.
 */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Wraps the public OpenSSF Scorecard API (`api.securityscorecards.dev`)
 * to add a security-trust score to the package meta panel.
 *
 * # Why surface this
 *
 * Scorecard is the most-used objective security score for open-source
 * projects. It checks ~17 boxes the maintainer team controls:
 * branch-protection rules, signed releases, fuzzing presence,
 * code-review usage, dependency-update tools, SBOM, token-permissions
 * hygiene, and so on. Surfacing the aggregate next to License and
 * Vitality completes the "is this project run responsibly?" picture
 * in a single glance.
 *
 * # SSR + cache behavior matches MaintainerVitalityService
 *
 *   - 7-day localStorage cache (scores change weekly at best)
 *   - In-flight dedup so two concurrent renders share one fetch
 *   - Graceful `null` fallback on 404 (no public report) or rate-limit
 *   - No-op writes/reads on the server (no `window`), so SSR doesn't
 *     crash but also doesn't pollute the prerendered HTML with a chip
 *     that the cache miss would have produced
 */
@Injectable({ providedIn: 'root' })
export class ScorecardService {
  private readonly http = inject(HttpClient);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  private readonly inFlight = new Map<string, Observable<ScorecardResult | null>>();

  /**
   * Resolve an OpenSSF Scorecard for a package given its npm
   * `repository.url`. Returns `null` (without an HTTP call) when we
   * can't parse a GitHub slug, and `null` (after an HTTP call) when
   * the repo has no public scorecard.
   */
  forRepoUrl(repoUrl: string | undefined | null): Observable<ScorecardResult | null> {
    const slug = this.parseGithubSlug(repoUrl);
    if (!slug) return of(null);

    const cached = this.readCache(slug);
    if (cached) return of(cached);

    const existing = this.inFlight.get(slug);
    if (existing) return existing;

    const url = `https://api.securityscorecards.dev/projects/github.com/${slug}`;
    const req$ = this.http.get<ScorecardApiResponse>(url).pipe(
      map((res) => this.fromResponse(slug, res)),
      catchError(() => of<ScorecardResult | null>(null)),
      map((result) => {
        if (result) this.writeCache(slug, result);
        this.inFlight.delete(slug);
        return result;
      }),
      shareReplay(1)
    );
    this.inFlight.set(slug, req$);
    return req$;
  }

  private fromResponse(slug: string, res: ScorecardApiResponse): ScorecardResult | null {
    if (typeof res?.score !== 'number') return null;
    return {
      slug,
      score: Math.round(res.score * 10) / 10, // pin to 1 decimal
      band: this.band(res.score),
      checkCount: res.checks?.length ?? 0,
      reportUrl: `https://scorecard.dev/viewer/?uri=github.com%2F${slug.replace('/', '%2F')}`
    };
  }

  /**
   * Banding thresholds match the visual convention OpenSSF's own
   * viewer uses: green ≥ 7.5, yellow ≥ 5.0, red below. We add an
   * `unknown` band for completeness even though the type system
   * already excludes null scores — defensive against API drift.
   */
  private band(score: number | undefined): ScorecardResult['band'] {
    if (typeof score !== 'number' || !isFinite(score)) return 'unknown';
    if (score >= 7.5) return 'high';
    if (score >= 5.0) return 'medium';
    return 'low';
  }

  /**
   * Same parser MaintainerVitalityService and ChangelogRagService use.
   * Duplicated rather than extracted because each service owns its
   * full GitHub-source story; a shared util would need to defend
   * against partial-input cases neither caller hits.
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

  // ----- localStorage cache (no-ops on server) -----

  private readCache(slug: string): ScorecardResult | null {
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

  private writeCache(slug: string, result: ScorecardResult): void {
    if (!this.isBrowser) return;
    try {
      const entry: CacheEntry = { result, ts: Date.now() };
      window.localStorage.setItem(`${CACHE_KEY}.${slug}`, JSON.stringify(entry));
    } catch {
      // Quota or private-mode — accept the re-fetch on next visit.
    }
  }
}
