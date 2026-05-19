import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslocoModule } from '@jsverse/transloco';
import { CompatibilityReport, ReportEntry } from '../../models/npm-package.model';

interface MoverRow {
  name: string;
  deltaBytes: number;
  deltaPercent: number | null;
  currentGzip: number | null;
  recommendedGzip: number | null;
}

interface AggregateView {
  totalDeltaBytes: number;
  growersTotalBytes: number;
  shrinkersTotalBytes: number;
  netDirection: 'grows' | 'shrinks' | 'flat';
  growerShare: number; // 0..1 for the bar
  topGrowers: MoverRow[];
  topShrinkers: MoverRow[];
  countWithData: number;
  countMissingData: number;
}

/**
 * Aggregate "bundle-size delta" viewer for the upgrade page.
 *
 * Shows the *net* bundle impact of accepting every recommendation in the
 * report — total bytes, top 5 growers, top 5 shrinkers, and a small visual
 * split so people can see the trade-off at a glance before committing to the
 * upgrade.
 */
@Component({
  selector: 'app-bundle-delta-summary',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TranslocoModule],
  template: `
    @if (view(); as v) {
      @if (v.countWithData === 0) {
        <section class="bundle-summary empty">
          <h3>{{ 'bundleDelta.title' | transloco }}</h3>
          <p class="muted">{{ 'bundleDelta.noData' | transloco }}</p>
        </section>
      } @else {
        <section
          class="bundle-summary"
          role="region"
          [attr.aria-label]="'bundleDelta.title' | transloco"
          [class.grow]="v.netDirection === 'grows'"
          [class.shrink]="v.netDirection === 'shrinks'"
        >
          <header>
            <h3>{{ 'bundleDelta.title' | transloco }}</h3>
            <p class="muted">
              {{ 'bundleDelta.lede' | transloco }}
            </p>
          </header>

          <div class="totals">
            <div class="big" [attr.aria-live]="'polite'">
              <span class="sign">{{ v.totalDeltaBytes >= 0 ? '+' : '−' }}</span>
              <span class="num">{{ formatBytes(v.totalDeltaBytes) }}</span>
              <span class="label">
                @switch (v.netDirection) {
                  @case ('grows') { {{ 'bundleDelta.grows' | transloco }} }
                  @case ('shrinks') { {{ 'bundleDelta.shrinks' | transloco }} }
                  @default { {{ 'bundleDelta.flat' | transloco }} }
                }
              </span>
            </div>

            <div
              class="splitbar"
              role="img"
              [attr.aria-label]="'bundleDelta.splitAria' | transloco"
            >
              <span
                class="grow-fill"
                [style.flexBasis.%]="v.growerShare * 100"
                [title]="'+' + formatBytes(v.growersTotalBytes)"
              ></span>
              <span
                class="shrink-fill"
                [style.flexBasis.%]="(1 - v.growerShare) * 100"
                [title]="'−' + formatBytes(Math.abs(v.shrinkersTotalBytes))"
              ></span>
            </div>

            <p class="meta muted">
              {{
                'bundleDelta.coverage'
                  | transloco
                    : { withData: v.countWithData, missing: v.countMissingData }
              }}
            </p>
          </div>

          <div class="movers">
            @if (v.topGrowers.length) {
              <div class="col">
                <h4>{{ 'bundleDelta.growers' | transloco }}</h4>
                <ul>
                  @for (m of v.topGrowers; track m.name) {
                    <li>
                      <code class="pkg">{{ m.name }}</code>
                      <span class="delta up">+{{ formatBytes(m.deltaBytes) }}</span>
                      @if (m.deltaPercent != null) {
                        <span class="pct">{{ formatPct(m.deltaPercent) }}</span>
                      }
                    </li>
                  }
                </ul>
              </div>
            }
            @if (v.topShrinkers.length) {
              <div class="col">
                <h4>{{ 'bundleDelta.shrinkers' | transloco }}</h4>
                <ul>
                  @for (m of v.topShrinkers; track m.name) {
                    <li>
                      <code class="pkg">{{ m.name }}</code>
                      <span class="delta down">−{{ formatBytes(Math.abs(m.deltaBytes)) }}</span>
                      @if (m.deltaPercent != null) {
                        <span class="pct">{{ formatPct(m.deltaPercent) }}</span>
                      }
                    </li>
                  }
                </ul>
              </div>
            }
          </div>
        </section>
      }
    }
  `,
  styles: [`
    :host { display: block; margin: 1rem 0; }
    .bundle-summary {
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 12px; padding: 1rem 1.1rem;
      background: var(--surface-1, #fff);
    }
    .bundle-summary header h3 { margin: 0 0 0.2rem; font-size: 1rem; }
    .muted { color: var(--fg-dim, #64748b); font-size: 0.85rem; margin: 0 0 0.85rem; }
    .empty .muted { margin: 0; }

    .totals { display: grid; gap: 0.55rem; margin-bottom: 0.85rem; }
    .big { display: flex; align-items: baseline; gap: 0.4rem; flex-wrap: wrap; }
    .big .sign { font-size: 1.6rem; font-weight: 700; color: var(--fg, #111827); }
    .grow .big .sign, .grow .big .num { color: #b91c1c; }
    .shrink .big .sign, .shrink .big .num { color: #15803d; }
    .big .num { font-size: 1.6rem; font-weight: 700; }
    .big .label { font-size: 0.85rem; color: var(--fg-dim, #64748b); }

    .splitbar {
      display: flex; height: 0.55rem; border-radius: 999px; overflow: hidden;
      background: var(--surface-2, #f1f5f9);
    }
    .splitbar .grow-fill { background: #ef4444; }
    .splitbar .shrink-fill { background: #22c55e; }
    .meta { font-size: 0.78rem; margin: 0; }

    .movers {
      display: grid; gap: 1rem;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      margin-top: 0.4rem;
    }
    .col h4 { margin: 0 0 0.4rem; font-size: 0.82rem; color: var(--fg-dim, #64748b); font-weight: 600; }
    .col ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.3rem; }
    .col li {
      display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
      font-size: 0.85rem;
      padding: 0.3rem 0.5rem;
      border-radius: 6px;
      background: var(--surface-2, #f8fafc);
    }
    .col code.pkg {
      flex: 1 1 auto; min-width: 0;
      font: 0.78rem ui-monospace, Menlo, Consolas, monospace;
      background: transparent; padding: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .col .delta {
      font: 600 0.78rem ui-monospace, Menlo, Consolas, monospace;
      padding: 0.05rem 0.35rem; border-radius: 4px;
    }
    .col .delta.up { color: #b91c1c; background: #fee2e2; }
    .col .delta.down { color: #15803d; background: #dcfce7; }
    .col .pct { color: var(--fg-dim, #64748b); font-size: 0.78rem; }
  `]
})
export class BundleDeltaSummaryComponent {
  readonly report = input<CompatibilityReport | null>(null);

