import {
  ChangeDetectionStrategy,
  Component,
  ViewChild,
  computed,
  effect,
  inject,
  input,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslocoModule } from '@jsverse/transloco';
import {
  AiCompletionResponse,
  AiError,
  AiProviderId
} from '../../services/ai/ai-provider.service';
import { VersionMigrationService } from '../../services/ai/version-migration.service';
import { CompareHistoryService } from '../../services/compare-history.service';
import {
  MigrationResponse,
  MigrationSeverity,
  MigrationEffort
} from '../../services/ai/schemas/version-migration.schema';
import { AiSettingsDialogComponent } from '../ai-settings-dialog/ai-settings-dialog.component';

/**
 * AI-generated upgrade report for a SINGLE package across two versions.
 * Used on /compare when both inputs resolve to the same package
 * ("ngx-toastr v15 vs ngx-toastr v17").
 *
 * UI shape:
 *   - Header with title + Settings gear + Refresh
 *   - Idle CTA (single button — opt-in API call)
 *   - Loading shimmer (severity chip silhouette + 3 section silhouettes)
 *   - Result: severity + effort chip strip, then sections for
 *     Breaking Changes / Deprecations / Migration Steps
 *   - Error: typed message + retry, mirrors the other AI panels
 *
 * Why three stacked sections rather than tabs:
 *   Unlike the Usage Guide (where you want to compare A's install with
 *   B's install side-by-side), the Migration output reads
 *   top-to-bottom: severity → what breaks → what's deprecated → how to
 *   fix it. A user reading this on an upgrade ticket wants a single
 *   linear scroll, not three tabs they have to click through.
 */

interface IdleState { kind: 'idle'; }
interface LoadingState { kind: 'loading'; }
interface ResultState {
  kind: 'result';
  data: MigrationResponse;
  provider: AiProviderId;
  model: string;
  generatedAt: number;
  latencyMs: number;
}
interface ErrorState {
  kind: 'error';
  message: string;
  errorKind: AiError['kind'] | 'UNKNOWN';
  isRateLimited: boolean;
}
type PanelState = IdleState | LoadingState | ResultState | ErrorState;

