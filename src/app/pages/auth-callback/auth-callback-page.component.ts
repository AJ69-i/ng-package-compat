import {
  ChangeDetectionStrategy,
  Component,
  PLATFORM_ID,
  effect,
  inject,
  signal
} from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import { SupabaseService } from '../../services/supabase.service';
import { ProviderTokenStore } from '../../services/provider-token-store.service';
import { AuthProvider, consumePendingProvider } from '../../services/auth.service';
import { SupabaseSyncService } from '../../services/supabase-sync.service';
import { ToastService } from '../../services/toast.service';

/**
 * Shape of the OAuth error parameters Supabase / the upstream provider can
 * forward back to us. Per RFC 6749 §4.1.2.1, errors are returned via the
 * redirect URI. Supabase puts them in the URL hash (because it parses the
 * hash for tokens too); some providers — Azure / Microsoft Entra ID in
 * particular — return errors via the query string when they reject the
 * authorization request before Supabase ever sees it.
 */
interface OAuthError {
  error: string;
  description: string | null;
  /** Raw URI the provider redirected us to — useful for support requests. */
  raw: string | null;
}

/**
 * Auth callback page — Supabase redirects here after OAuth round-trip.
 *
 * Three success paths:
 *   1. The Supabase client detects the URL hash, populates `session()`, and
 *      we route to /projects.
 *   2. The provider token (provider_token) is captured for repo scanning.
 *   3. The sync service emits a merge report → we surface a contextual toast.
 *
 * Four failure paths handled here (not just spun on indefinitely):
 *   1. The provider returned an `error` query param (Azure invalid_scope,
 *      access_denied, server_error, etc.) — we show a typed error card.
 *   2. Supabase returned an error in the URL hash (#error=...).
 *   3. Eight-second timeout with no session — we report it as a probable
 *      Supabase redirect-URL misconfiguration.
 *   4. Any of the above shows the same friendly card with a retry CTA;
 *      developers get the raw error code in a collapsed details panel.
 */
