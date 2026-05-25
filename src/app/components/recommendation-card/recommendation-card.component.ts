import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Recommendation } from '../../models/npm-package.model';
import { PackageManagerService } from '../../services/package-manager.service';
import { CopyOnClickDirective } from '../../directives/copy-on-click.directive';

@Component({
  selector: 'app-recommendation-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, CopyOnClickDirective],
  template: `
    @let r = rec();
    @if (r && pkgName()) {
      <section class="card" aria-label="Recommendation">
        <header>
          <h3>Recommended for Angular {{ r.angularMajor }}</h3>
          @if (!r.stable && !r.latest) {
            <span class="pill pill-warn">no compatible version found</span>
          }
        </header>

        @if (r.stable) {
          <div class="row">
            <div class="label">Stable</div>
            <code class="cmd" [appCopyOnClick]="install(r.stable.version)" copyLabel="install command">{{ install(r.stable.version) }}</code>
            <button type="button" class="copy" (click)="copy.emit(install(r.stable.version))">Copy</button>
          </div>
        }

        @if (r.latest && r.latest !== r.stable) {
          <div class="row">
            <div class="label">Latest</div>
            <code class="cmd" [appCopyOnClick]="install(r.latest.version)" copyLabel="install command">{{ install(r.latest.version) }}</code>
            <button type="button" class="copy" (click)="copy.emit(install(r.latest.version))">Copy</button>
          </div>
        }

        @if (r.stable && r.latest && r.stable.version === r.latest.version) {}

        <p class="hint">
          Scanned {{ r.all.length }} compatible version{{ r.all.length === 1 ? '' : 's' }}
          across {{ pkgName() }}. Prefer <strong>stable</strong> unless you need a preview.
        </p>
      </section>
    }
  `,
  styles: [`
    /* Make the host a block so the component participates predictably
       in the page's vertical rhythm even when it's the only child in
       a defer block. The inner .card already owns the 1rem top
       margin; this rule just guarantees the host doesn't collapse to
       inline. */
    :host { display: block; }
    .card {
      margin-top: 1rem; padding: 1rem 1.25rem;
      background: color-mix(in srgb, var(--accent) 7%, var(--surface-2));
      border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
      border-radius: 14px;
    }
    header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem; }
    h3 { margin: 0; font-size: 1rem; color: var(--fg); }
    .row {
      display: grid; grid-template-columns: auto 1fr auto; gap: 0.5rem; align-items: center;
      margin-top: 0.6rem;
    }
    .label {
      font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em;
      color: var(--fg-dim);
    }
    .cmd {
      padding: 0.45rem 0.7rem; background: var(--surface-1); border: 1px solid var(--border);
      border-radius: 8px; color: var(--fg); font-family: ui-monospace, Menlo, Consolas, monospace;
      font-size: 0.85rem; overflow-x: auto;
    }
    .copy {
      padding: 0.4rem 0.8rem; background: var(--surface-1);
      border: 1px solid var(--border); border-radius: 8px; color: var(--accent);
      cursor: pointer; min-height: 36px;
    }
    .copy:hover { border-color: var(--accent); }
    .pill { padding: 2px 8px; border-radius: 999px; font-size: 0.72rem; }
    .pill-warn {
      background: color-mix(in srgb, #ef4444 15%, transparent); color: #fca5a5;
      border: 1px solid color-mix(in srgb, #ef4444 35%, transparent);
    }
    .hint { margin-top: 0.5rem; color: var(--fg-dim); font-size: 0.8rem; }

    @media (max-width: 520px) {
      .row { grid-template-columns: 1fr; }
      .copy { justify-self: start; }
    }
  `]
})
export class RecommendationCardComponent {
  private readonly pm = inject(PackageManagerService);

  readonly rec = input<Recommendation | null>(null);
  readonly pkgName = input<string | null>(null);
  readonly copy = output<string>();

  install(version: string): string {
    const name = this.pkgName();
    if (!name) return '';
    return this.pm.installCommand(name, version);
  }
}
