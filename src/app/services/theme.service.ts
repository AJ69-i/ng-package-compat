import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, effect, inject, signal } from '@angular/core';

export type Theme = 'dark' | 'light' | 'system';
const KEY = 'ngpc.theme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly doc = inject(DOCUMENT);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  readonly theme = signal<Theme>(this.initial());
  /** Effective theme after resolving 'system'. */
  readonly effective = signal<Exclude<Theme, 'system'>>('dark');

  constructor() {
    effect(() => {
      const t = this.theme();
      const eff = this.resolve(t);
      this.effective.set(eff);
      this.doc.documentElement.setAttribute('data-theme', eff);
      if (this.isBrowser) {
        try {
          localStorage.setItem(KEY, t);
        } catch {
          /* ignore */
        }
      }
    });

    if (this.isBrowser && typeof matchMedia !== 'undefined') {
      const mm = matchMedia('(prefers-color-scheme: light)');
      mm.addEventListener?.('change', () => {
        if (this.theme() === 'system') {
          this.effective.set(mm.matches ? 'light' : 'dark');
          this.doc.documentElement.setAttribute('data-theme', this.effective());
        }
      });
    }
  }

  toggle(): void {
    this.theme.update((t) => (this.resolve(t) === 'dark' ? 'light' : 'dark'));
  }

  set(theme: Theme): void {
    this.theme.set(theme);
  }

  private resolve(t: Theme): Exclude<Theme, 'system'> {
    if (t !== 'system') return t;
    if (!this.isBrowser || typeof matchMedia === 'undefined') return 'dark';
    return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  private initial(): Theme {
    if (!this.isBrowser) return 'dark';
    try {
      const saved = localStorage.getItem(KEY) as Theme | null;
      if (saved === 'dark' || saved === 'light' || saved === 'system') return saved;
    } catch {
      /* ignore */
    }
    return 'system';
  }
}
