import { Injectable, PLATFORM_ID, inject, signal, computed } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { AuthProvider } from './auth.service';

/**
 * Per-user store for OAuth provider tokens.
 *
 * The model:
 *   - **PATs** the user types in by hand have no expiry — they live until
 *     the user removes them.
 *   - **OAuth tokens** captured from the sign-in flow are persisted with
 *     an explicit TTL (default 24 hours). After the TTL elapses we drop
 *     the token and prompt the user to re-authenticate.
 *
 * Why TTL instead of "never persist":
 *   Re-authenticating on every page reload was unusable in practice. The
 *   tradeoff: a malicious script with browser access could read the token
 *   from localStorage, but that risk window is now bounded by the TTL.
 *
 * Why this isn't using HttpOnly cookies (the more secure option):
 *   That requires a server-side token proxy — every request to a code host
 *   would have to go through our SSR server, and the server would store
 *   tokens (e.g. in Appwrite or Supabase via service-role). Real production
 *   answer; bigger refactor. Implement when ready.
 *
 * On sign-out, both tracks are cleared and localStorage is wiped.
 */

const STORAGE_KEY = 'ngpc.provider-tokens.v2';
/**
 * Older versions of the app used this key. We don't read from it (the v1
 * shape is incompatible with the current PersistedToken layout), but we
 * include it in `clearAll()` so a sign-out wipes any pre-migration leftover.
 * Without this, a user who upgraded from a much older build could still
 * have a stale GitHub binding sitting in v1 that becomes the source of
 * "Bad credentials" errors.
 */
const LEGACY_STORAGE_KEYS = ['ngpc.provider-tokens.v1'] as const;

/** OAuth tokens get a 24h TTL. PATs (manual entry) have no expiry. */
const DEFAULT_OAUTH_TTL_MS = 24 * 60 * 60 * 1000;

interface PersistedToken {
  token: string;
  /** Epoch ms; null = never expires (PATs). */
  expiresAt: number | null;
  /** What kind of token this is — affects how we treat it on rotation. */
  kind: 'oauth' | 'pat';
}

type PersistedMap = Partial<Record<AuthProvider, PersistedToken>>;

@Injectable({ providedIn: 'root' })
export class ProviderTokenStore {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly entries = signal<PersistedMap>(this.load());

  /**
   * Effective token map — only includes non-expired entries. Expired tokens
   * are pruned lazily here so any consumer reading via `all()` /
   * `bindings()` automatically sees only valid tokens.
   */
  readonly all = computed<Partial<Record<AuthProvider, string>>>(() => {
    const now = Date.now();
    const out: Partial<Record<AuthProvider, string>> = {};
    const m = this.entries();
    for (const [provider, entry] of Object.entries(m) as Array<[AuthProvider, PersistedToken]>) {
      if (!entry) continue;
      if (entry.expiresAt && entry.expiresAt < now) continue;
      out[provider] = entry.token;
    }
    return out;
  });

  /** Tokens currently available, in the form scanners want. */
  readonly bindings = computed(() =>
    (Object.entries(this.all()) as Array<[AuthProvider, string]>)
      .filter(([, t]) => !!t)
      .map(([provider, token]) => ({ provider, token }))
  );

  /**
   * Earliest time *any* OAuth token will expire — used by the UI to show
   * a "your session expires in X minutes" hint. Returns `null` if nothing
   * is set or all entries are PATs.
   */
  readonly earliestOauthExpiry = computed<number | null>(() => {
    let earliest: number | null = null;
    for (const entry of Object.values(this.entries()) as PersistedToken[]) {
      if (!entry || entry.kind !== 'oauth' || !entry.expiresAt) continue;
      if (earliest === null || entry.expiresAt < earliest) earliest = entry.expiresAt;
    }
    return earliest;
  });

  // ---------- mutators ----------

  /**
   * Persist an OAuth-captured token with a 24h TTL. Call this from the
   * auth-callback page after `signInWithOAuth` completes.
   */
  setSessionToken(
    provider: AuthProvider,
    token: string,
    ttlMs: number = DEFAULT_OAUTH_TTL_MS
  ): void {
    const expiresAt = Date.now() + ttlMs;
    this.entries.update((m) => ({
      ...m,
      [provider]: { token, expiresAt, kind: 'oauth' }
    }));
    this.persist();
  }

  /** Persist a user-typed PAT — no expiry, lives until the user removes it. */
  setPersistentToken(provider: AuthProvider, token: string): void {
    this.entries.update((m) => ({
      ...m,
      [provider]: { token, expiresAt: null, kind: 'pat' }
    }));
    this.persist();
  }

  removeToken(provider: AuthProvider): void {
    this.entries.update((m) => {
      const next = { ...m };
      delete next[provider];
      return next;
    });
    this.persist();
  }

  has(provider: AuthProvider): boolean {
    return !!this.all()[provider];
  }

  /** Returns the current valid token for a provider, or `null`. */
  tokenFor(provider: AuthProvider): string | null {
    return this.all()[provider] ?? null;
  }

  /**
   * Wipe every stored token, in-memory AND on disk. Critical that this
   * fully removes the localStorage key (rather than writing `{}`) — that
   * way no race condition can merge a stale binding back in on the next
   * sign-in. Also clears any legacy keys from older app versions, so
   * upgraders don't carry forward a long-dead GitHub token.
   *
   * Called on:
   *   - sign-out (navbar.onSignOut, projects-page.signOut)
   *   - the start of every fresh sign-in (auth-callback) as a belt-and-
   *     braces guard against the auth-callback inheriting a stale entry
   */
  clearAll(): void {
    this.entries.set({});
    if (!isPlatformBrowser(this.platformId)) return;
    try {
      localStorage.removeItem(STORAGE_KEY);
      for (const legacy of LEGACY_STORAGE_KEYS) {
        localStorage.removeItem(legacy);
      }
    } catch {
      /* storage blocked — non-fatal */
    }
  }

  // ---------- persistence ----------

  private load(): PersistedMap {
    if (!isPlatformBrowser(this.platformId)) return {};
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as PersistedMap;
      if (!parsed || typeof parsed !== 'object') return {};
      // Drop already-expired entries on load so we don't keep stale tokens
      // around even momentarily.
      const now = Date.now();
      const cleaned: PersistedMap = {};
      for (const [provider, entry] of Object.entries(parsed) as Array<
        [AuthProvider, PersistedToken | undefined]
      >) {
        if (!entry || typeof entry.token !== 'string') continue;
        if (entry.expiresAt && entry.expiresAt < now) continue;
        cleaned[provider] = entry;
      }
      return cleaned;
    } catch {
      return {};
    }
  }

  private persist(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.entries()));
    } catch {
      /* storage full / blocked — non-fatal */
    }
  }
}
