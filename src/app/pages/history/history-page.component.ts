import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TranslocoModule } from '@jsverse/transloco';
import { StorageService } from '../../services/storage.service';
import { HistoryDbService } from '../../services/history-db.service';
import { CompareHistoryService } from '../../services/compare-history.service';
import { VirtualListDirective } from '../../directives/virtual-list.directive';
import { DiffSparklineComponent } from '../../components/diff-sparkline/diff-sparkline.component';
import { SyncBannerComponent } from '../../components/sync-banner/sync-banner.component';

@Component({
  selector: 'app-history-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, DatePipe, RouterLink, TranslocoModule, VirtualListDirective, DiffSparklineComponent, SyncBannerComponent],
  template: `
    <section class="head">
      <h1>{{ 'history.title' | transloco }}</h1>
      <p>{{ 'history.subtitle' | transloco }}</p>
    </section>

    <app-sync-banner kind="history" />

    <section class="group">
      <div class="group-head">
        <h2>{{ 'history.favorites' | transloco }}</h2>
      </div>
      @if (storage.favorites().length) {
        <ul class="list">
          @for (name of storage.favorites(); track name) {
            <li>
              <a [routerLink]="['/']" [queryParams]="{ q: name }">★ {{ name }}</a>
              <button type="button" class="linkish" (click)="storage.toggleFavorite(name)">{{ 'common.remove' | transloco }}</button>
            </li>
          }
        </ul>
      } @else {
        <p class="muted">{{ 'history.noFavorites' | transloco }}</p>
      }
    </section>

    @if (historyDb.snapshots().length >= 2) {
      <section class="group trend">
        <div class="group-head">
          <h2>{{ 'history.trend' | transloco }}</h2>
          <span class="muted">{{ historyDb.snapshots().length }} snapshots</span>
        </div>
        <div class="trend-card">
          <app-diff-sparkline [snapshots]="historyDb.snapshots()" [width]="520" [height]="72" />
        </div>
      </section>
    }

    <!-- Recent comparisons (compare-page history). Lives between the
         Favorites section and the search-Recent section so it inherits
         the same visual cadence: one section per kind, each with a
         header + optional "Clear" button + body. Empty state shows a
         placeholder so users understand the section exists but is
         awaiting their first comparison rather than being broken. -->
    <section class="group">
      <div class="group-head">
        <h2>{{ 'compareHistory.title' | transloco }}</h2>
        @if (compareHistory.entries().length) {
          <button type="button" class="danger" (click)="clearCompares()">
            {{ 'history.clear' | transloco }}
          </button>
        }
      </div>
      @if (compareHistory.entries().length) {
        <ul class="list compare-list">
          @for (entry of compareHistory.entries(); track entry.id) {
            <li class="compare-row">
              <!-- Chip-pair as a single link to /compare?a=&b=, so
                   clicking anywhere on the chip restores the full
                   comparison via the existing URL-state encoding. -->
              <a
                class="compare-pair"
                [routerLink]="['/compare']"
                [queryParams]="{ a: entry.packageA, b: entry.packageB }"
              >
                <span class="compare-pkg">{{ entry.packageA }}</span>
                <span class="compare-arrow" aria-hidden="true">↔</span>
                <span class="compare-pkg">{{ entry.packageB }}</span>
                <!-- AI feature badges — one small pill per generated
                     feature, always visible. Replaces an earlier
                     single-✨-with-native-tooltip approach which had
                     all the same problems we hit on the competitor
                     chips: OS-styled bubble that ignored our theme,
                     hover-only (broken on touch), slow to appear.
                     Surfacing the feature names inline reads at a
                     glance, themes correctly via CSS variables, and
                     is accessible to screen readers as part of the
                     link's content. -->
                @if (entry.aiHighlights.hasProsCons) {
                  <span class="ai-badge">
                    <span class="ai-sparkle" aria-hidden="true">✨</span>
                    {{ 'compareHistory.aiProsCons' | transloco }}
                  </span>
                }
                @if (entry.aiHighlights.hasUsageGuide) {
                  <span class="ai-badge">
                    <span class="ai-sparkle" aria-hidden="true">✨</span>
                    {{ 'compareHistory.aiUsageGuide' | transloco }}
                  </span>
                }
              </a>
              <span class="compare-meta">
                <span class="ts">{{ entry.createdAt | date: 'medium' }}</span>
                <button
                  type="button"
                  class="linkish"
                  (click)="removeCompare(entry.id)"
                  [attr.aria-label]="'common.remove' | transloco"
                >
                  {{ 'common.remove' | transloco }}
                </button>
              </span>
            </li>
          }
        </ul>
      } @else {
        <p class="muted">{{ 'compareHistory.empty' | transloco }}</p>
      }
    </section>

    <section class="group">
      <div class="group-head">
        <h2>{{ 'history.recent' | transloco }}</h2>
        @if (storage.history().length) {
          <button type="button" class="danger" (click)="storage.clearHistory()">{{ 'history.clear' | transloco }}</button>
        }
      </div>
      @if (storage.history().length) {
        <div class="scroll-host">
          <ul class="list">
            <ng-container *appVirtualList="storage.history(); itemSize: 48; buffer: 6; let entry; let i = index">
              <li>
                <a [routerLink]="['/']" [queryParams]="{ q: entry.name }">{{ entry.name }}</a>
                <span class="ts">{{ entry.ts | date: 'medium' }}</span>
              </li>
            </ng-container>
          </ul>
        </div>
      } @else {
        <p class="muted">{{ 'history.noHistory' | transloco }}</p>
      }
    </section>
  `,
  styles: [`
    .head h1 { font-size: clamp(1.3rem, 2vw + 0.8rem, 1.8rem); color: var(--fg); }
    .head p { color: var(--fg-dim); margin-top: 0.3rem; }
    .group { margin-top: 2rem; }
    .group-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem; gap: 0.5rem; flex-wrap: wrap; }
    h2 { color: var(--fg); font-size: 1.05rem; }
    .list {
      list-style: none; padding: 0; margin: 0;
      border: 1px solid var(--border); border-radius: 12px; overflow: hidden;
    }
    .list li {
      display: flex; justify-content: space-between; align-items: center; gap: 1rem;
      padding: 0.8rem 1rem; border-top: 1px solid var(--border); background: var(--surface-2);
      min-height: 48px;
    }
    .list li:first-child { border-top: none; }
    .scroll-host { max-height: 520px; overflow: auto; border: 1px solid var(--border); border-radius: 12px; }
    .scroll-host .list { border: none; border-radius: 0; }
    .list a { color: var(--accent); text-decoration: none; font-weight: 500; }
    .list a:hover, .list a:focus-visible { text-decoration: underline; outline: none; }
    .ts { color: var(--fg-dim); font-size: 0.8rem; }
    .linkish { background: none; border: none; color: var(--fg-dim); cursor: pointer; font-size: 0.85rem; padding: 6px 8px; min-height: 32px; }
    .linkish:hover { color: #fca5a5; }
    .danger {
      background: color-mix(in srgb, #ef4444 10%, transparent); color: #fca5a5;
      border: 1px solid color-mix(in srgb, #ef4444 35%, transparent); border-radius: 8px;
      padding: 0.4rem 0.8rem; font-size: 0.8rem; cursor: pointer; min-height: 36px;
    }
    .muted { color: var(--fg-dim); font-style: italic; }
    .trend-card {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1rem 1.1rem;
    }

    /* Compare history — chip-pair link layout, single row per comparison.
       The pair link is the primary action surface (click to reopen the
       comparison); the meta column on the right holds the date and a
       per-row remove button. Same visual rhythm as the other history
       sections (favorites, search) so the page reads as one coherent
       set of "things you've looked at" rather than several disconnected
       lists. */
    .compare-list .compare-row {
      gap: 0.75rem;
    }
    .compare-pair {
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      flex-wrap: wrap;
      color: var(--accent);
      text-decoration: none;
      font-weight: 500;
      padding: 0.25rem 0;
    }
    .compare-pair:hover, .compare-pair:focus-visible {
      text-decoration: underline;
      outline: none;
    }
    .compare-pkg {
      font-family: var(--code-font, ui-monospace, Menlo, Consolas, monospace);
      font-size: 0.92em;
    }
    .compare-arrow {
      color: var(--fg-dim);
      font-size: 0.85em;
    }
    /* AI feature badges — small accent-tinted pills with a sparkle
       prefix. Always visible (no hover gate), theme-aware via the
       accent token (works in both light and dark mode automatically),
       and indistinguishable from "static label" to screen readers
       since they're plain spans inside the link's content. The
       sparkle is decoration only (aria-hidden), so the announced
       text is just "Pros & Cons" / "Usage Guide" without weird
       emoji read-outs. */
    .ai-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      margin-inline-start: 0.4rem;
      padding: 1px 8px;
      border-radius: var(--radius-pill, 999px);
      background: color-mix(in srgb, var(--accent) 12%, transparent);
      color: var(--accent);
      border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
      font-size: 0.7rem;
      font-weight: 500;
      letter-spacing: 0.01em;
      line-height: 1.5;
      white-space: nowrap;
    }
    .ai-sparkle {
      font-size: 0.85em;
      line-height: 1;
    }
    .compare-meta {
      display: inline-flex;
      align-items: center;
      gap: 0.6rem;
      color: var(--fg-dim);
    }
  `]
})
export class HistoryPageComponent {
  readonly storage = inject(StorageService);
  readonly historyDb = inject(HistoryDbService);
  readonly compareHistory = inject(CompareHistoryService);

  /** Fire-and-forget removal — service handles errors internally. */
  removeCompare(id: string): void {
    void this.compareHistory.delete(id);
  }

  /** Clear all compare history. Confirmation lives elsewhere if needed. */
  clearCompares(): void {
    void this.compareHistory.clear();
  }
}
