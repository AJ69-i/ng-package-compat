import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of, throwError } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import {
  CompatibilityReport,
  ParsedPackageJson,
  ReportEntry
} from '../models/npm-package.model';
import { ProviderTokenStore } from './provider-token-store.service';

/** Output of buildArtifacts — everything we need to construct a PR. */
export interface PrArtifacts {
  /** New `package.json` content with recommended versions applied. */
  patchedPackageJsonRaw: string;
  /** Unified diff (no `diff --git` header) — what changes between old/new. */
  unifiedDiff: string;
  /** Pre-formatted PR title. */
  title: string;
  /** Pre-formatted PR markdown body. */
  body: string;
  /** Suggested branch name. */
  branchName: string;
  /** Number of dependency lines bumped. */
  changedCount: number;
}

/** Request to actually create the PR through GitHub's API. */
export interface CreatePrRequest {
  /** `owner/repo`, e.g. `acme/widgets`. */
  fullName: string;
  /** Branch the PR will target (defaults to the repo's default branch). */
  baseBranch: string;
  /** Branch the PR will be created from. Suffixed with a timestamp for uniqueness. */
  headBranch: string;
  artifacts: PrArtifacts;
}

/**
 * Request to actually create the MR through GitLab's API. Different shape
 * from the GitHub one because GitLab routes API calls by numeric project
 * id, not `owner/repo` slug.
 */
export interface CreateMrRequest {
  /** GitLab project numeric id (e.g. `81492333`). */
  projectId: string;
  /** Used only for the user-facing toast / URL fallback. */
  fullName: string;
  /** Branch the MR will target (typically the repo's default branch). */
  baseBranch: string;
  /** Branch we'll create off the base. */
  headBranch: string;
  artifacts: PrArtifacts;
}

/**
 * Request to create a Pull Request through Bitbucket's API. Bitbucket
 * routes by `workspace/repo_slug` (same shape as GitHub's `owner/repo`)
 * so this mirrors `CreatePrRequest` deliberately — the differences are
 * all in the API endpoints, not the inputs.
 */
export interface CreateBbPrRequest {
  /** `workspace/repo_slug`, e.g. `aj769-workspace/acuanix-task`. */
  fullName: string;
  baseBranch: string;
  headBranch: string;
  artifacts: PrArtifacts;
}

export interface CreatePrResponse {
  url: string;
  number: number;
}

/**
 * Builds Pull-Request artifacts from a CompatibilityReport, and optionally
 * pushes them to a code host (today: GitHub) via the linked provider token.
 *
 * Why this is its own service: the "what to write into package.json" logic is
 * easy to get subtly wrong (devDependencies vs dependencies, version range
 * preservation), so isolating it lets it be tested and reused — both by the
 * UI button and a future CLI subcommand.
 */
@Injectable({ providedIn: 'root' })
export class PrGeneratorService {
  private readonly tokens = inject(ProviderTokenStore);
  private readonly http = inject(HttpClient);

  /**
   * Compute the patch — does NOT make any network calls.
   *
   * @param parsed   The user's parsed package.json.
   * @param report   The compatibility report (we use its recommendations).
   * @param raw      The user's *original* package.json text — required so the
   *                 diff is line-for-line accurate. If absent, we synthesize
   *                 one from `parsed`.
   */
  buildArtifacts(
    parsed: ParsedPackageJson,
    report: CompatibilityReport,
    raw: string | null
  ): PrArtifacts {
    // Determine which entries to actually change. Conflict + warning bumps
    // (i.e. anything with an installSpec) are the candidates.
    const bumps = report.entries.filter(
      (e) => e.installSpec && e.recommendedForTarget?.version
    );

    const original = raw && raw.trim().length ? raw : this.synthesize(parsed);

    let patched = original;
    let changed = 0;
    for (const e of bumps) {
      const next = e.recommendedForTarget!.version;
      const result = this.replaceVersion(patched, e.name, next, e.currentRange);
      if (result.changed) {
        patched = result.text;
        changed++;
      }
    }

    // Normalize trailing newline so the diff doesn't show a fake "no newline"
    // artifact when the user's file had one and ours doesn't.
    if (original.endsWith('\n') && !patched.endsWith('\n')) patched += '\n';

    const unifiedDiff = this.unifiedDiff(original, patched, 'package.json');
    const title = this.composeTitle(report);
    const body = this.composeBody(report, bumps);
    const branchName = this.composeBranchName(report);

    return {
      patchedPackageJsonRaw: patched,
      unifiedDiff,
      title,
      body,
      branchName,
      changedCount: changed
    };
  }

