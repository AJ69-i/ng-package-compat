import {
  ChangeDetectionStrategy,
  Component,
  PLATFORM_ID,
  computed,
  inject,
  input,
  signal
} from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { TranslocoModule } from '@jsverse/transloco';
import { RouterLink } from '@angular/router';
import { SupabaseService } from '../../services/supabase.service';

/**
 * Soft sign-in CTA shown above auth-gated personal data pages
 * (history, favorites). Three rules:
 *
 *   1. Hidden when the user is already signed in — they don't need the nag.
 *   2. Hidden if the user has dismissed it on this device. Per-page
 *      dismissal is tracked in localStorage so dismissing on /history
 *      doesn't dismiss on /favorites.
 *   3. Never blocks the page: the user can keep using local-only mode
 *      indefinitely if they want.
 *
 * Inputs:
 *   - `kind` — controls which i18n string is shown ("history" / "favorites" / etc.)
 */
@Component({
  selector: 'app-sync-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TranslocoModule, RouterLink],
  template: `
    @if (visible()) {
      <article class="banner" role="region" [attr.aria-label]="'sync.banner.aria' | transloco">
        <span class="emoji" aria-hidden="true">☁️</span>
        <p class="copy">
          {{ 'sync.banner.' + kind() | transloco }}
        </p>
        <div class="actions">
          <a routerLink="/sign-in" class="cta">{{ 'sync.banner.signIn' | transloco }}</a>
          <button type="button" class="dismiss" (click)="dismiss()" [attr.aria-label]="'sync.banner.dismiss' | transloco">
            {{ 'sync.banner.notNow' | transloco }}
          </button>
        </div>
      </article>
    }
  `,
  styles: [`
    :host { display: block; margin-bottom: 1rem; }
    .banner {
      display: flex; align-items: center; gap: 0.85rem; flex-wrap: wrap;
      padding: 0.7rem 1rem;
      background: var(--surface-2, #f8fafc);
      border: 1px solid var(--border, #e5e7eb);
      border-left: 3px solid var(--accent, #2563eb);
      border-radius: 10px;
      font-size: 0.88rem;
    }
    .emoji { font-size: 1.1rem; }
    .copy {
      flex: 1 1 220px; margin: 0; color: var(--fg, #111);
    }
    .actions { display: flex; gap: 0.4rem; }
    .cta {
      padding: 0.4rem 0.85rem; border-radius: 7px;
      background: var(--accent, #2563eb); color: #fff;
      font-weight: 600; font-size: 0.82rem;
      text-decoration: none;
    }
    .cta:hover { filter: brightness(0.95); }
    .dismiss {
      background: none; border: 1px solid var(--border, #e5e7eb);
      color: var(--fg-dim, #475569);
      padding: 0.4rem 0.75rem; border-radius: 7px; font-size: 0.82rem;
      cursor: pointer;
    }
    .dismiss:hover { color: var(--fg, #111); border-color: var(--fg-dim, #94a3b8); }
  `]
})
export class SyncBannerComponent {
  private readonly supabase = inject(SupabaseService);
  private readonly platformId = inject(PLATFORM_ID);

  /** Which page this banner is on — drives the i18n key + dismissal storage. */
  readonly kind = input.required<'history' | 'favorites'>();

  private readonly dismissed = signal<boolean>(this.loadDismissed());

  readonly visible = computed(() => {
    if (!isPlatformBrowser(this.platformId)) return false;
    if (this.supabase.isSignedIn()) return false;
    if (this.dismissed()) return false;
    return true;
  });

  dismiss(): void {
    this.dismissed.set(true);
    if (!isPlatformBrowser(this.platformId)) return;
    try {
      localStorage.setItem(this.storageKey(), '1');
    } catch {
      /* ignore */
    }
  }

  private loadDismissed(): boolean {
    if (!isPlatformBrowser(this.platformId)) return false;
    try {
      // We rely on the input being available in the change detector tick
      // when this is read; defensively coerce to false if input isn't set.
      return localStorage.getItem(this.storageKey()) === '1';
    } catch {
      return false;
    }
  }

  private storageKey(): string {
    // input might not be set on first read in tests/SSR — fall back to a
    // generic key so we don't accidentally dismiss the banner globally.
    let kind: string;
    try {
      kind = this.kind();
    } catch {
      kind = 'unknown';
    }
    return `ngpc.syncBanner.${kind}.dismissed.v1`;
  }
}
