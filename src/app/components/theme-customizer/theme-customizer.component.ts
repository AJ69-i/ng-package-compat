import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslocoModule } from '@jsverse/transloco';
import { PreferencesService, AccentPreset, FontScale, LayoutDensity } from '../../services/preferences.service';
import { SyncStatusComponent } from '../sync-status/sync-status.component';

/**
 * Floating "cog" button that opens a preferences panel.
 *
 * All visuals — accent color, font scale, reduced motion, high contrast,
 * color-blind-safe palette — are set via PreferencesService which applies
 * them reactively to :root and <body>, so there is no one-off template
 * logic here.
 */
@Component({
  selector: 'app-theme-customizer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TranslocoModule, SyncStatusComponent],
  template: `
    <button
      type="button"
      class="trigger"
      (click)="toggle()"
      [attr.aria-expanded]="open()"
      [attr.aria-label]="'preferences.ariaLabel' | transloco"
    >
      <span aria-hidden="true">⚙</span>
    </button>

    @if (open()) {
      <div class="sheet" role="dialog" aria-modal="false" [attr.aria-label]="'preferences.title' | transloco">
        <header>
          <h3>{{ 'preferences.title' | transloco }}</h3>
          <button type="button" class="close" (click)="toggle()" aria-label="Close">×</button>
        </header>

        <fieldset>
          <legend>{{ 'preferences.accent' | transloco }}</legend>
          <div class="swatches">
            @for (a of prefs.accents(); track a.id) {
              <button
                type="button"
                class="swatch"
                [class.active]="prefs.prefs().accent === a.id"
                [style.background]="a.swatch"
                [attr.aria-label]="a.name"
                [attr.aria-pressed]="prefs.prefs().accent === a.id"
                (click)="setAccent(a.id)"
              ></button>
            }
          </div>
        </fieldset>

        <fieldset>
          <legend>{{ 'preferences.fontScale' | transloco }}</legend>
          <div class="seg">
            <button type="button" [class.active]="prefs.prefs().fontScale === 'small'" (click)="setFont('small')">A</button>
            <button type="button" [class.active]="prefs.prefs().fontScale === 'medium'" (click)="setFont('medium')">A</button>
            <button type="button" [class.active]="prefs.prefs().fontScale === 'large'" (click)="setFont('large')">A</button>
          </div>
        </fieldset>

        <fieldset>
          <legend>{{ 'preferences.density' | transloco }}</legend>
          <div class="seg">
            <button
              type="button"
              [class.active]="prefs.prefs().density === 'compact'"
              [title]="'preferences.densityCompactHint' | transloco"
              (click)="setDensity('compact')"
            >{{ 'preferences.densityCompact' | transloco }}</button>
            <button
              type="button"
              [class.active]="prefs.prefs().density === 'comfortable'"
              [title]="'preferences.densityComfortableHint' | transloco"
              (click)="setDensity('comfortable')"
            >{{ 'preferences.densityComfortable' | transloco }}</button>
            <button
              type="button"
              [class.active]="prefs.prefs().density === 'wide'"
              [title]="'preferences.densityWideHint' | transloco"
              (click)="setDensity('wide')"
            >{{ 'preferences.densityWide' | transloco }}</button>
          </div>
        </fieldset>

        <fieldset class="toggles">
          <label>
            <input type="checkbox" [checked]="prefs.prefs().reducedMotion" (change)="toggleMotion()">
            <span>{{ 'preferences.reducedMotion' | transloco }}</span>
          </label>
          <label>
            <input type="checkbox" [checked]="prefs.prefs().highContrast" (change)="toggleContrast()">
            <span>{{ 'preferences.highContrast' | transloco }}</span>
          </label>
          <label>
            <input type="checkbox" [checked]="prefs.prefs().colorBlindSafe" (change)="toggleCb()">
            <span>{{ 'preferences.colorBlind' | transloco }}</span>
          </label>
        </fieldset>

        <!-- Personal-data sync: only meaningful for signed-in users, but
             the row also surfaces the sign-in CTA when signed out. -->
        <app-sync-status />

        <footer>
          <button type="button" class="ghost" (click)="reset()">{{ 'preferences.reset' | transloco }}</button>
        </footer>
      </div>
    }
  `,
  styles: [
    `
      :host { display: contents; }
      .trigger {
        position: fixed;
        bottom: 1rem;
        inset-inline-end: 1rem;
        width: 44px; height: 44px;
        border-radius: 50%;
        border: 1px solid var(--border, #e5e7eb);
        background: var(--surface-1, #fff);
        box-shadow: 0 6px 18px rgba(0,0,0,0.12);
        cursor: pointer;
        font-size: 1.15rem;
        color: var(--fg, #111);
        z-index: 45;
      }
      .trigger:hover { transform: rotate(45deg); transition: transform 0.25s; }
      body.reduced-motion .trigger:hover { transform: none; }

      .sheet {
        position: fixed;
        bottom: 4.5rem;
        inset-inline-end: 1rem;
        width: min(320px, 92vw);
        background: var(--surface-1, #fff);
        border: 1px solid var(--border, #e5e7eb);
        border-radius: 14px;
        padding: 1rem 1.1rem;
        box-shadow: 0 18px 38px rgba(0,0,0,0.18);
        z-index: 46;
        color: var(--fg, #111);
        animation: slide-up 0.22s ease-out;
      }
      body.reduced-motion .sheet { animation: none; }
      @keyframes slide-up {
        from { transform: translateY(10px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
      header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
      header h3 { margin: 0; font-size: 1rem; }
      .close { border: none; background: none; font-size: 1.3rem; cursor: pointer; color: var(--fg-dim, #666); }
      fieldset { border: none; padding: 0; margin: 0.65rem 0; }
      legend { font-size: 0.78rem; font-weight: 700; color: var(--fg-dim, #555); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 0.35rem; }
      .swatches { display: flex; gap: 0.4rem; flex-wrap: wrap; }
      .swatch {
        width: 28px; height: 28px;
        border-radius: 50%;
        border: 2px solid transparent;
        cursor: pointer;
        padding: 0;
      }
      .swatch.active { border-color: var(--fg, #111); box-shadow: 0 0 0 2px var(--surface-1, #fff) inset; }
      .seg { display: inline-flex; border: 1px solid var(--border, #e5e7eb); border-radius: 8px; overflow: hidden; }
      .seg button {
        flex: 1;
        border: none;
        padding: 0.35rem 0.9rem;
        background: transparent;
        cursor: pointer;
        color: var(--fg-dim, #555);
      }
      .seg button:nth-child(1) { font-size: 0.78rem; }
      .seg button:nth-child(2) { font-size: 0.95rem; }
      .seg button:nth-child(3) { font-size: 1.1rem; }
      .seg button.active { background: var(--accent, #6366f1); color: #fff; }
      .toggles { display: flex; flex-direction: column; gap: 0.45rem; }
      .toggles label { display: flex; align-items: center; gap: 0.55rem; font-size: 0.88rem; cursor: pointer; }
      footer { display: flex; justify-content: flex-end; margin-top: 0.5rem; }
      .ghost {
        background: transparent;
        border: 1px solid var(--border, #e5e7eb);
        color: var(--fg-dim, #555);
        border-radius: 6px;
        padding: 0.3rem 0.75rem;
        font-size: 0.82rem;
        cursor: pointer;
      }
    `
  ]
})
export class ThemeCustomizerComponent {
  protected readonly prefs = inject(PreferencesService);
  readonly open = signal<boolean>(false);

  toggle(): void { this.open.update((v) => !v); }

  setAccent(id: AccentPreset): void { this.prefs.set('accent', id); }
  setFont(f: FontScale): void { this.prefs.set('fontScale', f); }
  setDensity(d: LayoutDensity): void { this.prefs.set('density', d); }
  toggleMotion(): void { this.prefs.set('reducedMotion', !this.prefs.prefs().reducedMotion); }
  toggleContrast(): void { this.prefs.set('highContrast', !this.prefs.prefs().highContrast); }
  toggleCb(): void { this.prefs.set('colorBlindSafe', !this.prefs.prefs().colorBlindSafe); }
  reset(): void { this.prefs.reset(); }
}
