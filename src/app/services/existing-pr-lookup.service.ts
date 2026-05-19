import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { forkJoin, Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { NormalizedRepo } from './provider-repo.service';
import { ProviderTokenStore } from './provider-token-store.service';

/**
 * Three-state model for an existing PR/MR. Maps to UI button behaviour:
 *   - `opened` → "Open existing PR/MR #N ↗" (link to the existing one)
 *   - `merged` → disabled "Already merged into {{ target }} — view PR/MR #N"
 *   - `closed` → caller treats as "no existing PR" and shows the normal
 *     create button. We still surface the data (so consumers can show a
 *     hint like "previous attempt was closed") but the UX guidance is
 *     not to block creation, since closed-without-merge means a human
 *     deliberately rejected the previous attempt.
 *
 * GitHub returns `state: 'open' | 'closed'` plus `merged_at: string | null`,
 * which we normalize into this shape (closed + merged_at != null → merged).
 * GitLab returns `state: 'opened' | 'merged' | 'closed' | 'locked'`, which
 * already matches once we collapse `locked` into `closed`.
 */
export type ExistingPrState = 'opened' | 'merged' | 'closed';

export interface ExistingPr {
  /** Public URL of the PR/MR — used for the "open existing" CTA. */
  url: string;
  /** Public-facing number — `#N` on GitHub/Bitbucket, `!N` on GitLab. */
  number: number;
  state: ExistingPrState;
  /** The provider this came from — handy for label rendering. */
  provider: 'github' | 'gitlab' | 'bitbucket';
}

/**
 * Cross-provider lookup: "is there already a PR/MR from `sourceBranch` into
 * `targetBranch` on this repo?" — used to swap the create button into an
 * "open existing" button before the user pushes a duplicate.
 *
 * Why this lives separately from `pr-generator.service.ts`:
 *   - It's read-only, has different error semantics (404 just means "no
 *     existing PR", not a hard failure), and it doesn't need the proxy
 *     fallback the create path uses.
 *   - It's called on every `(repo, source, target)` change in the UI, so
 *     it's worth keeping the implementation lean and easily debounceable
 *     from the caller.
 *
 * Both providers' list endpoints return at most a handful of MRs/PRs for
 * a given source+target pair, so we read the first page (per_page=20) and
 * pick by priority: opened > merged > closed. If multiple opened MRs exist
 * (rare on GitLab — they normally close as duplicates), we surface the
 * most recently created one.
 */
@Injectable({ providedIn: 'root' })
export class ExistingPrLookupService {
  private readonly http = inject(HttpClient);
  private readonly tokens = inject(ProviderTokenStore);

  /**
   * Look up an existing PR/MR. Returns `null` if there's none — this is
   * the common case (no error). Network errors are also swallowed to
   * `null` so a flaky lookup doesn't break the create-button UX; the
   * worst outcome is the user sees a "Create" button when an "Open
   * existing" would have been better, and the create call surfaces a
   * 409 / 422 we already friendly-error.
   */
  findExisting(
    repo: NormalizedRepo,
    sourceBranch: string,
    targetBranch: string
  ): Observable<ExistingPr | null> {
    if (
      repo.provider !== 'github' &&
      repo.provider !== 'gitlab' &&
      repo.provider !== 'bitbucket'
    ) {
      return of(null);
    }
    if (!sourceBranch || !targetBranch) return of(null);
    if (sourceBranch === targetBranch) return of(null);

    const token = this.tokens.tokenFor(repo.provider);
    if (!token) return of(null);

    if (repo.provider === 'gitlab') {
      return this.findGitLabMr(repo, token, sourceBranch, targetBranch);
    }
    if (repo.provider === 'bitbucket') {
      return this.findBitbucketPr(repo, token, sourceBranch, targetBranch);
    }
    return this.findGitHubPr(repo, token, sourceBranch, targetBranch);
  }

  // ---------- GitLab ----------

  private findGitLabMr(
    repo: NormalizedRepo,
    token: string,
    source: string,
    target: string
  ): Observable<ExistingPr | null> {
    const headers = new HttpHeaders({ Authorization: `Bearer ${token}` });
    const url =
      `https://gitlab.com/api/v4/projects/${encodeURIComponent(repo.id)}/merge_requests` +
      `?source_branch=${encodeURIComponent(source)}` +
      `&target_branch=${encodeURIComponent(target)}` +
      `&state=all&per_page=20`;
    return this.http.get<GitLabMr[]>(url, { headers }).pipe(
      map((list) => this.pickGitLab(list)),
      catchError(() => of(null))
    );
  }

  private pickGitLab(list: GitLabMr[]): ExistingPr | null {
    if (!Array.isArray(list) || !list.length) return null;
    // GitLab returns most recent first by default. Pick by priority.
    const opened = list.find((m) => m.state === 'opened');
    if (opened) return this.toGitLab(opened, 'opened');
    const merged = list.find((m) => m.state === 'merged');
    if (merged) return this.toGitLab(merged, 'merged');
    const closed = list.find((m) => m.state === 'closed' || m.state === 'locked');
    if (closed) return this.toGitLab(closed, 'closed');
    return null;
  }

  private toGitLab(m: GitLabMr, state: ExistingPrState): ExistingPr {
    return {
      url: m.web_url,
      number: m.iid,
      state,
      provider: 'gitlab'
    };
  }

  // ---------- GitHub ----------

  private findGitHubPr(
    repo: NormalizedRepo,
    token: string,
    source: string,
    target: string
  ): Observable<ExistingPr | null> {
    const headers = new HttpHeaders({
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    });
    // GitHub's `head` filter requires `:owner:branch` form. The source
    // branch lives in the same repo (we created it ourselves on the
    // base), so the owner is the part of `fullName` before the slash.
    const owner = repo.fullName.split('/')[0];
    const head = `${owner}:${source}`;
    const url =
      `https://api.github.com/repos/${repo.fullName}/pulls` +
      `?head=${encodeURIComponent(head)}` +
      `&base=${encodeURIComponent(target)}` +
      `&state=all&per_page=20`;
    return this.http.get<GitHubPr[]>(url, { headers }).pipe(
      map((list) => this.pickGitHub(list)),
      catchError(() => of(null))
    );
  }

  private pickGitHub(list: GitHubPr[]): ExistingPr | null {
    if (!Array.isArray(list) || !list.length) return null;
    // GitHub returns most recent first when sort is left default. Pick
    // by priority: open > merged (closed + merged_at) > closed-without-merge.
    const open = list.find((p) => p.state === 'open');
    if (open) return this.toGitHub(open, 'opened');
    const merged = list.find((p) => p.state === 'closed' && !!p.merged_at);
    if (merged) return this.toGitHub(merged, 'merged');
    const closed = list.find((p) => p.state === 'closed');
    if (closed) return this.toGitHub(closed, 'closed');
    return null;
  }

  private toGitHub(p: GitHubPr, state: ExistingPrState): ExistingPr {
    return {
      url: p.html_url,
      number: p.number,
      state,
      provider: 'github'
    };
  }

  // ---------- Bitbucket ----------

  /**
   * Bitbucket's `/pullrequests` endpoint accepts a single value for the
   * `state` query param — to look across all relevant states we fan out
   * three parallel calls (OPEN / MERGED / DECLINED) and pick by priority.
   * SUPERSEDED is treated like DECLINED for our purposes (closed-without-
   * merge), so we don't query for it separately. The `q` filter syntax
   * is `q=field="value" AND field="value"` — Bitbucket-specific.
   */
  private findBitbucketPr(
    repo: NormalizedRepo,
    token: string,
    source: string,
    target: string
  ): Observable<ExistingPr | null> {
    const headers = new HttpHeaders({ Authorization: `Bearer ${token}` });
    const baseUrl = `https://api.bitbucket.org/2.0/repositories/${repo.fullName}/pullrequests`;
    const filter = `source.branch.name="${source}" AND destination.branch.name="${target}"`;

    const fetch = (state: 'OPEN' | 'MERGED' | 'DECLINED') =>
      this.http
        .get<BitbucketPrList>(
          `${baseUrl}?q=${encodeURIComponent(filter)}&state=${state}&pagelen=5`,
          { headers }
        )
        .pipe(catchError(() => of<BitbucketPrList>({ values: [] })));

    return forkJoin([fetch('OPEN'), fetch('MERGED'), fetch('DECLINED')]).pipe(
      map(([open, merged, declined]) => {
        if (open.values?.length) return this.toBitbucket(open.values[0], 'opened');
        if (merged.values?.length) return this.toBitbucket(merged.values[0], 'merged');
        if (declined.values?.length) return this.toBitbucket(declined.values[0], 'closed');
        return null;
      }),
      catchError(() => of(null))
    );
  }

  private toBitbucket(p: BitbucketPr, state: ExistingPrState): ExistingPr {
    return {
      url: p.links.html.href,
      number: p.id,
      state,
      provider: 'bitbucket'
    };
  }
}

// Wire-shape interfaces — kept private so callers only see ExistingPr.
interface GitLabMr {
  iid: number;
  web_url: string;
  state: 'opened' | 'closed' | 'merged' | 'locked';
}

interface GitHubPr {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  /** ISO timestamp when the PR was merged, or null. Closed-without-merge
      has `state: 'closed'` and `merged_at: null`. */
  merged_at: string | null;
}

interface BitbucketPrList {
  values?: BitbucketPr[];
}

interface BitbucketPr {
  id: number;
  links: { html: { href: string } };
}