@Component({
  selector: 'app-version-migration-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TranslocoModule, AiSettingsDialogComponent],
  template: `
    @if (pkg() && fromVersion() && toVersion()) {
      <section class="vm-panel" [class.vm-busy]="state().kind === 'loading'">
        <header class="vm-head">
          <div class="vm-head-text">
            <h3>{{ 'versionMigration.title' | transloco }}</h3>
            <p class="vm-lede">
              {{ 'versionMigration.lede' | transloco: { pkg: pkg(), from: fromVersion(), to: toVersion() } }}
            </p>
          </div>
          <div class="vm-head-actions">
            <button
              type="button"
              class="vm-icon-btn"
              (click)="openSettings()"
              [attr.aria-label]="'aiSettings.openButton' | transloco"
              [title]="'aiSettings.openButton' | transloco"
            >
              <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="8" cy="8" r="2"/>
                <path d="M8 1v2M8 13v2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M1 8h2M13 8h2M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41"/>
              </svg>
            </button>
            @if (state().kind === 'result' || state().kind === 'error') {
              <button
                type="button"
                class="vm-refresh"
                (click)="generate(true)"
                [attr.aria-label]="'versionMigration.refresh' | transloco"
                [disabled]="state().kind === 'loading'"
              >
                {{ 'versionMigration.refresh' | transloco }}
              </button>
            }
          </div>
        </header>

        @switch (state().kind) {
          @case ('idle') {
            <div class="vm-cta">
              <p class="vm-cta-body">
                {{ 'versionMigration.ctaBody' | transloco: { pkg: pkg(), from: fromVersion(), to: toVersion() } }}
              </p>
              <button
                type="button"
                class="primary"
                (click)="generate(false)"
                data-testid="versionMigration.generate"
              >
                {{ 'versionMigration.generate' | transloco }}
              </button>
            </div>
          }

          @case ('loading') {
            <div class="vm-skeleton" role="status" aria-live="polite">
              <div class="vm-sk-chips">
                <span class="sk-pill"></span>
                <span class="sk-pill"></span>
              </div>
              <div class="vm-sk-line w-90"></div>
              <div class="vm-sk-line w-70"></div>
              <div class="vm-sk-section">
                <div class="vm-sk-line w-60"></div>
                <div class="vm-sk-line w-80"></div>
                <div class="vm-sk-line w-50"></div>
              </div>
              <span class="vm-sr-only">{{ 'common.loading' | transloco }}</span>
            </div>
          }

          @case ('result') {
            @let r = asResult(state());
            <div class="vm-result">
              <!-- Severity + effort chips form the at-a-glance summary.
                   Color-coded so the eye lands on the severity first; the
                   tooltip carries the long description for sighted users
                   and the aria-label for screen-reader users alike. -->
              <div class="vm-chips">
                <span
                  class="vm-sev"
                  [class.sev-patch]="r.data.severity === 'patch'"
                  [class.sev-minor]="r.data.severity === 'minor'"
                  [class.sev-major-safe]="r.data.severity === 'major-safe'"
                  [class.sev-major-breaking]="r.data.severity === 'major-breaking'"
                  [attr.title]="('versionMigration.severity.desc.' + r.data.severity) | transloco"
                >
                  <span class="vm-dot" aria-hidden="true"></span>
                  {{ ('versionMigration.severity.label.' + r.data.severity) | transloco }}
                </span>
                <span class="vm-effort">
                  {{ 'versionMigration.effort.label' | transloco }}:
                  {{ ('versionMigration.effort.' + r.data.effortEstimate) | transloco }}
                </span>
                @if (r.data.confidence === 'low') {
                  <span class="vm-confidence vm-conf-low" [attr.title]="'versionMigration.confidence.lowHint' | transloco">
                    {{ 'versionMigration.confidence.low' | transloco }}
                  </span>
                }
              </div>

              <p class="vm-summary">{{ r.data.summary }}</p>

              <!-- BREAKING CHANGES -->
              @if (r.data.breakingChanges.length) {
                <section class="vm-section vm-breaks">
                  <h4>
                    <span aria-hidden="true">⚠️</span>
                    {{ 'versionMigration.sections.breaks' | transloco }}
                    <span class="vm-count">{{ r.data.breakingChanges.length }}</span>
                  </h4>
                  <ul class="vm-list">
                    @for (b of r.data.breakingChanges; track b.title) {
                      <li class="vm-item">
                        <div class="vm-item-head">
                          <strong>{{ b.title }}</strong>
                          <span class="vm-since">{{ 'versionMigration.since' | transloco }} {{ b.sinceVersion }}</span>
                        </div>
                        <p class="vm-item-detail">{{ b.detail }}</p>
                        <p class="vm-item-action">
                          <span class="vm-action-label">{{ 'versionMigration.action' | transloco }}:</span>
                          {{ b.action }}
                        </p>
                      </li>
                    }
                  </ul>
                </section>
              }

              <!-- DEPRECATIONS -->
              @if (r.data.deprecations.length) {
                <section class="vm-section vm-deps">
                  <h4>
                    <span aria-hidden="true">⚠</span>
                    {{ 'versionMigration.sections.deprecations' | transloco }}
                    <span class="vm-count">{{ r.data.deprecations.length }}</span>
                  </h4>
                  <ul class="vm-list">
                    @for (d of r.data.deprecations; track d.api) {
                      <li class="vm-item">
                        <div class="vm-item-head">
                          <code>{{ d.api }}</code>
                          <span class="vm-since">{{ 'versionMigration.since' | transloco }} {{ d.sinceVersion }}</span>
                        </div>
                        @if (d.replacement) {
                          <p class="vm-dep-replace">
                            <span class="vm-action-label">{{ 'versionMigration.replacement' | transloco }}:</span>
                            <code>{{ d.replacement }}</code>
                          </p>
                        }
                        @if (d.note) { <p class="vm-item-detail">{{ d.note }}</p> }
                      </li>
                    }
                  </ul>
                </section>
              }

              <!-- MIGRATION STEPS -->
              @if (r.data.migrationSteps.length) {
                <section class="vm-section vm-steps">
                  <h4>
                    <span aria-hidden="true">🛠</span>
                    {{ 'versionMigration.sections.steps' | transloco }}
                  </h4>
                  <ol class="vm-step-list">
                    @for (s of r.data.migrationSteps; track $index) {
                      <li class="vm-step">
                        <div class="vm-step-text">{{ s.step }}</div>
                        @if (s.code) {
                          <div class="vm-code-wrap">
                            <span class="vm-lang">{{ s.language }}</span>
                            <pre class="vm-code"><code>{{ s.code }}</code></pre>
                            <button
                              type="button"
                              class="vm-copy"
                              (click)="copy(s.code, $index)"
                              [attr.aria-label]="'versionMigration.copyCode' | transloco"
                            >
                              {{ (copiedIndex() === $index ? 'common.copied' : 'common.copy') | transloco }}
                            </button>
                          </div>
                        }
                      </li>
                    }
                  </ol>
                </section>
              }

              @if (!r.data.breakingChanges.length && !r.data.deprecations.length && !r.data.migrationSteps.length) {
                <p class="vm-empty">{{ 'versionMigration.emptyAllClear' | transloco }}</p>
              }

              <footer class="vm-meta">
                <span>{{ 'versionMigration.poweredBy' | transloco: { provider: providerLabel(r.provider) } }}</span>
                <span>·</span>
                <span>{{ 'versionMigration.generatedIn' | transloco: { ms: r.latencyMs } }}</span>
              </footer>
            </div>
          }

          @case ('error') {
            @let e = asError(state());
            <div class="vm-error" role="alert">
              <p class="vm-err-msg">{{ e.message }}</p>
              <button type="button" class="primary" (click)="generate(false)">
                {{ 'common.retry' | transloco }}
              </button>
            </div>
          }
        }
      </section>

      <!-- Inline settings dialog so changing the provider doesn't lose
           the user's current versions selection. Mirrors the UsageGuide
           and ProsCons panels. -->
      <app-ai-settings-dialog #settingsDialog />
    }
  `,
  styles: [`
    :host { display: block; }

    .vm-panel {
      margin-top: 1.5rem;
      padding: 1.25rem 1.5rem;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--radius-xl, 14px);
      box-shadow: var(--shadow-1);
    }
    .vm-busy { opacity: 0.85; }

    .vm-head {
      display: flex; justify-content: space-between; align-items: flex-start;
      gap: 1rem; margin-bottom: 1rem;
    }
    .vm-head h3 { margin: 0; font-size: 1.1rem; color: var(--fg); }
    .vm-lede { margin: 0.25rem 0 0; color: var(--fg-dim); font-size: 0.9rem; }
    .vm-head-actions { display: flex; gap: 0.4rem; }
    .vm-icon-btn, .vm-refresh {
      background: var(--surface-1); border: 1px solid var(--border);
      color: var(--fg-dim);
      padding: 6px 10px;
      border-radius: var(--radius-md, 10px);
      font-size: 0.8rem;
      cursor: pointer;
      display: inline-flex; align-items: center; gap: 0.35rem;
    }
    .vm-icon-btn:hover, .vm-refresh:hover { color: var(--fg); border-color: var(--accent); }
    .vm-refresh:disabled { opacity: 0.5; cursor: not-allowed; }

    /* ----- CTA / Idle ----- */
    .vm-cta {
      padding: 1.25rem; text-align: center;
      background: var(--surface-1); border: 1px dashed var(--border);
      border-radius: var(--radius-md, 10px);
    }
    .vm-cta-body { margin: 0 0 0.85rem; color: var(--fg-dim); font-size: 0.9rem; }
    button.primary {
      padding: 0.65rem 1.2rem;
      border-radius: var(--radius-md, 10px);
      border: 1px solid transparent;
      background: var(--accent-gradient, var(--accent));
      color: #fff;
      font-weight: 600;
      cursor: pointer;
    }
    button.primary:hover { filter: brightness(1.05); }

    /* ----- Skeleton ----- */
    .vm-skeleton { padding: 0.4rem 0; }
    .vm-sk-chips { display: flex; gap: 0.5rem; margin-bottom: 0.8rem; }
    .sk-pill {
      width: 90px; height: 24px; border-radius: 999px;
      background: linear-gradient(90deg, var(--surface-1) 0%, var(--border) 50%, var(--surface-1) 100%);
      background-size: 200% 100%;
      animation: sk-shimmer 1.4s ease-in-out infinite;
    }
    .vm-sk-line {
      height: 12px; margin: 0.4rem 0; border-radius: 6px;
      background: linear-gradient(90deg, var(--surface-1) 0%, var(--border) 50%, var(--surface-1) 100%);
      background-size: 200% 100%;
      animation: sk-shimmer 1.4s ease-in-out infinite;
    }
    .w-90 { width: 90%; } .w-80 { width: 80%; } .w-70 { width: 70%; } .w-60 { width: 60%; } .w-50 { width: 50%; }
    .vm-sk-section { margin-top: 1rem; padding-top: 0.8rem; border-top: 1px solid var(--border); }
    @keyframes sk-shimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      .sk-pill, .vm-sk-line { animation: none; }
    }
    .vm-sr-only {
      position: absolute; width: 1px; height: 1px; padding: 0;
      margin: -1px; overflow: hidden; clip: rect(0,0,0,0);
      white-space: nowrap; border: 0;
    }

    /* ----- Severity / effort chips ----- */
    .vm-chips {
      display: flex; flex-wrap: wrap; gap: 0.5rem;
      margin-bottom: 0.85rem; align-items: center;
    }
    .vm-sev {
      display: inline-flex; align-items: center; gap: 0.4rem;
      padding: 4px 12px; border-radius: 999px;
      font-size: 0.85rem; font-weight: 500;
      border: 1px solid var(--border);
    }
    .vm-sev .vm-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; opacity: 0.85; }
    .sev-patch {
      background: color-mix(in srgb, #22c55e 12%, transparent);
      border-color: color-mix(in srgb, #22c55e 40%, transparent);
      color: #86efac;
    }
    .sev-minor {
      background: color-mix(in srgb, #38bdf8 12%, transparent);
      border-color: color-mix(in srgb, #38bdf8 40%, transparent);
      color: #bae6fd;
    }
    .sev-major-safe {
      background: color-mix(in srgb, #eab308 12%, transparent);
      border-color: color-mix(in srgb, #eab308 40%, transparent);
      color: #fde68a;
    }
    .sev-major-breaking {
      background: color-mix(in srgb, #ef4444 12%, transparent);
      border-color: color-mix(in srgb, #ef4444 40%, transparent);
      color: #fca5a5;
    }
    .vm-effort, .vm-confidence {
      font-size: 0.8rem; padding: 4px 10px;
      border-radius: 999px; color: var(--fg-dim);
      background: var(--surface-1); border: 1px solid var(--border);
    }
    .vm-conf-low {
      background: color-mix(in srgb, #eab308 10%, transparent);
      border-color: color-mix(in srgb, #eab308 35%, transparent);
      color: #fde68a;
    }

    .vm-summary {
      margin: 0 0 1.1rem;
      color: var(--fg);
      line-height: 1.55;
    }

    /* ----- Sections ----- */
    .vm-section {
      padding: 0.9rem 0; border-top: 1px solid var(--border);
    }
    .vm-section h4 {
      margin: 0 0 0.6rem;
      font-size: 0.9rem;
      color: var(--fg);
      letter-spacing: 0.01em;
      display: inline-flex; align-items: center; gap: 0.45rem;
    }
    .vm-count {
      font-size: 0.7rem;
      background: var(--surface-1); border: 1px solid var(--border);
      padding: 1px 8px; border-radius: 999px;
      color: var(--fg-dim);
    }

    .vm-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.7rem; }
    .vm-item {
      padding: 0.7rem 0.85rem;
      background: var(--surface-1); border: 1px solid var(--border);
      border-radius: var(--radius-md, 10px);
    }
    .vm-item-head {
      display: flex; justify-content: space-between; align-items: baseline;
      gap: 0.5rem; flex-wrap: wrap;
    }
    .vm-item-head strong { color: var(--fg); }
    .vm-item-head code { font-family: var(--code-font, ui-monospace, Menlo, Consolas, monospace); color: var(--accent); }
    .vm-since {
      font-size: 0.72rem; color: var(--fg-dim);
      background: var(--surface-2); padding: 1px 8px;
      border-radius: 999px;
    }
    .vm-item-detail {
      margin: 0.35rem 0 0; color: var(--fg-dim);
      font-size: 0.88rem; line-height: 1.5;
    }
    .vm-item-action {
      margin: 0.45rem 0 0;
      color: var(--fg);
      font-size: 0.88rem;
      line-height: 1.5;
    }
    .vm-action-label {
      font-weight: 600; color: var(--accent);
      letter-spacing: 0.02em; text-transform: uppercase;
      font-size: 0.7rem; margin-right: 0.3rem;
    }
    .vm-dep-replace {
      margin: 0.4rem 0 0; color: var(--fg-dim);
      font-size: 0.88rem;
    }
    .vm-dep-replace code {
      font-family: var(--code-font, ui-monospace, Menlo, Consolas, monospace);
      background: var(--surface-2);
      padding: 1px 6px; border-radius: 4px;
      color: var(--fg);
    }

    /* ----- Steps ----- */
    .vm-step-list { padding-left: 1.4rem; margin: 0; display: grid; gap: 0.8rem; }
    .vm-step::marker { color: var(--accent); font-weight: 600; }
    .vm-step-text { color: var(--fg); margin-bottom: 0.4rem; }
    .vm-code-wrap {
      position: relative;
      background: var(--surface-1); border: 1px solid var(--border);
      border-radius: var(--radius-md, 10px);
      padding: 0.5rem 0.75rem 0.6rem;
    }
    .vm-lang {
      display: inline-block;
      font-size: 0.65rem; text-transform: uppercase;
      color: var(--fg-dim);
      letter-spacing: 0.06em;
      margin-bottom: 0.25rem;
    }
    .vm-code {
      margin: 0; padding: 0;
      font-family: var(--code-font, ui-monospace, Menlo, Consolas, monospace);
      font-size: 0.82rem;
      color: var(--fg);
      overflow-x: auto;
      white-space: pre;
    }
    .vm-copy {
      position: absolute; top: 0.4rem; right: 0.4rem;
      background: var(--surface-2); border: 1px solid var(--border);
      color: var(--fg-dim);
      font-size: 0.7rem; padding: 2px 8px;
      border-radius: 6px;
      cursor: pointer;
    }
    .vm-copy:hover { color: var(--fg); border-color: var(--accent); }

    .vm-empty {
      margin: 0; padding: 0.9rem;
      background: color-mix(in srgb, #22c55e 8%, transparent);
      border: 1px solid color-mix(in srgb, #22c55e 35%, transparent);
      border-radius: var(--radius-md, 10px);
      color: #86efac;
    }

    .vm-error {
      padding: 1rem;
      background: color-mix(in srgb, #ef4444 8%, transparent);
      border: 1px solid color-mix(in srgb, #ef4444 35%, transparent);
      border-radius: var(--radius-md, 10px);
    }
    .vm-err-msg { color: #fca5a5; margin: 0 0 0.6rem; }

    .vm-meta {
      margin-top: 1rem;
      padding-top: 0.75rem;
      border-top: 1px solid var(--border);
      color: var(--fg-dim);
      font-size: 0.75rem;
      display: flex; gap: 0.4rem; align-items: center;
    }
  `]
})
export class VersionMigrationPanelComponent {
  private readonly service = inject(VersionMigrationService);
  private readonly compareHistory = inject(CompareHistoryService);

