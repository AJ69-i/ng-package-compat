import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TranslocoModule } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { FavoritesService } from '../../services/favorites.service';
import { NpmRegistryService } from '../../services/npm-registry.service';
import { NpmDownloadsService } from '../../services/npm-downloads.service';
import { EmptyStateComponent } from '../../components/empty-state/empty-state.component';
import { SkeletonComponent } from '../../components/skeleton/skeleton.component';
import { NotesService } from '../../services/notes.service';
import { ToastService } from '../../services/toast.service';
import { PullToRefreshDirective } from '../../directives/pull-to-refresh.directive';
import { SyncBannerComponent } from '../../components/sync-banner/sync-banner.component';

interface FavoriteRow {
  name: string;
  latestVersion: string | null;
  weeklyDownloads: number | null;
  daysSinceRelease: number | null;
  /** 0–100 lightweight freshness score (not a full compatibility score). */
  freshness: number | null;
  error?: string;
  flagged?: boolean;
  note?: string;
}

/**
 * Favorites dashboard — a live watch-list for the packages a user has starred.
 *
 * For each starred package we fan out two concurrent registry lookups (latest
 * metadata + downloads trend) and synthesize a lightweight "freshness" score
 * from weekly downloads and recency. The full compatibility score requires a
 * target Angular version and a full report, so we link to the search page for
 * the deep view rather than duplicating that pipeline here.
 *
 * The whole page is signal-composed so adding / removing / flagging a
 * favorite updates the table instantly; data refreshes on mount and can be
 * forced with the Refresh button.
 */
