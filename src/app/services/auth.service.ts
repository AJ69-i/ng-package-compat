import { Injectable, inject } from '@angular/core';
import { Provider } from '@supabase/supabase-js';
import { SupabaseService } from './supabase.service';

/**
 * The four code-host providers we support, in canonical Supabase form.
 *
 * Sign-in is intentionally direct-OAuth-only: the user picks a code host,
 * we land them on `/projects` with their repos enumerated. No identity-hub
 * abstraction; no LinkedIn workspace; no Gmail-Firebase fork. Cross-host
 * aggregation is out of scope on purpose — most users only need one host.
 */
export type AuthProvider =
  | 'github'
  | 'gitlab'
  | 'bitbucket'
  | 'azure';

/**
 * Display metadata for the sign-in page. The OAuth `scopes` we request are the
 * minimum required to (a) authenticate and (b) list the user's repos / projects
 * so we can fetch package.json files later.
 *
 * Azure note: we deliberately stick to Microsoft Graph scopes here
 * (`openid email profile User.Read offline_access`). Azure DevOps uses a
 * separate API (`vso.code`) that requires a *separate* API permission on
 * the Azure AD app registration AND that the user has an Azure DevOps
 * Services tenant — neither of which holds for personal Microsoft accounts.
 * Adding `vso.code` to the default scope list breaks sign-in for everyone
 * who doesn't already have an Azure DevOps subscription, which is most
 * users. We therefore request Azure DevOps scopes incrementally only when
 * the user actually opts into Azure DevOps repo scanning, via
 * `requestDevOpsScopes()` below.
 */
export const PROVIDER_META: Record<AuthProvider, {
  label: string;
  scopes: string;
  /** Whether this provider can directly enumerate Angular projects. */
  canFetchProjects: boolean;
  /**
   * True for providers where we ship code we haven't validated against
   * a real account. Consuming UIs read this flag to render an
   * "Experimental" badge + tooltip, and the project list uses it to
   * customise the empty-state copy. One source of truth — flipping
   * this here updates every UI surface that depends on it.
   *
   * Why per-provider rather than a global "experimental providers"
   * list: keeps the metadata co-located with all the other per-
   * provider config (scopes, label, capabilities). When we eventually
   * test Azure against a real org, we just flip this to false here
   * and every badge disappears automatically.
   */
  experimental: boolean;
}> = {
  github: { label: 'GitHub', scopes: 'read:user repo', canFetchProjects: true, experimental: false },
  // GitLab: we deliberately request the broad `api` scope (rather than the
  // narrower `read_api read_repository` combo we used before) because the
  // MR-creation flow needs to (a) push a new branch, (b) commit a patched
  // package.json onto it, and (c) open the merge request itself — all of
  // which are write operations that read-only scopes 403 on. `api` is
  // GitLab's umbrella scope covering full read+write through their REST
  // and GraphQL APIs and is what their own UI uses for OAuth apps that
  // integrate write actions. `read_user` is kept explicit so identity and
  // avatar fetches keep working even if the user has constrained their
  // token through some org-level policy.
  gitlab: { label: 'GitLab', scopes: 'api read_user', canFetchProjects: true, experimental: false },
  // Bitbucket: same write-capability story as GitLab — the read-only
  // scope set (`account repository`) lets us list repos and read
  // package.json, but creating a PR needs `repository:write` (push
  // branches, commit files) and `pullrequest:write` (open the PR
  // itself). `pullrequest` (read) is required by the existing-PR
  // lookup we do before showing the create button. `account` keeps
  // identity / avatar fetches working.
  bitbucket: {
    label: 'BitBucket',
    scopes: 'account repository repository:write pullrequest pullrequest:write',
    canFetchProjects: true,
    experimental: false
  },
  azure: {
    label: 'Microsoft Azure',
    // Microsoft Graph scopes only — match what the Azure AD app registration
    // grants under "API permissions → Microsoft Graph". `offline_access`
    // gets us refresh tokens so the session survives across reloads.
    scopes: 'openid email profile User.Read offline_access',
    // Repo enumeration on Azure requires the separate `vso.code` scope which
    // we ask for on demand, not at first sign-in.
    canFetchProjects: false,
    // Marked experimental: we ship the sign-in flow plus the
    // AzureRepoService that walks orgs → projects → repos, but we
    // haven't been able to test against a real Azure DevOps tenant
    // (creating an org currently requires verified payment info).
    // The adapter shares its overall shape with the GitHub/GitLab
    // ones we DO test, so most cases should work — but until we have
    // ground-truth verification, users see an "Experimental" badge.
    // Flip this to false the moment Azure gets validated.
    experimental: true
  }
};

