import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

/** One package as returned by the npm search API, sliced to what we care about. */
export interface OrgPackage {
  name: string;
  version: string;
  description: string;
  publishedAt: string | null;
  keywords: string[];
  isDeprecated: boolean;
  /** Package-level score from npm (0–1). */
  score: number;
  /** Optional flags populated by the health heuristic. */
  staleMonths?: number;
  healthTier?: 'fresh' | 'stale' | 'abandoned';
}

/** One batch of org results (npm search paginates at `size=250`). */
interface NpmSearchResponse {
  objects: Array<{
    package: {
      name: string;
      version: string;
      description?: string;
      date?: string;
      keywords?: string[];
      scope?: string;
    };
    flags?: { deprecated?: string };
    score?: { final?: number };
  }>;
  total: number;
}

/** Aggregate result shape the UI binds to. */
export interface OrgScanReport {
  scope: string;
  totalPackages: number;
  fresh: number;
  stale: number;
  abandoned: number;
  deprecated: number;
  oldestMonths: number;
  newestMonths: number;
  packages: OrgPackage[];
}

const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30;
const FRESH_CUTOFF_MONTHS = 12;
const STALE_CUTOFF_MONTHS = 24;
const PAGE_SIZE = 100; // npm search caps at 250; 100 keeps each request snappy

/**
 * Scan an entire npm organization (scope) in one shot.
 *
 * Enterprise angle:
 *   - Large teams don't own a single package — they own `@company/*`.
 *   - Before an Angular upgrade they need to know which of their own packages
 *     are fresh, stale, or deprecated.
 *   - Asking the npm UI package-by-package is a half-day job; this does it in
 *     a few seconds and produces a chart-ready report.
 *
 * How it works:
 *   1. Hit `registry.npmjs.org/-/v1/search?text=scope:<scope>&size=100` with
 *      paging `from=0,100,200...` until `objects.length < size` or `total`
 *      is reached.
 *   2. For each hit, extract name/version/date/deprecation/score.
 *   3. Classify each package by last-publish age into fresh/stale/abandoned.
 *   4. Aggregate counts for the sticky summary bar + bar chart.
 */
@Injectable({ providedIn: 'root' })
export class NpmOrgScanService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = 'https://registry.npmjs.org/-/v1/search';

  /** Reactive scan progress, 0–100. Components can bind to this. */
  readonly progress = signal<number>(0);
  /** `true` while an org scan is in flight. */
  readonly inFlight = signal<boolean>(false);

  /**
   * Run a full scan for a single scope (leading `@` optional).
   *
   * Throws if the scope is empty or the network call fails catastrophically.
   */
  async scanOrg(scopeInput: string, opts: { maxPackages?: number } = {}): Promise<OrgScanReport> {
    const scope = this.normalizeScope(scopeInput);
    if (!scope) throw new Error('Scope cannot be empty.');

    this.inFlight.set(true);
    this.progress.set(0);

    try {
      const cap = opts.maxPackages ?? 500;
      const collected: OrgPackage[] = [];
      let from = 0;
      let total = Infinity;

      while (collected.length < cap && from < total) {
        const page = await this.fetchPage(scope, from);
        if (!page.objects.length) break;
        total = page.total;
        for (const o of page.objects) {
          if (collected.length >= cap) break;
          collected.push(this.toOrgPackage(o));
        }
        from += PAGE_SIZE;
        // Progress: cap the reported total so the bar isn't stuck at ~1% for huge orgs
        const effectiveTotal = Math.min(total, cap);
        this.progress.set(Math.min(99, Math.round((collected.length / effectiveTotal) * 100)));
      }

      const classified = this.classify(collected);
      this.progress.set(100);
      return this.aggregate(scope, classified);
    } finally {
      this.inFlight.set(false);
    }
  }

  private async fetchPage(scope: string, from: number): Promise<NpmSearchResponse> {
    const q = encodeURIComponent(`scope:${scope}`);
    const url = `${this.baseUrl}?text=${q}&size=${PAGE_SIZE}&from=${from}`;
    return firstValueFrom(this.http.get<NpmSearchResponse>(url));
  }

  private toOrgPackage(o: NpmSearchResponse['objects'][number]): OrgPackage {
    return {
      name: o.package.name,
      version: o.package.version,
      description: o.package.description ?? '',
      publishedAt: o.package.date ?? null,
      keywords: o.package.keywords ?? [],
      isDeprecated: !!o.flags?.deprecated,
      score: o.score?.final ?? 0
    };
  }

  private classify(pkgs: OrgPackage[]): OrgPackage[] {
    const now = Date.now();
    return pkgs.map((p) => {
      if (!p.publishedAt) return { ...p, healthTier: 'abandoned' };
      const months = (now - Date.parse(p.publishedAt)) / MS_PER_MONTH;
      const tier: OrgPackage['healthTier'] =
        months <= FRESH_CUTOFF_MONTHS ? 'fresh' : months <= STALE_CUTOFF_MONTHS ? 'stale' : 'abandoned';
      return { ...p, staleMonths: Math.round(months), healthTier: tier };
    });
  }

  private aggregate(scope: string, pkgs: OrgPackage[]): OrgScanReport {
    let fresh = 0;
    let stale = 0;
    let abandoned = 0;
    let deprecated = 0;
    let oldest = 0;
    let newest = Infinity;

    for (const p of pkgs) {
      if (p.isDeprecated) deprecated++;
      if (p.healthTier === 'fresh') fresh++;
      else if (p.healthTier === 'stale') stale++;
      else abandoned++;
      if (typeof p.staleMonths === 'number') {
        oldest = Math.max(oldest, p.staleMonths);
        newest = Math.min(newest, p.staleMonths);
      }
    }

    return {
      scope,
      totalPackages: pkgs.length,
      fresh,
      stale,
      abandoned,
      deprecated,
      oldestMonths: oldest,
      newestMonths: Number.isFinite(newest) ? newest : 0,
      packages: pkgs
    };
  }

  private normalizeScope(input: string): string {
    const t = (input ?? '').trim().replace(/^@/, '');
    return t;
  }
}
