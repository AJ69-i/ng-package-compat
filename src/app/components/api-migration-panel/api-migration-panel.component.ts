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
import { ApiDiffClientService, ApiSurfaceDiff } from '../../services/api-diff-client.service';
import { MigrationIntelligenceService } from '../../services/ai/migration-intelligence.service';
import {
  AiCompletionResponse,
  AiError,
  AiProviderId
} from '../../services/ai/ai-provider.service';
import { AiSettingsDialogComponent } from '../ai-settings-dialog/ai-settings-dialog.component';
import type { ApiChange, MigrationReport } from '../../../server/api-diff/types';

/**
 * V2 Compare-page panel. Replaces V1's VersionMigrationPanelComponent
 * for the self-mode (single-package, two-version) flow.
 *
 * # Two-stage loading choreography
 *
 *   Stage 1 — Scanning API surface:    /api/api-diff in flight
 *   Stage 2 — AI is analyzing changes: AI completion in flight
 *
 * Each stage gets its own banner with appropriate copy. When the
 * cache has the diff (very common), Stage 1 is invisible — we go
 * straight to Stage 2. When the cache has the full report, both
 * stages are skipped and the panel just renders.
 *
 * # State machine
 *
 *   idle           user hasn't clicked Generate yet
 *   scanning       Stage 1: api-diff fetch in flight
 *   analyzing      Stage 2: AI call in flight (with diff in hand)
 *   ready          success — diff + report available
 *   error          typed by which stage failed (scan | analyze)
 */

interface IdleState { kind: 'idle'; }
interface ScanningState { kind: 'scanning'; }
interface AnalyzingState { kind: 'analyzing'; diff: ApiSurfaceDiff | null; }
interface ReadyState {
  kind: 'ready';
  diff: ApiSurfaceDiff | null;
  report: MigrationReport;
  provider: AiProviderId;
  model: string;
  generatedAt: number;
  latencyMs: number;
}
interface ErrorState {
  kind: 'error';
  stage: 'scan' | 'analyze';
  message: string;
  isRateLimited: boolean;
}
type PanelState = IdleState | ScanningState | AnalyzingState | ReadyState | ErrorState;

@Component({
  selector: 'app-api-migration-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TranslocoModule, AiSettingsDialogComponent],
  templateUrl: './api-migration-panel.component.html',
  styleUrls: ['./api-migration-panel.component.scss']
})
export class ApiMigrationPanelComponent {
  private readonly intel = inject(MigrationIntelligenceService);
  private readonly diffClient = inject(ApiDiffClientService);

  // ── Inputs (the host page passes the tuple to migrate) ──
  readonly pkg = input<string | null>(null);
  readonly fromVersion = input<string | null>(null);
  readonly toVersion = input<string | null>(null);
  /** npm `repository.url` — feeds the changelog fetcher's GitHub slug parse. */
  readonly repoUrl = input<string | null>(null);

  // ── Local state ──
  readonly state = signal<PanelState>({ kind: 'idle' });
  readonly copiedCodeIndex = signal<string | null>(null);

  @ViewChild('settingsDialog') private settingsDialog?: AiSettingsDialogComponent;

  /**
   * Reset to idle whenever the (pkg, from, to) tuple changes. Without
   * this, a user who generated for v15→v17 and then tweaked the picker
   * would still see the stale v17 report.
   */
  private readonly tuple = computed(
    () => `${this.pkg()}@${this.fromVersion()}..${this.toVersion()}`
  );

  constructor() {
    effect(() => {
      // Touch tuple() so the effect re-runs on changes.
      this.tuple();
      this.state.set({ kind: 'idle' });
    });
  }

  /**
   * Kick off the two-stage pipeline. The stage transitions are visible
   * to the user — that's the whole point. We don't use the one-shot
   * `intel.generate()` helper because we want to render the Stage 2
   * banner with a real change-count, which requires the Stage 1 result
   * before we make the AI call.
   */
  generate(forceRefresh: boolean): void {
    const p = this.pkg();
    const f = this.fromVersion();
    const t = this.toVersion();
    if (!p || !f || !t) return;

    const startedAt = Date.now();
    this.state.set({ kind: 'scanning' });

    this.intel.scanApiDiff(p, f, t).subscribe({
      next: (diff) => {
        // Stage 1 done — transition to Stage 2 with the diff in hand.
        // Even when the diff is null (types unavailable), we proceed
        // to AI narration; the orchestrator handles null gracefully
        // and the AI produces a narrative-only report with confidence: 'low'.
        this.state.set({ kind: 'analyzing', diff });
        this.intel.narrate(p, f, t, diff, this.repoUrl(), forceRefresh).subscribe({
          next: (res: AiCompletionResponse<MigrationReport>) => {
            this.state.set({
              kind: 'ready',
              diff,
              report: res.data,
              provider: res.provider,
              model: res.model,
              generatedAt: res.generatedAt,
              latencyMs: Date.now() - startedAt
            });
          },
          error: (err) => this.toError('analyze', err)
        });
      },
      // Stage 1 errors are uncommon (the diff service silently nulls
      // out network failures) but possible if the dev server itself
      // crashed. Type the error stage so the UI message is accurate.
      error: (err) => this.toError('scan', err)
    });
  }

  openSettings(): void {
    this.settingsDialog?.open();
  }

  /** Copy code to clipboard with transient feedback. */
  copy(text: string, slot: string): void {
    const flash = () => {
      this.copiedCodeIndex.set(slot);
      setTimeout(() => {
        if (this.copiedCodeIndex() === slot) this.copiedCodeIndex.set(null);
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
      // Non-critical convenience.
    }
  }

  // ── Template helpers ──

  asReady(s: PanelState): ReadyState { return s as ReadyState; }
  asAnalyzing(s: PanelState): AnalyzingState { return s as AnalyzingState; }
  asError(s: PanelState): ErrorState { return s as ErrorState; }

  providerLabel(id: AiProviderId): string {
    switch (id) {
      case 'groq-proxy': return 'Groq';
      case 'gemini-byo': return 'Gemini';
      case 'openai-byo': return 'OpenAI';
      case 'deepseek-byo': return 'DeepSeek';
    }
  }

  /** Filter helper used by the template to bucket apiChanges by severity. */
  changesBySeverity(report: MigrationReport, severity: ApiChange['severity']): ApiChange[] {
    return report.apiChanges.filter((c) => c.severity === severity);
  }

  /** Filter helper used by the template to bucket apiChanges by change type. */
  changesByKind(report: MigrationReport, kind: ApiChange['change']): ApiChange[] {
    return report.apiChanges.filter((c) => c.change === kind);
  }

  /** Total count for the Stage 2 banner — "Found N API changes across M modules." */
  changeCount(diff: ApiSurfaceDiff | null): number {
    return this.diffClient.changeCount(diff);
  }
  moduleCount(diff: ApiSurfaceDiff | null): number {
    return this.diffClient.moduleCount(diff);
  }

  /**
   * Translate an AI/HTTP error into the typed ErrorState. Detects
   * rate-limit specifically so the UI can offer the BYO-key path
   * with a helpful link instead of a generic "try again later."
   */
  private toError(stage: 'scan' | 'analyze', err: unknown): void {
    const ai = err as AiError;
    const isAi = ai && typeof ai === 'object' && 'kind' in ai && typeof ai.kind === 'string';
    this.state.set({
      kind: 'error',
      stage,
      message: isAi
        ? ai.message
        : err instanceof Error
          ? err.message
          : String(err),
      isRateLimited: isAi && ai.kind === 'RATE_LIMITED'
    });
  }
}
