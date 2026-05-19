import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  PLATFORM_ID,
  ViewChild,
  computed,
  inject,
  signal
} from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslocoModule } from '@jsverse/transloco';
import {
  AiProviderId,
  AiProviderService
} from '../../services/ai/ai-provider.service';
import { ToastService } from '../../services/toast.service';

/**
 * AI provider settings dialog.
 *
 * Three-tier UX matching the architecture we agreed on:
 *   1. Groq via our proxy (no key, free, default).
 *   2. Gemini BYO (free upgrade — Google AI Studio key).
 *   3. OpenAI BYO / DeepSeek BYO (paid upgrade — user pays per request).
 *
 * Implementation notes:
 *   - Native <dialog> element — gets focus management, ESC-to-close,
 *     backdrop click handling, and modal accessibility for free across
 *     evergreen browsers (Chrome 37+, Firefox 98+, Safari 15.4+).
 *   - All state lives in AiProviderService signals; this component is
 *     a pure render-and-dispatch surface. The dialog can be closed and
 *     reopened without losing state.
 *   - Keys are password-masked in the input but the user can toggle
 *     visibility on hover via the show/hide eye toggle next to each
 *     field — necessary for verifying a paste went through correctly.
 *   - Privacy notice up top: keys live in localStorage and go directly
 *     from this browser to the provider. We never touch them.
 *
 * Reusability: the component exposes `open()` / `close()` methods.
 * Anywhere that wants to surface AI settings just keeps a ViewChild
 * ref and calls `dialog.open()`. Currently called from the pros-cons
 * panel header (gear icon) and from its rate-limit error state.
 */
