import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslocoModule } from '@jsverse/transloco';
import { DigestChange, MonitorService } from '../../services/monitor.service';

/**
 * Monitor digest summary — used on the workspace and projects pages to show
 * "what changed since you last checked." Self-contained: it pulls everything
 * it needs from MonitorService.
 */
@Component({
  selector: 'app-monitor-digest',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TranslocoModule],
  template: `
    @if (rows().length) {
      <section class="digest">
        <header>
          <h2>{{ 'monitor.title' | transloco }}</h2>
          <p class="muted">{{ 'monitor.lede' | transloco }}</p>
        </header>
        <ul class="projects">
          @for (row of rows(); track row.projectKey) {
            <li>
              <header>
                <strong>{{ row.label }}</strong>
                <span class="meta">
                  {{ 'monitor.lastCheck' | transloco: { time: formatTime(row.capturedAt) } }}
                  @if (row.healthDelta !== 0) {
                    ·
                    <span [class.up]="row.healthDelta > 0" [class.down]="row.healthDelta < 0">
                      {{ row.healthDelta > 0 ? '+' : '' }}{{ row.healthDelta }} {{ 'monitor.healthDelta' | transloco }}
                    </span>
                  }
                </span>
                <button type="button" class="ghost" (click)="forget(row.projectKey)">
                  {{ 'monitor.stop' | transloco }}
                </button>
              </header>
              @if (row.changes.length === 0) {
                <p class="empty">{{ 'monitor.noChanges' | transloco }}</p>
              } @else {
                <ul class="changes">
                  @for (c of row.changes; track changeKey(c)) {
                    <li [attr.data-kind]="c.kind">
                      <code>{{ c.package }}</code>
                      <span>{{ describe(c) }}</span>
                    </li>
                  }
                </ul>
              }
            </li>
          }
        </ul>
      </section>
    }
  `,
  styles: [`
    :host { display: block; margin-bottom: 1.25rem; }
    .digest {
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 12px;
      padding: 1rem 1.1rem;
      background: var(--surface-1, #fff);
    }
    .digest > header h2 { margin: 0 0 0.2rem; font-size: 1rem; }
    .muted { color: var(--fg-dim, #64748b); font-size: 0.85rem; margin: 0 0 0.85rem; }
    .projects { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.7rem; }
    .projects > li {
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 10px;
      padding: 0.7rem 0.85rem;
      background: color-mix(in srgb, var(--surface-2, #f8fafc) 70%, transparent);
    }
    .projects > li > header {
      display: flex; gap: 0.6rem; align-items: baseline; flex-wrap: wrap;
      margin-bottom: 0.45rem;
    }
    .projects > li > header strong { font-size: 0.9rem; flex: 0 0 auto; }
    .projects > li > header .meta { color: var(--fg-dim, #64748b); font-size: 0.78rem; flex: 1 1 auto; min-width: 0; }
    .projects > li > header .meta .up { color: #16a34a; font-weight: 600; }
    .projects > li > header .meta .down { color: #dc2626; font-weight: 600; }
    .empty { color: var(--fg-dim, #64748b); font-size: 0.82rem; margin: 0; }
    .changes { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.25rem; }
    .changes li {
      display: grid; grid-template-columns: minmax(140px, auto) 1fr; gap: 0.5rem;
      align-items: baseline;
      padding: 0.3rem 0.5rem; border-radius: 6px;
      font-size: 0.83rem;
    }
    .changes li code { font: 0.8rem ui-monospace, Menlo, Consolas, monospace; }
    .changes li[data-kind="added"] { background: color-mix(in srgb, #22c55e 8%, transparent); }
    .changes li[data-kind="removed"] { background: color-mix(in srgb, #94a3b8 12%, transparent); color: var(--fg-dim, #64748b); }
    .changes li[data-kind="status-changed"] { background: color-mix(in srgb, #f59e0b 10%, transparent); }
    .changes li[data-kind="recommended-changed"] { background: color-mix(in srgb, #3b82f6 8%, transparent); }
    .changes li[data-kind="deprecated"] { background: color-mix(in srgb, #dc2626 10%, transparent); }
    .changes li[data-kind="undeprecated"] { background: color-mix(in srgb, #22c55e 8%, transparent); }
    button.ghost {
      padding: 0.3rem 0.7rem; border-radius: 6px;
      background: transparent; border: 1px solid var(--border, #e5e7eb);
      font-size: 0.78rem; cursor: pointer;
    }
  `]
})
export class MonitorDigestComponent {
  private readonly monitor = inject(MonitorService);

  /** Sorted by most-recent capture. */
  readonly rows = computed(() => {
    const m = this.monitor.latestDigests();
    return Object.values(m).sort((a, b) => b.capturedAt - a.capturedAt);
  });

  forget(key: string): void {
    this.monitor.forget(key);
  }

  describe(c: DigestChange): string {
    switch (c.kind) {
      case 'added':
        return c.recommendedVersion
          ? `Newly tracked — recommend ${c.recommendedVersion}.`
          : 'Newly tracked.';
      case 'removed':
        return 'No longer present in package.json.';
      case 'status-changed':
        return `Status changed from "${c.from}" to "${c.to}".`;
      case 'recommended-changed':
        return c.from && c.to
          ? `Recommended bumped from ${c.from} to ${c.to}.`
          : c.to
          ? `New recommendation: ${c.to}.`
          : 'Previous recommendation no longer applies.';
      case 'deprecated':
        return 'Now deprecated by maintainers.';
      case 'undeprecated':
        return 'No longer marked deprecated.';
    }
  }

  changeKey(c: DigestChange): string {
    return `${c.package}:${c.kind}`;
  }

  formatTime(ts: number): string {
    const diffMs = Date.now() - ts;
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
}
