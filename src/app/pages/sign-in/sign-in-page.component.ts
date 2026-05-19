import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { TranslocoModule } from '@jsverse/transloco';
import { AuthProvider, AuthService, PROVIDER_META } from '../../services/auth.service';
import { SupabaseService } from '../../services/supabase.service';
import { ToastService } from '../../services/toast.service';
import { ProviderIconComponent } from '../../components/provider-icon/provider-icon.component';

/**
 * Sign-in page (feature: multi-provider SSO).
 *
 * Two columns of choices:
 *   - "Direct providers" (GitHub / GitLab / BitBucket / Azure) — one click and
 *     we go straight to scanning their Angular projects.
 *   - "LinkedIn workspace" — one click sends them to a centralized workspace
 *     where they can link any combination of code hosts.
 *
 * If they're already signed in, we redirect — the page is for unauthenticated
 * users. We deliberately avoid auto-redirecting the moment auth state changes
 * because OAuth round-trips can briefly land on this URL with a partial state.
 */
@Component({
  selector: 'app-sign-in-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TranslocoModule, RouterLink, ProviderIconComponent],
  template: `
    <section class="hero">
      <h1>{{ 'auth.signIn.title' | transloco }}</h1>
      <p>{{ 'auth.signIn.lede' | transloco }}</p>
    </section>

    <section class="single-col">
      <article class="col">
        <header>
          <h2>{{ 'auth.signIn.directTitle' | transloco }}</h2>
          <p>{{ 'auth.signIn.directLede' | transloco }}</p>
        </header>
        <div class="btns">
          @for (p of directProviders; track p) {
            <button
              type="button"
              class="provider"
              [attr.data-provider]="p"
              [class.is-experimental]="isExperimental(p)"
              [disabled]="busy()"
              (click)="signIn(p)"
            >
              <app-provider-icon [provider]="p" [size]="40" [ariaHidden]="true" />
              <span class="text">
                <strong>
                  {{ label(p) }}
                  <!-- Experimental badge: appears only when PROVIDER_META[p]
                       .experimental is true. The badge styling matches the
                       AI settings dialog (amber pill) so users build a
                       consistent mental model: "amber pill = adapter shipped
                       but unverified." Tooltip gives the why on hover. -->
                  @if (isExperimental(p)) {
                    <span
                      class="provider-experimental"
                      [title]="'providerExperimental.tooltip' | transloco: { name: label(p) }"
                    >
                      {{ 'providerExperimental.label' | transloco }}
                    </span>
                  }
                </strong>
                <small>{{ 'auth.signIn.directSub' | transloco: { name: label(p) } }}</small>
              </span>
            </button>
          }
        </div>
      </article>
    </section>

    <p class="muted">
      {{ 'auth.signIn.skipNote' | transloco }}
      <a routerLink="/upgrade">{{ 'auth.signIn.skipLink' | transloco }}</a>
    </p>
  `,
  styles: [`
    :host { display: block; max-width: var(--content-max-width, min(94vw, 1320px)); margin: 0 auto; padding: 1.5rem 1rem 4rem; }
    .hero { text-align: center; margin-bottom: 1.5rem; }
    .hero h1 { font-size: clamp(1.6rem, 2.6vw, 2.4rem); margin: 0 0 0.4rem; }
    .hero p { margin: 0 auto; max-width: 60ch; color: var(--fg-dim, #475569); }
    /* The sign-in card is a focused decision so a tight column is right,
       but 520px felt cramped on a wide monitor. Bump to 720px and let the
       hero / footer breathe alongside it. */
    .single-col {
      max-width: 720px;
      margin: 0 auto;
    }
    .col {
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 14px;
      padding: 1.25rem;
      background: var(--surface-1, #fff);
      display: flex; flex-direction: column; gap: 0.85rem;
    }
    header h2 { margin: 0 0 0.25rem; font-size: 1.05rem; }
    header p { margin: 0; color: var(--fg-dim, #64748b); font-size: 0.88rem; }
    .btns { display: grid; gap: 0.5rem; }
    .provider {
      display: flex; align-items: center; gap: 0.85rem;
      padding: 0.7rem 0.9rem;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 10px;
      background: var(--surface-2, #f8fafc);
      color: var(--fg, #0f172a);
      font: inherit;
      cursor: pointer;
      text-align: left;
      transition: transform 80ms ease, box-shadow 120ms ease, border-color 120ms ease;
    }
    .provider:hover:not(:disabled) {
      border-color: var(--accent, #2563eb);
      box-shadow: 0 1px 4px rgba(37, 99, 235, 0.18);
      transform: translateY(-1px);
    }
    .provider:disabled { opacity: 0.6; cursor: progress; }
    .logo {
      width: 40px; height: 40px; border-radius: 8px;
      display: grid; place-items: center;
      font-weight: 700; font-size: 0.95rem; letter-spacing: 0.5px;
      flex-shrink: 0;
      color: #fff;
    }
    .logo[data-provider="github"] { background: #24292f; }
    .logo[data-provider="gitlab"] { background: #fc6d26; }
    .logo[data-provider="bitbucket"] { background: #2684ff; }
    .logo[data-provider="azure"] { background: #0078d4; }
    .text { display: grid; gap: 0.1rem; }
    .text strong {
      font-size: 0.95rem;
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      flex-wrap: wrap;
    }
    .text small { color: var(--fg-dim, #64748b); font-size: 0.8rem; }

    /* Experimental badge — matches the AI settings dialog amber pill so
       users learn one visual vocabulary: amber = adapter shipped but
       unverified. cursor:help signals "hover for explanation" via the
       title attribute on the element. */
    .provider-experimental {
      font-size: 0.6rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: var(--radius-pill, 999px);
      background: color-mix(in srgb, var(--warn, #f59e0b) 16%, transparent);
      color: color-mix(in srgb, var(--warn, #f59e0b) 70%, var(--fg, #0f172a));
      border: 1px solid color-mix(in srgb, var(--warn, #f59e0b) 40%, var(--border, #e5e7eb));
      cursor: help;
    }
    /* When the whole provider button is for an experimental adapter, a
       subtle amber tint on the left edge reinforces the badge without
       being overbearing. Drops the noise of "every button looks the
       same except this one." */
    .provider.is-experimental {
      border-left: 3px solid color-mix(in srgb, var(--warn, #f59e0b) 50%, var(--border, #e5e7eb));
    }
    .muted {
      color: var(--fg-dim, #64748b);
      font-size: 0.85rem;
      text-align: center;
      margin-top: 1.5rem;
    }
    .muted a { color: var(--accent, #2563eb); }
  `]
})
export class SignInPageComponent {
  private readonly auth = inject(AuthService);
  private readonly supabase = inject(SupabaseService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);

