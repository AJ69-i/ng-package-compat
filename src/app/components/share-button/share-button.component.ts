import {
  ChangeDetectionStrategy,
  Component,
  PLATFORM_ID,
  computed,
  inject,
  signal,
  input
} from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import { ToastService } from '../../services/toast.service';

/**
 * Permalink / Share button (Feature #10 of the search-page masterpiece
 * plan).
 *
 * The Search page already syncs `?q=<pkg>` into the URL bar, which
 * means the URL bar IS the shareable link. But there's no explicit
 * affordance — users have to know to copy from the address bar, and
 * mobile users find that fiddly. This button is the missing handle:
 * one click, the link is on the clipboard, and a toast confirms.
 *
 * We also expose the Web Share API on platforms that support it
 * (iOS Safari, Android Chrome, modern desktop Safari). When the API
 * is available we route through `navigator.share()` first, falling
 * back to clipboard if the user cancels or the API throws. The button
 * stays a single primary action either way — we don't show two
 * buttons or a menu.
 *
 * The component is fully self-contained: no external state, no
 * provider wiring beyond ToastService for the success toast. Drop it
 * into any page that wants a copy-link affordance.
 */
@Component({
  selector: 'app-share-button',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TranslocoModule],
  template: `
    @if (canRender()) {
      <button
        type="button"
        class="share-btn"
        [class.copied]="copied()"
        (click)="onClick()"
        [attr.aria-label]="'share.aria' | transloco"
      >
        <span class="ico" aria-hidden="true">{{ copied() ? '✓' : '🔗' }}</span>
        <span class="label">
          {{ (copied() ? 'share.copied' : 'share.copy') | transloco }}
        </span>
      </button>
    }
  `,
  styles: [`
    :host { display: inline-flex; }

    .share-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.42rem 0.85rem;
      background: var(--surface-2);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: var(--radius-md, 10px);
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      transition: background-color 160ms var(--ease, ease),
                  border-color 160ms var(--ease, ease),
                  color 160ms var(--ease, ease),
                  transform 120ms var(--ease, ease);
      min-height: 34px;
    }

    .share-btn:hover {
      background: var(--surface-1);
      border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
      color: var(--accent);
    }
    .share-btn:active { transform: translateY(1px); }
    .share-btn:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    .share-btn.copied {
      background: color-mix(in srgb, var(--ok, #16a34a) 12%, var(--surface-1));
      border-color: color-mix(in srgb, var(--ok, #16a34a) 45%, var(--border));
      color: var(--ok, #16a34a);
    }

    .ico { font-size: 1rem; line-height: 1; }
    .label { white-space: nowrap; }
  `]
})
export class ShareButtonComponent {
  /**
   * Optional override for the URL we share. When omitted we share the
   * current `window.location.href`. Callers can pass a normalized URL
   * (e.g. the canonical query-param-only version, without UI state in
   * the hash) if they want a cleaner share target.
   */
  readonly url = input<string | null>(null);

  /**
   * Optional title for the Web Share dialog ("Share via..."). On
   * platforms that don't support `navigator.share`, this is silently
   * ignored — the clipboard copy doesn't carry a title.
   */
  readonly shareTitle = input<string | null>(null);

  /** Optional descriptive text for the share dialog. */
  readonly shareText = input<string | null>(null);

  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly toast = inject(ToastService);
  private readonly transloco = inject(TranslocoService);

  /**
   * The "copied" affordance — we flip to true for 1.6s after a
   * successful copy, then back to false. The button label and color
   * both react to this signal.
   */
  readonly copied = signal<boolean>(false);

  /** Suppress rendering during SSR — there's no window to share from. */
  readonly canRender = computed<boolean>(() => this.isBrowser);

  async onClick(): Promise<void> {
    if (!this.isBrowser) return;

    const target = this.url() ?? window.location.href;

    // Prefer the platform share sheet when it's available — that's
    // what users on iOS expect for share affordances. If they cancel,
    // the API rejects with AbortError and we silently treat that as
    // a no-op (not a fallback to clipboard, because the user explicitly
    // cancelled).
    const nav = navigator as Navigator & {
      share?: (data: ShareData) => Promise<void>;
      canShare?: (data: ShareData) => boolean;
    };

    if (nav.share && this.shouldUseNativeShare()) {
      const data: ShareData = { url: target };
      if (this.shareTitle()) data.title = this.shareTitle()!;
      if (this.shareText()) data.text = this.shareText()!;
      try {
        if (!nav.canShare || nav.canShare(data)) {
          await nav.share(data);
          // Native share succeeded — no toast needed, the OS already
          // gave the user feedback. Don't flip `copied` either.
          return;
        }
      } catch (err: unknown) {
        // AbortError = user cancelled the share sheet. Don't fall
        // back to clipboard — they explicitly opted out.
        const name = (err as { name?: string })?.name;
        if (name === 'AbortError') return;
        // Any other error — fall through to clipboard.
      }
    }

    await this.copyToClipboard(target);
  }

  /**
   * Heuristic: prefer native share on mobile (where the share sheet
   * is a familiar pattern), prefer clipboard on desktop (where users
   * expect a direct "Copied!" affordance from a copy button).
   *
   * Chrome desktop exposes `navigator.share` too, but landing in the
   * Chrome sheet from a copy-link button on a wide screen feels wrong
   * — desktop users want one click and a confirmation, not a modal.
   */
  private shouldUseNativeShare(): boolean {
    if (!this.isBrowser) return false;
    // Treat anything narrower than ~720px as mobile-ish. Tablets in
    // landscape (1024+) will land on the clipboard path, which is what
    // their users expect from a desktop-class UI.
    return window.matchMedia?.('(max-width: 720px)')?.matches ?? false;
  }

  private async copyToClipboard(text: string): Promise<void> {
    let ok = false;

    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        // Fall through to the textarea fallback.
      }
    }

    if (!ok) {
      // execCommand fallback for older Safari and locked-down
      // browser contexts where the async clipboard API is gated.
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        ta.setAttribute('aria-hidden', 'true');
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }

    if (ok) {
      this.copied.set(true);
      // ToastService takes a plain string, not a translation key, so
      // we resolve via TranslocoService here. ttl (not duration) is
      // the field — kept short because the in-button "✓ Copied"
      // affordance is the primary feedback; the toast is a backup
      // for users with the button off-screen.
      this.toast.success(this.transloco.translate('share.copied'), { ttl: 1600 });
      window.setTimeout(() => this.copied.set(false), 1600);
    } else {
      this.toast.error(this.transloco.translate('share.failed'));
    }
  }
}
