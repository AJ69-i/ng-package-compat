import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { VersionDiff } from '../../models/npm-package.model';

@Component({
  selector: 'app-version-diff',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  template: `
    @let d = diff();
    @if (d) {
      <div class="header">
        <h3>Diff {{ d.from }} → {{ d.to }}</h3>
        @if (d.deprecationChange) {
          <span class="pill pill-warn">deprecation change</span>
        }
      </div>

      <div class="grid">
        <section class="col">
          <h4>Peer dependencies</h4>
          @if (!d.addedPeers.length && !d.removedPeers.length && !d.changedPeers.length) {
            <p class="empty">No peer changes.</p>
          }
          @for (i of d.addedPeers; track i.name) {
            <div class="line added"><span class="sym">+</span> {{ i.name }} <code>{{ i.range }}</code></div>
          }
          @for (i of d.removedPeers; track i.name) {
            <div class="line removed"><span class="sym">−</span> {{ i.name }} <code>{{ i.range }}</code></div>
          }
          @for (i of d.changedPeers; track i.name) {
            <div class="line changed">
              <span class="sym">~</span> {{ i.name }}
              <code class="old">{{ i.from }}</code>
              <span aria-hidden="true">→</span>
              <code class="new">{{ i.to }}</code>
            </div>
          }
        </section>

        <section class="col">
          <h4>Dependencies</h4>
          @if (!d.addedDeps.length && !d.removedDeps.length && !d.changedDeps.length) {
            <p class="empty">No dependency changes.</p>
          }
          @for (i of d.addedDeps; track i.name) {
            <div class="line added"><span class="sym">+</span> {{ i.name }} <code>{{ i.range }}</code></div>
          }
          @for (i of d.removedDeps; track i.name) {
            <div class="line removed"><span class="sym">−</span> {{ i.name }} <code>{{ i.range }}</code></div>
          }
          @for (i of d.changedDeps; track i.name) {
            <div class="line changed">
              <span class="sym">~</span> {{ i.name }}
              <code class="old">{{ i.from }}</code>
              <span aria-hidden="true">→</span>
              <code class="new">{{ i.to }}</code>
            </div>
          }
        </section>
      </div>
    }
  `,
  styles: [`
    .header { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
    h3 { margin: 0; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 0.75rem; margin-top: 0.5rem; }
    .col {
      background: var(--surface-2); border: 1px solid var(--border);
      border-radius: 12px; padding: 0.75rem 1rem;
    }
    h4 { margin: 0 0 0.35rem; font-size: 0.9rem; color: var(--fg); }
    .line {
      padding: 0.2rem 0; font-size: 0.85rem;
      display: flex; gap: 0.35rem; flex-wrap: wrap; align-items: center;
    }
    .line code { padding: 0 6px; border-radius: 5px; font-size: 0.8rem; }
    .added     { color: #86efac; }
    .added code      { background: color-mix(in srgb, #22c55e 15%, transparent); }
    .removed   { color: #fca5a5; }
    .removed code    { background: color-mix(in srgb, #ef4444 15%, transparent); }
    .changed   { color: var(--fg); }
    .changed .old    { background: color-mix(in srgb, #ef4444 15%, transparent); color: #fca5a5; }
    .changed .new    { background: color-mix(in srgb, #22c55e 15%, transparent); color: #86efac; }
    .sym { font-family: ui-monospace, Menlo, monospace; width: 1rem; }
    .empty { color: var(--fg-dim); margin: 0; }
    .pill { padding: 2px 8px; border-radius: 999px; font-size: 0.72rem; }
    .pill-warn {
      background: color-mix(in srgb, #f59e0b 15%, transparent); color: #fcd34d;
      border: 1px solid color-mix(in srgb, #f59e0b 40%, transparent);
    }
  `]
})
export class VersionDiffComponent {
  readonly diff = input<VersionDiff | null>(null);
}
