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
import { UsageGuideService } from '../../services/ai/usage-guide.service';
import { CompareHistoryService } from '../../services/compare-history.service';
import {
  PackageUsageGuide,
  UsageCodeBlock,
  UsageGuideResponse
} from '../../services/ai/schemas/usage-guide.schema';
import { AiSettingsDialogComponent } from '../ai-settings-dialog/ai-settings-dialog.component';

/**
 * AI-generated side-by-side Usage Guide for two npm packages. Sits
 * below the Pros & Cons panel on /compare and shares the same provider
 * + settings infrastructure.
 *
 * UI shape:
 *   - Header with title + Settings gear + Refresh
 *   - Idle CTA (single button) — the API call is opt-in
 *   - Loading skeleton with shape (tab strip + two code-block silhouettes)
 *   - Result: tab strip (Install | Setup | Example) above a 2-column
 *     code comparison (Package A | Package B)
 *   - Error: typed message + retry, mirrors pros-cons-panel patterns
 *
 * Why tabs rather than three stacked code blocks per package:
 *   The user has six code blocks to look at (3 sections × 2 packages).
 *   Stacking them all is a wall of code; tabbing the section axis
 *   lets the user compare LIKE-FOR-LIKE — A's install vs B's install —
 *   which is the comparison they actually want to make.
 */

