import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

@Component({
  selector: 'app-sparkline',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      [attr.viewBox]="'0 0 ' + width + ' ' + height"
      preserveAspectRatio="none"
      class="spark"
      role="img"
      [attr.aria-label]="ariaLabel()"
    >
      @if (points()) {
        <polygon [attr.points]="areaPoints()" fill="currentColor" fill-opacity="0.15" />
        <polyline
          [attr.points]="points()"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linejoin="round"
          stroke-linecap="round"
        />
      }
    </svg>
  `,
  styles: [`
    :host { display: inline-block; color: var(--accent); line-height: 0; width: 100%; max-width: 180px; }
    .spark { width: 100%; height: 40px; }
  `]
})
export class SparklineComponent {
  readonly width = 140;
  readonly height = 36;

  readonly data = input<number[]>([]);
  readonly ariaHint = input<string>('weekly downloads trend');

  readonly points = computed(() => {
    const vals = this.data();
    if (!vals.length) return '';
    const max = Math.max(...vals, 1);
    const min = Math.min(...vals, 0);
    const range = max - min || 1;
    const step = vals.length > 1 ? this.width / (vals.length - 1) : 0;
    return vals
      .map((v, i) => {
        const x = i * step;
        const y = this.height - ((v - min) / range) * this.height;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  });

  readonly areaPoints = computed(() => {
    const pts = this.points();
    if (!pts) return '';
    return `0,${this.height} ${pts} ${this.width},${this.height}`;
  });

  readonly ariaLabel = computed(() => {
    const v = this.data();
    if (!v.length) return this.ariaHint();
    return `${this.ariaHint()}: ${v.map((d) => d.toLocaleString()).join(', ')}`;
  });
}
