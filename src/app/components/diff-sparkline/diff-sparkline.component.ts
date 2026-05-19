import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HistorySnapshot } from '../../services/history-db.service';

interface SparkPoint {
  ts: number;
  conflict: number;
  warning: number;
  safe: number;
  total: number;
  /** Conflict ratio, 0–1. */
  ratio: number;
}

/**
 * Trend sparkline for snapshot history.
 *
 * Renders a compact SVG line chart showing the conflict ratio over time
 * across the provided snapshots. A second, fainter line tracks the "safe"
 * ratio so the viewer sees divergence between progress and risk. No
 * dependencies — hand-rolled SVG to keep the bundle untouched.
 *
 * Inputs:
 *   - `snapshots`  — chronological list (newest first OR oldest first works,
 *                    the component sorts internally)
 *   - `width` / `height` — optional sizing, defaults 220 × 52
 *
 * Usage:
 *   <app-diff-sparkline [snapshots]="history.snapshots()"></app-diff-sparkline>
 */
@Component({
  selector: 'app-diff-sparkline',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  template: `
    @if (points().length >= 2) {
      <figure class="spark" [attr.aria-label]="ariaLabel()">
        <svg [attr.viewBox]="'0 0 ' + w() + ' ' + h()"
             [attr.width]="w()" [attr.height]="h()"
             role="img" focusable="false">
          <!-- Baseline -->
          <line [attr.x1]="0" [attr.y1]="h() - 0.5"
                [attr.x2]="w()" [attr.y2]="h() - 0.5"
                stroke="var(--border, #e5e7eb)" stroke-width="1"/>

          <!-- Safe ratio (filled area, muted green) -->
          <path [attr.d]="safePath()"
                fill="color-mix(in srgb, #10b981 18%, transparent)"
                stroke="none"/>

          <!-- Conflict ratio (strong line, red) -->
          <path [attr.d]="conflictPath()"
                fill="none"
                stroke="#ef4444"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"/>

          <!-- Last point dot -->
          <circle [attr.cx]="lastDot().x" [attr.cy]="lastDot().y" r="3"
                  fill="#ef4444" stroke="var(--surface-1, #fff)" stroke-width="1.5"/>
        </svg>
        <figcaption class="caption">
          <span class="legend"><span class="dot red"></span>{{ latest().conflict }} blocking</span>
          <span class="legend"><span class="dot green"></span>{{ latest().safe }} safe</span>
          <span class="delta" [class.up]="trend() > 0" [class.down]="trend() < 0">
            {{ trendLabel() }}
          </span>
        </figcaption>
      </figure>
    } @else {
      <small class="na">Need at least 2 snapshots to show a trend.</small>
    }
  `,
  styles: [
    `
      :host { display: inline-block; }
      .spark { margin: 0; }
      svg { display: block; }
      .caption {
        display: flex; gap: 0.65rem; align-items: center;
        font-size: 0.75rem; color: var(--fg-dim, #555);
        margin-top: 0.25rem;
      }
      .legend { display: inline-flex; align-items: center; gap: 0.3rem; }
      .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
      .dot.red { background: #ef4444; }
      .dot.green { background: #10b981; }
      .delta { margin-inline-start: auto; font-weight: 600; color: var(--fg-dim, #555); }
      .delta.up { color: #b91c1c; }
      .delta.down { color: #047857; }
      .na { color: var(--fg-dim, #777); font-size: 0.8rem; }
    `
  ]
})
export class DiffSparklineComponent {
  readonly snapshots = input<HistorySnapshot[]>([]);
  readonly width = input<number>(220);
  readonly height = input<number>(52);

  readonly w = computed(() => this.width());
  readonly h = computed(() => this.height());

  /** Snapshots sorted oldest → newest, with ratios precomputed. */
  readonly points = computed<SparkPoint[]>(() => {
    const snaps = [...this.snapshots()].filter(Boolean);
    snaps.sort((a, b) => a.createdAt - b.createdAt);
    return snaps.map((s) => {
      const total = Math.max(1, s.summary.total);
      return {
        ts: s.createdAt,
        conflict: s.summary.conflict,
        warning: s.summary.warning,
        safe: s.summary.safe,
        total,
        ratio: s.summary.conflict / total
      };
    });
  });

  readonly latest = computed<SparkPoint>(() => {
    const p = this.points();
    return p.length
      ? p[p.length - 1]
      : { ts: 0, conflict: 0, warning: 0, safe: 0, total: 1, ratio: 0 };
  });

  /** Change in conflict ratio between first and last snapshot. */
  readonly trend = computed<number>(() => {
    const p = this.points();
    if (p.length < 2) return 0;
    return +(p[p.length - 1].ratio - p[0].ratio).toFixed(3);
  });

  readonly trendLabel = computed<string>(() => {
    const t = this.trend();
    if (!t) return '→';
    const pct = Math.round(Math.abs(t) * 100);
    return t > 0 ? `↑ ${pct}%` : `↓ ${pct}%`;
  });

  readonly ariaLabel = computed<string>(() => {
    const p = this.points();
    if (p.length < 2) return 'Trend unavailable';
    const first = p[0].ratio;
    const last = p[p.length - 1].ratio;
    return `Conflict ratio ${(first * 100).toFixed(0)}% to ${(last * 100).toFixed(0)}% over ${p.length} snapshots.`;
  });

  readonly conflictPath = computed<string>(() => this.linePath((p) => p.ratio));
  readonly safePath = computed<string>(() => {
    const points = this.points();
    if (points.length < 2) return '';
    const coords = points.map((p, i) => this.coord(i, 1 - (p.safe / p.total)));
    // Closed area from bottom-left to path to bottom-right
    const d = coords.map((c, i) => (i === 0 ? `M ${c.x} ${c.y}` : `L ${c.x} ${c.y}`)).join(' ');
    return `${d} L ${coords[coords.length - 1].x} ${this.h()} L ${coords[0].x} ${this.h()} Z`;
  });

  readonly lastDot = computed<{ x: number; y: number }>(() => {
    const p = this.points();
    if (!p.length) return { x: 0, y: 0 };
    return this.coord(p.length - 1, p[p.length - 1].ratio);
  });

  private linePath(accessor: (p: SparkPoint) => number): string {
    const points = this.points();
    if (points.length < 2) return '';
    return points
      .map((p, i) => {
        const c = this.coord(i, accessor(p));
        return `${i === 0 ? 'M' : 'L'} ${c.x} ${c.y}`;
      })
      .join(' ');
  }

  private coord(i: number, value01: number): { x: number; y: number } {
    const points = this.points();
    const n = points.length;
    const padX = 2, padY = 2;
    const w = this.w() - padX * 2;
    const h = this.h() - padY * 2;
    const x = padX + (i / Math.max(1, n - 1)) * w;
    const y = padY + (1 - Math.max(0, Math.min(1, value01))) * h;
    return { x, y };
  }
}
