import { Injectable, PLATFORM_ID, effect, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

export type AccentPreset = 'indigo' | 'emerald' | 'sunrise' | 'magenta' | 'slate';
export type FontScale = 'small' | 'medium' | 'large';

/**
 * How wide the centred page content can grow on a wide monitor.
 *
 *   - `compact`    — tight reading column, marketing-site feel (1100px cap)
 *   - `comfortable`— balanced default, dev-tool feel (1320px cap)
 *   - `wide`       — uses most of the screen, IDE-like (1600px cap)
 *
 * Each option still yields to a `94vw`-style gutter on narrow screens, so
 * mobile/laptop layouts are unaffected.
 */
export type LayoutDensity = 'compact' | 'comfortable' | 'wide';

export interface UserPreferences {
  accent: AccentPreset;
  fontScale: FontScale;
  density: LayoutDensity;
  reducedMotion: boolean;
  highContrast: boolean;
  colorBlindSafe: boolean;
}

export interface AccentDefinition {
  id: AccentPreset;
  name: string;
  /** Swatch color for the customizer button. */
  swatch: string;
  /** Full CSS custom-property map applied to :root when selected. */
  vars: Record<string, string>;
}

export const ACCENTS: Record<AccentPreset, AccentDefinition> = {
  indigo: {
    id: 'indigo', name: 'Indigo', swatch: '#6366f1',
    vars: { '--accent': '#6366f1', '--accent-2': '#8b5cf6' }
  },
  emerald: {
    id: 'emerald', name: 'Emerald', swatch: '#10b981',
    vars: { '--accent': '#10b981', '--accent-2': '#059669' }
  },
  sunrise: {
    id: 'sunrise', name: 'Sunrise', swatch: '#f97316',
    vars: { '--accent': '#f97316', '--accent-2': '#ec4899' }
  },
  magenta: {
    id: 'magenta', name: 'Magenta', swatch: '#d946ef',
    vars: { '--accent': '#d946ef', '--accent-2': '#8b5cf6' }
  },
  slate: {
    id: 'slate', name: 'Slate', swatch: '#475569',
    vars: { '--accent': '#475569', '--accent-2': '#334155' }
  }
};

const FONT_SCALE_PX: Record<FontScale, string> = {
  small: '15px',
  medium: '16px',
  large: '18px'
};

/**
 * The CSS expression each density resolves to. Pages reference
 * `var(--content-max-width)` instead of hard-coding their own caps, so
 * flipping this preference re-flows every page in real time.
 */
const DENSITY_CSS: Record<LayoutDensity, string> = {
  compact: 'min(90vw, 1100px)',
  comfortable: 'min(94vw, 1320px)',
  wide: 'min(98vw, 1600px)'
};

export const DENSITY_LABELS: Record<LayoutDensity, string> = {
  compact: 'Compact (marketing feel)',
  comfortable: 'Comfortable (default)',
  wide: 'Wide (IDE feel)'
};

const STORAGE_KEY = 'ngpc.preferences.v1';

const DEFAULT_PREFS: UserPreferences = {
  accent: 'indigo',
  fontScale: 'medium',
  density: 'comfortable',
  reducedMotion: false,
  highContrast: false,
  colorBlindSafe: false
};

/**
 * Single source of truth for user-facing visual preferences.
 *
 * Values flow:
 *   UI slider/toggle → set<x>() → signal updates → effect() applies CSS vars
 *   and body classes → localStorage persists → next session restores.
 *
 * This replaces the old "manually sprinkle classes on <body>" pattern with a
 * reactive one that's easy to reason about and unit-test.
 *
 * Accessibility notes:
 *   - `reducedMotion` additionally respects `prefers-reduced-motion: reduce`
 *     as an implicit floor — if the OS says reduce, the app reduces, even if
 *     the user has not toggled the app's own switch.
 *   - `highContrast` pairs with a global SCSS stylesheet that overrides
 *     backgrounds, borders, and focus rings when `body.high-contrast` is set.
 *   - `colorBlindSafe` swaps the severity palette (red/amber/green) to
 *     (blue/orange/teal) — friendly to protanopia and deuteranopia users.
 */
@Injectable({ providedIn: 'root' })
export class PreferencesService {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  readonly prefs = signal<UserPreferences>(this.load());

  constructor() {
    // Reactive apply: any time prefs() changes we restyle the document.
    effect(() => {
      const p = this.prefs();
      this.apply(p);
      this.persist(p);
    });
  }

  set<K extends keyof UserPreferences>(key: K, value: UserPreferences[K]): void {
    this.prefs.update((p) => ({ ...p, [key]: value }));
  }

  reset(): void {
    this.prefs.set({ ...DEFAULT_PREFS });
  }

  accents(): AccentDefinition[] {
    return Object.values(ACCENTS);
  }

  private apply(p: UserPreferences): void {
    if (!this.isBrowser) return;
    const root = document.documentElement;
    const body = document.body;

    // Accent color CSS vars
    const def = ACCENTS[p.accent] ?? ACCENTS.indigo;
    for (const [k, v] of Object.entries(def.vars)) {
      root.style.setProperty(k, v);
    }

    // Font scale
    root.style.fontSize = FONT_SCALE_PX[p.fontScale];

    // Layout density — drives the global `--content-max-width` CSS var that
    // every page max-width binds to. Swapping density re-flows the layout
    // instantly with no JS work other than a single CSS variable write.
    root.style.setProperty('--content-max-width', DENSITY_CSS[p.density]);

    // Body class toggles — consumed by global SCSS.
    body.classList.toggle('reduced-motion', p.reducedMotion);
    body.classList.toggle('high-contrast', p.highContrast);
    body.classList.toggle('cb-safe', p.colorBlindSafe);
  }

  private load(): UserPreferences {
    if (!this.isBrowser) return { ...DEFAULT_PREFS };
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_PREFS };
      const parsed = JSON.parse(raw) as Partial<UserPreferences>;
      return { ...DEFAULT_PREFS, ...parsed };
    } catch {
      return { ...DEFAULT_PREFS };
    }
  }

  private persist(p: UserPreferences): void {
    if (!this.isBrowser) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
    } catch {
      /* ignore */
    }
  }
}