  /** Package name (lowercase npm id). */
  readonly pkg = input<string | null>(null);
  readonly fromVersion = input<string | null>(null);
  readonly toVersion = input<string | null>(null);
  /** npm `repository.url` field — feeds the RAG slug parse. */
  readonly repoUrl = input<string | null>(null);

  readonly state = signal<PanelState>({ kind: 'idle' });
  readonly copiedIndex = signal<number | null>(null);

  @ViewChild('settingsDialog') private settingsDialog?: AiSettingsDialogComponent;

  /**
   * Drop back to the idle CTA whenever the (pkg, from, to) tuple
   * changes. Without this, a user who generated for v15→v17 and then
   * tweaked the picker to v15→v16 would still see the stale v17
   * result.
   */
  private readonly tuple = computed(() => `${this.pkg()}@${this.fromVersion()}..${this.toVersion()}`);

  constructor() {
    effect(() => {
      // Touch the signal so the effect re-runs on tuple changes.
      this.tuple();
      this.state.set({ kind: 'idle' });
    });
  }

  generate(forceRefresh: boolean): void {
    const p = this.pkg();
    const f = this.fromVersion();
    const t = this.toVersion();
    if (!p || !f || !t) return;
    this.state.set({ kind: 'loading' });

    this.service.generate(p, f, t, this.repoUrl(), forceRefresh).subscribe({
      next: (res: AiCompletionResponse<MigrationResponse>) => {
        this.state.set({
          kind: 'result',
          data: res.data,
          provider: res.provider,
          model: res.model,
          generatedAt: res.generatedAt,
          latencyMs: res.latencyMs
        });
        // Flag this self-version comparison so it shows the ✨ marker
        // on the history page. We reuse the existing flag mechanism by
        // passing the same package on both sides — CompareHistoryService
        // normalizes the pair key.
        void this.compareHistory.flagAiHighlight(p, p, 'usage-guide');
      },
      error: (err) => {
        const ai = err as AiError;
        const isAi = ai && ai.kind && typeof ai.kind === 'string';
        this.state.set({
          kind: 'error',
          message: isAi ? ai.message : err instanceof Error ? err.message : String(err),
          errorKind: isAi ? ai.kind : 'UNKNOWN',
          isRateLimited: isAi && ai.kind === 'RATE_LIMITED'
        });
      }
    });
  }

  openSettings(): void {
    this.settingsDialog?.open();
  }

  copy(text: string, idx: number): void {
    const flash = () => {
      this.copiedIndex.set(idx);
      setTimeout(() => {
        if (this.copiedIndex() === idx) this.copiedIndex.set(null);
      }, 1600);
    };
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(flash, () => this.legacyCopy(text, flash));
    } else {
      this.legacyCopy(text, flash);
    }
  }

  private legacyCopy(text: string, onSuccess: () => void): void {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) onSuccess();
    } catch {
      // Non-critical convenience — silent failure is fine.
    }
  }

  // ---------- Template helpers ----------

  asResult(s: PanelState): ResultState { return s as ResultState; }
  asError(s: PanelState): ErrorState { return s as ErrorState; }

  providerLabel(id: AiProviderId): string {
    switch (id) {
      case 'groq-proxy': return 'Groq';
      case 'gemini-byo': return 'Gemini';
      case 'openai-byo': return 'OpenAI';
      case 'deepseek-byo': return 'DeepSeek';
    }
  }
}
