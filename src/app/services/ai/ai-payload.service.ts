import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, forkJoin, of } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import { NpmRegistryService } from '../npm-registry.service';
import {
  NpmDownloadsRange,
  NpmRegistryResponse,
  NpmVersionMetadata
} from '../../models/npm-package.model';

/**
 * Objective payload of facts about one or two npm packages, fetched from
 * public sources. The output of this service is what gets fed to the AI
 * provider for the Pros/Cons and Usage Guide features.
 *
 * Why this is its own service:
 *   - Provider-agnostic. The same payload feeds Groq, Gemini, DeepSeek,
 *     OpenAI, anyone — only the prompt differs.
 *   - Cache-friendly. Hashing a serialized AiPayload gives a stable key
 *     for IndexedDB cache lookups; the AI cache layer never has to know
 *     anything about how the facts were gathered.
 *   - Robust by design. Every public API we call can be flaky; per-source
 *     `catchError` ensures one failed fetch (e.g. Bundlephobia is down)
 *     leaves a `null` field rather than failing the whole feature. The
 *     system prompt then tells the model "if a field is null, acknowledge
 *     the gap — do not invent."
 *
 * What we deliberately DO NOT include:
 *   - Anything from the user's private repos. README content is fetched
 *     from public npm/GitHub APIs only.
 *   - Anything user-typed beyond the package name. No accidental data
 *     leakage to third-party AI providers.
 *   - The user's BYO-AI key. That stays browser-side; this service has
 *     no awareness of which provider will be called.
 */

// ---------------------------------------------------------------------------
// Public types — these are what AI prompt builders consume
// ---------------------------------------------------------------------------

export interface AiPayload {
  /** Always present. */
  packageA: PackageFacts;
  /**
   * Present for two-package comparisons (Pros/Cons feature). `null` for
   * single-package use cases like the Usage Guide.
   */
  packageB: PackageFacts | null;
  /** ISO timestamp when this payload was assembled — used for cache TTLs. */
  generatedAt: string;
}

export interface PackageFacts {
  name: string;
  version: string;
  description: string | null;

  /** Bundlephobia: size, gzipped size, dependency count, tree-shakeability. */
  bundleSize: BundleSizeFacts | null;
  /** NPM downloads trend over the last 365 days, with delta vs prior 90 days. */
  downloads: DownloadsTrend | null;
  /** Best-effort GitHub repo metrics: stars, open issues, last commit, etc. */
  repo: RepoMetrics | null;
  /** Release cadence and recency, derived from the npm packument's `time` map. */
  releases: ReleaseCadence | null;
  /** Runtime + peer dependency profile for the targeted version. */
  dependencies: DependencyProfile | null;
  /** Truncated README content, with provenance. */
  readme: ReadmeContent | null;
  /** Major-version churn signal — proxy for "API stability." */
  majorVersionChurn: MajorVersionChurn | null;
}

export interface BundleSizeFacts {
  /** Minified bytes. */
  size: number;
  /** Minified + gzipped bytes — what users actually pay over the wire. */
  gzip: number;
  /** Number of transitive runtime dependencies. */
  dependencyCount: number;
  /** Whether the package ships an ESM build (better tree-shaking). */
  treeShakeable: boolean;
}

export interface DownloadsTrend {
  /** Sum of the most recent 7-day window. */
  weeklyDownloads: number;
  /** Sum of the most recent 30-day window. */
  monthlyDownloads: number;
  /** Sum across the whole 365-day range. */
  yearlyDownloads: number;
  /**
   * Percent change of the most recent 90-day window vs the 90-day window
   * before that. Useful for "this package is rising / falling / flat."
   * Null if we don't have enough data to compute (e.g. a brand-new package).
   */
  deltaPctRecent90VsPrior90: number | null;
  /** High-level direction signal derived from the delta. */
  trend: 'rising' | 'falling' | 'flat' | 'unknown';
}