@Component({
  selector: 'app-auth-callback',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, RouterLink, TranslocoModule],
  template: `
    <section class="cb" [class.cb-error]="!!err()">
      @if (err(); as e) {
        <!-- Error state — replaces the spinner so the user sees one screen,
             not a stack of conflicting messages. -->
        <div class="icon-wrap" aria-hidden="true">
          <svg viewBox="0 0 56 56" width="56" height="56" role="img">
            <circle cx="28" cy="28" r="26" fill="none" stroke="currentColor" stroke-width="2.5" opacity="0.5"/>
            <path d="M28 16v16" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
            <circle cx="28" cy="40" r="2.5" fill="currentColor"/>
          </svg>
        </div>
        <h1>{{ 'auth.callback.errorTitle' | transloco }}</h1>
        <p class="lede">{{ friendlyMessage(e) }}</p>

        <div class="actions">
          <a routerLink="/sign-in" class="btn btn-primary">
            {{ 'auth.callback.tryAgain' | transloco }}
          </a>
          <a routerLink="/" class="btn btn-ghost">
            {{ 'auth.callback.continueAnonymous' | transloco }}
          </a>
        </div>

        @if (e.error || e.description) {
          <details class="diag">
            <summary>{{ 'auth.callback.details' | transloco }}</summary>
            <dl>
              @if (e.error) {
                <dt>{{ 'auth.callback.errorCode' | transloco }}</dt>
                <dd><code>{{ e.error }}</code></dd>
              }
              @if (e.description) {
                <dt>{{ 'auth.callback.errorDescription' | transloco }}</dt>
                <dd>{{ e.description }}</dd>
              }
            </dl>
          </details>
        }
      } @else {
        <!-- Loading state — spinner only, no double-stacked messages. -->
        <div class="spinner" aria-hidden="true"></div>
        <p>{{ 'auth.callback.message' | transloco }}</p>
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .cb {
      max-width: 520px;
      margin: clamp(2rem, 6vh, 4rem) auto 0;
      text-align: center;
      padding: clamp(1.5rem, 4vw, 2.5rem);
      background: var(--surface-2, #fff);
      border: 1px solid var(--border, #e5e7eb);
      border-radius: var(--radius-lg, 14px);
      box-shadow: var(--shadow-2, 0 6px 16px rgba(0,0,0,0.08));
      animation: cb-in 280ms cubic-bezier(0.2, 0.6, 0.2, 1) both;
    }
    .cb.cb-error {
      border-color: color-mix(in srgb, var(--bad, #ef4444) 35%, var(--border, #e5e7eb));
    }
    @keyframes cb-in {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @media (prefers-reduced-motion: reduce) { .cb { animation: none; } }

    /* Loading spinner */
    .spinner {
      width: 36px; height: 36px;
      margin: 0 auto 1.25rem;
      border-radius: 50%;
      border: 3px solid var(--border, #e5e7eb);
      border-top-color: var(--accent, #2563eb);
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
      .spinner { animation: none; border-top-color: var(--border, #e5e7eb); }
    }

    /* Error icon */
    .icon-wrap {
      display: inline-flex; align-items: center; justify-content: center;
      width: 64px; height: 64px;
      margin: 0 auto 1rem;
      color: var(--bad, #ef4444);
      background: color-mix(in srgb, var(--bad, #ef4444) 12%, transparent);
      border-radius: 50%;
    }

    h1 {
      margin: 0 0 0.5rem;
      font-size: clamp(1.2rem, 2vw + 0.6rem, 1.5rem);
      font-weight: 600;
      letter-spacing: -0.01em;
      color: var(--fg);
    }
    .lede {
      margin: 0 0 1.5rem;
      color: var(--fg-dim, #475569);
      line-height: 1.55;
      max-width: 44ch;
      margin-left: auto; margin-right: auto;
    }

    .actions {
      display: flex; gap: 0.5rem; flex-wrap: wrap; justify-content: center;
      margin-bottom: 1.25rem;
    }

    /* Local copies of the global .btn primitives — the auth-callback page
       loads early in the bootstrap so we don't want to depend on the global
       stylesheet having reached a particular component yet. */
    .btn {
      display: inline-flex; align-items: center; justify-content: center;
      min-height: 40px;
      padding: 0 1rem;
      border-radius: var(--radius-md, 10px);
      font-size: 0.95rem;
      font-weight: 600;
      letter-spacing: 0.01em;
      text-decoration: none;
      border: 1px solid var(--border);
      background: var(--surface-1);
      color: var(--fg);
      cursor: pointer;
      transition: background-color 160ms ease, border-color 160ms ease, transform 120ms ease, box-shadow 160ms ease;
    }
    .btn:hover {
      border-color: var(--accent);
      transform: translateY(-1px);
    }
    .btn-primary {
      background: var(--accent-gradient, var(--accent, #2563eb));
      color: #fff;
      border-color: transparent;
      box-shadow: var(--shadow-1);
    }
    .btn-primary:hover {
      box-shadow: var(--shadow-glow);
      filter: brightness(1.04);
    }
    .btn-ghost {
      background: transparent;
      border-color: transparent;
      color: var(--fg-dim);
    }
    .btn-ghost:hover {
      background: var(--surface-2);
      color: var(--fg);
      border-color: var(--border);
    }

    /* Collapsible developer-detail panel */
    .diag {
      text-align: left;
      margin-top: 1rem;
      border-top: 1px dashed var(--border);
      padding-top: 1rem;
    }
    .diag summary {
      cursor: pointer;
      color: var(--fg-dim);
      font-size: 0.85rem;
      list-style: none;
    }
    .diag summary::-webkit-details-marker { display: none; }
    .diag summary::before {
      content: '▸';
      display: inline-block;
      margin-inline-end: 0.4rem;
      transition: transform 160ms ease;
      font-size: 0.7em;
    }
    .diag[open] summary::before { transform: rotate(90deg); }
    .diag dl {
      margin: 0.75rem 0 0;
      font-size: 0.82rem;
      color: var(--fg-dim);
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 0.4rem 0.85rem;
    }
    .diag dt { font-weight: 600; color: var(--fg); }
    .diag dd { margin: 0; word-break: break-word; }
    .diag code {
      background: var(--surface-1);
      border: 1px solid var(--border);
      padding: 1px 6px;
      border-radius: var(--radius-sm, 6px);
      font-size: 0.9em;
    }
  `]
})
export class AuthCallbackPageComponent {
  private readonly supabase = inject(SupabaseService);
  private readonly tokenStore = inject(ProviderTokenStore);
  private readonly sync = inject(SupabaseSyncService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  private readonly transloco = inject(TranslocoService);
  private readonly platformId = inject(PLATFORM_ID);

  readonly err = signal<OAuthError | null>(null);

  /**
   * Set once we've routed away. Without this, the effect can re-fire on
   * the next tick (because `supabase.session()` keeps emitting) and trigger
   * a second navigation that fights with router state.
   */
  private routed = false;

  constructor() {
    // 1. Look for an explicit OAuth error in the URL up-front. If present,
    //    don't even wait for Supabase — show the error immediately.
    const urlError = this.readUrlError();
    if (urlError) {
      this.err.set(urlError);
      return;
    }

    // 2. React when the session arrives. Use a signal effect so we don't
    //    have to imperatively poll Supabase — the session signal flips when
    //    the client finishes processing the URL hash.
    effect(() => {
      if (this.routed) return;
      if (!this.supabase.ready()) return;
      const session = this.supabase.session();
      if (!session) return; // Stay parked — the timeout below will fail it.

      // Capture provider token (volatile) for scanning.
      //
      // Resolution order — most reliable signal first:
      //   1. `consumePendingProvider()` — reads the provider the user
      //      explicitly clicked on /sign-in. This is bulletproof: we know
      //      what they chose because we recorded it before the OAuth
      //      redirect even fired.
      //   2. `mostRecentProvider()` — falls back to identity timestamps
      //      if sessionStorage is empty (e.g. the user navigated to
      //      /auth/callback directly, or storage was disabled).
      //
      // Why we don't trust Supabase alone: `app_metadata.provider` is set
      // at signup and never updates. `identities[].last_sign_in_at` *should*
      // update on each sign-in but in practice has stale values right
      // after the OAuth redirect. The pending-provider sessionStorage
      // signal is the only source of truth that's guaranteed to reflect
      // the user's actual choice.
      const pending = consumePendingProvider();
      const provider = (pending ?? this.supabase.mostRecentProvider()) as AuthProvider | null;
      const token =
        (session as { provider_token?: string | null }).provider_token ?? null;
      if (provider && token) {
        // Belt-and-braces: wipe ANY existing tokens before storing the new
        // one. If the previous sign-out somehow failed to fully clear the
        // store (race condition, missed call, manual back-button nav, etc.)
        // the next sign-in inherits a known-empty state, and the just-
        // captured token is the only one in there. This is the second half
        // of the "every fresh sign-in starts clean" invariant — the first
        // half is `clearAll()` on sign-out.
        this.tokenStore.clearAll();
        this.tokenStore.setSessionToken(provider, token);
      }

      this.routed = true;
      this.routeForUser(provider);
    });

    // 3. Subscribe to the sync service's first-pull stats and surface a
    //    contextual welcome toast.
    effect(() => {
      const report = this.sync.mergeReport();
      if (!report) return;
      let msg: string;
      if (report.cloudBefore === 0 && report.localBefore === 0) {
        msg = 'Signed in. Your workspace will sync going forward.';
      } else if (report.cloudBefore === 0 && report.localBefore > 0) {
        msg = `Signed in. ${report.merged} item${report.merged === 1 ? '' : 's'} synced to cloud.`;
      } else if (report.localBefore === 0 && report.cloudBefore > 0) {
        msg = `Welcome back. Restored ${report.merged} item${report.merged === 1 ? '' : 's'} from your other devices.`;
      } else {
        msg = `Merged ${report.localBefore} local item${report.localBefore === 1 ? '' : 's'} with ${report.cloudBefore} from cloud.`;
      }
      this.toast.success(msg);
      this.sync.consumeMergeReport();
    });

    // 4. Hard timeout: if Supabase hasn't produced a session in 8 seconds,
    //    something else is wrong. Surface it as a generic auth-failed error
    //    with the redirect-URL hint kept in the developer details panel.
    if (isPlatformBrowser(this.platformId)) {
      setTimeout(() => {
        if (this.routed) return;
        if (this.err()) return;
        if (this.supabase.session()) return;
        this.err.set({
          error: 'session_timeout',
          description:
            'No session detected after 8 seconds. The redirect URL ' +
            '(http://localhost:4200/auth/callback) may not be allow-listed ' +
            'in the Supabase project, or the OAuth provider returned no token.',
          raw: typeof window !== 'undefined' ? window.location.href : null
        });
      }, 8000);
    }
  }

  /**
   * Map OAuth error codes to a friendly, translatable user-facing sentence.
   * Falls back to the provider's `error_description` when we don't have a
   * dedicated translation. The raw `error` code is always shown in the
   * developer-detail panel below the message.
   */
  friendlyMessage(e: OAuthError): string {
    const key = `auth.callback.errors.${e.error}`;
    const translated = this.transloco.translate(key);
    // Transloco returns the key itself when no translation exists.
    if (translated && translated !== key) return translated;
    if (e.description) return e.description;
    return this.transloco.translate('auth.callback.errors.unknown');
  }

  /**
   * Read OAuth errors from both query string and URL hash. OAuth providers
   * (notably Azure / Microsoft Entra ID) use the query string per spec when
   * they reject the request before token exchange; Supabase uses the hash
   * because that's where it also parses access tokens. We check both.
   */
  private readUrlError(): OAuthError | null {
    if (!isPlatformBrowser(this.platformId)) return null;
    if (typeof window === 'undefined') return null;

    const url = window.location.href;
    const search = window.location.search;
    const hash = window.location.hash.startsWith('#')
      ? window.location.hash.slice(1)
      : window.location.hash;

    // Try query string first (OAuth provider errors).
    const fromQuery = this.parseError(search.startsWith('?') ? search.slice(1) : search);
    if (fromQuery) return { ...fromQuery, raw: url };

    // Then hash (Supabase forwards them here for the implicit flow).
    const fromHash = this.parseError(hash);
    if (fromHash) return { ...fromHash, raw: url };

    return null;
  }

  private parseError(qs: string): { error: string; description: string | null } | null {
    if (!qs) return null;
    const params = new URLSearchParams(qs);
    const error = params.get('error');
    if (!error) return null;
    const desc =
      params.get('error_description') ??
      params.get('error_message') ??
      null;
    // URLSearchParams already %-decodes; some providers double-encode +.
    const cleaned = desc ? desc.replace(/\+/g, ' ') : null;
    return { error, description: cleaned };
  }

  private routeForUser(_provider: AuthProvider | null): void {
    this.router.navigateByUrl('/projects');
  }
}
