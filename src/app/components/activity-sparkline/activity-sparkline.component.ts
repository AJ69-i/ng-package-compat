import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslocoModule } from '@jsverse/transloco';

/**
 * Tiny 52-week commit-activity sparkline (Phase 3 feature #6).
 *
 * Renders a compact SVG bar chart of weekly commit counts plus a
 * one-line caption summarising what it means ("226 commits in 31
 * active weeks · 12 in the last week"). Sits next to the vitality
 * chip in package-meta and gives an at-a-glance "is this alive?"
 * trajectory signal that a single number can't.
 *
 * # Why this is a better signal than "stars over time"
 *
 * Stars are a one-way accumulator — a library can be dead for 3
 * years and still look "growing" by stars. Commits, in contrast,
 * are a true cadence signal. A dropoff is visible immediately,
 * a steady cadence is visible immediately, a burst of recent work
 * after a quiet stretch is visible immediately. Compresses ~52
 * data points of nuance into a 100-pixel-wide visualisation.
 *
 * # A11Y
 *
 * The visualisation is purely decorative for screen-reader users —
 * the meaningful information is the caption ("226 commits over 52
 * weeks, 31 active weeks") which renders as plain text right next
 * to it. The SVG carries role="img" + aria-label that summarises
 * the bars so users on mixed-modality (sighted but using a SR for
 * navigation) get the same takeaway.
 */
@Component({
  selector: 'app-activity-sparkline',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TranslocoModule],
  template: `
    @if (visible()) {
      <div class="actsp" role="group" [attr.aria-label]="'commitActivity.aria' | transloco">
        <svg
          class="actsp-svg"
          viewBox="0 0 104 24"
          preserveAspectRatio="none"
          role="img"
          [attr.aria-label]="('commitActivity.summary' | transloco: { total: total(), active: activeWeeks(), recent: recent() })"
        >
          @for (b of bars(); track b.idx) {
            <rect
              class="bar"
              [class.bar-recent]="b.idx >= 48"
              [attr.x]="b.x"
              [attr.y]="b.y"
              [attr.width]="b.w"
              [attr.height]="b.h"
              [attr.rx]="0.4"
            />
          }
        </svg>
        <span class="actsp-caption">
          {{ 'commitActivity.captionShort' | transloco: { total: total(), active: activeWeeks() } }}
          @if (recent() > 0) {
            <span class="dot" aria-hidden="true">·</span>
            <span class="recent">
              {{ 'commitActivity.recent' | transloco: { n: recent() } }}
            </span>
          }
        </span>
      </div>
    }
  `,
  styles: [`
    :host { display: inline-flex; }
    .actsp {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.2rem 0.55rem;
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-pill, 999px);
      font-size: 0.78rem;
      color: var(--fg-dim);
    }
    .actsp-svg {
      display: block;
      width: 104px;
      height: 24px;
      flex: 0 0 auto;
    }
    .bar {
      fill: color-mix(in srgb, var(--accent) 60%, var(--fg-dim));
      transition: fill 160ms var(--ease, ease);
    }
    /* Last ~4 bars (most recent month) get the brighter accent so
       the eye is drawn to "what's happening now" rather than the
       whole year-long flat ribbon. */
    .bar-recent {
      fill: var(--accent);
    }
    .actsp-caption {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      color: var(--fg-dim);
      white-space: nowrap;
    }
    .actsp-caption .recent {
      color: var(--fg);
      font-weight: 600;
    }
    .actsp-caption .dot {
      color: var(--border);
    }
  `]
})
export class ActivitySparklineComponent {
  /** 52 weekly commit counts, oldest first. Empty array hides the chip. */
  readonly weeklyTotals = input<number[]>([]);

  readonly visible = computed<boolean>(() =>
    this.weeklyTotals().length > 0 && this.weeklyTotals().some((n) => n > 0)
  );

  readonly total = computed<number>(() =>
    this.weeklyTotals().reduce((a, b) => a + b, 0)
  );
  readonly activeWeeks = computed<number>(() =>
    this.weeklyTotals().filter((n) => n > 0).length
  );
  readonly recent = computed<number>(() => {
    const arr = this.weeklyTotals();
    return arr.length > 0 ? arr[arr.length - 1] : 0;
  });

  /**
   * Pre-computed bar geometry — width/height/x/y for each of the 52
   * weekly bars. Computing once via computed() means CD doesn't
   * recalc on every animation tick.
   *
   * Layout:
   *   - viewBox is 104×24 (matches CSS) so we don't have to do
   *     px-conversion math.
   *   - Each bar is 1.6px wide with 0.4px gap → 52 × 2 = 104 total.
   *   - Heights scale linearly from 0 to the week with most commits.
   *     We use a 1.5px floor so non-zero weeks are always visible
   *     (a single commit shouldn't disappear into a flat baseline).
   */
  readonly bars = computed<Array<{ idx: number; x: number; y: number; w: number; h: number }>>(() => {
    const arr = this.weeklyTotals();
    if (!arr.length) return [];
    const max = Math.max(...arr, 1);
    const barW = 1.6;
    const gap = 0.4;
    const minH = 1.5;
    const maxH = 22;
    return arr.map((n, idx) => {
      const ratio = max > 0 ? n / max : 0;
      const h = n > 0 ? Math.max(minH, maxH * ratio) : 0.6;
      const y = 24 - h - 1; // 1px bottom padding
      const x = idx * (barW + gap);
      return { idx, x, y, w: barW, h };
    });
  });
}