export interface RepoMetrics {
  /** Public web URL of the repo (GitHub, GitLab, etc. — for now we only
   * resolve metrics for github.com hosts; others get the URL but null
   * metrics so the model still has a link to attribute. */
  webUrl: string;
  /** Provider host — `github` is the only one we fetch metrics for today. */
  host: 'github' | 'gitlab' | 'bitbucket' | 'other';
  stars: number | null;
  openIssues: number | null;
  /** ISO timestamp of the latest pushed commit on the default branch. */
  lastPushedAt: string | null;
  /** Days since last push, computed at payload generation time. */
  daysSinceLastPush: number | null;
  /** Whether the repo has been archived — strong "do not adopt" signal. */
  archived: boolean | null;
  defaultBranch: string | null;
}

export interface ReleaseCadence {
  /** Number of distinct semver releases on record. */
  totalReleases: number;
  /** ISO timestamp of the latest release. */
  lastReleaseAt: string | null;
  daysSinceLastRelease: number | null;
  /**
   * Median time between consecutive releases over the last 12 months.
   * Null if fewer than 2 releases in that window.
   */
  medianDaysBetweenReleasesLast12Months: number | null;
}

export interface DependencyProfile {
  /** Runtime deps (always installed alongside this package). */
  runtimeDependencies: { name: string; range: string }[];
  /** Peer deps the host project must satisfy. */
  peerDependencies: { name: string; range: string }[];
  /** Peer range that targets `@angular/core` specifically — extracted for
   *  the model's convenience since this is the most common compat axis. */
  angularPeerRange: string | null;
}

export interface ReadmeContent {
  /** Where this README came from. GitHub is preferred when available. */
  source: 'github' | 'npm';
  /** Truncated markdown content. Truncation is section-aware. */
  truncated: string;
  /** Original character count before truncation — lets the model say
   *  "showing the first 25% of the README." */
  originalChars: number;
  /** Set when truncation actually happened. */
  truncatedFlag: boolean;
}

export interface MajorVersionChurn {
  /** How many distinct majors have been released over all time. */
  totalMajors: number;
  /** How many of those were released in the last 12 months. Indicates
   *  "actively breaking the API" vs "stable mature library." */
  majorsLast12Months: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Roughly 3000 tokens — leaves room for the rest of the prompt. */
const README_TRUNCATE_CHARS = 12_000;
const TRENDING_THRESHOLD_PCT = 15;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable({ providedIn: 'root' })
export class AiPayloadService {
  private readonly http = inject(HttpClient);
  private readonly registry = inject(NpmRegistryService);

  /**
   * Build a complete `AiPayload` for one or two packages, fetching every
   * fact source in parallel. Per-source failures are absorbed into `null`
   * fields rather than failing the whole observable.
   */
  forPackages(
    a: { name: string; version?: string },
    b: { name: string; version?: string } | null = null
  ): Observable<AiPayload> {
    const factsA$ = this.factsFor(a.name, a.version);
    const factsB$ = b
      ? this.factsFor(b.name, b.version)
      : of<PackageFacts | null>(null);

    return forkJoin([factsA$, factsB$]).pipe(
      map(([packageA, packageB]) => ({
        packageA: packageA!,
        packageB,
        generatedAt: new Date().toISOString()
      }))
    );
  }

  /**
   * Convenience for the Usage Guide feature — a single package's facts.
   */
  forSinglePackage(
    name: string,
    version?: string
  ): Observable<PackageFacts> {
    return this.factsFor(name, version);
  }

  // -------------------------------------------------------------------------
  // Per-package orchestration
  // -------------------------------------------------------------------------