@Component({
  selector: 'app-favorites-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, RouterLink, TranslocoModule, EmptyStateComponent, SkeletonComponent, PullToRefreshDirective, SyncBannerComponent],
  template: `
    <section class="wrap" appPullToRefresh (refresh)="refresh()">
      <app-sync-banner kind="favorites" />
      <header class="head">
        <div>
          <h1>{{ 'favorites.title' | transloco }}</h1>
          <p class="sub">{{ 'favorites.subtitle' | transloco }}</p>
        </div>
        <div class="head-actions">
          <button class="refresh" type="button" (click)="refresh()" [disabled]="loading()">
            {{ (loading() ? 'favorites.refreshing' : 'favorites.refresh') | transloco }}
          </button>
          <button class="clear" type="button" (click)="clearAll()" [disabled]="!favorites.names().length">
            {{ 'favorites.clear' | transloco }}
          </button>
        </div>
      </header>

      @if (!favorites.names().length) {
        <app-empty-state
          icon="star"
          [title]="'favorites.emptyTitle' | transloco"
          [description]="'favorites.emptyBody' | transloco"
        >
          <a routerLink="/" class="cta">{{ 'favorites.emptyCta' | transloco }}</a>
        </app-empty-state>
      } @else if (loading() && !rows().length) {
        <div class="skel">
          @for (i of [1,2,3,4]; track i) {
            <app-skeleton [height]="64"></app-skeleton>
          }
        </div>
      } @else {
        <table class="grid" role="table">
          <thead>
            <tr>
              <th scope="col">{{ 'favorites.col.name' | transloco }}</th>
              <th scope="col">{{ 'favorites.col.version' | transloco }}</th>
              <th scope="col" class="num">{{ 'favorites.col.downloads' | transloco }}</th>
              <th scope="col" class="num">{{ 'favorites.col.release' | transloco }}</th>
              <th scope="col" class="num">{{ 'favorites.col.health' | transloco }}</th>
              <th scope="col" class="actions">{{ 'favorites.col.actions' | transloco }}</th>
            </tr>
          </thead>
          <tbody>
            @for (r of rows(); track r.name; let i = $index) {
              <tr
                [class.flagged]="r.flagged"
                [class.errored]="!!r.error"
                [class.dragging]="draggingIndex() === i"
                [class.drop-target]="dragOverIndex() === i && draggingIndex() !== i"
                draggable="true"
                (dragstart)="onDragStart($event, i)"
                (dragover)="onDragOver($event, i)"
                (dragleave)="onDragLeave($event)"
                (drop)="onDrop($event, i)"
                (dragend)="onDragEnd()"
              >
                <th scope="row">
                  <span
                    class="drag-handle"
                    aria-hidden="true"
                    [title]="'favorites.dragHandle' | transloco"
                  >⋮⋮</span>
                  <a [routerLink]="['/']" [queryParams]="{ q: r.name }">{{ r.name }}</a>
                  @if (r.flagged) { <span class="pin" aria-label="Pinned">📌</span> }
                  @if (r.note) { <small class="note" [title]="r.note">— {{ r.note }}</small> }
                </th>
                <td>
                  @if (r.latestVersion) { <code>{{ r.latestVersion }}</code> }
                  @else if (r.error) { <span class="err">{{ r.error }}</span> }
                  @else { <span class="dim">—</span> }
                </td>
                <td class="num">
                  @if (r.weeklyDownloads !== null) {
                    {{ formatCount(r.weeklyDownloads) }}
                  } @else {
                    <span class="dim">—</span>
                  }
                </td>
                <td class="num">
                  @if (r.daysSinceRelease !== null) {
                    {{ r.daysSinceRelease }}d
                  } @else {
                    <span class="dim">—</span>
                  }
                </td>
                <td class="num">
                  @if (r.freshness !== null) {
                    <span class="score" [class.good]="r.freshness >= 70"
                                        [class.ok]="r.freshness >= 40 && r.freshness < 70"
                                        [class.bad]="r.freshness < 40">
                      {{ r.freshness }}
                    </span>
                  } @else { <span class="dim">—</span> }
                </td>
                <td class="actions">
                  <button type="button" class="ic" (click)="remove(r.name)"
                          [attr.aria-label]="('favorites.unstar' | transloco) + ' ' + r.name">★</button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      }
    </section>
  `,
  styles: [
    `
      :host { display: block; }
      .wrap { max-width: 1120px; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
      .head { display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.25rem; }
      .head h1 { margin: 0; font-size: 1.5rem; color: var(--fg, #111); }
      .sub { margin: 0.15rem 0 0; color: var(--fg-dim, #555); font-size: 0.92rem; max-width: 60ch; }
      .head-actions { display: flex; gap: 0.5rem; }
      .refresh, .clear {
        border-radius: 8px;
        padding: 0.45rem 0.9rem;
        font-size: 0.85rem;
        cursor: pointer;
        border: 1px solid var(--border, #e5e7eb);
        background: var(--surface-2, #f9fafb);
        color: var(--fg, #111);
      }
      .refresh { background: var(--accent, #6366f1); border-color: var(--accent, #6366f1); color: #fff; }
      .refresh:disabled, .clear:disabled { opacity: 0.6; cursor: default; }

      .skel { display: flex; flex-direction: column; gap: 0.5rem; }
      .grid { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 0.9rem; }
      thead th {
        position: sticky; top: 0;
        background: var(--surface-2, #f9fafb);
        color: var(--fg-dim, #555);
        text-align: start;
        font-weight: 600;
        font-size: 0.78rem;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        padding: 0.55rem 0.75rem;
        border-bottom: 1px solid var(--border, #e5e7eb);
      }
      thead th.num, tbody td.num { text-align: end; }
      thead th.actions, tbody td.actions { text-align: end; }
      tbody th, tbody td { padding: 0.55rem 0.75rem; border-bottom: 1px solid var(--border, #f1f5f9); color: var(--fg, #111); }
      tbody tr:hover { background: var(--surface-2, #f9fafb); }
      tbody tr.flagged { background: color-mix(in srgb, var(--accent, #6366f1) 7%, transparent); }
      tbody tr.errored { opacity: 0.72; }
      tbody tr[draggable="true"] { cursor: grab; }
      tbody tr[draggable="true"]:active { cursor: grabbing; }
      tbody tr.dragging { opacity: 0.5; }
      tbody tr.drop-target { box-shadow: 0 -2px 0 var(--accent, #6366f1) inset; }
      .drag-handle {
        display: inline-block; width: 14px; color: var(--fg-dim, #94a3b8);
        font-weight: 700; letter-spacing: -2px; user-select: none;
        margin-inline-end: 0.4rem; cursor: grab;
      }
      tbody th { font-weight: 500; }
      tbody th a { color: var(--fg, #111); text-decoration: none; }
      tbody th a:hover { color: var(--accent, #6366f1); text-decoration: underline; }
      .pin { margin-inline-start: 0.35rem; }
      .note { color: var(--fg-dim, #777); font-weight: 400; }
      .dim { color: var(--fg-dim, #999); }
      .err { color: #b91c1c; font-size: 0.82rem; }
      .score { display: inline-block; min-width: 2.25rem; text-align: center; border-radius: 999px; padding: 0.05rem 0.45rem; font-weight: 700; color: #fff; background: #64748b; }
      .score.good { background: #10b981; }
      .score.ok { background: #f59e0b; }
      .score.bad { background: #ef4444; }
      .ic { border: none; background: none; cursor: pointer; color: var(--accent, #6366f1); font-size: 1.15rem; }
      .cta { display: inline-block; margin-top: 0.5rem; color: var(--accent, #6366f1); font-weight: 600; text-decoration: none; }
      .cta:hover { text-decoration: underline; }
    `
  ]
})
export class FavoritesPageComponent {
  protected readonly favorites = inject(FavoritesService);
  private readonly registry = inject(NpmRegistryService);
  private readonly downloads = inject(NpmDownloadsService);
  private readonly notes = inject(NotesService);
  private readonly toast = inject(ToastService);

