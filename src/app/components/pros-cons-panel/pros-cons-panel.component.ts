import {
  ChangeDetectionStrategy,
  Component,
  ViewChild,
  computed,
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
import { ProsConsService } from '../../services/ai/pros-cons.service';
import { CompareHistoryService } from '../../services/compare-history.service';
import {
  PROS_CONS_AXES,
  ProsConsAxis,
  ProsConsResponse
} from '../../services/ai/schemas/pros-cons.schema';
import { AiSettingsDialogComponent } from '../ai-settings-dialog/ai-settings-dialog.component';

/**
 * AI-generated comparative analysis between two npm packages. Lives on
 * the /compare page, below the version-compatibility tables. Opt-in:
 * the user clicks "Generate AI Pros & Cons" — we don't burn quota on
 * every page load.
 *
 * Four UI states, tracked by a single discriminated union so the
 * template can `@switch` on it cleanly:
 *   - 'idle'       → show the generate CTA
 *   - 'loading'    → skeleton with the schema's outer shape
 *   - 'result'     → render the verdict, axes, warnings, recommendation
 *   - 'error'      → typed error message + retry path; rate-limited
 *                    errors include the "add a Gemini key" upgrade hint
 */

interface IdleState { kind: 'idle'; }
interface LoadingState { kind: 'loading'; }
interface ResultState {
  kind: 'result';
  data: ProsConsResponse;
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
  selector: 'app-pros-cons-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TranslocoModule, AiSettingsDialogComponent],
  template: `
    @if (pkgA() && pkgB()) {
      <section class="pc-panel" [class.pc-busy]="state().kind === 'loading'">
        <header class="pc-head">
          <div class="pc-head-text">
            <h3>{{ 'prosCons.title' | transloco }}</h3>
            <p class="pc-lede">{{ 'prosCons.lede' | transloco }}</p>
          </div>
          <div class="pc-head-actions">
            <!-- Settings gear: always available so users can configure
                 BYO keys before they even hit the generate button. -->
            <button
              type="button"
              class="pc-icon-btn"
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
                class="pc-refresh"
                (click)="generate(true)"
                [attr.aria-label]="'prosCons.refresh' | transloco"
                [disabled]="state().kind === 'loading'"
              >
                <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M14 8a6 6 0 1 1-1.76-4.24"/>
                  <polyline points="14 2 14 6 10 6"/>
                </svg>
                {{ 'prosCons.refresh' | transloco }}
              </button>
            }
          </div>
        </header>

        @switch (state().kind) {

          @case ('idle') {
            <div class="pc-cta">
              <p class="pc-cta-body">
                {{ 'prosCons.ctaBody' | transloco: { a: pkgA(), b: pkgB() } }}
              </p>
              <button
                type="button"
                class="primary"
                (click)="generate()"
                data-testid="prosCons.generate"
              >
                <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
                  <path d="M8 0l1.8 5.2L15 7l-5.2 1.8L8 14l-1.8-5.2L1 7l5.2-1.8z"/>
                </svg>
                {{ 'prosCons.generate' | transloco }}
              </button>
              <p class="pc-cta-hint">{{ 'prosCons.ctaHint' | transloco }}</p>
            </div>
          }

          @case ('loading') {
            <!-- Skeleton with shape — gives the user a preview of WHERE
                 the verdict / axes / recommendation will appear, not just
                 a generic spinner. Materially better perceived latency
                 because the layout doesn't reflow when the result lands. -->
            <div class="pc-skeleton" role="status" [attr.aria-label]="'prosCons.loading' | transloco">
              <div class="pc-skel-verdict shimmer"></div>
              <div class="pc-skel-axes">
                <div class="pc-skel-axis shimmer"></div>
                <div class="pc-skel-axis shimmer"></div>
                <div class="pc-skel-axis shimmer"></div>
                <div class="pc-skel-axis shimmer"></div>
              </div>
              <div class="pc-skel-rec shimmer"></div>
              <p class="pc-skel-msg">{{ 'prosCons.loading' | transloco }}</p>
            </div>
          }

          @case ('result') {
            @let r = asResult(state());
            <div class="pc-result">
              <!-- Verdict — large, prominent, the screenshot-able takeaway. -->
              <p class="pc-verdict">{{ r.data.verdict }}</p>

              <!-- Axes table — one row per dimension, with a winner pill,
                   the quantified delta, and a small evidence chip. -->
              <ul class="pc-axes" [attr.aria-label]="'prosCons.axesLabel' | transloco">
                @for (axis of r.data.axes; track axis.axis + axis.delta) {
                  <li class="pc-axis" [attr.data-winner]="axis.winner">
                    <div class="pc-axis-head">
                      <span class="pc-axis-icon" aria-hidden="true">
                        {{ iconForAxis(axis.axis) }}
                      </span>
                      <span class="pc-axis-name">
                        {{ axisLabel(axis.axis) | transloco }}
                      </span>
                      <span class="pc-winner-pill" [attr.data-winner]="axis.winner">
                        @switch (axis.winner) {
                          @case ('a') { {{ pkgA() }} }
                          @case ('b') { {{ pkgB() }} }
                          @case ('tie') { {{ 'prosCons.tie' | transloco }} }
                        }
                      </span>
                    </div>
                    <p class="pc-axis-delta">{{ axis.delta }}</p>
                    <p class="pc-axis-evidence">
                      <span aria-hidden="true">📊</span>
                      {{ axis.evidence }}
                    </p>
                  </li>
                }
              </ul>

              <!-- Warnings, if any — concrete risk callouts. -->
              @if (r.data.warnings.length) {
                <div class="pc-warnings" role="alert">
                  <h4>
                    <span aria-hidden="true">⚠️</span>
                    {{ 'prosCons.warnings' | transloco }}
                  </h4>
                  <ul>
                    @for (w of r.data.warnings; track w) {
                      <li>{{ w }}</li>
                    }
                  </ul>
                </div>
              }

              <!-- Recommendation — synthesizes the comparison into a
                   decision. Highlighted box, always shown. -->
              <div class="pc-recommendation">
                <h4>
                  <span aria-hidden="true">🎯</span>
                  {{ 'prosCons.recommendation' | transloco }}
                </h4>
                <p>{{ r.data.recommendation }}</p>
              </div>

              <!-- Provenance footer: which provider, how long it took,
                   when it was generated. Sets the right expectation that
                   this is AI-generated and was a real network call. -->
              <footer class="pc-provenance">
                <span>
                  {{
                    'prosCons.generatedBy'
                      | transloco: { provider: providerLabel(r.provider), seconds: (r.latencyMs / 1000).toFixed(1) }
                  }}
                </span>
                <span aria-hidden="true">·</span>
                <time>{{ relativeTime(r.generatedAt) | transloco }}</time>
                <span aria-hidden="true">·</span>
                <button type="button" class="pc-link-btn" (click)="openSettings()">
                  {{ 'aiSettings.changeProvider' | transloco }}
                </button>
              </footer>
            </div>
          }

          @case ('error') {
            @let e = asError(state());
            <div class="pc-error" role="alert">
              <p class="pc-error-msg">{{ e.message }}</p>
              @if (e.isRateLimited) {
                <p class="pc-error-hint">
                  {{ 'prosCons.error.rateLimitHint' | transloco }}
                  <button type="button" class="pc-link-btn" (click)="openSettings()">
                    {{ 'aiSettings.openButton' | transloco }} →
                  </button>
                </p>
              } @else if (e.errorKind === 'PROXY_UNAVAILABLE') {
                <!-- The dev-server-without-SSR case. Show a structured
                     "two paths forward" hint: run the SSR server, or BYO key. -->
                <div class="pc-error-hint">
                  <p>{{ 'prosCons.error.proxyUnavailableLead' | transloco }}</p>
                  <ul>
                    <li>
                      <strong>{{ 'prosCons.error.proxyOptionSsr' | transloco }}</strong>
                      <code>npm run build:ssr &amp;&amp; npm run serve:ssr</code>
                    </li>
                    <li>
                      <strong>{{ 'prosCons.error.proxyOptionByo' | transloco }}</strong>
                    </li>
                  </ul>
                </div>
              }
              <div class="pc-error-actions">
                <button type="button" class="primary" (click)="generate()">
                  {{ 'prosCons.retry' | transloco }}
                </button>
              </div>
            </div>
          }
        }
      </section>

      <!-- AI provider settings dialog. Sits at the panel level so we
           don't have to deal with it being inside the @if for ready
           inputs; safe to render always since the dialog element is
           invisible until .showModal() is called. -->
      <app-ai-settings-dialog #aiSettings />
    }
  `,
  styles: [`
    :host { display: block; }

    .pc-panel {
      margin-top: 1.5rem;
      padding: clamp(1.1rem, 2vw, 1.5rem);
      border: 1px solid var(--border, #e5e7eb);
      border-radius: var(--radius-lg, 14px);
      background: var(--surface-2, #fff);
    }
    .pc-panel.pc-busy { animation: pc-pulse 1.6s ease-in-out infinite; }
    @keyframes pc-pulse { 50% { border-color: var(--accent); } }
    @media (prefers-reduced-motion: reduce) {
      .pc-panel.pc-busy { animation: none; }
    }

    .pc-head {
      display: flex; align-items: flex-start; justify-content: space-between;
      gap: 1rem; flex-wrap: wrap; margin-bottom: 1.1rem;
    }
    .pc-head-text { min-width: 0; flex: 1 1 auto; }
    .pc-head h3 {
      margin: 0 0 0.25rem;
      font-size: 1.1rem; font-weight: 600; color: var(--fg);
      letter-spacing: -0.01em;
    }
    .pc-lede { margin: 0; color: var(--fg-dim); font-size: 0.88rem; line-height: 1.5; }

    .pc-head-actions {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      flex-shrink: 0;
    }
    .pc-refresh {
      display: inline-flex; align-items: center; gap: 0.4rem;
      padding: 0.45rem 0.85rem;
      background: transparent;
      border: 1px solid var(--border);
      border-radius: var(--radius-md, 10px);
      color: var(--fg-dim);
      font-size: 0.82rem;
      cursor: pointer;
      transition: border-color 160ms ease, color 160ms ease;
    }
    .pc-refresh:hover:not([disabled]) {
      border-color: var(--accent);
      color: var(--fg);
    }
    .pc-refresh[disabled] { opacity: 0.5; cursor: not-allowed; }

    /* Settings gear — circular icon-only button matching the
       refresh button's resting palette so the two read as a pair. */
    .pc-icon-btn {
      width: 32px; height: 32px;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: 50%;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--fg-dim);
      cursor: pointer;
      transition: border-color 160ms ease, color 160ms ease, transform 200ms ease;
    }
    .pc-icon-btn:hover {
      border-color: var(--accent);
      color: var(--fg);
      transform: rotate(45deg);
    }
    @media (prefers-reduced-motion: reduce) {
      .pc-icon-btn:hover { transform: none; }
    }

    /* Inline anchor-style button — used in the provenance footer
       ("Change provider") and in the rate-limit error hint
       ("Open settings"). Reads as text but is a real button so it
       lives within keyboard tab order. */
    .pc-link-btn {
      background: none;
      border: none;
      padding: 0;
      /* No margin — the parent flex container's gap (0.4rem in
         .pc-provenance, natural inline spacing inside .pc-error-hint)
         already handles spacing. A left margin here was double-spacing
         the button and nudging it off baseline. */
      margin: 0;
      color: var(--accent);
      cursor: pointer;
      font: inherit;
      /* Match the surrounding text's line-height so the button doesn't
         introduce its own taller line-box that pushes the baseline
         down a hair relative to the adjacent <span> and <time>. */
      line-height: inherit;
      text-decoration: underline;
      text-decoration-color: color-mix(in srgb, var(--accent) 40%, transparent);
      text-underline-offset: 2px;
    }
    .pc-link-btn:hover { text-decoration-color: var(--accent); }
    .pc-link-btn:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
      border-radius: 2px;
    }

    /* === Idle CTA === */
    .pc-cta {
      display: grid; gap: 0.85rem;
      padding: 1.5rem;
      border-radius: var(--radius-md, 10px);
      background: var(--accent-gradient-soft, var(--surface-1));
      border: 1px dashed color-mix(in srgb, var(--accent) 35%, var(--border));
      text-align: center;
    }
    .pc-cta-body { margin: 0; color: var(--fg); font-size: 0.95rem; line-height: 1.55; }
    .pc-cta-hint { margin: 0; color: var(--fg-dim); font-size: 0.78rem; }

    /* === Skeleton === */
    .pc-skeleton {
      display: grid; gap: 0.85rem;
      padding: 0.5rem 0;
    }
    .pc-skel-verdict {
      height: 1.4rem; width: 70%;
      border-radius: 6px;
    }
    .pc-skel-axes { display: grid; gap: 0.55rem; }
    .pc-skel-axis {
      height: 3.2rem; border-radius: var(--radius-md, 10px);
    }
    .pc-skel-rec { height: 4.5rem; border-radius: var(--radius-md, 10px); }
    .pc-skel-msg {
      margin: 0.75rem 0 0;
      text-align: center;
      color: var(--fg-dim);
      font-size: 0.85rem;
    }
    .shimmer {
      background: linear-gradient(
        90deg,
        var(--surface-1) 0%,
        var(--surface-2) 50%,
        var(--surface-1) 100%
      );
      background-size: 200% 100%;
      animation: pc-shimmer 1.4s ease-in-out infinite;
    }
    @keyframes pc-shimmer { to { background-position: -200% 0; } }
    @media (prefers-reduced-motion: reduce) {
      .shimmer { animation: none; }
    }

    /* === Result === */
    .pc-result { display: grid; gap: 1.1rem; }
    .pc-verdict {
      margin: 0;
      font-size: 1.05rem;
      font-weight: 500;
      line-height: 1.5;
      color: var(--fg);
      padding: 0.85rem 1rem;
      border-left: 3px solid var(--accent);
      background: var(--accent-gradient-soft, var(--surface-1));
      border-radius: 0 var(--radius-md, 10px) var(--radius-md, 10px) 0;
    }

    .pc-axes {
      list-style: none; margin: 0; padding: 0;
      display: grid; gap: 0.6rem;
    }
    .pc-axis {
      display: grid; gap: 0.4rem;
      padding: 0.85rem 1rem;
      border-radius: var(--radius-md, 10px);
      border: 1px solid var(--border-subtle, var(--border));
      background: var(--surface-1);
    }
    .pc-axis-head {
      display: flex; align-items: center; gap: 0.5rem;
      flex-wrap: wrap;
    }
    .pc-axis-icon {
      font-size: 1.05rem; line-height: 1;
    }
    .pc-axis-name {
      font-weight: 600; font-size: 0.9rem; color: var(--fg);
      flex: 1 1 auto;
    }
    .pc-winner-pill {
      display: inline-block;
      padding: 0.15rem 0.55rem;
      border-radius: var(--radius-pill, 999px);
      font-size: 0.74rem; font-weight: 600;
      letter-spacing: 0.02em;
      max-width: 220px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .pc-winner-pill[data-winner='a'] {
      background: color-mix(in srgb, var(--accent) 16%, transparent);
      color: var(--accent);
      border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
    }
    .pc-winner-pill[data-winner='b'] {
      background: color-mix(in srgb, #8b5cf6 16%, transparent);
      color: #8b5cf6;
      border: 1px solid color-mix(in srgb, #8b5cf6 40%, var(--border));
    }
    .pc-winner-pill[data-winner='tie'] {
      background: var(--surface-2);
      color: var(--fg-dim);
      border: 1px solid var(--border);
    }
    .pc-axis-delta {
      margin: 0;
      color: var(--fg);
      font-size: 0.88rem;
      line-height: 1.45;
    }
    .pc-axis-evidence {
      margin: 0;
      color: var(--fg-dim);
      font-size: 0.74rem;
      letter-spacing: 0.01em;
    }

    /* === Warnings === */
    .pc-warnings {
      padding: 0.9rem 1rem;
      border-radius: var(--radius-md, 10px);
      background: color-mix(in srgb, var(--warn, #f59e0b) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--warn, #f59e0b) 35%, var(--border));
    }
    .pc-warnings h4 {
      display: flex; align-items: center; gap: 0.4rem;
      margin: 0 0 0.5rem; font-size: 0.9rem;
      color: color-mix(in srgb, var(--warn, #f59e0b) 70%, var(--fg));
    }
    .pc-warnings ul { margin: 0; padding: 0 0 0 1.1rem; display: grid; gap: 0.3rem; }
    .pc-warnings li { color: var(--fg); font-size: 0.86rem; line-height: 1.45; }

    /* === Recommendation === */
    .pc-recommendation {
      padding: 1rem 1.2rem;
      border-radius: var(--radius-md, 10px);
      background: color-mix(in srgb, var(--ok, #22c55e) 7%, transparent);
      border: 1px solid color-mix(in srgb, var(--ok, #22c55e) 35%, var(--border));
    }
    .pc-recommendation h4 {
      display: flex; align-items: center; gap: 0.4rem;
      margin: 0 0 0.45rem; font-size: 0.9rem;
      color: color-mix(in srgb, var(--ok, #22c55e) 70%, var(--fg));
    }
    .pc-recommendation p {
      margin: 0; color: var(--fg); font-size: 0.92rem; line-height: 1.55;
    }

    /* === Provenance footer === */
    .pc-provenance {
      display: flex; flex-wrap: wrap; gap: 0.4rem;
      /* Baseline alignment is what makes inline-like children — a span,
         a time element, and a button — sit on the same imaginary text
         line. Without it, the button's own line-height and padding push
         it down a fraction of a pixel, which reads as a glitch even
         though every child has the same font-size. */
      align-items: baseline;
      padding-top: 0.8rem;
      border-top: 1px dashed var(--border);
      color: var(--fg-dim); font-size: 0.74rem;
    }

    /* === Error === */
    .pc-error {
      display: grid; gap: 0.65rem;
      padding: 1rem 1.2rem;
      border-radius: var(--radius-md, 10px);
      background: color-mix(in srgb, var(--bad, #ef4444) 7%, transparent);
      border: 1px solid color-mix(in srgb, var(--bad, #ef4444) 35%, var(--border));
    }
    .pc-error-msg {
      margin: 0; color: var(--bad, #b91c1c);
      font-size: 0.9rem; font-weight: 500;
    }
    .pc-error-hint {
      margin: 0; color: var(--fg);
      font-size: 0.85rem; line-height: 1.5;
    }
    .pc-error-hint p { margin: 0 0 0.5rem; }
    .pc-error-hint ul {
      margin: 0; padding: 0 0 0 1.1rem;
      display: grid; gap: 0.35rem;
    }
    .pc-error-hint li { color: var(--fg); font-size: 0.85rem; }
    .pc-error-hint code {
      display: inline-block;
      margin-inline-start: 0.35rem;
      padding: 1px 6px;
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm, 6px);
      font: 0.78rem/1 var(--code-font, ui-monospace, Menlo, Consolas, monospace);
    }
    .pc-error-actions { display: flex; gap: 0.5rem; }

    /* === Buttons === */
    button.primary {
      display: inline-flex; align-items: center; justify-content: center;
      gap: 0.45rem;
      padding: 0 1.1rem;
      min-height: 40px;
      border-radius: var(--radius-md, 10px);
      border: 1px solid transparent;
      background: var(--accent-gradient, var(--accent, #2563eb));
      color: #fff;
      font-weight: 600; font-size: 0.92rem;
      letter-spacing: 0.01em;
      cursor: pointer;
      box-shadow: var(--shadow-1);
      transition: transform 120ms var(--ease, ease), box-shadow 200ms var(--ease, ease), filter 160ms var(--ease, ease);
    }
    button.primary:hover:not([disabled]) {
      transform: translateY(-1px);
      box-shadow: var(--shadow-glow);
      filter: brightness(1.04);
    }
    button.primary[disabled] { opacity: 0.55; cursor: not-allowed; }
  `]
})
export class ProsConsPanelComponent {
  private readonly service = inject(ProsConsService);
  private readonly compareHistory = inject(CompareHistoryService);

