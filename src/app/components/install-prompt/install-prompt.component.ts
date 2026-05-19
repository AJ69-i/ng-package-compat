import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  inject,
  signal
} from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { TranslocoModule } from '@jsverse/transloco';

/**
 * Typed shim for the non-standard `beforeinstallprompt` event Chrome fires
 * when a PWA becomes installable. The TS DOM lib doesn't ship this type.
 */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

const DISMISSED_KEY = 'ngpc.a2hs.dismissed';
const DISMISS_TTL_DAYS = 14;

/**
 * Add-to-Home-Screen / Install-PWA prompt.
 *
 * Why bother with a custom prompt when Chrome ships its own:
 *   - Chrome's native install chip is tiny and often missed
 *   - Firefox & Safari (iOS) don't expose `beforeinstallprompt` at all, so
 *     those users get no indication they can pin the app — this component
 *     shows them the right platform-specific instructions
 *   - We respect the "already installed" state by watching
 *     `window.matchMedia('(display-mode: standalone)')` so we don't pester
 *     users who've already installed it
 *
 * Lifecycle:
 *   1. On mount, store the `beforeinstallprompt` event for later.
 *   2. If the user is on an iOS Safari UA and the app isn't installed, we
 *      show our own "Tap Share → Add to Home Screen" hint.
 *   3. When the user clicks "Install" we call `prompt()` on the saved event.
 *   4. Either way we store a dismiss-timestamp in localStorage so we don't
 *      re-ask for two weeks.
 */
@Component({
  selector: 'app-install-prompt',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TranslocoModule],
  template: `
    @if (visible()) {
      <div class="installer" role="dialog" [attr.aria-label]="'install.ariaLabel' | transloco">
        <span class="icon" aria-hidden="true">&#128241;</span>
        <div class="body">
          <strong>{{ 'install.title' | transloco }}</strong>
          <span class="sub">{{ 'install.subtitle' | transloco }}</span>
          @if (isIos()) {
            <span class="hint">{{ 'install.iosHint' | transloco }}</span>
          }
        </div>
        <div class="actions">
          @if (!isIos()) {
            <button type="button" class="primary" (click)="install()">{{ 'install.button' | transloco }}</button>
          }
          <button type="button" class="ghost" (click)="dismiss()">{{ 'install.later' | transloco }}</button>
        </div>
      </div>
    }
  `,
  styles: [
    `
      :host { display: block; }
      .installer {
        position: fixed;
        inset-inline-start: 1rem;
        bottom: 1rem;
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.75rem 1rem;
        border-radius: 14px;
        background: var(--surface-1, #fff);
        border: 1px solid var(--border, #e5e7eb);
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.12);
        z-index: 50;
        max-width: min(92vw, 420px);
        animation: slide-up 0.3s ease-out;
      }
      @keyframes slide-up {
        from { transform: translateY(30px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
      .icon { font-size: 1.4rem; }
      .body {
        display: flex;
        flex-direction: column;
        gap: 2px;
        font-size: 0.9rem;
        flex: 1;
      }
      .sub, .hint { color: var(--fg-dim, #555); font-size: 0.78rem; }
      .hint { font-style: italic; }
      .actions { display: flex; gap: 0.4rem; }
      button {
        cursor: pointer;
        border-radius: 999px;
        padding: 6px 14px;
        font-size: 0.82rem;
        font-weight: 600;
        border: 1px solid transparent;
      }
      button.primary {
        background: var(--accent, #6366f1);
        color: #fff;
      }
      button.ghost {
        background: transparent;
        color: var(--fg-dim, #555);
        border-color: var(--border, #e5e7eb);
      }
    `
  ]
})
export class InstallPromptComponent implements OnInit, OnDestroy {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  readonly visible = signal<boolean>(false);
  readonly isIos = signal<boolean>(false);

  private pendingPrompt: BeforeInstallPromptEvent | null = null;
  private readonly onBeforeInstall = (ev: Event): void => {
    ev.preventDefault();
    this.pendingPrompt = ev as BeforeInstallPromptEvent;
    if (this.shouldShow()) this.visible.set(true);
  };
  private readonly onInstalled = (): void => {
    this.visible.set(false);
    this.pendingPrompt = null;
  };

  ngOnInit(): void {
    if (!this.isBrowser) return;

    if (this.isStandalone()) return; // Already installed — stay silent.

    // iOS Safari — no beforeinstallprompt, so we show the hint manually.
    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/.test(ua) && !/CriOS|FxiOS/.test(ua)) {
      this.isIos.set(true);
      if (this.shouldShow()) this.visible.set(true);
    }

    window.addEventListener('beforeinstallprompt', this.onBeforeInstall);
    window.addEventListener('appinstalled', this.onInstalled);
  }

  ngOnDestroy(): void {
    if (!this.isBrowser) return;
    window.removeEventListener('beforeinstallprompt', this.onBeforeInstall);
    window.removeEventListener('appinstalled', this.onInstalled);
  }

  async install(): Promise<void> {
    if (!this.pendingPrompt) {
      this.visible.set(false);
      return;
    }
    try {
      await this.pendingPrompt.prompt();
      const choice = await this.pendingPrompt.userChoice;
      if (choice.outcome === 'dismissed') this.remember();
    } finally {
      this.pendingPrompt = null;
      this.visible.set(false);
    }
  }

  dismiss(): void {
    this.remember();
    this.visible.set(false);
  }

  private isStandalone(): boolean {
    if (!this.isBrowser) return false;
    const mqMatches = typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches;
    // iOS Safari exposes `navigator.standalone` instead of display-mode
    const iosStandalone = (navigator as unknown as { standalone?: boolean }).standalone === true;
    return !!mqMatches || iosStandalone;
  }

  private shouldShow(): boolean {
    if (!this.isBrowser) return false;
    try {
      const raw = localStorage.getItem(DISMISSED_KEY);
      if (!raw) return true;
      const ts = Number(raw);
      if (!Number.isFinite(ts)) return true;
      const ageDays = (Date.now() - ts) / (1000 * 60 * 60 * 24);
      return ageDays > DISMISS_TTL_DAYS;
    } catch {
      return true;
    }
  }

  private remember(): void {
    if (!this.isBrowser) return;
    try {
      localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
  }
}
