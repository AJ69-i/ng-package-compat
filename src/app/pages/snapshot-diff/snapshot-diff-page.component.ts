import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslocoModule } from '@jsverse/transloco';
import { MonitorService, ReportSnapshot } from '../../services/monitor.service';

interface DiffRow {
  name: string;
  fromVersion: string | null;
  toVersion: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  kind: 'added' | 'removed' | 'changed' | 'unchanged';
}

/**
 * Snapshot-vs-snapshot time-travel diff (feature #94).
 *
 * The user picks two captured snapshots and we render the package-level
 * delta between them: added, removed, version-changed, status-changed.
 * Useful for "what did I change since last quarter's checkpoint?" and
 * for after-the-fact incident review ("when did we go from healthy to
 * conflict-heavy?").
 *
 * Snapshots come from MonitorService — both the locally-captured ones
 * and (when signed in) the ones synced from Supabase.
 */
@Component({
  selector: 'app-snapshot-diff-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, TranslocoModule],
  template: `
    <main class="page" role="main" aria-labelledby="snapshot-diff-title">
      <header>
        <h1 id="snapshot-diff-title">{{ 'snapshotDiff.title' | transloco }}</h1>
        <p class="muted">{{ 'snapshotDiff.lede' | transloco }}</p>
      </header>

      @if (snapshots().length < 2) {
        <p class="empty">
          {{ 'snapshotDiff.notEnough' | transloco: { count: snapshots().length } }}
        </p>
      } @else {
        <section class="picker">
          <label>
            <span>{{ 'snapshotDiff.from' | transloco }}</span>
            <select [(ngModel)]="fromKey" name="from">
              @for (s of snapshots(); track s.projectKey + s.capturedAt) {
                <option [value]="snapshotKey(s)">
                  {{ s.label }} — {{ s.capturedAt | date: 'short' }}
                </option>
              }
            </select>
          </label>
          <label>
            <span>{{ 'snapshotDiff.to' | transloco }}</span>
            <select [(ngModel)]="toKey" name="to">
              @for (s of snapshots(); track s.projectKey + s.capturedAt) {
                <option [value]="snapshotKey(s)">
                  {{ s.label }} — {{ s.capturedAt | date: 'short' }}
                </option>
              }
            </select>
          </label>
        </section>

        @if (diff(); as d) {
          <section class="summary" aria-live="polite" role="status">
            <span class="chip add">+{{ d.added }} {{ 'snapshotDiff.added' | transloco }}</span>
            <span class="chip rm">−{{ d.removed }} {{ 'snapshotDiff.removed' | transloco }}</span>
            <span class="chip ch">~{{ d.changed }} {{ 'snapshotDiff.changed' | transloco }}</span>
          </section>
          <!-- .scroll-table caps height + sticky thead for the diff
               rows. Snapshot diffs can span hundreds of packages
               across two versions of a monorepo. -->
          <div class="scroll-table">
          <table class="diff-table">
            <thead>
              <tr>
                <th>{{ 'snapshotDiff.package' | transloco }}</th>
                <th>{{ 'snapshotDiff.from' | transloco }}</th>
                <th>{{ 'snapshotDiff.to' | transloco }}</th>
                <th>{{ 'snapshotDiff.kind' | transloco }}</th>
              </tr>
            </thead>
            <tbody>
              @for (r of d.rows; track r.name) {
                <tr [attr.data-kind]="r.kind">
                  <td><code>{{ r.name }}</code></td>
                  <td>{{ r.fromVersion ?? '—' }} <small class="muted">{{ r.fromStatus ?? '' }}</small></td>
                  <td>{{ r.toVersion ?? '—' }} <small class="muted">{{ r.toStatus ?? '' }}</small></td>
                  <td>{{ r.kind }}</td>
                </tr>
              }
            </tbody>
          </table>
          </div>
        }
      }
    </main>
  `,
  styles: [`
    :host { display: block; }
    .page { max-width: var(--content-max-width, min(94vw, 1320px)); margin: 0 auto; padding: 1.25rem 1rem 4rem; }
    h1 { margin: 0 0 0.3rem; font-size: 1.4rem; }
    .muted { color: var(--fg-dim); }
    .empty { padding: 2rem; text-align: center; color: var(--fg-dim); }
    .picker {
      display: grid; gap: 0.75rem; grid-template-columns: 1fr 1fr;
      margin: 1rem 0 1.25rem;
    }
    .picker label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; color: var(--fg-dim); }
    .picker select {
      padding: 0.4rem 0.6rem; border-radius: 8px;
      border: 1px solid var(--border); background: var(--surface-2); color: var(--fg);
    }
    .summary { display: flex; gap: 0.4rem; margin-bottom: 0.75rem; }
    .chip { padding: 0.2rem 0.55rem; border-radius: 999px; font-size: 0.78rem; font-weight: 600; }
    .chip.add { background: #dcfce7; color: #15803d; }
    .chip.rm { background: #fee2e2; color: #b91c1c; }
    .chip.ch { background: #fef3c7; color: #b45309; }
    .diff-table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
    .diff-table th, .diff-table td {
      padding: 0.5rem 0.7rem; border-bottom: 1px solid var(--border); text-align: left;
    }
    .diff-table th { color: var(--fg-dim); font-weight: 600; }
    .diff-table tr[data-kind="added"] td { background: rgba(34,197,94,0.05); }
    .diff-table tr[data-kind="removed"] td { background: rgba(239,68,68,0.05); }
    .diff-table tr[data-kind="changed"] td { background: rgba(245,158,11,0.05); }
    @media (max-width: 720px) {
      .picker { grid-template-columns: 1fr; }
    }
  `]
})
export class SnapshotDiffPageComponent {
  private readonly monitor = inject(MonitorService);

