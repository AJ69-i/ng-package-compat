import { Injectable, PLATFORM_ID, inject, signal, computed } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import {
  SupabaseClient,
  createClient,
  Session,
  User,
  UserIdentity
} from '@supabase/supabase-js';
import { environment } from '../../environments/environment';

/**
 * Singleton wrapper around the Supabase JS client.
 *
 * Design decisions worth knowing:
 *
 *   - The client is **only** instantiated in the browser. On the server we
 *     return a stub so SSR doesn't blow up trying to read localStorage.
 *   - We expose `session` as an Angular signal so the rest of the app can
 *     bind to auth state without subscribing to RxJS imperatively.
 *   - We don't expose the raw client unconditionally — call `assertClient()`
 *     so SSR-side calls fail loudly instead of silently 500ing.
 */
@Injectable({ providedIn: 'root' })
export class SupabaseService {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly _session = signal<Session | null>(null);
  private readonly _ready = signal(false);
  private _client: SupabaseClient | null = null;

  readonly session = this._session.asReadonly();
  readonly ready = this._ready.asReadonly();
  readonly user = computed<User | null>(() => this._session()?.user ?? null);
  readonly identities = computed<UserIdentity[]>(
    () => this._session()?.user?.identities ?? []
  );

  /** Whether the user has at least one active session. */
  readonly isSignedIn = computed(() => !!this._session());

  /**
   * The "primary" provider — i.e. the OAuth provider the user originally
   * signed in / signed up with. Sticky for the lifetime of the Supabase
   * account regardless of which provider the user used most recently.
   *
   * NOTE: do NOT use this to decide which provider's API to call after a
   * fresh sign-in. Use `mostRecentProvider()` instead — see comment there.
   */
  readonly primaryProvider = computed<string | null>(() => {
    const u = this.user();
    if (!u) return null;
    // app_metadata.provider is the original sign-in provider (set by Supabase).
    const fromMetadata = (u.app_metadata as Record<string, unknown>)?.['provider'];
    if (typeof fromMetadata === 'string' && fromMetadata) return fromMetadata;
    return u.identities?.[0]?.provider ?? null;
  });

  /**
   * The provider used in the **most recent** sign-in. This is what we want
   * for `provider_token`-driven flows (the projects page calling each repo
   * provider's API), because the `session.provider_token` is issued by
   * whichever provider the user just authenticated with — not the one they
   * originally signed up with.
   *
   * Without this, a user who first signed up with GitHub and later signs in
   * with GitLab gets their GitLab token stored under the `github` key, and
   * the GitHub API rejects every request as "Bad credentials". Same bug for
   * BitBucket / Azure transitions.
   *
   * Resolution: compare every identity's `last_sign_in_at` and pick the
   * most-recent one. Fallback chain handles edge cases where Supabase
   * hasn't populated those timestamps (which is rare but possible during
   * the first PKCE round-trip).
   */
  readonly mostRecentProvider = computed<string | null>(() => {
    const ids = this.identities();
    if (!ids.length) return this.primaryProvider();
    type WithTs = { provider: string; last_sign_in_at?: string | null };
    let best: WithTs | null = null;
    for (const i of ids as WithTs[]) {
      const ts = i.last_sign_in_at ? Date.parse(i.last_sign_in_at) : 0;
      const bestTs = best?.last_sign_in_at ? Date.parse(best.last_sign_in_at) : 0;
      if (!best || ts > bestTs) best = i;
    }
    return best?.provider ?? this.primaryProvider();
  });

  constructor() {
    if (isPlatformBrowser(this.platformId)) {
      this._client = createClient(
        environment.supabase.url,
        environment.supabase.anonKey,
        {
          auth: {
            autoRefreshToken: true,
            persistSession: true,
            detectSessionInUrl: true,
            flowType: 'pkce'
          }
        }
      );

      this._client.auth.getSession().then(({ data }) => {
        this._session.set(data.session);
        this._ready.set(true);
      });

      this._client.auth.onAuthStateChange((_event, session) => {
        this._session.set(session);
      });
    } else {
      // SSR: no client, no session. Mark ready so guards don't hang forever.
      this._ready.set(true);
    }
  }

  /**
   * Return the underlying Supabase client. Throws on SSR — auth flows are
   * always browser-side.
   */
  get client(): SupabaseClient {
    if (!this._client) {
      throw new Error('Supabase client is not available in this environment.');
    }
    return this._client;
  }

  /** Lookup whether a specific provider is already linked to this account. */
  hasIdentity(provider: string): boolean {
    return this.identities().some((i) => i.provider === provider);
  }
}