  /**
   * Reference to the settings dialog so the gear button and the
   * rate-limit error hint can both open it imperatively. The dialog
   * itself is a child element of this panel's template (#aiSettings).
   */
  @ViewChild('aiSettings')
  private settingsDialog?: AiSettingsDialogComponent;

  /** Both inputs are required for the panel to render. */
  readonly pkgA = input<string>('');
  readonly pkgB = input<string>('');

  readonly state = signal<PanelState>({ kind: 'idle' });

  /**
   * Reset state when the inputs change. Also computed-derived for the
   * template's `@if` gate at the top.
   */
  readonly bothReady = computed(() => !!this.pkgA() && !!this.pkgB());

  /**
   * Trigger a generation (or regeneration on refresh).
   *
   * @param forceRefresh true when the user clicked Refresh — bypasses
   * the cache read and forces a fresh API call. Default false so
   * the initial Generate respects any cached entry.
   */
  generate(forceRefresh = false): void {
    const a = this.pkgA();
    const b = this.pkgB();
    if (!a || !b) return;

    this.state.set({ kind: 'loading' });

    this.service.generate(a, b, forceRefresh).subscribe({
      next: (res) => {
        this.state.set({
          kind: 'result',
          data: res.data,
          provider: res.provider,
          model: res.model,
          // Use the response's own generatedAt so cache hits show the
          // accurate original generation time ("4 hours ago") instead
          // of resetting to "just now" every cache hit.
          generatedAt: res.generatedAt,
          latencyMs: res.latencyMs
        });
        // Flag this comparison as "has Pros & Cons" in history so the
        // ✨ indicator appears on the chip when the user revisits the
        // History page. Fire-and-forget — failure to flag doesn't
        // affect the user-visible state.
        void this.compareHistory.flagAiHighlight(a, b, 'pros-cons');
      },
      error: (err) => {
        const ai = err as AiError;
        const isAi = ai && ai.kind && typeof ai.kind === 'string';
        this.state.set({
          kind: 'error',
          message: isAi
            ? ai.message
            : err instanceof Error
              ? err.message
              : String(err),
          errorKind: isAi ? ai.kind : 'UNKNOWN',
          isRateLimited: isAi && ai.kind === 'RATE_LIMITED'
        });
      }
    });
  }

