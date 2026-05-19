import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';

export type SkeletonVariant = 'line' | 'row' | 'card' | 'circle' | 'table';

/**
 * Reusable skeleton loader.
 *
 * Historically accepted only a numeric `height` for a single shimmer bar.
 * Now supports composed variants so consumers can drop one component in any
 * context:
 *
 *   <app-skeleton [height]="16"/>                  <-- single line (legacy)
 *   <app-skeleton variant="row"/>                  <-- avatar + 2 lines
 *   <app-skeleton variant="card" [lines]="3"/>     <-- card with title + N lines
 *   <app-skeleton variant="table" [rows]="5"/>     <-- fake table rows
 *   <app-skeleton variant="circle" [size]="48"/>   <-- avatar placeholder
 *
 * All variants respect `prefers-reduced-motion` via CSS and the global
 * `body.reduced-motion` toggle set by PreferencesService.
 */
@Component({
  selector: 'app-skeleton',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  template: `
    @switch (variant()) {
      @case ('row') {
        <div class="row" role="status" aria-live="polite" aria-busy="true">
          <span class="sr-only">Loading…</span>
          <div class="circle" [style.width.px]="40" [style.height.px]="40"></div>
          <div class="col">
            <div class="bar" [style.width.%]="62"></div>
            <div class="bar muted" [style.width.%]="42"></div>
          </div>
        </div>
      }
      @case ('card') {
        <div class="card" role="status" aria-live="polite" aria-busy="true">
          <span class="sr-only">Loading…</span>
          <div class="bar title" [style.width.%]="55"></div>
          @for (i of lineRange(); track i) {
            <div class="bar" [style.width.%]="lineWidth(i)"></div>
          }
        </div>
      }
      @case ('circle') {
        <div class="circle" role="status" aria-busy="true"
             [style.width.px]="size()" [style.height.px]="size()">
          <span class="sr-only">Loading…</span>
        </div>
      }
      @case ('table') {
        <div class="table" role="status" aria-live="polite" aria-busy="true">
          <span class="sr-only">Loading table…</span>
          @for (r of rowRange(); track r) {
            <div class="trow">
              <div class="bar" [style.width.%]="35"></div>
              <div class="bar" [style.width.%]="20"></div>
              <div class="bar" [style.width.%]="15"></div>
              <div class="bar" [style.width.%]="25"></div>
            </div>
          }
        </div>
      }
      @default {
        <div class="skeleton" [style.width.%]="100" [style.height.px]="height()"
             role="status" aria-live="polite" aria-busy="true">
          <span class="sr-only">Loading…</span>
        </div>
      }
    }
  `,
  styles: [
    `
      :host { display: block; }
      .skeleton, .bar, .circle {
        display: block; border-radius: 8px;
        background: linear-gradient(90deg,
          color-mix(in srgb, var(--surface-2) 100%, transparent) 0%,
          color-mix(in srgb, var(--surface-2) 60%, var(--surface-1)) 50%,
          color-mix(in srgb, var(--surface-2) 100%, transparent) 100%);
        background-size: 200% 100%;
        animation: shimmer 1.3s infinite linear;
      }
      .bar { height: 10px; margin-top: 0.4rem; }
      .bar.muted { opacity: 0.6; }
      .bar.title { height: 14px; margin-top: 0; }
      .circle { border-radius: 50%; flex: 0 0 auto; }

      .row { display: flex; align-items: center; gap: 0.8rem; padding: 0.4rem 0; }
      .row .col { flex: 1 1 auto; }

      .card {
        padding: 0.85rem 1rem;
        border: 1px solid var(--border, #e5e7eb);
        border-radius: 12px;
        background: var(--surface-1, #fff);
      }

      .table { display: flex; flex-direction: column; gap: 0.45rem; }
      .trow { display: flex; gap: 0.75rem; padding: 0.4rem 0.25rem; }
      .trow .bar { margin-top: 0; height: 14px; }

      @keyframes shimmer {
        from { background-position: 200% 0; }
        to   { background-position: -200% 0; }
      }
      @media (prefers-reduced-motion: reduce) {
        .skeleton, .bar, .circle { animation: none; }
      }
      :host-context(body.reduced-motion) .skeleton,
      :host-context(body.reduced-motion) .bar,
      :host-context(body.reduced-motion) .circle { animation: none; }

      .sr-only {
        position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
        overflow: hidden; clip: rect(0,0,0,0); border: 0;
      }
    `
  ]
})
export class SkeletonComponent {
  /** Legacy single-bar height. */
  readonly height = input<number>(16);

  /** Composed variant. */
  readonly variant = input<SkeletonVariant>('line');

  /** Number of content lines (card variant). */
  readonly lines = input<number>(3);

  /** Number of table rows. */
  readonly rows = input<number>(4);

  /** Diameter for circle variant. */
  readonly size = input<number>(40);

  lineRange = computed<number[]>(() =>
    Array.from({ length: Math.max(1, this.lines()) }, (_, i) => i)
  );
  rowRange = computed<number[]>(() =>
    Array.from({ length: Math.max(1, this.rows()) }, (_, i) => i)
  );

  /** Stagger the widths so cards don't look mechanical. */
  lineWidth(index: number): number {
    const widths = [88, 72, 62, 90, 58, 80, 66];
    return widths[index % widths.length];
  }
}