  /**
   * Push the artifacts to GitHub: create branch from base, write the file,
   * open the PR. Returns the PR URL.
   *
   * Today we only support GitHub. GitLab/BitBucket/Azure require provider-
   * specific endpoints; the abstraction lives in `provider-repo.service` and
   * we'd extend it the same way to support them — this service intentionally
   * keeps the GitHub path concrete so we ship something users can use now.
   */
  createGitHubPr(req: CreatePrRequest): Observable<CreatePrResponse> {
    // Prefer the server-side proxy when it's reachable: the user's PAT never
    // leaves the browser session, and the server is the only thing that
    // actually talks to GitHub. We probe `/api/pr/health` once per call; if
    // it answers `configured: true`, we POST to `/api/pr` and return that.
    const proxyAttempt$ = this.http
      .get<{ configured: boolean }>(`/api/pr/health`)
      .pipe(
        switchMap((health) => {
          if (!health?.configured) return throwError(() => new Error('proxy not configured'));
          return this.http.post<CreatePrResponse>('/api/pr', {
            fullName: req.fullName,
            baseBranch: req.baseBranch,
            headBranch: req.headBranch,
            title: req.artifacts.title,
            body: req.artifacts.body,
            commitMessage: req.artifacts.title,
            packageJsonBase64: btoa(
              unescape(encodeURIComponent(req.artifacts.patchedPackageJsonRaw))
            )
          });
        })
      );

    // Fall back to the original browser-side flow if the proxy isn't
    // configured (or not reachable, e.g. when running `ng serve` without
    // the SSR Express server in front of it).
    return proxyAttempt$.pipe(
      catchError(() => this.createGitHubPrDirect(req))
    );
  }

  /**
   * Original direct-from-browser implementation. Only used when the
   * server-side proxy isn't available; kept verbatim so existing flows
   * (ng serve dev mode, environments without the proxy) still work.
   */
  private createGitHubPrDirect(req: CreatePrRequest): Observable<CreatePrResponse> {
    const token = this.tokens.tokenFor('github');
    if (!token) {
      return throwError(() => new Error('No GitHub token available — sign in or paste a PAT.'));
    }
    const headers = {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    const repoUrl = `https://api.github.com/repos/${req.fullName}`;

    // 1. Get the head SHA of the base branch.
    return this.http
      .get<{ object: { sha: string } }>(`${repoUrl}/git/ref/heads/${encodeURIComponent(req.baseBranch)}`, {
        headers
      })
      .pipe(
        switchMap((ref) => {
          const baseSha = ref.object.sha;
          // 2. Create the branch (will 422 if it exists; we ignore that and
          //    continue — the user pressing the button twice shouldn't be fatal).
          return this.http
            .post(
              `${repoUrl}/git/refs`,
              { ref: `refs/heads/${req.headBranch}`, sha: baseSha },
              { headers }
            )
            .pipe(catchError(() => of(null)))
            .pipe(map(() => baseSha));
        }),
        switchMap(() => {
          // 3. Read the existing file SHA so PUT can replace it.
          return this.http
            .get<{ sha: string }>(
              `${repoUrl}/contents/package.json?ref=${encodeURIComponent(req.headBranch)}`,
              { headers }
            )
            .pipe(catchError(() => of({ sha: '' })));
        }),
        switchMap((file) => {
          // 4. PUT the new content on the branch.
          const content = btoa(unescape(encodeURIComponent(req.artifacts.patchedPackageJsonRaw)));
          const body: Record<string, unknown> = {
            message: req.artifacts.title,
            content,
            branch: req.headBranch
          };
          if (file.sha) body['sha'] = file.sha;
          return this.http.put(`${repoUrl}/contents/package.json`, body, { headers });
        }),
        switchMap(() => {
          // 5. Open the PR.
          return this.http.post<{ html_url: string; number: number }>(
            `${repoUrl}/pulls`,
            {
              title: req.artifacts.title,
              body: req.artifacts.body,
              head: req.headBranch,
              base: req.baseBranch
            },
            { headers }
          );
        }),
        map((pr) => ({ url: pr.html_url, number: pr.number }))
      );
  }

  /**
   * Push the artifacts to GitLab: create a branch off the base, commit the
   * patched `package.json`, then open the merge request. Returns the MR URL
   * on success.
   *
   * GitLab's API is route-by-numeric-project-id rather than `owner/repo`, so
   * `req.projectId` is the canonical identifier here. We get that for free
   * from `provider-repo.service` which stores `String(p.id)` as the
   * NormalizedRepo id for GitLab.
   *
   * Auth: OAuth tokens go on the standard `Authorization: Bearer` header;
   * GitLab also accepts `PRIVATE-TOKEN` for PATs but Bearer covers both
   * cases against gitlab.com so we keep the call sites identical.
   */
  createGitLabMr(req: CreateMrRequest): Observable<CreatePrResponse> {
    const token = this.tokens.tokenFor('gitlab');
    if (!token) {
      return throwError(() => new Error('No GitLab token available — sign in or paste a PAT.'));
    }
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    };
    const projectUrl = `https://gitlab.com/api/v4/projects/${encodeURIComponent(req.projectId)}`;

    // 1. Create the branch off `baseBranch`. If the branch already exists
    //    GitLab returns 400 with `Branch already exists`; we swallow that
    //    so a double-click doesn't crash the flow.
    const createBranch$ = this.http
      .post(
        `${projectUrl}/repository/branches?branch=${encodeURIComponent(req.headBranch)}&ref=${encodeURIComponent(req.baseBranch)}`,
        null,
        { headers }
      )
      .pipe(catchError(() => of(null)));

    return createBranch$.pipe(
      switchMap(() => {
        // 2. Commit the patched package.json. GitLab's commits endpoint
        //    takes an `actions` array — `update` for an existing file,
        //    `create` for a new one. package.json always exists in a real
        //    Angular repo, so we use `update`. If for some pathological
        //    case it doesn't, GitLab will return 400 and the catchError
        //    on the outer subscribe will surface it.
        const body = {
          branch: req.headBranch,
          commit_message: req.artifacts.title,
          actions: [
            {
              action: 'update',
              file_path: 'package.json',
              content: req.artifacts.patchedPackageJsonRaw
            }
          ]
        };
        return this.http.post(`${projectUrl}/repository/commits`, body, { headers });
      }),
      switchMap(() => {
        // 3. Open the merge request.
        return this.http.post<{ web_url: string; iid: number }>(
          `${projectUrl}/merge_requests`,
          {
            source_branch: req.headBranch,
            target_branch: req.baseBranch,
            title: req.artifacts.title,
            description: req.artifacts.body,
            remove_source_branch: true
          },
          { headers }
        );
      }),
      map((mr) => ({ url: mr.web_url, number: mr.iid }))
    );
  }