  readonly loading = signal<boolean>(false);
  readonly rowMap = signal<Record<string, FavoriteRow>>({});

  // Drag-to-reorder state (feature #96).
  readonly draggingIndex = signal<number | null>(null);
  readonly dragOverIndex = signal<number | null>(null);

  onDragStart(ev: DragEvent, index: number): void {
    this.draggingIndex.set(index);
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', String(index));
    }
  }

  onDragOver(ev: DragEvent, index: number): void {
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    if (this.dragOverIndex() !== index) this.dragOverIndex.set(index);
  }

  onDragLeave(_ev: DragEvent): void {
    // Tiny grace period: only clear if no other row claims it within a tick.
    queueMicrotask(() => {
      if (this.draggingIndex() === null) this.dragOverIndex.set(null);
    });
  }

  onDrop(ev: DragEvent, dropIndex: number): void {
    ev.preventDefault();
    const fromIdx = this.draggingIndex();
    if (fromIdx == null) return;
    this.favorites.move(fromIdx, dropIndex);
    this.draggingIndex.set(null);
    this.dragOverIndex.set(null);
  }

  onDragEnd(): void {
    this.draggingIndex.set(null);
    this.dragOverIndex.set(null);
  }

  readonly rows = computed<FavoriteRow[]>(() => {
    const names = this.favorites.names();
    const map = this.rowMap();
    const notes = this.notes.all();
    return names.map((name) => {
      const base = map[name] ?? emptyRow(name);
      const n = notes[name];
      return { ...base, flagged: n?.flagged ?? false, note: n?.note?.trim() || undefined };
    });
  });

  constructor() {
    this.refresh();
  }

  refresh(): void {
    const names = this.favorites.names();
    if (!names.length) { this.rowMap.set({}); return; }
    this.loading.set(true);
    const next: Record<string, FavoriteRow> = {};
    Promise.all(names.map((name) => this.loadOne(name).then((row) => { next[name] = row; })))
      .then(() => this.rowMap.set(next))
      .finally(() => this.loading.set(false));
  }

  remove(name: string): void {
    this.favorites.remove(name);
    this.rowMap.update((m) => {
      const next = { ...m };
      delete next[name];
      return next;
    });
    this.toast.info(`Removed ${name} from favorites`);
  }

  clearAll(): void {
    if (!confirm('Clear all favorites?')) return;
    this.favorites.clear();
    this.rowMap.set({});
  }

  formatCount(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
    return String(n);
  }

  private async loadOne(name: string): Promise<FavoriteRow> {
    try {
      const meta = await firstValueFrom(this.registry.fetchPackage(name));
      const latest = (meta?.['dist-tags'] as Record<string, string> | undefined)?.['latest'] ?? null;
      const time = (meta as unknown as { time?: Record<string, string> })?.time ?? {};
      const latestTime = latest && time[latest] ? new Date(time[latest]).getTime() : null;
      const daysSince = latestTime !== null ? Math.floor((Date.now() - latestTime) / 86_400_000) : null;

      // Downloads: read the last weekly bucket (service exposes weeklyTrend).
      let weekly: number | null = null;
      try {
        const trend = await firstValueFrom(this.downloads.weeklyTrend(name, 1));
        weekly = Array.isArray(trend) && trend.length ? trend[trend.length - 1].downloads : 0;
      } catch { weekly = null; }

      const freshness = this.freshness(weekly, daysSince);
      return {
        name,
        latestVersion: latest ?? null,
        weeklyDownloads: weekly,
        daysSinceRelease: daysSince,
        freshness
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load';
      return { ...emptyRow(name), error: msg };
    }
  }

  /**
   * Lightweight 0–100 score: half from downloads (log scale, capped at 1M/wk),
   * half from release recency (full credit <30d, zero credit >720d).
   */
  private freshness(weekly: number | null, daysSince: number | null): number | null {
    if (weekly === null && daysSince === null) return null;
    const dlScore = weekly === null ? 30 : Math.min(50, Math.round((Math.log10(Math.max(1, weekly)) / 6) * 50));
    const ageScore = daysSince === null ? 25 :
      daysSince <= 30 ? 50 :
      daysSince >= 720 ? 0 :
      Math.round(50 * (1 - (daysSince - 30) / 690));
    return Math.max(0, Math.min(100, dlScore + ageScore));
  }
}

function emptyRow(name: string): FavoriteRow {
  return {
    name,
    latestVersion: null,
    weeklyDownloads: null,
    daysSinceRelease: null,
    freshness: null
  };
}
