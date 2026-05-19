import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { VersionCompatibility } from '../../models/npm-package.model';

@Component({
  selector: 'app-dependencies-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  template: `
    @let r = row();
    @if (r) {
      <div class="grid">
        @if (peerEntries().length) {
          <section class="panel">
            <h3>peerDependencies <span class="count">({{ peerEntries().length }})</span></h3>
            <ul>
              @for (d of peerEntries(); track d[0]) {
                <li>
                  <code class="name">{{ d[0] }}</code>
                  <code class="range">{{ d[1] }}</code>
                </li>
              }
            </ul>
          </section>
        }

        @if (depEntries().length) {
          <section class="panel">
            <h3>dependencies <span class="count">({{ depEntries().length }})</span></h3>
            <ul>
              @for (d of depEntries(); track d[0]) {
                <li>
                  <code class="name">{{ d[0] }}</code>
                  <code class="range">{{ d[1] }}</code>
                </li>
              }
            </ul>
          </section>
        }

        <section class="panel panel-sm">
          <h3>Runtime</h3>
          <dl>
            <dt>Node engine</dt>
            <dd>{{ r.nodeEngine || '—' }}</dd>
            <dt>License</dt>
            <dd>{{ r.license || '—' }}</dd>
            <dt>Ships types</dt>
            <dd>{{ r.hasTypes ? 'yes' : 'no' }}</dd>
            <dt>Unpacked size</dt>
            <dd>{{ r.unpackedSize ? formatBytes(r.unpackedSize) : '—' }}</dd>
            <dt>Published</dt>
            <dd>{{ r.publishedAt ? (r.publishedAt.toISOString().slice(0,10)) : '—' }}</dd>
          </dl>
        </section>
      </div>

      @if (!peerEntries().length && !depEntries().length) {
        <p class="empty">This version declares no dependencies.</p>
      }
    }
  `,
  styles: [`
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 0.75rem; }
    .panel {
      border: 1px solid var(--border); border-radius: 12px;
      background: var(--surface-2); padding: 0.75rem 1rem;
    }
    .panel h3 { margin: 0 0 0.4rem; font-size: 0.9rem; color: var(--fg); }
    .count { font-size: 0.75rem; color: var(--fg-dim); font-weight: 400; }
    .panel ul { list-style: none; padding: 0; margin: 0; }
    .panel li {
      display: flex; justify-content: space-between; gap: 0.5rem;
      padding: 0.25rem 0; border-top: 1px dashed var(--border); font-size: 0.85rem;
    }
    .panel li:first-child { border-top: none; }
    .name { color: var(--fg); }
    .range { color: var(--fg-dim); }
    .panel-sm dl { display: grid; grid-template-columns: auto 1fr; gap: 0.25rem 0.75rem; margin: 0; }
    .panel-sm dt { color: var(--fg-dim); font-size: 0.8rem; }
    .panel-sm dd { margin: 0; color: var(--fg); font-size: 0.85rem; }
    .empty { color: var(--fg-dim); padding: 1rem 0; }
  `]
})
export class DependenciesPanelComponent {
  readonly row = input<VersionCompatibility | null>(null);

  readonly peerEntries = computed(() => {
    const r = this.row();
    return r ? Object.entries(r.peerDependencies).sort(([a], [b]) => a.localeCompare(b)) : [];
  });

  readonly depEntries = computed(() => {
    const r = this.row();
    return r ? Object.entries(r.dependencies).sort(([a], [b]) => a.localeCompare(b)) : [];
  });

  formatBytes(n: number): string {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }
}