  /** Public alias so the template can use `Math.abs(...)`. */
  readonly Math = Math;

  readonly view = computed<AggregateView | null>(() => {
    const r = this.report();
    if (!r) return null;
    return BundleDeltaSummaryComponent.aggregate(r.entries ?? []);
  });

  static aggregate(entries: ReportEntry[]): AggregateView {
    let total = 0;
    let growers = 0;
    let shrinkers = 0;
    let withData = 0;
    let missing = 0;
    const movers: MoverRow[] = [];

    for (const e of entries) {
      const d = e.bundleDelta;
      if (!d || d.deltaBytes == null) {
        missing++;
        continue;
      }
      withData++;
      total += d.deltaBytes;
      if (d.deltaBytes > 0) growers += d.deltaBytes;
      else if (d.deltaBytes < 0) shrinkers += d.deltaBytes;
      movers.push({
        name: e.name,
        deltaBytes: d.deltaBytes,
        deltaPercent: d.deltaPercent ?? null,
        currentGzip: d.currentGzip ?? null,
        recommendedGzip: d.recommendedGzip ?? null
      });
    }

    const topGrowers = movers
      .filter((m) => m.deltaBytes > 0)
      .sort((a, b) => b.deltaBytes - a.deltaBytes)
      .slice(0, 5);
    const topShrinkers = movers
      .filter((m) => m.deltaBytes < 0)
      .sort((a, b) => a.deltaBytes - b.deltaBytes)
      .slice(0, 5);

    const absGrowers = Math.abs(growers);
    const absShrinkers = Math.abs(shrinkers);
    const denom = absGrowers + absShrinkers || 1;
    const growerShare = absGrowers / denom;

    let netDirection: AggregateView['netDirection'];
    if (total > 1024) netDirection = 'grows';
    else if (total < -1024) netDirection = 'shrinks';
    else netDirection = 'flat';

    return {
      totalDeltaBytes: total,
      growersTotalBytes: growers,
      shrinkersTotalBytes: shrinkers,
      netDirection,
      growerShare,
      topGrowers,
      topShrinkers,
      countWithData: withData,
      countMissingData: missing
    };
  }

  formatBytes(n: number): string {
    const abs = Math.abs(n);
    if (abs >= 1024 * 1024) return `${(abs / (1024 * 1024)).toFixed(1)} MB`;
    if (abs >= 1024) return `${(abs / 1024).toFixed(1)} kB`;
    return `${Math.round(abs)} B`;
  }

  formatPct(p: number): string {
    const sign = p >= 0 ? '+' : '−';
    return `${sign}${Math.round(Math.abs(p))}%`;
  }
}