  private factsFor(name: string, version?: string): Observable<PackageFacts> {
    return this.registry.fetchPackage(name).pipe(
      switchMap((packument) => {
        // Resolve which version's manifest we'll inspect for deps. Default
        // to dist-tags.latest so this works with just `{name}`.
        const targetVersion =
          version ?? packument['dist-tags']?.['latest'] ?? '';
        const repoWebUrl = this.extractRepoWebUrl(packument);

        return forkJoin({
          bundleSize: this.fetchBundleSize(name, targetVersion),
          downloads: this.fetchDownloads(name),
          repo: this.fetchRepoMetrics(repoWebUrl),
          // The next three are derived from the packument we already have —
          // no extra network calls. Wrap in `of` so the forkJoin shape is
          // uniform.
          releases: of(this.computeReleaseCadence(packument)),
          dependencies: of(this.computeDependencyProfile(packument, targetVersion)),
          majorVersionChurn: of(this.computeMajorVersionChurn(packument)),
          // README needs a network hop to GitHub when available; fall back
          // to packument.readme otherwise.
          readme: this.fetchReadme(packument, repoWebUrl)
        }).pipe(
          map((parts) => ({
            name,
            version: targetVersion,
            description: packument.description ?? null,
            ...parts
          }))
        );
      }),
      catchError(() => of(this.emptyFacts(name, version ?? '')))
    );
  }

  /**
   * Fallback when even the packument fetch fails — return a minimally-
   * populated `PackageFacts` so the caller still gets the package name
   * back and the model can acknowledge "couldn't find this package."
   */
  private emptyFacts(name: string, version: string): PackageFacts {
    return {
      name,
      version,
      description: null,
      bundleSize: null,
      downloads: null,
      repo: null,
      releases: null,
      dependencies: null,
      readme: null,
      majorVersionChurn: null
    };
  }

  // -------------------------------------------------------------------------
  // Bundlephobia
  // -------------------------------------------------------------------------

  private fetchBundleSize(
    name: string,
    version: string
  ): Observable<BundleSizeFacts | null> {
    const pkg = version ? `${name}@${version}` : name;
    const url = `https://bundlephobia.com/api/size?package=${encodeURIComponent(pkg)}`;
    return this.http
      .get<{
        size: number;
        gzip: number;
        dependencyCount: number;
        hasJSModule: boolean;
        hasJSNext: boolean;
      }>(url)
      .pipe(
        map((res) => ({
          size: res.size,
          gzip: res.gzip,
          dependencyCount: res.dependencyCount,
          treeShakeable: !!(res.hasJSModule || res.hasJSNext)
        })),
        catchError((err) => {
          // Bundlephobia returns 500 for packages it can't analyze —
          // older packages, unusual build configs, anything that
          // doesn't fit its build pipeline. Affects ~5-8% of packages
          // on npm. The AI payload degrades to `bundleSize: null`
          // here, and the system prompt instructs the model to
          // acknowledge the gap rather than invent a number.
          //
          // We log a friendly console.info (NOT console.error) so the
          // companion red entry in the network panel has context
          // attached for anyone debugging — it's expected behaviour,
          // not a bug in our code, and the comparison still works.
          const status = err?.status ?? 'unknown';
          console.info(
            `[AI payload] Bundlephobia returned ${status} for "${pkg}". ` +
            `Proceeding without bundle-size data — the model will ` +
            `acknowledge the gap rather than invent numbers.`
          );
          return of<BundleSizeFacts | null>(null);
        })
      );
  }

  // -------------------------------------------------------------------------
  // NPM downloads
  // -------------------------------------------------------------------------

  private fetchDownloads(name: string): Observable<DownloadsTrend | null> {
    const url = `https://api.npmjs.org/downloads/range/last-year/${encodeURIComponent(name)}`;
    return this.http.get<NpmDownloadsRange>(url).pipe(
      map((res) => this.summarizeDownloads(res)),
      catchError(() => of<DownloadsTrend | null>(null))
    );
  }