  /**
   * Push the artifacts to Bitbucket: create the head branch off base,
   * commit the patched package.json on it, then open the PR. Returns
   * the PR URL on success.
   *
   * Bitbucket routes API calls by `workspace/repo_slug`, mirroring
   * GitHub's `owner/repo`, so the request shape mirrors GitHub's
   * `CreatePrRequest`. The wire calls are different though:
   *   1. GET  /refs/branches/:base — get the base branch's commit SHA
   *   2. POST /refs/branches       — create the head branch off that SHA
   *   3. POST /src                 — commit the patched file (FormData!)
   *   4. POST /pullrequests        — open the PR
   *
   * The `/src` endpoint is the unusual one — Bitbucket takes a
   * multipart form with the file path as the field name and the file
   * content as the value, plus `branch` and `message` form fields. We
   * deliberately don't set Content-Type so the browser auto-sets it
   * with the correct boundary.
   */
  createBitbucketPr(req: CreateBbPrRequest): Observable<CreatePrResponse> {
    const token = this.tokens.tokenFor('bitbucket');
    if (!token) {
      return throwError(() => new Error('No Bitbucket token available — sign in or paste a PAT.'));
    }
    const auth = { Authorization: `Bearer ${token}` };
    const jsonHeaders = { ...auth, 'Content-Type': 'application/json' };
    const repoUrl = `https://api.bitbucket.org/2.0/repositories/${req.fullName}`;

    // 1. Get the base branch's commit SHA.
    return this.http
      .get<{ target: { hash: string } }>(
        `${repoUrl}/refs/branches/${encodeURIComponent(req.baseBranch)}`,
        { headers: auth }
      )
      .pipe(
        switchMap((branch) => {
          const baseSha = branch.target.hash;
          // 2. Create the head branch off the base SHA. Swallow errors
          //    (typically "branch already exists" from a previous click)
          //    so a re-click doesn't crash the flow — we just continue
          //    to the commit step on whatever's there.
          return this.http
            .post(
              `${repoUrl}/refs/branches`,
              { name: req.headBranch, target: { hash: baseSha } },
              { headers: jsonHeaders }
            )
            .pipe(catchError(() => of(null)))
            .pipe(map(() => baseSha));
        }),
        switchMap(() => {
          // 3. Commit the patched package.json onto the head branch.
          //    Bitbucket's /src endpoint takes multipart/form-data:
          //      - file path as field name → file content as value
          //      - `branch` and `message` as separate form fields
          //    We omit the Content-Type header so the browser sets it
          //    with the correct multipart boundary.
          const form = new FormData();
          form.append('branch', req.headBranch);
          form.append('message', req.artifacts.title);
          form.append(
            'package.json',
            new Blob([req.artifacts.patchedPackageJsonRaw], {
              type: 'application/json'
            })
          );
          return this.http.post(`${repoUrl}/src`, form, { headers: auth });
        }),
        switchMap(() => {
          // 4. Open the PR. `close_source_branch: true` so the chore/...
          //    branch is auto-cleaned when the PR merges — same UX as
          //    the GitLab `remove_source_branch: true` we set there.
          return this.http.post<{ id: number; links: { html: { href: string } } }>(
            `${repoUrl}/pullrequests`,
            {
              title: req.artifacts.title,
              description: req.artifacts.body,
              source: { branch: { name: req.headBranch } },
              destination: { branch: { name: req.baseBranch } },
              close_source_branch: true
            },
            { headers: jsonHeaders }
          );
        }),
        map((pr) => ({ url: pr.links.html.href, number: pr.id }))
      );
  }