  readonly directProviders: AuthProvider[] = ['github', 'gitlab', 'bitbucket', 'azure'];
  readonly busy = signal(false);
  readonly alreadySignedIn = computed(() => this.supabase.isSignedIn());

  constructor() {
    // If a session shows up while we're on this page, route the user out.
    // (e.g. they came back from OAuth and the callback handler hasn't routed yet.)
    queueMicrotask(() => this.maybeRedirect());
  }

  private maybeRedirect(): void {
    if (this.alreadySignedIn()) {
      this.router.navigateByUrl('/projects');
    }
  }

  async signIn(provider: AuthProvider): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await this.auth.signInWith(provider);
      // Browser will redirect — nothing else to do here.
    } catch (e) {
      this.busy.set(false);
      const message = e instanceof Error ? e.message : 'Sign-in failed.';
      this.toast.error(message);
    }
  }

  label(p: AuthProvider): string {
    return PROVIDER_META[p].label;
  }

  /**
   * True when this provider is marked experimental in PROVIDER_META —
   * i.e. we've shipped the adapter but haven't validated it against a
   * real account. Drives the badge + amber-edge styling on the
   * provider button. Reads the flag from a single source of truth so
   * the moment Azure (or any other provider) gets validated, flipping
   * PROVIDER_META.experimental to false makes the badge disappear
   * everywhere without touching this component.
   */
  isExperimental(p: AuthProvider): boolean {
    return PROVIDER_META[p].experimental;
  }

  glyph(p: AuthProvider): string {
    switch (p) {
      case 'github': return 'GH';
      case 'gitlab': return 'GL';
      case 'bitbucket': return 'BB';
      case 'azure': return 'AZ';
    }
  }
}