  /**
   * Open the AI provider settings dialog. Called from the gear button
   * in the header, from the "Change provider" link in the provenance
   * footer, and from the "Open settings" CTA in the rate-limit error
   * hint. All three converge on the same dialog instance.
   */
  openSettings(): void {
    this.settingsDialog?.open();
  }

  // ---------- Template helpers ----------

  asResult(s: PanelState): ResultState {
    return s as ResultState;
  }

  asError(s: PanelState): ErrorState {
    return s as ErrorState;
  }

  /** Provider id → human-readable label for the provenance footer. */
  providerLabel(id: AiProviderId): string {
    switch (id) {
      case 'groq-proxy': return 'Groq';
      case 'gemini-byo': return 'Gemini';
      case 'openai-byo': return 'OpenAI';
      case 'deepseek-byo': return 'DeepSeek';
    }
  }

  /** Map the constrained axis enum to a translation key + emoji icon. */
  axisLabel(axis: ProsConsAxis['axis']): string {
    return `prosCons.axis.${axis}`;
  }

  iconForAxis(axis: ProsConsAxis['axis']): string {
    switch (axis) {
      case 'bundle-size':    return '📦';
      case 'performance':    return '⚡';
      case 'maintenance':    return '🔧';
      case 'api-stability':  return '🛡️';
      case 'adoption':       return '📈';
      case 'ecosystem-fit':  return '🧩';
      default:               return '◆';
    }
  }

  /**
   * Map a timestamp to a translation key for the provenance footer.
   * Uses key-only references so the locale file owns the actual text.
   */
  relativeTime(ts: number): string {
    const seconds = Math.floor((Date.now() - ts) / 1000);
    if (seconds < 60) return 'prosCons.time.justNow';
    if (seconds < 120) return 'prosCons.time.aMinuteAgo';
    if (seconds < 3600) return 'prosCons.time.minutesAgo';
    return 'prosCons.time.hoursAgo';
  }

  /** Used by track-by — kept for completeness even though we use field
   *  values in the template. */
  readonly axesEnum = PROS_CONS_AXES;
}