  // ---------- Composition helpers ----------

  private composeTitle(report: CompatibilityReport): string {
    if (report.mode === 'upgrade') {
      return `chore(angular): upgrade to Angular ${report.targetAngularMajor}`;
    }
    return `chore(deps): refresh dependency versions for Angular ${report.targetAngularMajor}`;
  }

  private composeBranchName(report: CompatibilityReport): string {
    const stamp = new Date().toISOString().slice(0, 10);
    return `chore/ng${report.targetAngularMajor}-deps-${stamp}`;
  }

  private composeBody(report: CompatibilityReport, bumps: ReportEntry[]): string {
    const lines: string[] = [];
    lines.push(`### Summary`);
    lines.push('');
    if (report.mode === 'upgrade') {
      lines.push(
        `This PR is an automated dependency refresh produced by ng-package-compat to make this project compatible with Angular ${report.targetAngularMajor}.`
      );
    } else {
      lines.push(
        `This PR refreshes dependencies that have newer recommended releases for Angular ${report.targetAngularMajor}.`
      );
    }
    lines.push('');
    lines.push(
      `**Health score:** ${report.health.score} (${report.health.grade}) · **Effort estimate:** ${report.estimate.summary}`
    );
    lines.push('');

    if (report.ngUpdateCommand) {
      lines.push(`### Run \`ng update\` first`);
      lines.push('');
      lines.push('```bash');
      lines.push(report.ngUpdateCommand);
      lines.push('```');
      lines.push('');
    }

    lines.push(`### Bumps (${bumps.length})`);
    lines.push('');
    if (bumps.length === 0) {
      lines.push('_No version changes needed — everything is already compatible._');
    } else {
      lines.push('| Package | From | → | To | Status |');
      lines.push('| --- | --- | --- | --- | --- |');
      for (const b of bumps) {
        lines.push(
          `| \`${b.name}\` | ${b.currentVersion ?? '—'} | → | ${b.recommendedForTarget!.version} | ${b.status} |`
        );
      }
    }
    lines.push('');

    const breaking = bumps.filter((b) => (b.breakingChanges?.length ?? 0) > 0);
    if (breaking.length) {
      lines.push(`### Breaking changes to review`);
      lines.push('');
      for (const b of breaking) {
        lines.push(`- **${b.name}** — ${b.breakingChanges!.length} item(s)`);
        for (const bc of b.breakingChanges!) {
          lines.push(`  - ${bc.title}`);
        }
      }
      lines.push('');
    }

    const deprecated = bumps.filter((b) => !!b.deprecation);
    if (deprecated.length) {
      lines.push(`### Deprecated dependencies`);
      lines.push('');
      for (const b of deprecated) {
        const alt = b.deprecation?.alternatives?.[0]?.name;
        const reason = b.deprecation?.reason;
        const note = alt
          ? `replace with \`${alt}\``
          : reason
            ? reason
            : 'no drop-in replacement';
        lines.push(`- \`${b.name}\` — ${note}`);
      }
      lines.push('');
    }

    if (report.rollbackCommand) {
      lines.push(`### If something breaks`);
      lines.push('');
      lines.push('Roll back with:');
      lines.push('```bash');
      lines.push(report.rollbackCommand);
      lines.push('```');
      lines.push('');
    }

    lines.push('---');
    lines.push('');
    lines.push(`Generated by [ng-package-compat](https://github.com/ng-package-compat) — review carefully before merging.`);
    return lines.join('\n');
  }