  private summarizeDownloads(res: NpmDownloadsRange): DownloadsTrend {
    const days = res.downloads || [];
    const total = days.reduce((sum, d) => sum + (d.downloads || 0), 0);
    // Most recent windows: counted from the END of the array because npm
    // returns chronologically, oldest-first.
    const last7 = days.slice(-7).reduce((s, d) => s + d.downloads, 0);
    const last30 = days.slice(-30).reduce((s, d) => s + d.downloads, 0);
    const recent90 = days.slice(-90).reduce((s, d) => s + d.downloads, 0);
    const prior90 = days
      .slice(-180, -90)
      .reduce((s, d) => s + d.downloads, 0);

    let deltaPct: number | null = null;
    let trend: DownloadsTrend['trend'] = 'unknown';
    if (prior90 > 0) {
      deltaPct = ((recent90 - prior90) / prior90) * 100;
      if (deltaPct > TRENDING_THRESHOLD_PCT) trend = 'rising';
      else if (deltaPct < -TRENDING_THRESHOLD_PCT) trend = 'falling';
      else trend = 'flat';
    }

    return {
      weeklyDownloads: last7,
      monthlyDownloads: last30,
      yearlyDownloads: total,
      deltaPctRecent90VsPrior90: deltaPct,
      trend
    };
  }

  // -------------------------------------------------------------------------
  // GitHub repo metrics
  // -------------------------------------------------------------------------

  private fetchRepoMetrics(
    repoWebUrl: string | null
  ): Observable<RepoMetrics | null> {
    if (!repoWebUrl) return of(null);
    const host = this.detectHost(repoWebUrl);

    // For non-GitHub hosts, return the URL with null metrics — the model
    // still gets a clickable link, and we don't burn bandwidth on APIs
    // we can't unauthenticate against (GitLab/BitBucket per-repo metrics
    // require auth, would be cross-origin, and rate-limit the user fast).
    if (host !== 'github') {
      return of({
        webUrl: repoWebUrl,
        host,
        stars: null,
        openIssues: null,
        lastPushedAt: null,
        daysSinceLastPush: null,
        archived: null,
        defaultBranch: null
      });
    }

    const slug = this.parseGithubSlug(repoWebUrl);
    if (!slug) return of(null);
    const url = `https://api.github.com/repos/${slug}`;
    const headers = new HttpHeaders({
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    });

    return this.http
      .get<{
        stargazers_count: number;
        open_issues_count: number;
        pushed_at: string;
        archived: boolean;
        default_branch: string;
        html_url: string;
      }>(url, { headers })
      .pipe(
        map((r) => {
          const lastPushedAt = r.pushed_at;
          const daysSinceLastPush = lastPushedAt
            ? Math.floor(
                (Date.now() - new Date(lastPushedAt).getTime()) / ONE_DAY_MS
              )
            : null;
          return {
            webUrl: r.html_url || repoWebUrl,
            host: 'github' as const,
            stars: r.stargazers_count,
            openIssues: r.open_issues_count,
            lastPushedAt,
            daysSinceLastPush,
            archived: r.archived,
            defaultBranch: r.default_branch
          };
        }),
        catchError(() =>
          // 403/404/429 — most likely rate limit. Surface what we can:
          // the URL is still useful, the metrics aren't.
          of({
            webUrl: repoWebUrl,
            host: 'github' as const,
            stars: null,
            openIssues: null,
            lastPushedAt: null,
            daysSinceLastPush: null,
            archived: null,
            defaultBranch: null
          })
        )
      );
  }

  private detectHost(url: string): RepoMetrics['host'] {
    if (/github\.com/i.test(url)) return 'github';
    if (/gitlab\.com/i.test(url)) return 'gitlab';
    if (/bitbucket\.org/i.test(url)) return 'bitbucket';
    return 'other';
  }

  private parseGithubSlug(url: string): string | null {
    // Accept the variety of shapes npm packuments contain:
    //   git+https://github.com/owner/repo.git
    //   git://github.com/owner/repo.git
    //   https://github.com/owner/repo
    //   git@github.com:owner/repo.git
    const match = url.match(
      /github\.com[:/]([^/]+)\/([^/.\s]+)(?:\.git)?(?:\/|$)/i
    );
    if (!match) return null;
    return `${match[1]}/${match[2]}`;
  }