/**
 * sessionStorage key used to remember which provider the user clicked on
 * the sign-in page. Read from `auth-callback` to know exactly which key
 * the just-issued OAuth token belongs under — independent of whatever
 * Supabase reports about identity timestamps.
 */
const PENDING_PROVIDER_KEY = 'ngpc.pending-auth-provider';

/**
 * Read + consume the pending-provider record. Returns the provider the user
 * just chose to sign in with, or `null` if nothing was set (e.g. they
 * arrived at /auth/callback by some other path). Removes the key so a stale
 * value can't bleed into a future sign-in.
 */
export function consumePendingProvider(): AuthProvider | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(PENDING_PROVIDER_KEY);
    sessionStorage.removeItem(PENDING_PROVIDER_KEY);
    if (!raw) return null;
    if (raw === 'github' || raw === 'gitlab' || raw === 'bitbucket' || raw === 'azure') {
      return raw;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * High-level auth orchestration: sign-in, sign-out, and identity linking.
 *
 * "Direct provider" sign-in (GitHub/GitLab/BitBucket/Azure) goes straight to
 * the project-fetching workflow because we have a usable provider token.
 *
 * LinkedIn sign-in is the "workspace" model: the user lands in their workspace
 * and links additional providers via `linkProvider()` (Supabase identity linking),
 * which keeps everything tied to the original LinkedIn account.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly supabase = inject(SupabaseService);

  /**
   * Kick off OAuth sign-in. Redirects to the provider, then comes back to
   * `redirectTo` (defaults to the post-auth router callback).
   *
   * Bulletproof provider tracking: we stash the chosen provider in
   * sessionStorage BEFORE the redirect fires. After OAuth, the auth-callback
   * page reads it back and uses it directly to file the token. This is the
   * only fully reliable signal — Supabase's `app_metadata.provider` and
   * `identities[].last_sign_in_at` can both lie about the most-recent
   * provider when a user has multiple linked identities, leading to
   * tokens stored under the wrong key (the "Bad credentials" bug).
   *
   * sessionStorage is the right scope here:
   *   - per-tab (so two tabs signing in to different providers don't collide)
   *   - persists across the OAuth redirect (which keeps the same tab)
   *   - auto-clears when the tab closes — no cross-session leakage
   */
  async signInWith(provider: AuthProvider, redirectTo?: string): Promise<void> {
    const meta = PROVIDER_META[provider];
    const target = redirectTo ?? this.defaultRedirect();

    if (typeof sessionStorage !== 'undefined') {
      try {
        sessionStorage.setItem(PENDING_PROVIDER_KEY, provider);
      } catch { /* storage blocked — fall back to mostRecentProvider() */ }
    }

    const { error } = await this.supabase.client.auth.signInWithOAuth({
      provider: provider as Provider,
      options: {
        redirectTo: target,
        scopes: meta.scopes
      }
    });
    if (error) throw error;
  }

  /**
   * Identity linking — attach an additional provider to the *current*
   * (already-signed-in) Supabase user. This is the LinkedIn-as-workspace flow:
   * the user signs in with LinkedIn, then links GitHub/GitLab/BitBucket/Azure
   * to enrich their account with code-host capabilities.
   */
  async linkProvider(provider: AuthProvider, redirectTo?: string): Promise<void> {
    const meta = PROVIDER_META[provider];
    const { error } = await this.supabase.client.auth.linkIdentity({
      provider: provider as Provider,
      options: {
        redirectTo: redirectTo ?? this.workspaceRedirect(),
        scopes: meta.scopes
      }
    });
    if (error) throw error;
  }

  /**
   * Detach a previously-linked identity. The user's primary identity (the one
   * they originally signed in with) cannot be unlinked.
   */
  async unlinkProvider(provider: AuthProvider): Promise<void> {
    const target = this.supabase.identities().find((i) => i.provider === provider);
    if (!target) return;
    const { error } = await this.supabase.client.auth.unlinkIdentity(target);
    if (error) throw error;
  }

  async signOut(): Promise<void> {
    await this.supabase.client.auth.signOut();
  }

  /**
   * Default OAuth redirect target after sign-in. We let the AuthCallback page
   * inspect `app_metadata.provider` and route the user to either the workspace
   * (LinkedIn) or the direct project-scanner (everyone else).
   */
  private defaultRedirect(): string {
    if (typeof window === 'undefined') return '/auth/callback';
    return `${window.location.origin}/auth/callback`;
  }

  private workspaceRedirect(): string {
    if (typeof window === 'undefined') return '/workspace';
    return `${window.location.origin}/workspace`;
  }
}