  // ---------- Patching helpers ----------

  /**
   * Replace the version of `name` inside the JSON text. We preserve the
   * original range prefix (`^`, `~`, `>=` etc.) so we don't accidentally
   * narrow a permissive range into a pin.
   */
  private replaceVersion(
    text: string,
    name: string,
    nextVersion: string,
    originalRange: string | null
  ): { text: string; changed: boolean } {
    const prefix = this.detectRangePrefix(originalRange);
    // Match `"name": "<anything>"` allowing arbitrary whitespace around `:`.
    // Escape regex specials inside the package name (mostly the `/`).
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`("${escaped}"\\s*:\\s*")([^"]+)(")`, 'g');
    let changed = false;
    const out = text.replace(re, (match, p1, _p2, p3) => {
      changed = true;
      return `${p1}${prefix}${nextVersion}${p3}`;
    });
    return { text: out, changed };
  }

  private detectRangePrefix(range: string | null): string {
    if (!range) return '^';
    const t = range.trim();
    if (t.startsWith('^')) return '^';
    if (t.startsWith('~')) return '~';
    if (t.startsWith('>=')) return '>=';
    if (t.startsWith('>')) return '>';
    // exact pin — preserve
    return '';
  }

  private synthesize(parsed: ParsedPackageJson): string {
    // Last-resort fallback: synthesize a plausible package.json from the parsed
    // form. We won't always have a perfectly faithful diff, but it's better
    // than nothing.
    const deps: Record<string, string> = {};
    const devDeps: Record<string, string> = {};
    for (const d of parsed.deps) {
      const target = d.section === 'devDependencies' ? devDeps : deps;
      target[d.name] = d.range ?? '*';
    }
    return JSON.stringify(
      {
        name: parsed.name ?? 'project',
        version: parsed.version ?? '0.0.0',
        dependencies: deps,
        devDependencies: devDeps
      },
      null,
      2
    ) + '\n';
  }

  /**
   * Tiny unified-diff producer. Not as compact as `diff` libraries, but doesn't
   * pull in a 30 KB dependency just for a UI preview.
   */
  private unifiedDiff(a: string, b: string, name: string): string {
    if (a === b) return '';
    const al = a.split('\n');
    const bl = b.split('\n');
    const lines: string[] = [];
    lines.push(`--- a/${name}`);
    lines.push(`+++ b/${name}`);
    // We use a simple line-by-line LCS-free approach: emit @@ chunks per
    // contiguous run of changes. Good enough for package.json (where the
    // changes are small + line-aligned).
    const maxLen = Math.max(al.length, bl.length);
    let i = 0;
    while (i < maxLen) {
      // Find the next divergence.
      let j = i;
      while (j < maxLen && al[j] === bl[j]) j++;
      if (j >= maxLen) break;
      // Find the end of the divergent region (re-converge).
      let endA = j, endB = j;
      // Greedy advance both pointers until N consecutive equal lines reached.
      const CONTEXT = 3;
      while (endA < al.length || endB < bl.length) {
        // Cheap re-converge check
        let same = 0;
        while (
          same < CONTEXT &&
          endA + same < al.length &&
          endB + same < bl.length &&
          al[endA + same] === bl[endB + same]
        ) {
          same++;
        }
        if (same === CONTEXT) break;
        if (endA < al.length) endA++;
        if (endB < bl.length) endB++;
      }
      const ctxStart = Math.max(0, j - CONTEXT);
      const aHunk = al.slice(ctxStart, endA);
      const bHunk = bl.slice(ctxStart, endB);
      lines.push(`@@ -${ctxStart + 1},${aHunk.length} +${ctxStart + 1},${bHunk.length} @@`);
      // Emit context (start), then deletions, then additions, then trailing context.
      for (let k = ctxStart; k < j; k++) lines.push(' ' + al[k]);
      for (let k = j; k < endA; k++) lines.push('-' + al[k]);
      for (let k = j; k < endB; k++) lines.push('+' + bl[k]);
      // Trailing context (whatever follows in both — emit from `a` as canonical).
      i = Math.max(endA, endB);
    }
    return lines.join('\n');
  }
}
