import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, forkJoin, from, of, throwError } from 'rxjs';
import { catchError, map, mergeMap, toArray } from 'rxjs/operators';
import { AuthProvider } from './auth.service';
import { BitbucketWorkspacesService } from './bitbucket-workspaces.service';

/**
 * Auth-style errors (401/403) mean "your token is wrong / expired / for the
 * wrong provider", which is a user-actionable condition — not a generic
 * network failure. We surface those upward so the projects page can render a
 * real message instead of an empty list. Anything else (network glitch, 5xx)
 * is still swallowed to an empty array because retrying is the user's call.
 *
 * Without this, the classic failure mode is invisible: a stale token under
 * the wrong provider key returns "Bad credentials" → swallowed → user sees
 * an empty page with no diagnostic.
 */
function rethrowAuthErrors<T>(fallback: T) {
  return (err: unknown): Observable<T> => {
    const status = (err as { status?: number })?.status;
    if (status === 401 || status === 403) {
      return throwError(() => ({
        kind: 'AUTH_INVALID',
        status,
        provider: '' as AuthProvider | '',
        message: status === 401
          ? 'The provider rejected your access token. Sign out and sign back in to refresh.'
          : 'Your token does not have permission to list repositories. Sign out, sign back in, and approve every requested scope.'
      }));
    }
    return of(fallback);
  };
}

/**
 * A repository, normalized across providers. Every `ProviderRepoClient` flattens
 * its provider-specific shape into this so the rest of the app doesn't care
 * whether a project came from GitHub, GitLab, BitBucket, or Azure DevOps.
 */
export interface NormalizedRepo {
  /** Provider that owns this repo. */
  provider: AuthProvider;
  /** Slug used to fetch package.json (varies by provider). */
  id: string;
  /** Display name, e.g. `acme/admin-portal`. */
  fullName: string;
  /** Primary HTTPS URL the user can click to. */
  webUrl: string;
  /** Default branch — used as the ref when we fetch package.json. */
  defaultBranch: string;
  /** Inferred `private` flag for the UI. */
  isPrivate: boolean;
}

/**
 * The contract every code host implements. We keep it small on purpose: list
 * repos, fetch a single `package.json`, and detect Angular by reading deps.
 */
export interface ProviderRepoClient {
  readonly provider: AuthProvider;
  /** List repos the authenticated user can read. */
  listRepos(token: string): Observable<NormalizedRepo[]>;
  /** Fetch the raw `package.json` content from the repo's default branch. */
  fetchPackageJson(token: string, repo: NormalizedRepo): Observable<string | null>;
}

/**
 * Pulls a token from a Supabase session. Supabase exposes the OAuth provider
 * token as `session.provider_token` after sign-in (when the provider is
 * configured to "Save provider tokens"). The token is volatile — it doesn't
 * survive a page reload by default — so callers should grab it eagerly.
 */
