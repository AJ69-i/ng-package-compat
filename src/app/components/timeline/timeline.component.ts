import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { VersionCompatibility } from '../../models/npm-package.model';

interface Point {
  x: number;
  version: string;
  date: Date;
  isLatest: boolean;
  deprecated: boolean;
  prerelease: boolean;
}

@Component({
  selector: 'app-timeline',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  template: `
    @if (points().length > 1) {
      <div class="wrap">
        <h3>Release timeline <span class="muted">({{ points().length }} versions)</span></h3>
        <svg [attr.viewBox]="'0 0 ' + W + ' ' + H" role="img" aria-label="Release timeline">
          <line [attr.x1]="margin" [attr.y1]="H/2" [attr.x2]="W - margin" [attr.y2]="H/2"
                stroke="currentColor" stroke-opacity="0.25" />
          @for (p of points(); track p.version) {
            <g>
              <circle [attr.cx]="p.x" [attr.cy]="H/2" r="4"
                      [class.latest]="p.isLatest"
                      [class.deprecated]="p.deprecated"
                      [class.prerelease]="p.prerelease" />
              <title>{{ p.version }} · {{ p.date.toISOString().slice(0,10) }}{{ p.isLatest ? ' · latest' : '' }}{{ p.deprecated ? ' · deprecated' : '' }}</title>
            </g>
          }
          <text [attr.x]="margin" [attr.y]="H - 4" font-size="10"
                fill="currentColor" fill-opacity="0.6">
            {{ firstDate() }}
          </text>
          <text [attr.x]="W - margin" [attr.y]="H - 4" text-anchor="end" font-size="10"
                fill="currentColor" fill-opacity="0.6">
            {{ lastDate() }}
          </text>
        </svg>
        <p class="legend">
          <span><span class="dot latest"></span> latest</span>
          <span><span class="dot deprecated"></span> deprecated</span>
          <span><span class="dot prerelease"></span> prerelease</span>
        </p>
      </div>
    }
  `,
  styles: [`
    /* Block host so the timeline participates in the page's vertical
       rhythm. The inner .wrap already owns the 1rem top margin —
       this rule just guarantees the host doesn't collapse to inline. */
    :host { display: block; }
    .wrap { margin-top: 1rem; padding: 0.75rem 1rem; border: 1px solid var(--border);
            border-radius: 12px; background: var(--surface-1); color: var(--accent); }
    .wrap h3 { color: var(--fg); margin: 0 0 0.35rem; font-size: 0.95rem; }
    .muted { color: var(--fg-dim); font-weight: 400; font-size: 0.8rem; }
    svg { width: 100%; height: 64px; display: block; }
    circle { fill: currentColor; }
    circle.latest { fill: #86efac; }
    circle.deprecated { fill: #fca5a5; opacity: 0.8; }
    circle.prerelease { fill: #fcd34d; }
    .legend { color: var(--fg-dim); font-size: 0.75rem; display: flex; gap: 1rem; margin: 0.35rem 0 0; flex-wrap: wrap; }
    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 3px; vertical-align: middle; }
    .dot.latest { background: #86efac; }
    .dot.deprecated { background: #fca5a5; }
    .dot.prerelease { background: #fcd34d; }
  `]
})
export class TimelineComponent {
  readonly W = 720;
  readonly H = 64;
  readonly margin = 12;

  readonly rows = input<VersionCompatibility[]>([]);

  readonly points = computed<Point[]>(() => {
    const dated = this.rows().filter((r) => r.publishedAt).slice().reverse();
    if (dated.length < 2) return [];
    const first = dated[0].publishedAt!.getTime();
    const last = dated[dated.length - 1].publishedAt!.getTime();
    const span = Math.max(1, last - first);
    const w = this.W - this.margin * 2;
    return dated.map((r) => ({
      x: this.margin + ((r.publishedAt!.getTime() - first) / span) * w,
      version: r.version,
      date: r.publishedAt!,
      isLatest: r.isLatest,
      deprecated: r.isDeprecated,
      prerelease: r.isPrerelease
    }));
  });

  readonly firstDate = computed(() => this.points()[0]?.date.toISOString().slice(0, 10) ?? '');
  readonly lastDate = computed(() => this.points().slice(-1)[0]?.date.toISOString().slice(0, 10) ?? '');
}