interface IdleState { kind: 'idle'; }
interface LoadingState { kind: 'loading'; }
interface ResultState {
  kind: 'result';
  data: UsageGuideResponse;
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

type TabId = 'install' | 'setup' | 'example';

@Component({
  selector: 'app-usage-guide-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TranslocoModule, AiSettingsDialogComponent],
  template: `
    @if (pkgA() && pkgB()) {
      <section class="ug-panel" [class.ug-busy]="state().kind === 'loading'">
        <header class="ug-head">
          <div class="ug-head-text">
            <h3>{{ 'usageGuide.title' | transloco }}</h3>
            <p class="ug-lede">{{ 'usageGuide.lede' | transloco }}</p>
          </div>
          <div class="ug-head-actions">
            <button
              type="button"
              class="ug-icon-btn"
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
                class="ug-refresh"
                (click)="generate(true)"
                [attr.aria-label]="'usageGuide.refresh' | transloco"
                [disabled]="state().kind === 'loading'"
              >
                <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M14 8a6 6 0 1 1-1.76-4.24"/>
                  <polyline points="14 2 14 6 10 6"/>
                </svg>
                {{ 'usageGuide.refresh' | transloco }}
              </button>
            }
          </div>
        </header>

        @switch (state().kind) {
          @case ('idle') {
            <div class="ug-cta">
              <p class="ug-cta-body">
                {{ 'usageGuide.ctaBody' | transloco: { a: pkgA(), b: pkgB() } }}
              </p>
              <button
                type="button"
                class="primary"
                (click)="generate(false)"
                data-testid="usageGuide.generate"
              >
                <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
                  <path d="M2 4h12v2H2zm0 3h12v2H2zm0 3h8v2H2z"/>
                </svg>
                {{ 'usageGuide.generate' | transloco }}
              </button>
              <p class="ug-cta-hint">{{ 'usageGuide.ctaHint' | transloco }}</p>
            </div>
          }

          @case ('loading') {
            <div class="ug-skeleton" role="status" [attr.aria-label]="'usageGuide.loading' | transloco">
              <div class="ug-skel-tabs">
                <div class="ug-skel-tab shimmer"></div>
                <div class="ug-skel-tab shimmer"></div>
                <div class="ug-skel-tab shimmer"></div>
              </div>
              <div class="ug-skel-grid">
                <div class="ug-skel-block shimmer"></div>
                <div class="ug-skel-block shimmer"></div>
              </div>
              <p class="ug-skel-msg">{{ 'usageGuide.loading' | transloco }}</p>
            </div>
          }

          @case ('result') {
            @let r = asResult(state());
            <div class="ug-result">
              <!-- Integration delta — the one-sentence orientation that
                   tells the user the SHAPE of the difference before they
                   read any code. Always rendered, never empty. -->
              <p class="ug-delta">
                <span class="ug-delta-icon" aria-hidden="true">🔀</span>
                {{ r.data.integrationDelta }}
              </p>

              <!-- Tab strip — three tabs over the section axis. WAI-ARIA
                   tab pattern: role=tablist on the container, role=tab on
                   each button, role=tabpanel on the content below. -->
              <div
                class="ug-tabs"
                role="tablist"
                [attr.aria-label]="'usageGuide.tabsLabel' | transloco"
              >
                @for (tab of TABS; track tab.id) {
                  <button
                    type="button"
                    role="tab"
                    class="ug-tab"
                    [class.is-active]="activeTab() === tab.id"
                    [attr.aria-selected]="activeTab() === tab.id"
                    [attr.aria-controls]="'ug-panel-' + tab.id"
                    [id]="'ug-tab-' + tab.id"
                    [tabindex]="activeTab() === tab.id ? 0 : -1"
                    (click)="activeTab.set(tab.id)"
                    (keydown)="onTabKeyDown($event)"
                  >
                    <span class="ug-tab-icon" aria-hidden="true">{{ tab.icon }}</span>
                    {{ ('usageGuide.tabs.' + tab.id) | transloco }}
                  </button>
                }
              </div>

              <div
                class="ug-tabpanel"
                role="tabpanel"
                [id]="'ug-panel-' + activeTab()"
                [attr.aria-labelledby]="'ug-tab-' + activeTab()"
              >
                <div class="ug-cmp-grid">
                  <article class="ug-cmp-col">
                    <header class="ug-cmp-head">
                      <span class="ug-cmp-pill" data-side="a">{{ r.data.packageA.packageName }}</span>
                    </header>
                    @let blockA = currentBlock(r.data.packageA);
                    <div class="ug-code-block">
                      <header class="ug-code-head">
                        <span class="ug-code-lang">{{ blockA.language }}</span>
                        <button
                          type="button"
                          class="ug-copy"
                          (click)="copy(blockA.code, 'a')"
                          [attr.aria-label]="'common.copy' | transloco"
                          [title]="'common.copy' | transloco"
                        >
                          @if (copied() === 'a') {
                            <span aria-hidden="true">✓</span>
                            {{ 'common.copied' | transloco }}
                          } @else {
                            <span aria-hidden="true">📋</span>
                            {{ 'common.copy' | transloco }}
                          }
                        </button>
                      </header>
                      <pre class="ug-code"><code [class]="'lang-' + blockA.language">{{ blockA.code }}</code></pre>
                    </div>
                    @if (r.data.packageA.notes) {
                      <p class="ug-notes">
                        <span aria-hidden="true">ℹ️</span>
                        {{ r.data.packageA.notes }}
                      </p>
                    }
                  </article>

                  <article class="ug-cmp-col">
                    <header class="ug-cmp-head">
                      <span class="ug-cmp-pill" data-side="b">{{ r.data.packageB.packageName }}</span>
                    </header>
                    @let blockB = currentBlock(r.data.packageB);
                    <div class="ug-code-block">
                      <header class="ug-code-head">
                        <span class="ug-code-lang">{{ blockB.language }}</span>
                        <button
                          type="button"
                          class="ug-copy"
                          (click)="copy(blockB.code, 'b')"
                          [attr.aria-label]="'common.copy' | transloco"
                          [title]="'common.copy' | transloco"
                        >
                          @if (copied() === 'b') {
                            <span aria-hidden="true">✓</span>
                            {{ 'common.copied' | transloco }}
                          } @else {
                            <span aria-hidden="true">📋</span>
                            {{ 'common.copy' | transloco }}
                          }
                        </button>
                      </header>
                      <pre class="ug-code"><code [class]="'lang-' + blockB.language">{{ blockB.code }}</code></pre>
                    </div>
                    @if (r.data.packageB.notes) {
                      <p class="ug-notes">
                        <span aria-hidden="true">ℹ️</span>
                        {{ r.data.packageB.notes }}
                      </p>
                    }
                  </article>
                </div>
              </div>

              <!-- Provenance footer — same layout / tokens as pros-cons-panel. -->
              <footer class="ug-provenance">
                <span>
                  {{
                    'usageGuide.generatedBy'
                      | transloco: { provider: providerLabel(r.provider), seconds: (r.latencyMs / 1000).toFixed(1) }
                  }}
                </span>
                <span aria-hidden="true">·</span>
                <time>{{ relativeTime(r.generatedAt) | transloco }}</time>
                <span aria-hidden="true">·</span>
                <button type="button" class="ug-link-btn" (click)="openSettings()">
                  {{ 'aiSettings.changeProvider' | transloco }}
                </button>
              </footer>
            </div>
          }

          @case ('error') {
            @let e = asError(state());
            <div class="ug-error" role="alert">
              <p class="ug-error-msg">{{ e.message }}</p>
              @if (e.isRateLimited) {
                <p class="ug-error-hint">
                  {{ 'usageGuide.error.rateLimitHint' | transloco }}
                  <button type="button" class="ug-link-btn" (click)="openSettings()">
                    {{ 'aiSettings.openButton' | transloco }} →
                  </button>
                </p>
              } @else if (e.errorKind === 'PROXY_UNAVAILABLE') {
                <div class="ug-error-hint">
                  <p>{{ 'usageGuide.error.proxyUnavailableLead' | transloco }}</p>
                  <ul>
                    <li>
                      <strong>{{ 'usageGuide.error.proxyOptionSsr' | transloco }}</strong>
                      <code>npm run build:ssr &amp;&amp; npm run serve:ssr</code>
                    </li>
                    <li>
                      <strong>{{ 'usageGuide.error.proxyOptionByo' | transloco }}</strong>
                    </li>
                  </ul>
                </div>
              }
              <div class="ug-error-actions">
                <button type="button" class="primary" (click)="generate(false)">
                  {{ 'usageGuide.retry' | transloco }}
                </button>
              </div>
            </div>
          }
        }
      </section>

      <app-ai-settings-dialog #aiSettings />
    }
  `,
  styles: [`
    :host { display: block; }

    .ug-panel {
      margin-top: 1.5rem;
      padding: clamp(1.1rem, 2vw, 1.5rem);
      border: 1px solid var(--border, #e5e7eb);
      border-radius: var(--radius-lg, 14px);
      background: var(--surface-2, #fff);
    }
    .ug-panel.ug-busy { animation: ug-pulse 1.6s ease-in-out infinite; }
    @keyframes ug-pulse { 50% { border-color: var(--accent); } }
    @media (prefers-reduced-motion: reduce) {
      .ug-panel.ug-busy { animation: none; }
    }

    .ug-head {
      display: flex; align-items: flex-start; justify-content: space-between;
      gap: 1rem; flex-wrap: wrap; margin-bottom: 1.1rem;
    }
    .ug-head-text { min-width: 0; flex: 1 1 auto; }
    .ug-head h3 {
      margin: 0 0 0.25rem;
      font-size: 1.1rem; font-weight: 600; color: var(--fg);
      letter-spacing: -0.01em;
    }
    .ug-lede { margin: 0; color: var(--fg-dim); font-size: 0.88rem; line-height: 1.5; }

    .ug-head-actions {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      flex-shrink: 0;
    }
    .ug-refresh {
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
    .ug-refresh:hover:not([disabled]) {
      border-color: var(--accent);
      color: var(--fg);
    }
    .ug-refresh[disabled] { opacity: 0.5; cursor: not-allowed; }

    .ug-icon-btn {
      width: 32px; height: 32px;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: 50%;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--fg-dim);
      cursor: pointer;
      transition: border-color 160ms ease, color 160ms ease, transform 200ms ease;
    }
    .ug-icon-btn:hover {
      border-color: var(--accent);
      color: var(--fg);
      transform: rotate(45deg);
    }
    @media (prefers-reduced-motion: reduce) {
      .ug-icon-btn:hover { transform: none; }
    }

    .ug-link-btn {
      background: none;
      border: none;
      padding: 0;
      margin: 0;
      color: var(--accent);
      cursor: pointer;
      font: inherit;
      line-height: inherit;
      text-decoration: underline;
      text-decoration-color: color-mix(in srgb, var(--accent) 40%, transparent);
      text-underline-offset: 2px;
    }
    .ug-link-btn:hover { text-decoration-color: var(--accent); }
    .ug-link-btn:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
      border-radius: 2px;
    }

    /* === Idle CTA === */
    .ug-cta {
      display: grid; gap: 0.85rem;
      padding: 1.5rem;
      border-radius: var(--radius-md, 10px);
      background: var(--accent-gradient-soft, var(--surface-1));
      border: 1px dashed color-mix(in srgb, var(--accent) 35%, var(--border));
      text-align: center;
    }
    .ug-cta-body { margin: 0; color: var(--fg); font-size: 0.95rem; line-height: 1.55; }
    .ug-cta-hint { margin: 0; color: var(--fg-dim); font-size: 0.78rem; }

    /* === Skeleton === */
    .ug-skeleton { display: grid; gap: 0.85rem; padding: 0.5rem 0; }
    .ug-skel-tabs { display: flex; gap: 0.5rem; }
    .ug-skel-tab { height: 2.1rem; width: 100px; border-radius: var(--radius-md, 10px); }
    .ug-skel-grid {
      display: grid; gap: 0.85rem;
      grid-template-columns: 1fr 1fr;
    }
    @media (max-width: 720px) {
      .ug-skel-grid { grid-template-columns: 1fr; }
    }
    .ug-skel-block { height: 11rem; border-radius: var(--radius-md, 10px); }
    .ug-skel-msg {
      margin: 0.5rem 0 0;
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
      animation: ug-shimmer 1.4s ease-in-out infinite;
    }
    @keyframes ug-shimmer { to { background-position: -200% 0; } }
    @media (prefers-reduced-motion: reduce) {
      .shimmer { animation: none; }
    }

    /* === Result === */
    .ug-result { display: grid; gap: 1rem; }
    .ug-delta {
      margin: 0;
      padding: 0.85rem 1rem;
      border-left: 3px solid var(--accent);
      background: var(--accent-gradient-soft, var(--surface-1));
      border-radius: 0 var(--radius-md, 10px) var(--radius-md, 10px) 0;
      color: var(--fg);
      font-size: 0.95rem;
      line-height: 1.5;
      display: flex; align-items: flex-start; gap: 0.5rem;
    }
    .ug-delta-icon { line-height: 1.4; }

    /* === Tabs === */
    .ug-tabs {
      display: inline-flex;
      gap: 0.25rem;
      padding: 0.25rem;
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-md, 10px);
      align-self: flex-start;
      flex-wrap: wrap;
    }
    .ug-tab {
      display: inline-flex; align-items: center; gap: 0.4rem;
      padding: 0.45rem 0.85rem;
      background: transparent;
      border: 1px solid transparent;
      border-radius: calc(var(--radius-md, 10px) - 2px);
      color: var(--fg-dim);
      font-size: 0.84rem; font-weight: 500;
      cursor: pointer;
      transition: background 160ms ease, color 160ms ease, border-color 160ms ease;
    }
    .ug-tab:hover { color: var(--fg); }
    .ug-tab.is-active {
      background: var(--surface-2);
      border-color: var(--border);
      color: var(--fg);
      font-weight: 600;
    }
    .ug-tab-icon { font-size: 1rem; line-height: 1; }
    .ug-tab:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }

    /* === Side-by-side comparison === */
    .ug-cmp-grid {
      display: grid; gap: 1rem;
      grid-template-columns: 1fr 1fr;
    }
    @media (max-width: 820px) {
      .ug-cmp-grid { grid-template-columns: 1fr; }
    }
    .ug-cmp-col {
      /* Flex column (not grid) so .ug-code-block can grow with flex:1
         to fill the row height set by the outer .ug-cmp-grid. Without
         this, code blocks were sized purely by their content and the
         shorter side left a jagged gap at the bottom of its column
         even though the grid was correctly stretching the column
         heights to match. */
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      min-width: 0; /* prevents <pre> from blowing out the grid */
    }
    .ug-cmp-head { display: flex; align-items: center; }
    .ug-cmp-pill {
      display: inline-block;
      padding: 0.2rem 0.65rem;
      border-radius: var(--radius-pill, 999px);
      font-size: 0.78rem; font-weight: 600;
      letter-spacing: 0.01em;
      max-width: 100%;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .ug-cmp-pill[data-side='a'] {
      background: color-mix(in srgb, var(--accent) 16%, transparent);
      color: var(--accent);
      border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
    }
    .ug-cmp-pill[data-side='b'] {
      background: color-mix(in srgb, #8b5cf6 16%, transparent);
      color: #8b5cf6;
      border: 1px solid color-mix(in srgb, #8b5cf6 40%, var(--border));
    }

    /* === Code blocks === */
    .ug-code-block {
      /* flex:1 makes the code block grow to fill the column's available
         vertical space (the column is also flex now). This is what
         actually solves the unequal-heights problem — both code-block
         boxes become the same height regardless of content length,
         and the shorter side just shows blank space inside its box
         rather than a jagged column bottom. */
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0; /* allow shrinking below content size when needed */
      border-radius: var(--radius-md, 10px);
      border: 1px solid var(--border);
      background: var(--surface-1);
      overflow: hidden;
    }
    .ug-code-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 0.4rem 0.6rem 0.4rem 0.85rem;
      background: color-mix(in srgb, var(--fg) 4%, transparent);
      border-bottom: 1px solid var(--border);
    }
    .ug-code-lang {
      font: 0.74rem/1 var(--code-font, ui-monospace, Menlo, Consolas, monospace);
      color: var(--fg-dim);
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .ug-copy {
      display: inline-flex; align-items: center; gap: 0.3rem;
      padding: 0.25rem 0.55rem;
      background: transparent;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm, 6px);
      color: var(--fg-dim);
      font-size: 0.72rem; font-weight: 500;
      cursor: pointer;
      transition: border-color 160ms ease, color 160ms ease;
    }
    .ug-copy:hover { border-color: var(--accent); color: var(--fg); }
    .ug-code {
      /* flex:1 inside .ug-code-block (also flex column) means the
         <pre> grows to fill the space below the header strip. Both
         shorter and longer code blocks now render at the same height;
         the shorter one has blank space inside its <pre> rather than
         the whole card being shorter. min-height:0 is the standard
         flex-shrink unlock so very tall code doesn't blow out the
         column. overflow:auto handles both axes — horizontal for
         long lines (was already there), vertical kicks in only when
         a single code block exceeds the row's available height,
         which is rare in practice given the 60-line schema cap. */
      flex: 1;
      min-height: 0;
      margin: 0;
      padding: 0.85rem 1rem;
      background: transparent;
      overflow: auto;
      font: 0.82rem/1.55 var(--code-font, ui-monospace, Menlo, Consolas, monospace);
      color: var(--fg);
      white-space: pre;
      tab-size: 2;
    }
    .ug-code code { font: inherit; color: inherit; background: transparent; }

    /* === Notes === */
    .ug-notes {
      margin: 0;
      padding: 0.55rem 0.75rem;
      border-radius: var(--radius-md, 10px);
      background: color-mix(in srgb, var(--accent) 6%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 25%, var(--border));
      color: var(--fg);
      font-size: 0.82rem; line-height: 1.5;
      display: flex; align-items: flex-start; gap: 0.4rem;
    }

    /* === Provenance === */
    .ug-provenance {
      display: flex; flex-wrap: wrap; gap: 0.4rem;
      align-items: baseline;
      padding-top: 0.8rem;
      border-top: 1px dashed var(--border);
      color: var(--fg-dim); font-size: 0.74rem;
    }

    /* === Error === */
    .ug-error {
      display: grid; gap: 0.65rem;
      padding: 1rem 1.2rem;
      border-radius: var(--radius-md, 10px);
      background: color-mix(in srgb, var(--bad, #ef4444) 7%, transparent);
      border: 1px solid color-mix(in srgb, var(--bad, #ef4444) 35%, var(--border));
    }
    .ug-error-msg {
      margin: 0; color: var(--bad, #b91c1c);
      font-size: 0.9rem; font-weight: 500;
    }
    .ug-error-hint {
      margin: 0; color: var(--fg);
      font-size: 0.85rem; line-height: 1.5;
    }
    .ug-error-hint p { margin: 0 0 0.5rem; }
    .ug-error-hint ul {
      margin: 0; padding: 0 0 0 1.1rem;
      display: grid; gap: 0.35rem;
    }
    .ug-error-hint li { color: var(--fg); font-size: 0.85rem; }
    .ug-error-hint code {
      display: inline-block;
      margin-inline-start: 0.35rem;
      padding: 1px 6px;
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm, 6px);
      font: 0.78rem/1 var(--code-font, ui-monospace, Menlo, Consolas, monospace);
    }
    .ug-error-actions { display: flex; gap: 0.5rem; }

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
export class UsageGuidePanelComponent {
  private readonly service = inject(UsageGuideService);
  private readonly compareHistory = inject(CompareHistoryService);

  @ViewChild('aiSettings')
  private settingsDialog?: AiSettingsDialogComponent;

  readonly pkgA = input<string>('');
  readonly pkgB = input<string>('');

  readonly state = signal<PanelState>({ kind: 'idle' });

  /** Currently-selected tab. */
  readonly activeTab = signal<TabId>('install');

  /**
   * Which package's copy button was most-recently activated, so the
   * UI can show a transient "Copied" affordance on that specific
   * button only. Cleared after 1.6s by `copy()`.
   */
  readonly copied = signal<'a' | 'b' | null>(null);

  /** Tab definitions — kept as a static constant so the template
   *  can iterate them and the order is locked. */
  readonly TABS: ReadonlyArray<{ id: TabId; icon: string }> = [
    { id: 'install', icon: '📦' },
    { id: 'setup', icon: '⚙️' },
    { id: 'example', icon: '▶️' }
  ];

  readonly bothReady = computed(() => !!this.pkgA() && !!this.pkgB());

  generate(forceRefresh: boolean): void {
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
          generatedAt: res.generatedAt,
          latencyMs: res.latencyMs
        });
        // Flag this comparison as "has Usage Guide" in history so the
        // ✨ indicator appears on the chip when the user revisits.
        // Fire-and-forget — failure to flag doesn't affect user state.
        void this.compareHistory.flagAiHighlight(a, b, 'usage-guide');
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

  openSettings(): void {
    this.settingsDialog?.open();
  }

  /**
   * Copy a code block to the clipboard. We fall back to the legacy
   * `execCommand('copy')` path on browsers that don't expose the
   * Clipboard API (older Safari, some embedded webviews). The transient
   * "Copied" affordance fires regardless of which path succeeds.
   */
  copy(text: string, side: 'a' | 'b'): void {
    const setFlash = () => {
      this.copied.set(side);
      setTimeout(() => this.copied.set(null), 1600);
    };
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(setFlash, () => {
        this.legacyCopy(text, setFlash);
      });
    } else {
      this.legacyCopy(text, setFlash);
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
      /* nothing useful to do — copy is a non-critical convenience */
    }
  }

  /**
   * WAI-ARIA tab keyboard pattern: ArrowLeft/Right cycle through tabs,
   * Home/End jump to the first/last. The browser handles activation
   * (Enter/Space) via the native button element.
   */
  onTabKeyDown(ev: KeyboardEvent): void {
    const ids = this.TABS.map((t) => t.id);
    const current = ids.indexOf(this.activeTab());
    if (current < 0) return;
    let next = current;
    switch (ev.key) {
      case 'ArrowLeft':
      case 'ArrowUp':
        ev.preventDefault();
        next = (current - 1 + ids.length) % ids.length;
        break;
      case 'ArrowRight':
      case 'ArrowDown':
        ev.preventDefault();
        next = (current + 1) % ids.length;
        break;
      case 'Home':
        ev.preventDefault();
        next = 0;
        break;
      case 'End':
        ev.preventDefault();
        next = ids.length - 1;
        break;
      default:
        return;
    }
    if (next !== current) {
      this.activeTab.set(ids[next]);
      // Focus the newly-active tab so the keyboard user sees focus
      // follow their navigation. Defer to next frame so Angular has
      // applied [tabindex] changes.
      requestAnimationFrame(() => {
        const el = document.getElementById('ug-tab-' + ids[next]);
        el?.focus();
      });
    }
  }

  // ---------- Template helpers ----------

  asResult(s: PanelState): ResultState { return s as ResultState; }
  asError(s: PanelState): ErrorState { return s as ErrorState; }

  /**
   * Map the currently-active tab id to the matching field on a
   * per-package guide. Centralized so the template doesn't repeat a
   * switch across both columns.
   */
  currentBlock(guide: PackageUsageGuide): UsageCodeBlock {
    switch (this.activeTab()) {
      case 'install': return guide.installCommand;
      case 'setup':   return guide.setupCode;
      case 'example': return guide.basicExample;
    }
  }

  providerLabel(id: AiProviderId): string {
    switch (id) {
      case 'groq-proxy': return 'Groq';
      case 'gemini-byo': return 'Gemini';
      case 'openai-byo': return 'OpenAI';
      case 'deepseek-byo': return 'DeepSeek';
    }
  }

  relativeTime(ts: number): string {
    const seconds = Math.floor((Date.now() - ts) / 1000);
    if (seconds < 60) return 'usageGuide.time.justNow';
    if (seconds < 120) return 'usageGuide.time.aMinuteAgo';
    if (seconds < 3600) return 'usageGuide.time.minutesAgo';
    return 'usageGuide.time.hoursAgo';
  }
}