export function tokenFromSession(session: { provider_token?: string | null } | null | undefined): string | null {
  return session?.provider_token ?? null;
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

@Injectable({ providedIn: 'root' })
export class GithubRepoService implements ProviderRepoClient {
  readonly provider: AuthProvider = 'github';
  private readonly http = inject(HttpClient);

  listRepos(token: string): Observable<NormalizedRepo[]> {
    const headers = new HttpHeaders({
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    });
    // 100/page is GitHub's max. We page through up to 5 times for users with
    // many repos (500 cap is sane for an interactive list).
    const fetchPage = (page: number) =>
      this.http.get<GithubRepo[]>(
        `https://api.github.com/user/repos?per_page=100&sort=pushed&page=${page}`,
        { headers }
      );
    return fetchPage(1).pipe(
      mergeMap((first) => {
        if (first.length < 100) return of(first);
        // Best-effort: fetch a few more pages.
        return forkJoin([2, 3, 4, 5].map((p) => fetchPage(p).pipe(catchError(() => of([] as GithubRepo[]))))).pipe(
          map((rest) => [first, ...rest].flat())
        );
      }),
      map((repos) =>
        repos.map<NormalizedRepo>((r) => ({
          provider: 'github',
          id: r.full_name,
          fullName: r.full_name,
          webUrl: r.html_url,
          defaultBranch: r.default_branch || 'main',
          isPrivate: r.private
        }))
      ),
      catchError(rethrowAuthErrors<NormalizedRepo[]>([]))
    );
  }

  fetchPackageJson(token: string, repo: NormalizedRepo): Observable<string | null> {
    const headers = new HttpHeaders({
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.raw'
    });
    const url = `https://api.github.com/repos/${repo.id}/contents/package.json?ref=${encodeURIComponent(repo.defaultBranch)}`;
    return this.http.get(url, { headers, responseType: 'text' }).pipe(
      catchError(() => of(null))
    );
  }
}

interface GithubRepo {
  full_name: string;
  html_url: string;
  default_branch: string;
  private: boolean;
}

// ---------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------

@Injectable({ providedIn: 'root' })
export class GitlabRepoService implements ProviderRepoClient {
  readonly provider: AuthProvider = 'gitlab';
  private readonly http = inject(HttpClient);

  listRepos(token: string): Observable<NormalizedRepo[]> {
    const headers = new HttpHeaders({ Authorization: `Bearer ${token}` });
    return this.http
      .get<GitlabProject[]>(
        'https://gitlab.com/api/v4/projects?membership=true&per_page=100&order_by=last_activity_at',
        { headers }
      )
      .pipe(
        map((projects) =>
          projects.map<NormalizedRepo>((p) => ({
            provider: 'gitlab',
            id: String(p.id),
            fullName: p.path_with_namespace,
            webUrl: p.web_url,
            defaultBranch: p.default_branch || 'main',
            isPrivate: p.visibility !== 'public'
          }))
        ),
        catchError(rethrowAuthErrors<NormalizedRepo[]>([]))
      );
  }

  fetchPackageJson(token: string, repo: NormalizedRepo): Observable<string | null> {
    const headers = new HttpHeaders({ Authorization: `Bearer ${token}` });
    // GitLab's "raw file" endpoint takes the file path URL-encoded.
    const url = `https://gitlab.com/api/v4/projects/${repo.id}/repository/files/${encodeURIComponent('package.json')}/raw?ref=${encodeURIComponent(repo.defaultBranch)}`;
    return this.http.get(url, { headers, responseType: 'text' }).pipe(
      catchError(() => of(null))
    );
  }
}

interface GitlabProject {
  id: number;
  path_with_namespace: string;
  web_url: string;
  default_branch: string;
  visibility: string;
}

// ---------------------------------------------------------------------------
// BitBucket
// ---------------------------------------------------------------------------

/**
 * Bitbucket repo discovery is fiddly because the same account can be
 * reached via two very different OAuth consumer types:
 *
 *   - **Account-level consumers** (Bitbucket Settings → OAuth consumers).
 *     Tokens issued through these reliably populate `/2.0/workspaces` and
 *     show up in https://bitbucket.org/account/settings/app-authorizations/.
 *
 *   - **Workspace-level consumers** (Workspace settings → OAuth consumers).
 *     Tokens issued through these are scoped to the workspace and DO NOT
 *     appear in the user-account App Authorizations page. They also
 *     occasionally return an empty `/2.0/workspaces` response, even for
 *     the workspace's own owner.
 *
 * Supabase OAuth integrations typically register a workspace-level
 * consumer (because that's where Bitbucket's UI funnels you), so the
 * empty-`/2.0/workspaces` case is a real edge case in production —
 * `aj769-workspace` is one such account.
 *
 * Defense-in-depth: we run TWO listing endpoints in parallel and merge
 * the results, deduped by `full_name`:
 *
 *   1. Workspace-traversal — `/2.0/workspaces` → `/2.0/repositories/{slug}`.
 *      Wins when workspaces are visible to the token.
 *   2. Cross-workspace `?role=member` — `/2.0/repositories?role=member`.
 *      Wins when workspaces are filtered out but the user still has
 *      direct read access to specific repos.
 *
 * Either path being empty no longer leaves the user staring at "No
 * projects yet"; only both paths returning empty produces an empty list.
 * Auth errors (401/403) propagate via `rethrowAuthErrors` so the user
 * sees a real "your token is wrong" message rather than a misleading
 * empty state.
 */
@Injectable({ providedIn: 'root' })
export class BitbucketRepoService implements ProviderRepoClient {
  readonly provider: AuthProvider = 'bitbucket';
  private readonly http = inject(HttpClient);
  private readonly workspaceStore = inject(BitbucketWorkspacesService);

  listRepos(token: string): Observable<NormalizedRepo[]> {
    const headers = new HttpHeaders({ Authorization: `Bearer ${token}` });
    const configured = this.workspaceStore.workspaces();

    // Preferred path: hit the workspace-scoped `/2.0/repositories/{slug}`
    // endpoint for each workspace the user has configured. This is the
    // ONLY listing endpoint that survived Atlassian's CHANGE-2770
    // deprecation (https://developer.atlassian.com/cloud/bitbucket/changelog#CHANGE-2770)
    // — both `/2.0/workspaces` and `/2.0/repositories?role=member` now
    // return HTTP 410 Gone for OAuth-token-driven flows.
    if (configured.length > 0) {
      return forkJoin(
        configured.map((slug) => this.listInWorkspace(headers, slug))
      ).pipe(
        map((nested) => this.mergeAndSort(nested.flat()))
      );
    }

    // Legacy fallback: when the user hasn't configured any workspaces
    // yet, take a hopeful pass at the deprecated cross-workspace
    // endpoints. We don't expect these to return anything post-CHANGE-2770,
    // but they're cheap, and if Atlassian ever reverses the deprecation
    // (or someone is running against a non-Atlassian Bitbucket fork)
    // the user shouldn't be forced into the manual workspace input
    // unnecessarily. Both swallow 410 to empty.
    return forkJoin([
      this.listViaWorkspaces(headers),
      this.listViaRoleFilter(headers)
    ]).pipe(
      map(([fromWorkspaces, fromRole]) =>
        this.mergeAndSort([...fromWorkspaces, ...fromRole])
      )
    );
  }

  /**
   * Workspace-scoped listing — the post-CHANGE-2770 reliable path.
   * Lists every repo in `{workspace}` the token can read, regardless
   * of how the OAuth consumer is registered.
   */
  private listInWorkspace(
    headers: HttpHeaders,
    workspace: string
  ): Observable<NormalizedRepo[]> {
    return this.http
      .get<BitbucketRepoListResponse>(
        `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(workspace)}?pagelen=100&sort=-updated_on`,
        { headers }
      )
      .pipe(
        map((res) => this.toNormalizedBatch(res.values || [])),
        catchError((err) => this.maybeRethrowAuth(err))
      );
  }

  private mergeAndSort(repos: NormalizedRepo[]): NormalizedRepo[] {
    const merged = new Map<string, NormalizedRepo>();
    for (const r of repos) {
      if (!merged.has(r.fullName)) merged.set(r.fullName, r);
    }
    return Array.from(merged.values()).sort((a, b) =>
      a.fullName.localeCompare(b.fullName)
    );
  }

  /**
   * Path 1: workspace-traversal. Lists workspaces, then repos per
   * workspace. The "main" path for account-level OAuth tokens.
   *
   * Auth errors (401/403) bubble — they mean the token is invalid or
   * lacks `account` scope, both user-actionable. Other errors swallow
   * to empty so they don't block the parallel role-filter path.
   */
  private listViaWorkspaces(headers: HttpHeaders): Observable<NormalizedRepo[]> {
    return this.http
      .get<BbWorkspaceListResponse>(
        'https://api.bitbucket.org/2.0/workspaces?pagelen=100',
        { headers }
      )
      .pipe(
        mergeMap((wsResp) => {
          const slugs = (wsResp.values || []).map((w) => w.slug);
          if (!slugs.length) return of<NormalizedRepo[]>([]);
          return forkJoin(
            slugs.slice(0, 5).map((slug) =>
              this.http
                .get<BitbucketRepoListResponse>(
                  `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(slug)}?pagelen=100&sort=-updated_on`,
                  { headers }
                )
                .pipe(
                  map((res) => this.toNormalizedBatch(res.values || [])),
                  catchError(() => of<NormalizedRepo[]>([]))
                )
            )
          ).pipe(map((nested) => nested.flat()));
        }),
        catchError((err) => this.maybeRethrowAuth(err))
      );
  }

  /**
   * Path 2: cross-workspace listing via `?role=member`. Lists every repo
   * the token can read regardless of workspace. The fallback path for
   * workspace-scoped tokens that don't see `/2.0/workspaces`.
   *
   * Same auth-error semantics as path 1 — 401/403 bubble so the user
   * sees a real error instead of a misleading empty state.
   */
  private listViaRoleFilter(headers: HttpHeaders): Observable<NormalizedRepo[]> {
    return this.http
      .get<BitbucketRepoListResponse>(
        'https://api.bitbucket.org/2.0/repositories?role=member&pagelen=100&sort=-updated_on',
        { headers }
      )
      .pipe(
        map((res) => this.toNormalizedBatch(res.values || [])),
        catchError((err) => this.maybeRethrowAuth(err))
      );
  }

  /**
   * Per-path error guard. 401/403 bubble through `rethrowAuthErrors`
   * (typed AUTH_INVALID error the projects page can render); 410 Gone
   * is the CHANGE-2770 deprecation signal — silent, since the user
   * can't fix that by re-authing — they need to add a workspace slug
   * via the projects-page UI. Everything else (network, 5xx, etc.) is
   * swallowed to an empty array so this path doesn't block the
   * parallel one in `forkJoin`.
   */
  private maybeRethrowAuth(err: unknown): Observable<NormalizedRepo[]> {
    const status = (err as { status?: number })?.status;
    if (status === 401 || status === 403) {
      return rethrowAuthErrors<NormalizedRepo[]>([])(err);
    }
    return of<NormalizedRepo[]>([]);
  }

  private toNormalizedBatch(
    raw: BitbucketRepo[]
  ): NormalizedRepo[] {
    return raw.map<NormalizedRepo>((r) => ({
      provider: 'bitbucket',
      id: r.full_name,
      fullName: r.full_name,
      webUrl: r.links?.html?.href ?? `https://bitbucket.org/${r.full_name}`,
      defaultBranch: r.mainbranch?.name ?? 'main',
      isPrivate: r.is_private
    }));
  }

  fetchPackageJson(token: string, repo: NormalizedRepo): Observable<string | null> {
    const headers = new HttpHeaders({ Authorization: `Bearer ${token}` });
    const url = `https://api.bitbucket.org/2.0/repositories/${repo.id}/src/${encodeURIComponent(repo.defaultBranch)}/package.json`;
    return this.http.get(url, { headers, responseType: 'text' }).pipe(
      catchError(() => of(null))
    );
  }
}

interface BitbucketRepo {
  full_name: string;
  is_private: boolean;
  mainbranch?: { name: string };
  links?: { html?: { href: string } };
}

interface BitbucketRepoListResponse {
  values?: BitbucketRepo[];
}

interface BbWorkspaceListResponse {
  values?: Array<{ slug: string }>;
}

// ---------------------------------------------------------------------------
// Azure DevOps
// ---------------------------------------------------------------------------

/**
 * Azure DevOps is special: there's no single "list all my repos across orgs"
 * endpoint. We need to (a) list the user's organizations, (b) list each org's
 * projects, then (c) list each project's repos. This service starts at step
 * (a) and walks down. Because that can be expensive, we cap each level.
 */
@Injectable({ providedIn: 'root' })
export class AzureRepoService implements ProviderRepoClient {
  readonly provider: AuthProvider = 'azure';
  private readonly http = inject(HttpClient);

  listRepos(token: string): Observable<NormalizedRepo[]> {
    const headers = new HttpHeaders({ Authorization: `Bearer ${token}` });
    // Step 1: get the user's profile so we know the memberId.
    return this.http
      .get<AzureProfile>('https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.0', {
        headers
      })
      .pipe(
        mergeMap((profile) =>
          // Step 2: list organizations.
          this.http.get<AzureAccountList>(
            `https://app.vssps.visualstudio.com/_apis/accounts?memberId=${profile.id}&api-version=7.0`,
            { headers }
          )
        ),
        mergeMap((accounts) =>
          forkJoin(
            (accounts.value || []).slice(0, 5).map((a) =>
              // Step 3: list repos in this org.
              this.http
                .get<AzureRepoList>(
                  `https://dev.azure.com/${a.accountName}/_apis/git/repositories?api-version=7.0`,
                  { headers }
                )
                .pipe(
                  map((res) =>
                    (res.value || []).map<NormalizedRepo>((r) => ({
                      provider: 'azure',
                      id: `${a.accountName}/${r.project?.name ?? ''}/${r.id}`,
                      fullName: `${a.accountName}/${r.project?.name ?? ''}/${r.name}`,
                      webUrl: r.webUrl,
                      defaultBranch: (r.defaultBranch || 'refs/heads/main').replace('refs/heads/', ''),
                      isPrivate: true
                    }))
                  ),
                  catchError(() => of<NormalizedRepo[]>([]))
                )
            )
          ).pipe(map((nested) => nested.flat()))
        ),
        catchError(() => of<NormalizedRepo[]>([]))
      );
  }

  fetchPackageJson(token: string, repo: NormalizedRepo): Observable<string | null> {
    const headers = new HttpHeaders({ Authorization: `Bearer ${token}` });
    // Azure repo `id` shape: org/project/repoId
    const [org, _project, repoId] = repo.id.split('/');
    const url =
      `https://dev.azure.com/${org}/_apis/git/repositories/${repoId}/items` +
      `?path=${encodeURIComponent('/package.json')}` +
      `&versionDescriptor.version=${encodeURIComponent(repo.defaultBranch)}` +
      `&includeContent=true&api-version=7.0`;
    return this.http.get(url, { headers, responseType: 'text' }).pipe(
      // Azure returns JSON wrapping the file content, but with `includeContent=true`
      // and `Accept: text/plain`, it returns raw bytes. We try the raw path; if the
      // response looks like a JSON envelope, we extract `.content`.
      map((body) => {
        try {
          const parsed = JSON.parse(body) as { content?: string };
          if (parsed && typeof parsed.content === 'string') return parsed.content;
        } catch {
          /* not JSON wrapping — that's fine, the body IS the file. */
        }
        return body;
      }),
      catchError(() => of(null))
    );
  }
}

interface AzureProfile { id: string; }
interface AzureAccountList { value?: Array<{ accountName: string }>; }
interface AzureRepoList {
  value?: Array<{
    id: string;
    name: string;
    webUrl: string;
    defaultBranch?: string;
    project?: { name: string };
  }>;
}

// ---------------------------------------------------------------------------
// Multi-provider orchestrator
// ---------------------------------------------------------------------------

/**
 * Convenience facade — given a provider name, hand back the right client.
 * Avoids every caller hard-coding `switch` statements on the provider.
 */
@Injectable({ providedIn: 'root' })
export class ProviderRepoRegistry {
  private readonly clients: Record<AuthProvider, ProviderRepoClient | null> = {
    github: inject(GithubRepoService),
    gitlab: inject(GitlabRepoService),
    bitbucket: inject(BitbucketRepoService),
    azure: inject(AzureRepoService)
  };

  for(provider: AuthProvider): ProviderRepoClient | null {
    return this.clients[provider];
  }

  /** All providers we can actually fetch projects from. */
  fetchableProviders(): AuthProvider[] {
    return (Object.keys(this.clients) as AuthProvider[]).filter(
      (p) => this.clients[p] !== null
    );
  }

  /**
   * Cross-provider repo listing. Hands each provider its own token and
   * concatenates the results. Failed providers contribute an empty list
   * rather than failing the whole batch.
   */
  listAllRepos(
    bindings: Array<{ provider: AuthProvider; token: string }>
  ): Observable<NormalizedRepo[]> {
    if (!bindings.length) return of([]);
    return from(bindings).pipe(
      mergeMap((b) => {
        const client = this.for(b.provider);
        if (!client) return of<NormalizedRepo[]>([]);
        return client.listRepos(b.token).pipe(catchError(() => of<NormalizedRepo[]>([])));
      }),
      toArray(),
      map((nested) => nested.flat())
    );
  }
}