  private extractRepoWebUrl(packument: NpmRegistryResponse): string | null {
    const raw = packument.repository?.url || packument.homepage;
    if (!raw) return null;
    // Normalize git-prefix URLs into clickable HTTPS so the model and the
    // UI both consume the same shape.
    return raw
      .replace(/^git\+/, '')
      .replace(/^git:\/\//, 'https://')
      .replace(/\.git$/, '');
  }

  // -------------------------------------------------------------------------
  // Release cadence (no network — derived from packument.time)
  // -------------------------------------------------------------------------

  private computeReleaseCadence(
    packument: NpmRegistryResponse
  ): ReleaseCadence | null {
    const time = packument.time || {};
    // npm packs "created" / "modified" into time too; strip them.
    const versionEntries = Object.entries(time).filter(
      ([k]) => k !== 'created' && k !== 'modified'
    );
    if (!versionEntries.length) return null;

    // Sort chronologically, newest last.
    const sorted = versionEntries
      .map(([v, t]) => ({ version: v, ts: new Date(t).getTime() }))
      .filter((e) => Number.isFinite(e.ts))
      .sort((a, b) => a.ts - b.ts);
    if (!sorted.length) return null;

    const lastTs = sorted[sorted.length - 1].ts;
    const lastReleaseAt = new Date(lastTs).toISOString();
    const daysSinceLastRelease = Math.floor((Date.now() - lastTs) / ONE_DAY_MS);

    // Median gap over the last 12 months — proxy for "active maintenance."
    const cutoff = Date.now() - 365 * ONE_DAY_MS;
    const recent = sorted.filter((e) => e.ts >= cutoff);
    let medianDays: number | null = null;
    if (recent.length >= 2) {
      const gaps: number[] = [];
      for (let i = 1; i < recent.length; i++) {
        gaps.push((recent[i].ts - recent[i - 1].ts) / ONE_DAY_MS);
      }
      gaps.sort((a, b) => a - b);
      const mid = Math.floor(gaps.length / 2);
      medianDays = gaps.length % 2
        ? gaps[mid]
        : (gaps[mid - 1] + gaps[mid]) / 2;
      medianDays = Math.round(medianDays);
    }

    return {
      totalReleases: sorted.length,
      lastReleaseAt,
      daysSinceLastRelease,
      medianDaysBetweenReleasesLast12Months: medianDays
    };
  }

  // -------------------------------------------------------------------------
  // Dependency profile (no network — read straight off the version manifest)
  // -------------------------------------------------------------------------

  private computeDependencyProfile(
    packument: NpmRegistryResponse,
    targetVersion: string
  ): DependencyProfile | null {
    const manifest =
      packument.versions?.[targetVersion] ??
      packument.versions?.[packument['dist-tags']?.['latest'] ?? ''] ??
      null;
    if (!manifest) return null;
    return {
      runtimeDependencies: this.depMapToList(manifest.dependencies),
      peerDependencies: this.depMapToList(manifest.peerDependencies),
      angularPeerRange:
        manifest.peerDependencies?.['@angular/core'] ?? null
    };
  }

  private depMapToList(
    map: NpmVersionMetadata['dependencies'] | undefined
  ): { name: string; range: string }[] {
    if (!map) return [];
    return Object.entries(map).map(([name, range]) => ({
      name,
      range: String(range)
    }));
  }

  // -------------------------------------------------------------------------
  // Major-version churn (no network)
  // -------------------------------------------------------------------------

  private computeMajorVersionChurn(
    packument: NpmRegistryResponse
  ): MajorVersionChurn | null {
    const time = packument.time || {};
    const entries = Object.entries(time).filter(
      ([k]) => k !== 'created' && k !== 'modified'
    );
    if (!entries.length) return null;

    const allMajors = new Set<number>();
    const recentMajors = new Set<number>();
    const cutoff = Date.now() - 365 * ONE_DAY_MS;
    for (const [version, ts] of entries) {
      const m = this.parseMajor(version);
      if (m === null) continue;
      allMajors.add(m);
      // Consider only stable releases (no `-rc`, `-beta` etc.) when
      // counting recent-major churn — a flurry of beta tags doesn't mean
      // the API actually broke.
      if (/-/.test(version)) continue;
      const t = new Date(ts).getTime();
      if (Number.isFinite(t) && t >= cutoff) recentMajors.add(m);
    }
    return {
      totalMajors: allMajors.size,
      majorsLast12Months: recentMajors.size
    };
  }

  private parseMajor(version: string): number | null {
    const match = version.match(/^(\d+)\./);
    if (!match) return null;
    const n = parseInt(match[1], 10);
    return Number.isFinite(n) ? n : null;
  }

  // -------------------------------------------------------------------------
  // README — GitHub-first with packument fallback
  // -------------------------------------------------------------------------

  private fetchReadme(
    packument: NpmRegistryResponse,
    repoWebUrl: string | null
  ): Observable<ReadmeContent | null> {
    const slug = repoWebUrl ? this.parseGithubSlug(repoWebUrl) : null;
    if (slug) {
      const url = `https://api.github.com/repos/${slug}/readme`;
      const headers = new HttpHeaders({
        Accept: 'application/vnd.github.raw',
        'X-GitHub-Api-Version': '2022-11-28'
      });
      return this.http
        .get(url, { headers, responseType: 'text' })
        .pipe(
          map((raw) => this.toReadmeContent(raw, 'github')),
          catchError(() => of(this.readmeFromPackument(packument)))
        );
    }
    return of(this.readmeFromPackument(packument));
  }

  private readmeFromPackument(
    packument: NpmRegistryResponse
  ): ReadmeContent | null {
    const raw = packument.readme;
    if (!raw || !raw.trim()) return null;
    return this.toReadmeContent(raw, 'npm');
  }

  private toReadmeContent(
    raw: string,
    source: ReadmeContent['source']
  ): ReadmeContent {
    const originalChars = raw.length;
    const truncated = this.truncateReadme(raw);
    return {
      source,
      truncated,
      originalChars,
      truncatedFlag: truncated.length < originalChars
    };
  }

  /**
   * Truncate a README to roughly the first 12 000 chars (~3 000 tokens).
   * Tries to break on a section boundary (heading) or paragraph boundary
   * to avoid cutting in the middle of a code fence — fenced code blocks
   * cut in the middle confuse models into thinking the code is incomplete.
   *
   * Algorithm:
   *   1. If under the budget, return as-is.
   *   2. Find the last `\n##` heading before the budget. Cut there.
   *   3. Else find the last blank line before the budget. Cut there.
   *   4. Else hard-cut at the budget and append a marker.
   *   5. Always append a `[...truncated]` sentinel if we cut anything.
   */
  private truncateReadme(raw: string): string {
    if (raw.length <= README_TRUNCATE_CHARS) return raw;

    const window = raw.slice(0, README_TRUNCATE_CHARS);

    // Prefer a section boundary — the model has a much better time when
    // the README ends on a clean heading than mid-paragraph.
    const headingIdx = window.lastIndexOf('\n## ');
    if (headingIdx > README_TRUNCATE_CHARS * 0.6) {
      return raw.slice(0, headingIdx) + '\n\n[...truncated]';
    }

    // Fall back to the last blank line.
    const paraIdx = window.lastIndexOf('\n\n');
    if (paraIdx > README_TRUNCATE_CHARS * 0.6) {
      return raw.slice(0, paraIdx) + '\n\n[...truncated]';
    }

    // Last resort: hard cut. Avoid leaving an unterminated fenced code
    // block — count fence markers and close the block if odd.
    let cut = window;
    const fenceCount = (cut.match(/```/g) || []).length;
    if (fenceCount % 2 === 1) cut += '\n```';
    return cut + '\n\n[...truncated]';
  }
}
