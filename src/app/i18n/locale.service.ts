import { DOCUMENT } from '@angular/common';
import { computed, inject, Injectable, signal } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { SUPPORTED_LANGS } from './transloco.providers';

const STORAGE_KEY = 'ng-package-compat:lang';

/**
 * Owns the "active language" signal. On initialization it:
 *   1. Reads the user's saved choice from localStorage (SSR-safe).
 *   2. Falls back to the browser's `navigator.language` if supported.
 *   3. Falls back to English otherwise.
 *
 * Exposes signals so components can react to language changes without
 * subscribing to a BehaviorSubject.
 */
@Injectable({ providedIn: 'root' })
export class LocaleService {
  private readonly transloco = inject(TranslocoService);
  private readonly doc = inject(DOCUMENT);

  readonly supported = SUPPORTED_LANGS;

  private readonly _active = signal<string>(this.resolveInitial());
  readonly active = this._active.asReadonly();
  readonly dir = computed(() =>
    this.supported.find((l) => l.code === this._active())?.dir ?? 'ltr'
  );
  readonly label = computed(() =>
    this.supported.find((l) => l.code === this._active())?.label ?? 'English'
  );

  constructor() {
    // Apply current language immediately.
    this.apply(this._active());
  }

  set(lang: string): void {
    if (!this.supported.some((l) => l.code === lang)) return;
    this._active.set(lang);
    this.apply(lang);
    this.persist(lang);
  }

  private apply(lang: string): void {
    this.transloco.setActiveLang(lang);
    const dir = this.supported.find((l) => l.code === lang)?.dir ?? 'ltr';
    try {
      const htmlEl = this.doc?.documentElement;
      if (htmlEl) {
        htmlEl.setAttribute('lang', lang);
        htmlEl.setAttribute('dir', dir);
      }
    } catch {
      // Non-browser / restricted environment — no-op.
    }
  }

  private resolveInitial(): string {
    // Saved preference
    try {
      if (typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved && this.supported.some((l) => l.code === saved)) return saved;
      }
    } catch {
      /* ignore */
    }
    // Browser preference
    try {
      if (typeof navigator !== 'undefined' && navigator.language) {
        const short = navigator.language.split('-')[0];
        if (this.supported.some((l) => l.code === short)) return short;
      }
    } catch {
      /* ignore */
    }
    return 'en';
  }

  private persist(lang: string): void {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, lang);
      }
    } catch {
      /* ignore */
    }
  }
}
