import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslocoModule } from '@jsverse/transloco';
import { AdoptionCost, AdoptionCostFactor, AdoptionCostTier } from '../../services/adoption-cost.service';

/**
 * Headline "Adoption Cost" chip with click-to-expand breakdown
 * (Phase 3 feature #9).
 *
 * # The UX intent
 *
 * One pill, four tiers (Low / Moderate / High / Heavy), color-coded
 * to the existing semantic tokens (--ok / --warn / --bad). The pill
 * is the first thing the user sees in the package-meta. Clicking it
 * expands an inline panel that lists the six contributing factors
 * with their per-factor points + display text.
 *
 * # Why a button-with-expansion instead of a popover/tooltip
 *
 * - Popovers have positioning issues on mobile + RTL layouts.
 * - Tooltips can't be keyboard-dismissed without ARIA gymnastics.
 * - Native `<details>` is keyboard-accessible by default and works
 *   correctly in print (the print stylesheet auto-opens it).
 *
 * # Confidence dimming
 *
 * When `knownFactorCount < 4` (less than ⅔ of the inputs are real
 * data), we dim the pill and append "low data" so the user knows
 * the headline is best-effort. This is honest about the model and
 * avoids over-confident assertions like "this 3 kB package with
 * unknown vitality, unknown deprecation, and unknown license is
 * definitely Low cost."
 */
