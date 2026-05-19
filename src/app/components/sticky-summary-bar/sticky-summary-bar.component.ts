import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
  computed,
  input,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslocoModule } from '@jsverse/transloco';

/** Filter value emitted back to the parent when a pill is clicked. */
export type SummaryFilter = 'all' | 'critical' | 'warning' | 'healthy';

/** A single counted category — the shape the component needs. */
export interface SummaryCounts {
  critical: number;
  warning: number;
  healthy: number;
  total: number;
}

/**
 * Sticky Summary Bar.
 *
 * Pins to the top of the viewport as the user scrolls through long dependency
 * tables. Shows instant, clickable tally pills that filter the main table.
 *
 * Input: counts from the parent (computed from the actual rows).
 * Output: `filter` — the selected category, for the parent to bind into the
 * filtering pipeline.
 *
 * Why this is valuable for real Angular projects:
 *   - A typical enterprise package.json has 100+ deps
 *   - Only 2-5 of those are usually critical
 *   - Without a sticky bar the user loses the health summary as they scroll
 *     and can't quickly jump between categories
 *   - Pills double as filters, giving a 2-click "show me the broken ones" flow
 */
@Component({
  selector: 'app-sticky-summary-bar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TranslocoModule],
  templateUrl: './sticky-summary-bar.component.html',
  styleUrls: ['./sticky-summary-bar.component.scss']
})
export class StickySummaryBarComponent {
  /** Counts computed by the parent from the analyzed package list. */
  @Input({ required: true }) counts!: SummaryCounts;
  /** Optional — shows "N of M" after filtering kicks in. */
  @Input() shown: number | null = null;

  /** Active filter value — parent binds this. */
  @Input() active: SummaryFilter = 'all';

  /** Emitted whenever a pill is pressed. */
  @Output() filterChange = new EventEmitter<SummaryFilter>();

  setFilter(f: SummaryFilter): void {
    // If the same pill is clicked again, revert to "all".
    const next = this.active === f ? 'all' : f;
    this.active = next;
    this.filterChange.emit(next);
  }

  healthRatio(): number {
    const t = this.counts?.total || 1;
    return Math.round((this.counts.healthy / t) * 100);
  }
}