@Component({
  selector: 'app-ai-settings-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, TranslocoModule],
  template: `
    <dialog
      #dlg
      class="ai-dlg"
      (close)="onDialogClose()"
      (click)="onBackdropClick($event)"
    >
      <article class="ai-dlg-card" (click)="$event.stopPropagation()">
        <header class="ai-dlg-head">
          <div>
            <h2>{{ 'aiSettings.title' | transloco }}</h2>
            <p class="ai-dlg-lede">
              {{ 'aiSettings.privacy' | transloco }}
            </p>
          </div>
          <button
            type="button"
            class="ai-dlg-close"
            (click)="close()"
            [attr.aria-label]="'aiSettings.close' | transloco"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M3 3l10 10M13 3L3 13"/>
            </svg>
          </button>
        </header>

        <!-- Tier 1: Groq (default, no key) -->
        <section class="ai-tier" data-tier="default">
          <div class="ai-tier-head">
            <span class="ai-tier-num">1</span>
            <div class="ai-tier-meta">
              <h3>
                <span aria-hidden="true">⚡</span>
                {{ 'aiSettings.groq.title' | transloco }}
                <span class="ai-tier-pill ai-tier-pill-free">
                  {{ 'aiSettings.tierFreeDefault' | transloco }}
                </span>
              </h3>
              <p>{{ 'aiSettings.groq.body' | transloco }}</p>
            </div>
            <span class="ai-tier-state ai-tier-state-on">
              ● {{ 'aiSettings.connected' | transloco }}
            </span>
          </div>
        </section>

        <!-- Tier 2: Gemini BYO -->
        <section class="ai-tier" data-tier="byo-free">
          <div class="ai-tier-head">
            <span class="ai-tier-num">2</span>
            <div class="ai-tier-meta">
              <h3>
                <span aria-hidden="true">✨</span>
                {{ 'aiSettings.gemini.title' | transloco }}
                <span class="ai-tier-pill ai-tier-pill-free">
                  {{ 'aiSettings.tierFreeUpgrade' | transloco }}
                </span>
              </h3>
              <p>{{ 'aiSettings.gemini.body' | transloco }}</p>
            </div>
            @if (geminiKey()) {
              <span class="ai-tier-state ai-tier-state-on">
                ● {{ 'aiSettings.configured' | transloco }}
              </span>
            }
          </div>
          <div class="ai-key-row">
            <label class="ai-key-input">
              <input
                [type]="showGemini() ? 'text' : 'password'"
                [(ngModel)]="geminiDraft"
                name="geminiKey"
                [placeholder]="geminiKey() ? maskKey(geminiKey()!) : 'AIza…'"
                autocomplete="off"
                spellcheck="false"
                autocapitalize="none"
                autocorrect="off"
              />
              <button
                type="button"
                class="ai-key-eye"
                (click)="showGemini.set(!showGemini())"
                [attr.aria-label]="(showGemini() ? 'aiSettings.hideKey' : 'aiSettings.showKey') | transloco"
                [title]="(showGemini() ? 'aiSettings.hideKey' : 'aiSettings.showKey') | transloco"
              >
                {{ showGemini() ? '🙈' : '👁' }}
              </button>
            </label>
            @if (geminiKey()) {
              <button type="button" class="ai-btn ai-btn-danger" (click)="remove('gemini')">
                {{ 'aiSettings.remove' | transloco }}
              </button>
            }
            <button
              type="button"
              class="ai-btn ai-btn-primary"
              (click)="save('gemini')"
              [disabled]="!geminiDraft.trim()"
            >
              {{ 'aiSettings.save' | transloco }}
            </button>
          </div>
          <a class="ai-tier-link" href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer">
            {{ 'aiSettings.gemini.getKey' | transloco }} →
          </a>
        </section>

        <!-- Tier 3: OpenAI / DeepSeek BYO -->
        <section class="ai-tier" data-tier="byo-paid">
          <div class="ai-tier-head">
            <span class="ai-tier-num">3</span>
            <div class="ai-tier-meta">
              <h3>
                <span aria-hidden="true">🚀</span>
                {{ 'aiSettings.paid.title' | transloco }}
                <span class="ai-tier-pill ai-tier-pill-paid">
                  {{ 'aiSettings.tierPaid' | transloco }}
                </span>
              </h3>
              <p>{{ 'aiSettings.paid.body' | transloco }}</p>
            </div>
          </div>

          <div class="ai-paid-row">
            <span class="ai-paid-label">
              OpenAI
              <!-- Experimental badge: we ship adapters for OpenAI and
                   DeepSeek but neither has been exercised against a real
                   key yet (we only have Groq + Gemini for QA). The badge
                   tells users "this might be flaky" without nuking the
                   feature, and the title attribute gives the why. The
                   self-healing retry in ai-provider.service.ts handles
                   the most common quirk class (schema-format rejection)
                   automatically, so the experience is still usable. -->
              <span
                class="ai-paid-experimental"
                [title]="'aiSettings.experimentalTooltip' | transloco"
              >
                {{ 'aiSettings.experimental' | transloco }}
              </span>
            </span>
            <div class="ai-key-row">
              <label class="ai-key-input">
                <input
                  [type]="showOpenai() ? 'text' : 'password'"
                  [(ngModel)]="openaiDraft"
                  name="openaiKey"
                  [placeholder]="openaiKey() ? maskKey(openaiKey()!) : 'sk-…'"
                  autocomplete="off"
                  spellcheck="false"
                  autocapitalize="none"
                  autocorrect="off"
                />
                <button
                  type="button"
                  class="ai-key-eye"
                  (click)="showOpenai.set(!showOpenai())"
                  [attr.aria-label]="(showOpenai() ? 'aiSettings.hideKey' : 'aiSettings.showKey') | transloco"
                >
                  {{ showOpenai() ? '🙈' : '👁' }}
                </button>
              </label>
              @if (openaiKey()) {
                <button type="button" class="ai-btn ai-btn-danger" (click)="remove('openai')">
                  {{ 'aiSettings.remove' | transloco }}
                </button>
              }
              <button
                type="button"
                class="ai-btn"
                (click)="save('openai')"
                [disabled]="!openaiDraft.trim()"
              >
                {{ 'aiSettings.save' | transloco }}
              </button>
            </div>
            <a class="ai-tier-link" href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">
              {{ 'aiSettings.openai.getKey' | transloco }} →
            </a>
          </div>

          <div class="ai-paid-row">
            <span class="ai-paid-label">
              DeepSeek
              <span
                class="ai-paid-experimental"
                [title]="'aiSettings.experimentalTooltip' | transloco"
              >
                {{ 'aiSettings.experimental' | transloco }}
              </span>
            </span>
            <div class="ai-key-row">
              <label class="ai-key-input">
                <input
                  [type]="showDeepseek() ? 'text' : 'password'"
                  [(ngModel)]="deepseekDraft"
                  name="deepseekKey"
                  [placeholder]="deepseekKey() ? maskKey(deepseekKey()!) : 'sk-…'"
                  autocomplete="off"
                  spellcheck="false"
                  autocapitalize="none"
                  autocorrect="off"
                />
                <button
                  type="button"
                  class="ai-key-eye"
                  (click)="showDeepseek.set(!showDeepseek())"
                  [attr.aria-label]="(showDeepseek() ? 'aiSettings.hideKey' : 'aiSettings.showKey') | transloco"
                >
                  {{ showDeepseek() ? '🙈' : '👁' }}
                </button>
              </label>
              @if (deepseekKey()) {
                <button type="button" class="ai-btn ai-btn-danger" (click)="remove('deepseek')">
                  {{ 'aiSettings.remove' | transloco }}
                </button>
              }
              <button
                type="button"
                class="ai-btn"
                (click)="save('deepseek')"
                [disabled]="!deepseekDraft.trim()"
              >
                {{ 'aiSettings.save' | transloco }}
              </button>
            </div>
            <a class="ai-tier-link" href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener noreferrer">
              {{ 'aiSettings.deepseek.getKey' | transloco }} →
            </a>
          </div>

          <!-- Tier-level disclosure about the Experimental status.
               Sits at the bottom of the paid tier so it applies to both
               sub-providers without repeating the same caveat twice. -->
          <p class="ai-paid-footnote">
            <span aria-hidden="true">🧪</span>
            {{ 'aiSettings.experimentalFootnote' | transloco }}
          </p>
        </section>

        <!-- Active provider + override -->
        <footer class="ai-dlg-foot">
          <div class="ai-active">
            <span class="ai-active-label">{{ 'aiSettings.active' | transloco }}</span>
            <span class="ai-active-pill">
              ● {{ providerLabel(activeProvider()) }}
              @if (preferredProvider()) {
                <span class="ai-active-mode">({{ 'aiSettings.manual' | transloco }})</span>
              } @else {
                <span class="ai-active-mode">({{ 'aiSettings.auto' | transloco }})</span>
              }
            </span>
          </div>
          <div class="ai-override">
            <label for="ai-override-select" class="visually-hidden">
              {{ 'aiSettings.overrideLabel' | transloco }}
            </label>
            <select
              id="ai-override-select"
              [ngModel]="overrideValue()"
              (ngModelChange)="setOverride($event)"
              name="aiOverride"
            >
              <option value="">{{ 'aiSettings.auto' | transloco }}</option>
              <option value="groq-proxy">Groq (proxy)</option>
              <option value="gemini-byo" [disabled]="!geminiKey()">Gemini (BYO)</option>
              <option value="openai-byo" [disabled]="!openaiKey()">OpenAI (BYO)</option>
              <option value="deepseek-byo" [disabled]="!deepseekKey()">DeepSeek (BYO)</option>
            </select>
          </div>
          <button type="button" class="ai-btn ai-btn-primary" (click)="close()">
            {{ 'aiSettings.done' | transloco }}
          </button>
        </footer>
      </article>
    </dialog>
  `,
  styles: [`
    :host { display: contents; }

    /* === Native <dialog> — wired to look like the rest of the app === */
    dialog.ai-dlg {
      padding: 0;
      border: none;
      background: transparent;
      max-width: min(640px, 92vw);
      width: 100%;
      max-height: 92vh;
      color: var(--fg);
    }
    dialog.ai-dlg::backdrop {
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
    }

    .ai-dlg-card {
      display: grid; gap: 1rem;
      padding: 1.5rem;
      max-height: 92vh;
      overflow-y: auto;
      background: var(--surface-2, #fff);
      border: 1px solid var(--border, #e5e7eb);
      border-radius: var(--radius-lg, 14px);
      box-shadow: var(--shadow-2, 0 10px 30px rgba(0, 0, 0, 0.18));
      animation: ai-dlg-pop 200ms cubic-bezier(0.2, 0.6, 0.2, 1);
    }
    @keyframes ai-dlg-pop {
      from { opacity: 0; transform: translateY(8px) scale(0.985); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    @media (prefers-reduced-motion: reduce) {
      .ai-dlg-card { animation: none; }
    }

    /* === Header === */
    .ai-dlg-head {
      display: flex; align-items: flex-start; justify-content: space-between;
      gap: 0.85rem;
    }
    .ai-dlg-head h2 {
      margin: 0 0 0.25rem;
      font-size: 1.15rem; font-weight: 600;
      letter-spacing: -0.01em;
      color: var(--fg);
    }
    .ai-dlg-lede {
      margin: 0;
      color: var(--fg-dim);
      font-size: 0.85rem;
      line-height: 1.5;
      max-width: 52ch;
    }
    .ai-dlg-close {
      width: 32px; height: 32px;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: 50%;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--fg-dim);
      cursor: pointer;
      transition: background-color 120ms ease, color 120ms ease;
      flex-shrink: 0;
    }
    .ai-dlg-close:hover { background: var(--surface-1); color: var(--fg); }

    /* === Tier card === */
    .ai-tier {
      display: grid; gap: 0.6rem;
      padding: 0.95rem 1rem;
      border-radius: var(--radius-md, 10px);
      border: 1px solid var(--border-subtle, var(--border));
      background: var(--surface-1);
    }
    .ai-tier[data-tier='default'] {
      background: var(--accent-gradient-soft, var(--surface-1));
      border-color: color-mix(in srgb, var(--accent) 30%, var(--border));
    }
    .ai-tier-head {
      display: grid; gap: 0.65rem;
      grid-template-columns: auto 1fr auto;
      align-items: start;
    }
    .ai-tier-num {
      display: inline-flex; align-items: center; justify-content: center;
      width: 24px; height: 24px;
      border-radius: 50%;
      background: var(--surface-2);
      border: 1px solid var(--border);
      color: var(--fg-dim);
      font-size: 0.75rem; font-weight: 700;
      margin-top: 2px;
    }
    .ai-tier-meta { min-width: 0; }
    .ai-tier-meta h3 {
      margin: 0 0 0.2rem;
      display: inline-flex; align-items: center; gap: 0.4rem;
      flex-wrap: wrap;
      font-size: 0.95rem; font-weight: 600;
      color: var(--fg);
    }
    .ai-tier-meta p {
      margin: 0;
      color: var(--fg-dim);
      font-size: 0.82rem;
      line-height: 1.5;
    }
    .ai-tier-pill {
      font-size: 0.66rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 1px 8px;
      border-radius: var(--radius-pill, 999px);
      border: 1px solid var(--border);
      background: var(--surface-2);
      color: var(--fg-dim);
    }
    .ai-tier-pill-free {
      background: color-mix(in srgb, var(--ok, #22c55e) 14%, transparent);
      color: var(--ok, #16a34a);
      border-color: color-mix(in srgb, var(--ok, #22c55e) 40%, var(--border));
    }
    .ai-tier-pill-paid {
      background: color-mix(in srgb, var(--accent) 14%, transparent);
      color: var(--accent);
      border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
    }
    .ai-tier-state {
      font-size: 0.72rem;
      color: var(--fg-dim);
      white-space: nowrap;
    }
    .ai-tier-state-on { color: var(--ok, #16a34a); }
    .ai-tier-link {
      font-size: 0.75rem;
      color: var(--accent);
      text-decoration: none;
    }
    .ai-tier-link:hover { text-decoration: underline; }

    /* === Key input row === */
    .ai-key-row {
      display: flex; gap: 0.45rem;
      align-items: stretch;
      flex-wrap: wrap;
    }
    .ai-key-input {
      flex: 1 1 220px;
      min-width: 200px;
      display: inline-flex;
      align-items: stretch;
      border: 1px solid var(--border);
      border-radius: var(--radius-md, 10px);
      background: var(--surface-2);
      overflow: hidden;
    }
    .ai-key-input input {
      flex: 1 1 auto;
      min-width: 0;
      padding: 0.55rem 0.7rem;
      border: none;
      background: transparent;
      color: var(--fg);
      font: 0.85rem var(--code-font, ui-monospace, Menlo, Consolas, monospace);
      outline: none;
    }
    .ai-key-input input:focus { background: var(--surface-1); }
    .ai-key-eye {
      width: 36px;
      border: none;
      background: transparent;
      cursor: pointer;
      color: var(--fg-dim);
      font-size: 0.95rem;
    }
    .ai-key-eye:hover { color: var(--fg); }

    /* === Paid-tier sub-rows (one per OpenAI / DeepSeek) === */
    .ai-paid-row {
      display: grid; gap: 0.35rem;
      padding-top: 0.65rem;
      border-top: 1px dashed var(--border);
    }
    .ai-paid-row:first-of-type { padding-top: 0; border-top: none; }
    .ai-paid-label {
      font-size: 0.72rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      font-weight: 600;
      color: var(--fg-dim);
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
    }

    /* Experimental badge — distinct from the tier pill (green/blue) so
       it reads as "caution" rather than "feature category." Amber tone
       is the conventional "use with care, not broken" colour. */
    .ai-paid-experimental {
      font-size: 0.6rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: var(--radius-pill, 999px);
      background: color-mix(in srgb, var(--warn, #f59e0b) 16%, transparent);
      color: color-mix(in srgb, var(--warn, #f59e0b) 70%, var(--fg));
      border: 1px solid color-mix(in srgb, var(--warn, #f59e0b) 40%, var(--border));
      cursor: help; /* signals "hover for explanation" via the title attr */
    }

    /* Tier-level footnote — appears once at the bottom of the paid tier
       to explain what "Experimental" means without repeating the same
       sentence under both OpenAI and DeepSeek sub-rows. */
    .ai-paid-footnote {
      margin: 0.65rem 0 0;
      padding: 0.5rem 0.7rem;
      border-radius: var(--radius-md, 10px);
      background: color-mix(in srgb, var(--warn, #f59e0b) 7%, transparent);
      border: 1px dashed color-mix(in srgb, var(--warn, #f59e0b) 35%, var(--border));
      color: var(--fg);
      font-size: 0.78rem;
      line-height: 1.5;
      display: flex;
      align-items: flex-start;
      gap: 0.45rem;
    }

    /* === Buttons === */
    .ai-btn {
      padding: 0 0.85rem;
      min-height: 36px;
      border-radius: var(--radius-md, 10px);
      border: 1px solid var(--border);
      background: var(--surface-2);
      color: var(--fg);
      font-size: 0.82rem;
      font-weight: 500;
      cursor: pointer;
      transition: background-color 120ms ease, border-color 120ms ease, transform 100ms ease;
    }
    .ai-btn:hover:not([disabled]) {
      background: var(--surface-1);
      border-color: var(--accent);
    }
    .ai-btn:active:not([disabled]) { transform: translateY(1px); }
    .ai-btn[disabled] { opacity: 0.5; cursor: not-allowed; }
    .ai-btn-primary {
      background: var(--accent-gradient, var(--accent));
      color: #fff;
      border-color: transparent;
      box-shadow: var(--shadow-1);
    }
    .ai-btn-primary:hover:not([disabled]) {
      filter: brightness(1.05);
      box-shadow: var(--shadow-glow);
    }
    .ai-btn-danger {
      background: transparent;
      border-color: color-mix(in srgb, var(--bad, #ef4444) 35%, var(--border));
      color: var(--bad, #b91c1c);
    }
    .ai-btn-danger:hover {
      background: color-mix(in srgb, var(--bad, #ef4444) 8%, transparent);
    }

    /* === Footer (active provider + override + Done) === */
    .ai-dlg-foot {
      display: flex; align-items: center; justify-content: space-between;
      gap: 0.85rem;
      padding-top: 1rem;
      border-top: 1px solid var(--border-subtle, var(--border));
      flex-wrap: wrap;
    }
    .ai-active { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
    .ai-active-label {
      font-size: 0.78rem;
      color: var(--fg-dim);
    }
    .ai-active-pill {
      display: inline-flex; align-items: center; gap: 0.4rem;
      padding: 0.2rem 0.6rem;
      border-radius: var(--radius-pill, 999px);
      background: var(--accent-gradient-soft, var(--surface-1));
      border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
      font-size: 0.8rem; font-weight: 600;
      color: var(--accent);
    }
    .ai-active-mode {
      font-weight: 400;
      color: var(--fg-dim);
      font-size: 0.74rem;
    }
    .ai-override select {
      padding: 0.45rem 0.7rem;
      border-radius: var(--radius-md, 10px);
      border: 1px solid var(--border);
      background: var(--surface-2);
      color: var(--fg);
      font: inherit;
      font-size: 0.82rem;
    }

    .visually-hidden {
      position: absolute; width: 1px; height: 1px;
      padding: 0; margin: -1px; overflow: hidden;
      clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
    }
  `]
})
export class AiSettingsDialogComponent {
  private readonly ai = inject(AiProviderService);
  private readonly toast = inject(ToastService);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);

  @ViewChild('dlg', { static: true })
  private dlgRef!: ElementRef<HTMLDialogElement>;

  // --- Reactive slices of the service signals ---
  readonly geminiKey = this.ai.geminiKey;
  readonly openaiKey = this.ai.openaiKey;
  readonly deepseekKey = this.ai.deepseekKey;
  readonly preferredProvider = this.ai.preferredProvider;
  readonly activeProvider = this.ai.activeProvider;

  // --- Local form state ---
  /**
   * Plain ngModel-bound strings. We don't lift these into signals
   * because the input loses focus between keystrokes when bound to a
   * signal under the OnPush + ngModel combination. Local mutation is
   * fine — the only consumer is the Save click handler.
   */
  geminiDraft = '';
  openaiDraft = '';
  deepseekDraft = '';

  readonly showGemini = signal(false);
  readonly showOpenai = signal(false);
  readonly showDeepseek = signal(false);

  /**
   * The select element binds to a string, but the service uses
   * `AiProviderId | null`. Empty string ↔ null translation lives here.
   */
  readonly overrideValue = computed(() => this.preferredProvider() ?? '');

  // --- Public dialog API ---

  open(): void {
    if (!this.isBrowser) return;
    const dlg = this.dlgRef?.nativeElement;
    if (!dlg) return;
    // Reset show toggles so a previously-opened state doesn't leak the
    // key value across sessions (e.g. user opens, eyes the key, closes,
    // re-opens — should default to masked again).
    this.showGemini.set(false);
    this.showOpenai.set(false);
    this.showDeepseek.set(false);
    if (!dlg.open) dlg.showModal();
  }

  close(): void {
    const dlg = this.dlgRef?.nativeElement;
    if (dlg?.open) dlg.close();
  }

  // --- Event handlers ---

  onDialogClose(): void {
    // Clear drafts on close so the next open is a fresh form.
    this.geminiDraft = '';
    this.openaiDraft = '';
    this.deepseekDraft = '';
  }

  /**
   * Native <dialog> backdrop clicks land on the dialog element itself
   * (the `.ai-dlg-card` inside calls stopPropagation). When we get a
   * direct click on the dialog, the user clicked the backdrop — close.
   */
  onBackdropClick(ev: MouseEvent): void {
    if (ev.target === this.dlgRef?.nativeElement) {
      this.close();
    }
  }

  save(provider: 'gemini' | 'openai' | 'deepseek'): void {
    const value = (
      provider === 'gemini' ? this.geminiDraft :
      provider === 'openai' ? this.openaiDraft :
                              this.deepseekDraft
    ).trim();
    if (!value) return;
    this.ai.setKey(provider, value);
    // Reset the relevant draft input
    if (provider === 'gemini')   this.geminiDraft = '';
    if (provider === 'openai')   this.openaiDraft = '';
    if (provider === 'deepseek') this.deepseekDraft = '';
    this.toast.success?.(`Saved ${this.providerShort(provider)} key.`);
  }

  remove(provider: 'gemini' | 'openai' | 'deepseek'): void {
    this.ai.setKey(provider, null);
    // If the preferred provider was this one, fall back to auto.
    const preferred = this.preferredProvider();
    if (
      (provider === 'gemini'   && preferred === 'gemini-byo') ||
      (provider === 'openai'   && preferred === 'openai-byo') ||
      (provider === 'deepseek' && preferred === 'deepseek-byo')
    ) {
      this.ai.setPreferredProvider(null);
    }
    this.toast.info?.(`Removed ${this.providerShort(provider)} key.`);
  }

  setOverride(value: string): void {
    if (!value) {
      this.ai.setPreferredProvider(null);
      return;
    }
    this.ai.setPreferredProvider(value as AiProviderId);
  }

  // --- Template helpers ---

  /**
   * Render a key like `sk-1234…cdef` so users can confirm WHICH key is
   * stored without exposing it. Shows the first 6 and last 4 chars;
   * dots fill the middle. For very short keys we just show "•••••".
   */
  maskKey(key: string): string {
    if (!key) return '';
    if (key.length <= 14) return '•'.repeat(8);
    return `${key.slice(0, 6)}…${key.slice(-4)}`;
  }

  providerLabel(id: AiProviderId): string {
    switch (id) {
      case 'groq-proxy':   return 'Groq';
      case 'gemini-byo':   return 'Gemini';
      case 'openai-byo':   return 'OpenAI';
      case 'deepseek-byo': return 'DeepSeek';
    }
  }

  private providerShort(p: 'gemini' | 'openai' | 'deepseek'): string {
    return p === 'gemini' ? 'Gemini' : p === 'openai' ? 'OpenAI' : 'DeepSeek';
  }
}