@Component({
  selector: 'app-adoption-cost-chip',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TranslocoModule],
  template: `
    @if (cost(); as c) {
      <div class="ac-wrap">
        <details class="ac-details" [open]="open()">
          <summary
            class="ac-summary"
            [class.tier-low]="c.tier === 'low'"
            [class.tier-moderate]="c.tier === 'moderate'"
            [class.tier-high]="c.tier === 'high'"
            [class.tier-heavy]="c.tier === 'heavy'"
            [class.low-data]="c.knownFactorCount < 4"
            (click)="onToggle($event)"
            [attr.aria-label]="('adoptionCost.aria' | transloco: { tier: ('adoptionCost.tier.' + c.tier | transloco), score: c.score })"
          >
            <span class="ac-ico" aria-hidden="true">📊</span>
            <span class="ac-label">{{ 'adoptionCost.headline' | transloco }}</span>
            <span class="ac-tier-pill">{{ 'adoptionCost.tier.' + c.tier | transloco }}</span>
            <span class="ac-score">{{ c.score }}/100</span>
            @if (c.knownFactorCount < 4) {
              <span class="ac-lowdata" [attr.title]="'adoptionCost.lowDataTitle' | transloco">
                · {{ 'adoptionCost.lowData' | transloco }}
              </span>
            }
            <span class="ac-chev" aria-hidden="true">{{ open() ? '▾' : '▸' }}</span>
          </summary>

          <div class="ac-breakdown" role="group" [attr.aria-label]="'adoptionCost.breakdownAria' | transloco">
            <ul class="ac-factor-list">
              @for (f of c.factors; track f.key) {
                <li class="ac-factor" [class.unknown]="f.unknown">
                  <span class="ac-factor-name">
                    {{ 'adoptionCost.factor.' + f.key | transloco }}
                  </span>
                  <span class="ac-factor-display">{{ f.display }}</span>
                  <span class="ac-factor-bar" aria-hidden="true">
                    <span
                      class="ac-factor-fill"
                      [style.width.%]="barFillPct(f)"
                    ></span>
                  </span>
                  <span class="ac-factor-points">
                    +{{ f.points }}<span class="dim">/{{ f.cap }}</span>
                  </span>
                </li>
              }
            </ul>
            <p class="ac-disclaimer">
              {{ 'adoptionCost.disclaimer' | transloco }}
            </p>
          </div>
        </details>
      </div>
    }
  `,
  styles: [`
    :host { display: block; }

    .ac-wrap { display: block; margin-top: 0.5rem; }

    .ac-details {
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-md, 10px);
      overflow: hidden;
    }

    .ac-summary {
      list-style: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.55rem 0.85rem;
      font-size: 0.85rem;
      color: var(--fg);
      transition: background-color 140ms ease;
      flex-wrap: wrap;
    }
    .ac-summary::-webkit-details-marker { display: none; }
    .ac-summary:hover { background: var(--surface-2); }
    .ac-summary:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }

    .ac-ico { font-size: 0.95rem; line-height: 1; flex: 0 0 auto; }
    .ac-label {
      font-weight: 700;
      color: var(--fg);
    }

    /* Tier pill — strong color cue. Each tier maps to a semantic
       token so dark/light theme parity is automatic. */
    .ac-tier-pill {
      padding: 0.12rem 0.55rem;
      border-radius: var(--radius-pill, 999px);
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      border: 1px solid var(--border);
    }
    .tier-low .ac-tier-pill {
      background: color-mix(in srgb, var(--ok) 15%, transparent);
      border-color: color-mix(in srgb, var(--ok) 50%, var(--border));
      color: var(--ok);
    }
    .tier-moderate .ac-tier-pill {
      background: color-mix(in srgb, var(--warn) 12%, transparent);
      border-color: color-mix(in srgb, var(--warn) 45%, var(--border));
      color: var(--warn);
    }
    .tier-high .ac-tier-pill {
      background: color-mix(in srgb, var(--warn) 20%, transparent);
      border-color: color-mix(in srgb, var(--warn) 65%, var(--border));
      color: var(--warn);
      font-weight: 800;
    }
    .tier-heavy .ac-tier-pill {
      background: color-mix(in srgb, var(--bad) 18%, transparent);
      border-color: color-mix(in srgb, var(--bad) 55%, var(--border));
      color: var(--bad);
      font-weight: 800;
    }

    .ac-score {
      color: var(--fg-dim);
      font-size: 0.78rem;
      font-variant-numeric: tabular-nums;
    }
    .ac-lowdata {
      color: var(--fg-dim);
      font-size: 0.75rem;
      font-style: italic;
    }
    .low-data { opacity: 0.85; }

    .ac-chev {
      margin-left: auto;
      color: var(--fg-dim);
      font-size: 0.75rem;
      flex: 0 0 auto;
    }

    .ac-breakdown {
      border-top: 1px solid var(--border);
      padding: 0.85rem 1rem 0.9rem;
      background: var(--surface-2);
    }

    .ac-factor-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 0.5rem;
    }
    .ac-factor {
      display: grid;
      grid-template-columns: 8rem 7rem 1fr auto;
      align-items: center;
      gap: 0.6rem;
      font-size: 0.82rem;
    }
    @media (max-width: 540px) {
      .ac-factor {
        grid-template-columns: 1fr auto;
        grid-template-areas: "name pts" "display display" "bar bar";
      }
      .ac-factor-name { grid-area: name; }
      .ac-factor-display { grid-area: display; }
      .ac-factor-bar { grid-area: bar; }
      .ac-factor-points { grid-area: pts; }
    }
    .ac-factor.unknown { opacity: 0.55; }
    .ac-factor-name {
      color: var(--fg);
      font-weight: 600;
    }
    .ac-factor-display {
      color: var(--fg-dim);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.78rem;
    }
    .ac-factor-bar {
      display: inline-block;
      width: 100%;
      height: 6px;
      background: var(--surface-1);
      border-radius: 999px;
      overflow: hidden;
      position: relative;
    }
    .ac-factor-fill {
      display: block;
      height: 100%;
      background: linear-gradient(
        90deg,
        var(--ok) 0%,
        var(--warn) 60%,
        var(--bad) 100%
      );
      transition: width 200ms var(--ease, ease);
    }
    .ac-factor-points {
      color: var(--fg-dim);
      font-size: 0.78rem;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .ac-factor-points .dim {
      opacity: 0.55;
    }

    .ac-disclaimer {
      margin: 0.7rem 0 0;
      padding: 0.5rem 0.7rem;
      background: var(--surface-1);
      border-left: 3px solid var(--border);
      border-radius: var(--radius-sm, 6px);
      color: var(--fg-dim);
      font-size: 0.75rem;
      line-height: 1.5;
    }
  `]
})
export class AdoptionCostChipComponent {
  /** Pre-computed AdoptionCost from AdoptionCostService.compute(). */
  readonly cost = input<AdoptionCost | null>(null);

  /** Whether the details panel is expanded. Toggled by clicks/keys. */
  readonly open = signal<boolean>(false);

  /**
   * Width of each factor's fill bar, as % of its cap. We chose
   * "% of cap" rather than "% of total score" because the breakdown
   * is about HOW the per-factor budget was consumed — a 25-point
   * deprecated factor shouldn't visually dwarf a 15-point license
   * factor just because the cap is bigger. Each row's fill maxes
   * out at 100% of its own row.
   */
  barFillPct(f: AdoptionCostFactor): number {
    if (f.cap <= 0) return 0;
    return Math.max(0, Math.min(100, (f.points / f.cap) * 100));
  }

  onToggle(ev: MouseEvent): void {
    // Prevent the native <details> from toggling — we own the
    // state via the `open` signal so the template can react.
    ev.preventDefault();
    this.open.update((v) => !v);
  }
}

// Re-export tier for the search-page's convenience.
export type { AdoptionCostTier };