  /** Sorted by capturedAt DESC so the picker default-selects the newest. */
  readonly snapshots = computed<ReportSnapshot[]>(() => {
    const map = this.monitor.snapshots();
    return Object.values(map).sort((a, b) => b.capturedAt - a.capturedAt);
  });

  readonly fromKey = signal<string>('');
  readonly toKey = signal<string>('');

  // Bind the signals through ngModel-style getters so [(ngModel)] works.
  // Angular Forms support binding to a signal via (ngModelChange) — but for
  // ChangeDetectionStrategy.OnPush we still need to write through the signal.

  set fromKeyValue(v: string) { this.fromKey.set(v); }
  get fromKeyValue(): string { return this.fromKey() || this.snapshotKeyOrEmpty(this.snapshots()[1]); }

  set toKeyValue(v: string) { this.toKey.set(v); }
  get toKeyValue(): string { return this.toKey() || this.snapshotKeyOrEmpty(this.snapshots()[0]); }

  snapshotKey(s: ReportSnapshot): string {
    return `${s.projectKey}::${s.capturedAt}`;
  }

  private snapshotKeyOrEmpty(s: ReportSnapshot | undefined): string {
    return s ? this.snapshotKey(s) : '';
  }

  readonly diff = computed<{
    rows: DiffRow[];
    added: number;
    removed: number;
    changed: number;
  } | null>(() => {
    const all = this.snapshots();
    if (all.length < 2) return null;
    const fromK = this.fromKey() || this.snapshotKeyOrEmpty(all[1]);
    const toK = this.toKey() || this.snapshotKeyOrEmpty(all[0]);
    const from = all.find((s) => this.snapshotKey(s) === fromK);
    const to = all.find((s) => this.snapshotKey(s) === toK);
    if (!from || !to || from === to) return { rows: [], added: 0, removed: 0, changed: 0 };

    const rows: DiffRow[] = [];
    const allNames = new Set<string>([
      ...Object.keys(from.packages),
      ...Object.keys(to.packages)
    ]);
    let added = 0;
    let removed = 0;
    let changed = 0;
    for (const name of [...allNames].sort()) {
      const a = from.packages[name];
      const b = to.packages[name];
      if (!a && b) {
        added++;
        rows.push({
          name,
          fromVersion: null,
          toVersion: b.recommendedVersion ?? b.currentVersion,
          fromStatus: null,
          toStatus: b.status,
          kind: 'added'
        });
      } else if (a && !b) {
        removed++;
        rows.push({
          name,
          fromVersion: a.recommendedVersion ?? a.currentVersion,
          toVersion: null,
          fromStatus: a.status,
          toStatus: null,
          kind: 'removed'
        });
      } else if (a && b) {
        const versionChanged =
          (a.recommendedVersion ?? a.currentVersion) !==
          (b.recommendedVersion ?? b.currentVersion);
        const statusChanged = a.status !== b.status;
        if (versionChanged || statusChanged) {
          changed++;
          rows.push({
            name,
            fromVersion: a.recommendedVersion ?? a.currentVersion,
            toVersion: b.recommendedVersion ?? b.currentVersion,
            fromStatus: a.status,
            toStatus: b.status,
            kind: 'changed'
          });
        }
      }
    }
    return { rows, added, removed, changed };
  });
}
