import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslocoModule } from '@jsverse/transloco';
import {
  ProjectScannerService,
  ScannedProject
} from '../../services/project-scanner.service';
import { ProviderTokenStore } from '../../services/provider-token-store.service';

/**
 * Renders the result of a project scan: one row per repo, with a clear
 * indicator of which ones are Angular and an "Analyze" button that hands the
 * parsed package.json off to the upgrade tool.
 *
 * This component is intentionally view-only — actions (analyze, refresh) are
 * emitted as outputs so the host page can decide how to wire them.
 */
@Component({
  selector: 'app-project-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TranslocoModule],
  template: `
    <header class="head">
      <h2>{{ 'projects.title' | transloco }}</h2>
      <div class="actions">
        @if (status()?.stage === 'fetching') {
          <!-- role=status (aria-live=polite) so screen readers
               announce scan progress as it ticks up, without
               interrupting whatever the user is currently doing.
               atomic=true means the whole line is re-read on each
               update, not just the changed numbers. -->
          <span class="muted" role="status" aria-live="polite" aria-atomic="true">
            {{ 'projects.scanning' | transloco: { done: status()!.done, total: status()!.total } }}
          </span>
        } @else if (projects().length) {
          <span class="muted" role="status" aria-live="polite" aria-atomic="true">
            {{ 'projects.found' | transloco: { angular: angularCount(), total: projects().length } }}
          </span>
        }
        <button type="button" class="ghost" (click)="refresh.emit()">
          {{ 'projects.refresh' | transloco }}
        </button>
      </div>
    </header>

    @if (status()?.stage === 'listing') {
      <p class="muted" role="status" aria-live="polite">{{ 'projects.listing' | transloco }}</p>
    }

    @if (projects().length === 0 && status()?.stage === 'done') {
      <article class="empty">
        <h3>{{ 'projects.empty.title' | transloco }}</h3>
        <p>{{ 'projects.empty.body' | transloco }}</p>
        <!-- Azure-specific empty-state hint. AzureRepoService silently
             swallows API failures (catchError → empty list) so without
             this hint, an Azure user who can't enumerate repos sees a
             generic "No projects yet" and has no idea why. The hint
             only renders when Azure is among the linked providers, so
             GitHub/GitLab/Bitbucket users with empty results don't see
             a misleading message about Azure. -->
        @if (hasAzureLinked()) {
          <p class="azure-hint">
            <span aria-hidden="true">🧪</span>
            {{ 'projects.empty.azureHint' | transloco }}
          </p>
        }
      </article>
    }

    @if (projects().length) {
      <ul class="rows">
        @for (p of projects(); track p.repo.id) {
          <li class="row" [class.angular]="p.isAngular" [class.errored]="!!p.error">
            <div class="meta">
              <span class="badge" [attr.data-provider]="p.repo.provider">
                {{ p.repo.provider }}
              </span>
              <a [href]="p.repo.webUrl" target="_blank" rel="noopener" class="name">
                {{ p.repo.fullName }}
              </a>
              @if (p.isAngular && p.parsed?.angularMajor !== null) {
                <span class="ng-chip">Angular {{ p.parsed!.angularMajor }}</span>
              }
              @if (!p.hasPackageJson && !p.error) {
                <span class="chip muted">{{ 'projects.noPackageJson' | transloco }}</span>
              }
              @if (p.error) {
                <span class="chip bad">{{ p.error }}</span>
              }
            </div>
            <div class="row-actions">
              @if (p.isAngular && p.parsed) {
                <button
                  type="button"
                  class="primary"
                  (click)="analyze.emit(p)"
                >
                  {{ 'projects.analyze' | transloco }}
                </button>
              } @else if (p.hasPackageJson && p.parsed) {
                <button
                  type="button"
                  class="ghost"
                  (click)="analyze.emit(p)"
                >
                  {{ 'projects.analyzeAnyway' | transloco }}
                </button>
              }
            </div>
          </li>
        }
      </ul>
    }
  `,
  styles: [`
    :host { display: block; }
    .head {
      display: flex; justify-content: space-between; align-items: center;
      gap: 0.5rem; flex-wrap: wrap;
      margin-bottom: 1rem;
    }
    .head h2 { margin: 0; font-size: 1.1rem; }
    .actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
    .muted { color: var(--fg-dim, #64748b); font-size: 0.85rem; }
    .empty {
      border: 1px dashed var(--border, #e5e7eb); border-radius: 12px;
      padding: 1.5rem; text-align: center; color: var(--fg-dim, #64748b);
    }
    .empty h3 { margin: 0 0 0.4rem; font-size: 1rem; color: var(--fg, #0f172a); }
    .empty p { margin: 0; }
    /* Azure-specific hint paragraph inside the generic empty state.
       Amber-tinted to match the Experimental pill vocabulary, but kept
       compact so it doesn't overpower the primary empty message. */
    .empty .azure-hint {
      margin-top: 0.75rem;
      padding: 0.55rem 0.75rem;
      border-radius: 8px;
      background: color-mix(in srgb, var(--warn, #f59e0b) 8%, transparent);
      border: 1px dashed color-mix(in srgb, var(--warn, #f59e0b) 35%, var(--border, #e5e7eb));
      color: var(--fg, #0f172a);
      font-size: 0.82rem;
      line-height: 1.5;
      text-align: left;
      display: flex;
      align-items: flex-start;
      gap: 0.4rem;
    }
    .rows { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.5rem; }
    .row {
      display: flex; justify-content: space-between; align-items: center;
      gap: 0.75rem; padding: 0.7rem 0.9rem;
      border: 1px solid var(--border, #e5e7eb); border-radius: 10px;
      background: var(--surface-1, #fff);
      flex-wrap: wrap;
    }
    .row.angular { border-color: color-mix(in srgb, #2563eb 35%, var(--border, #e5e7eb)); background: color-mix(in srgb, #2563eb 4%, var(--surface-1, #fff)); }
    .row.errored { border-color: color-mix(in srgb, #ef4444 30%, var(--border, #e5e7eb)); }
    .meta { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; flex: 1; min-width: 0; }
    .name { color: var(--fg, #0f172a); font-weight: 600; text-decoration: none; }
    .name:hover { color: var(--accent, #2563eb); text-decoration: underline; }
    .badge {
      font-size: 0.7rem; font-weight: 700; text-transform: uppercase;
      padding: 0.1rem 0.5rem; border-radius: 999px;
      color: #fff;
    }
    .badge[data-provider="github"] { background: #24292f; }
    .badge[data-provider="gitlab"] { background: #fc6d26; }
    .badge[data-provider="bitbucket"] { background: #2684ff; }
    .badge[data-provider="azure"] { background: #0078d4; }
    .ng-chip {
      background: var(--accent, #2563eb); color: #fff;
      padding: 0.05rem 0.55rem; border-radius: 999px;
      font-size: 0.72rem; font-weight: 700;
    }
    .chip {
      font-size: 0.72rem;
      padding: 0.05rem 0.5rem; border-radius: 999px;
      background: var(--surface-2, #f1f5f9); color: var(--fg-dim, #475569);
    }
    .chip.bad { background: color-mix(in srgb, #ef4444 18%, var(--surface-2, #f1f5f9)); color: #b91c1c; }
    .row-actions { display: flex; gap: 0.4rem; }
    button { font: inherit; cursor: pointer; }
    button.primary {
      background: var(--accent, #2563eb); color: #fff;
      padding: 0.4rem 0.9rem; border: none; border-radius: 8px;
      font-size: 0.82rem; font-weight: 600;
    }
    button.ghost {
      background: transparent;
      border: 1px solid var(--border, #e5e7eb);
      padding: 0.4rem 0.9rem; border-radius: 8px;
      font-size: 0.82rem;
    }
  `]
})
export class ProjectListComponent {
  readonly scanner = inject(ProjectScannerService);
  private readonly tokens = inject(ProviderTokenStore);

  /** Optional explicit list of projects; falls back to the scanner signal. */
  readonly override = input<ScannedProject[] | null>(null);

  readonly projects = computed(() => this.override() ?? this.scanner.projects());
  readonly status = computed(() => this.scanner.status());
  readonly angularCount = computed(() => this.projects().filter((p) => p.isAngular).length);

  /**
   * True when Azure DevOps is one of the user's linked providers. Drives
   * the Azure-specific hint in the empty state. We only show that hint
   * when Azure could plausibly be the reason for the empty result —
   * otherwise we'd alarm GitHub/GitLab/Bitbucket users about a provider
   * they aren't using.
   */
  readonly hasAzureLinked = computed(() =>
    this.tokens.bindings().some((b) => b.provider === 'azure')
  );

  /** User asked us to re-scan everything. */
  readonly refresh = output<void>();
  /** User asked to analyze a specific project. */
  readonly analyze = output<ScannedProject>();
}
