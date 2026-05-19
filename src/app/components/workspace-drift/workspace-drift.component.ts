import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslocoModule } from '@jsverse/transloco';
import { ParsedPackageJson } from '../../models/npm-package.model';
import {
  WorkspaceAnalyzerService,
  WorkspaceProject
} from '../../services/workspace-analyzer.service';
import { ToastService } from '../../services/toast.service';

/**
 * Shows cross-project dependency drift when the user uploads more than one
 * `package.json`. For Nx / Angular multi-project / npm-workspaces users the
 * real pain is "which version of rxjs does each app use?" — this answers it.
 */
@Component({
  selector: 'app-workspace-drift',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TranslocoModule],
  template: `
    @if (projects().length >= 2) {
      <section class="wd">
        <header>
          <h2>{{ 'workspace.title' | transloco }}</h2>
          <span class="chip" [attr.data-kind]="report()?.kind">
            {{ report()?.kind }} · {{ projects().length }} {{ 'workspace.projects' | transloco }}
          </span>
          @if ((report()?.angularMajors?.length ?? 0) > 1) {
            <span class="chip bad">
              {{ 'workspace.ngDrift' | transloco: { list: report()!.angularMajors.join(', ') } }}
            </span>
          }
        </header>
        @if (drift().length) {
          <p class="lede">{{ 'workspace.drift' | transloco: { n: drift().length } }}</p>
          <table>
            <thead>
              <tr>
                <th>{{ 'workspace.dep' | transloco }}</th>
                <th>{{ 'workspace.distinct' | transloco }}</th>
                @for (p of projects(); track p.id) { <th>{{ p.id }}</th> }
              </tr>
            </thead>
            <tbody>
              @for (d of drift(); track d.name) {
                <tr>
                  <td><code>{{ d.name }}</code></td>
                  <td><strong>{{ d.distinct }}</strong></td>
                  @for (p of projects(); track p.id) {
                    <td [class.off]="!!d.ranges[p.id] && d.ranges[p.id] !== d.majority">
                      {{ d.ranges[p.id] || '—' }}
                    </td>
                  }
                </tr>
              }
            </tbody>
          </table>
          <div class="cmd-row">
            <code>{{ alignNpm() || '—' }}</code>
            @if (alignNpm()) {
              <button type="button" class="link" (click)="copyCmd(alignNpm())">{{ 'workspace.copyAlign' | transloco }}</button>
            }
          </div>
        } @else {
          <p class="muted">{{ 'workspace.noDrift' | transloco }}</p>
        }
      </section>
    }
  `,
  styles: [`
    :host { display: block; }
    .wd { padding: 1rem; border: 1px solid var(--brd, #e5e7eb); border-radius: var(--r-md, 10px); background: var(--bg, #fff); margin: 1rem 0; }
    header { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
    header h2 { margin: 0; font-size: 1rem; }
    .chip { background: var(--bg-soft, #f1f5f9); padding: 0.15rem 0.55rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; color: var(--fg-dim, #475569); }
    .chip.bad { background: var(--warn-soft, #fef3c7); color: var(--warn, #b45309); }
    .lede { margin: 0.5rem 0; font-size: 0.9rem; }
    .muted { color: var(--muted, #64748b); font-size: 0.85rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.82rem; margin-top: 0.5rem; }
    th, td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--brd-soft, #f1f5f9); }
    th { background: var(--bg-soft, #f9fafb); font-weight: 600; }
    td code { background: var(--bg-soft, #f1f5f9); padding: 0.05rem 0.3rem; border-radius: 4px; }
    td.off { background: rgba(245, 158, 11, 0.12); color: var(--warn, #b45309); font-weight: 600; }
    .cmd-row { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.6rem; padding: 0.5rem 0.75rem; background: var(--bg-soft, #f9fafb); border-radius: var(--r-sm, 6px); }
    .cmd-row code { font-size: 0.78rem; flex: 1; min-width: 0; overflow-x: auto; white-space: nowrap; }
    .link { background: none; border: none; color: var(--accent, #2563eb); text-decoration: underline; cursor: pointer; font: inherit; }
  `]
})
export class WorkspaceDriftComponent {
  /** The primary project. */
  readonly primary = input.required<ParsedPackageJson>();
  /** Any additional project package.jsons. */
  readonly extras = input<ParsedPackageJson[]>([]);
  /** Optional raw nx.json content (for kind inference). */
  readonly nxJsonRaw = input<string | undefined>(undefined);

  private readonly analyzer = inject(WorkspaceAnalyzerService);
  private readonly toast = inject(ToastService);

  readonly projects = computed<WorkspaceProject[]>(() => {
    const all: WorkspaceProject[] = [];
    const p = this.primary();
    all.push({
      id: p.name ?? 'root',
      pkg: p,
      path: p.name ? `${p.name}/package.json` : 'package.json'
    });
    for (const [i, ex] of this.extras().entries()) {
      all.push({
        id: ex.name ?? `project-${i + 1}`,
        pkg: ex,
        path: ex.name ? `${ex.name}/package.json` : `apps/${i + 1}/package.json`
      });
    }
    return all;
  });

  readonly report = computed(() => {
    const ps = this.projects();
    if (ps.length < 2) return null;
    return this.analyzer.analyze(ps, this.nxJsonRaw());
  });

  readonly drift = computed(() => this.report()?.drift ?? []);
  readonly alignNpm = computed(() => this.analyzer.alignCommand('npm'));

  async copyCmd(cmd: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(cmd);
      this.toast.success('Alignment command copied');
    } catch {
      this.toast.error('Copy failed — your browser blocked clipboard access.');
    }
  }
}
