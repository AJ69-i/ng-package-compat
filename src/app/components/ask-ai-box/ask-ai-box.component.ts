import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { TranslocoModule } from '@jsverse/transloco';
import { Subscription } from 'rxjs';

import { AskAiContext, AskAiService } from '../../services/ai/ask-ai.service';
import { AskAiResponse } from '../../services/ai/schemas/ask-ai.schema';
import { MarkdownRendererService } from '../../services/markdown-renderer.service';
import { AiCompletionResponse } from '../../services/ai/ai-provider.service';

/**
 * "Ask AI about this package" inline box (Feature #4 of the search-page
 * masterpiece plan).
 *
 * Lives below the package-meta on /search and exposes a single,
 * focused affordance: a textarea + Submit + 4 example-question chips.
 * The user types a question scoped to the current package, the model
 * answers in markdown, we render through MarkdownRendererService (the
 * same safe-markdown subset the README preview uses).
 *
 * # Why a discriminated-union state instead of a plain "loading" boolean
 *
 * Same pattern as the existing CompetitorChipsComponent — explicit
 * idle/loading/result/error keeps the template branches readable and
 * the type narrows cleanly inside @case blocks.
 *
 * # Caching + provider routing
 *
 * Everything happens through AskAiService which sits on top of the
 * existing AiProviderService (Groq proxy default + BYO Gemini/OpenAI/
 * DeepSeek upgrade path) and AiCacheService (1h TTL + dedup). We
 * never call the AI provider directly from this component — it's a
 * thin UI shell that orchestrates the existing infrastructure.
 *
 * # A11Y
 *
 * - The textarea has an explicit label and aria-describedby pointing
 *   at the hint text.
 * - Submission is keyboard-friendly: Enter submits (Shift+Enter for a
 *   newline, like ChatGPT). The Submit button stays focusable for
 *   pointer users.
 * - The answer region is `role="region"` + `aria-live="polite"` so
 *   screen readers announce new answers without interrupting.
 * - Example-question chips are real buttons with aria-labels.
 */

interface IdleState { kind: 'idle'; }
interface LoadingState { kind: 'loading'; }
interface ResultState {
  kind: 'result';
  data: AskAiResponse;
  /** Provider metadata for the small footer ("answered by groq, cached 2m ago"). */
  meta: AiCompletionResponse<AskAiResponse>;
}
interface ErrorState { kind: 'error'; message: string; }
type State = IdleState | LoadingState | ResultState | ErrorState;

@Component({
  selector: 'app-ask-ai-box',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, TranslocoModule],
  template: `
    <section class="ask" [attr.aria-label]="'askAi.section' | transloco">
      <header class="ask-head">
        <span class="ask-ico" aria-hidden="true">✨</span>
        <div class="ask-title-block">
          <h3 id="ask-ai-title">{{ 'askAi.title' | transloco: { name: pkgName() } }}</h3>
          <p class="ask-sub">{{ 'askAi.subtitle' | transloco }}</p>
        </div>
      </header>

      <form class="ask-form" (submit)="onSubmit($event)">
        <label for="ask-ai-input" class="sr-only">
          {{ 'askAi.inputLabel' | transloco }}
        </label>
        <textarea
          id="ask-ai-input"
          class="ask-input"
          rows="2"
          [placeholder]="'askAi.placeholder' | transloco: { name: pkgName() }"
          [ngModel]="question()"
          (ngModelChange)="question.set($event)"
          (keydown.enter)="onEnter($event)"
          name="askAiInput"
          aria-describedby="ask-ai-hint"
          [disabled]="busy()"
        ></textarea>
        <p id="ask-ai-hint" class="sr-only">
          {{ 'askAi.enterHint' | transloco }}
        </p>
        <button
          type="submit"
          class="ask-submit"
          [disabled]="!canSubmit()"
          [attr.aria-label]="'askAi.submitAria' | transloco"
        >
          @if (busy()) {
            <span class="dots" aria-hidden="true">
              <span></span><span></span><span></span>
            </span>
            <span>{{ 'askAi.thinking' | transloco }}</span>
          } @else {
            <span>{{ 'askAi.submit' | transloco }}</span>
          }
        </button>
      </form>

      <!-- Example questions surface as small chips. Always rendered
           because new users land on /search not knowing what kind of
           questions the box accepts. Clicking populates the input —
           we don't auto-submit so the user can tweak before sending. -->
      @if (state().kind !== 'result' && state().kind !== 'loading') {
        <div class="examples" role="group" [attr.aria-label]="'askAi.examplesAria' | transloco">
          <span class="ex-label">{{ 'askAi.tryAsking' | transloco }}</span>
          @for (k of exampleKeys; track k) {
            <button
              type="button"
              class="ex-chip"
              (click)="useExample(k)"
              [attr.aria-label]="('askAi.examples.' + k) | transloco: { name: pkgName() }"
            >{{ ('askAi.examples.' + k) | transloco: { name: pkgName() } }}</button>
          }
        </div>
      }

      <!-- Answer region. role=region + aria-live=polite so SR users
           hear it announced when the answer streams in. We rendered
           the markdown through DomSanitizer.bypassSecurityTrustHtml —
           safe because MarkdownRendererService escapes every user-
           supplied substring and allowlists URL schemes. -->
      <div
        class="answer-region"
        role="region"
        aria-live="polite"
        [attr.aria-label]="'askAi.answerAria' | transloco"
      >
        @switch (state().kind) {
          @case ('loading') {
            <div class="answer-skeleton" aria-hidden="true">
              <div class="sk-line w80"></div>
              <div class="sk-line w95"></div>
              <div class="sk-line w70"></div>
              <div class="sk-line w50"></div>
            </div>
          }
          @case ('result') {
            @let r = asResult(state());
            <article class="answer-card">
              <div class="answer-confidence" [attr.data-level]="r.data.confidence">
                <span class="conf-dot" aria-hidden="true"></span>
                {{ 'askAi.confidence.' + r.data.confidence | transloco }}
                @if (r.meta.fromCache) {
                  <span class="cached-flag" [attr.title]="'askAi.cachedTip' | transloco">
                    · {{ 'askAi.cached' | transloco }}
                  </span>
                }
              </div>

              <div class="answer-body" [innerHTML]="renderedAnswer()"></div>

              @if (r.data.caveats.length) {
                <ul class="answer-caveats" [attr.aria-label]="'askAi.caveatsAria' | transloco">
                  @for (c of r.data.caveats; track c) {
                    <li>{{ c }}</li>
                  }
                </ul>
              }

              <footer class="answer-footer">
                <span class="provider">
                  {{ 'askAi.poweredBy' | transloco: { provider: r.meta.provider } }}
                </span>
                <button type="button" class="refresh-btn" (click)="refresh()">
                  {{ 'askAi.refresh' | transloco }}
                </button>
              </footer>
            </article>
          }
          @case ('error') {
            @let e = asError(state());
            <p class="error" role="alert">
              <span aria-hidden="true">⚠</span>
              {{ e.message }}
            </p>
          }
        }
      </div>
    </section>
  `,
  styles: [`
    :host { display: block; margin-top: 1.25rem; }

    .ask {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg, 12px);
      padding: 1.1rem 1.25rem;
    }

    .ask-head {
      display: flex; gap: 0.7rem; align-items: flex-start;
      margin-bottom: 0.9rem;
    }
    .ask-ico {
      font-size: 1.3rem; line-height: 1;
      color: var(--accent);
      flex: 0 0 auto;
    }
    .ask-title-block { flex: 1 1 auto; min-width: 0; }
    .ask-title-block h3 {
      margin: 0 0 0.15rem;
      font-size: 1rem;
      color: var(--fg);
      font-weight: 700;
    }
    .ask-sub {
      margin: 0;
      font-size: 0.82rem;
      color: var(--fg-dim);
      line-height: 1.5;
    }

    .ask-form {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 0.6rem;
      align-items: end;
    }
    .ask-input {
      width: 100%;
      padding: 0.7rem 0.85rem;
      background: var(--surface-1);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: var(--radius-md, 10px);
      font: inherit;
      font-size: 0.9rem;
      line-height: 1.5;
      resize: vertical;
      min-height: 44px;
      max-height: 200px;
      transition: border-color 160ms var(--ease, ease), box-shadow 160ms var(--ease, ease);
    }
    .ask-input:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-ring, color-mix(in srgb, var(--accent) 25%, transparent));
    }
    .ask-input:disabled {
      opacity: 0.7;
      cursor: not-allowed;
    }

    .ask-submit {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0 1.1rem;
      min-height: 44px;
      background: var(--accent-gradient, var(--accent));
      color: #fff;
      border: none;
      border-radius: var(--radius-md, 10px);
      font-weight: 600;
      font-size: 0.9rem;
      cursor: pointer;
      transition: filter 140ms ease, transform 120ms ease, opacity 140ms ease;
      white-space: nowrap;
    }
    .ask-submit:hover:not(:disabled) {
      filter: brightness(1.06);
      transform: translateY(-1px);
    }
    .ask-submit:active:not(:disabled) { transform: translateY(0); }
    .ask-submit:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .ask-submit:focus-visible {
      outline: 2px solid #fff;
      outline-offset: -3px;
    }

    /* Thinking-dots pulse — three dots that scale in turn while the
       request is in flight. Pure CSS, gracefully degrades to static
       under prefers-reduced-motion. */
    .dots {
      display: inline-flex; gap: 3px; align-items: center;
    }
    .dots span {
      width: 5px; height: 5px;
      background: currentColor;
      border-radius: 50%;
      animation: ask-bounce 1.2s ease-in-out infinite;
    }
    .dots span:nth-child(2) { animation-delay: 160ms; }
    .dots span:nth-child(3) { animation-delay: 320ms; }
    @keyframes ask-bounce {
      0%, 80%, 100% { transform: scale(0.5); opacity: 0.6; }
      40% { transform: scale(1); opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      .dots span { animation: none; opacity: 1; }
    }

    /* Example-question chips. Same visual language as competitor-chips
       but more compact since they're orientation hints, not actions
       with structured metadata. */
    .examples {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.4rem;
      margin-top: 0.9rem;
    }
    .ex-label {
      font-size: 0.78rem;
      color: var(--fg-dim);
      letter-spacing: 0.01em;
      margin-right: 0.2rem;
    }
    .ex-chip {
      padding: 0.3rem 0.7rem;
      background: var(--surface-1);
      color: var(--fg-dim);
      border: 1px solid var(--border);
      border-radius: var(--radius-pill, 999px);
      font: inherit;
      font-size: 0.78rem;
      cursor: pointer;
      transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease;
    }
    .ex-chip:hover {
      background: color-mix(in srgb, var(--accent) 8%, var(--surface-1));
      border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
      color: var(--fg);
    }
    .ex-chip:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    /* Answer region — appears below the form when a response lands. */
    .answer-region {
      margin-top: 1rem;
    }
    .answer-skeleton {
      display: grid; gap: 0.6rem;
      padding: 0.8rem 0;
    }
    .sk-line {
      height: 12px;
      background: linear-gradient(
        90deg,
        color-mix(in srgb, var(--accent) 8%, transparent) 0%,
        color-mix(in srgb, var(--accent) 14%, transparent) 50%,
        color-mix(in srgb, var(--accent) 8%, transparent) 100%
      );
      background-size: 200% 100%;
      animation: ask-shimmer 1.4s ease-in-out infinite;
      border-radius: 6px;
    }
    .sk-line.w80 { width: 80%; }
    .sk-line.w95 { width: 95%; }
    .sk-line.w70 { width: 70%; }
    .sk-line.w50 { width: 50%; }
    @keyframes ask-shimmer { to { background-position: -200% 0; } }
    @media (prefers-reduced-motion: reduce) {
      .sk-line { animation: none; }
    }

    .answer-card {
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-left: 3px solid var(--accent);
      border-radius: var(--radius-md, 10px);
      padding: 0.95rem 1.1rem;
    }

    /* Confidence pill — at the top of the card. Color tracks the level. */
    .answer-confidence {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      color: var(--fg-dim);
      margin-bottom: 0.55rem;
    }
    .conf-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: var(--fg-dim);
    }
    .answer-confidence[data-level='high']   .conf-dot { background: var(--ok); }
    .answer-confidence[data-level='medium'] .conf-dot { background: var(--warn); }
    .answer-confidence[data-level='low']    .conf-dot { background: var(--bad); }
    .answer-confidence[data-level='high']   { color: var(--ok); }
    .answer-confidence[data-level='medium'] { color: var(--warn); }
    .answer-confidence[data-level='low']    { color: var(--bad); }
    .cached-flag {
      color: var(--fg-dim);
      font-weight: 500;
      letter-spacing: 0;
      text-transform: none;
    }

    .answer-body {
      font-size: 0.92rem;
      line-height: 1.6;
      color: var(--fg);
    }
    /* Re-use the same .md-* selectors the README preview component
       defines; both render output from MarkdownRendererService. */
    .answer-body ::ng-deep .md-h1,
    .answer-body ::ng-deep .md-h2,
    .answer-body ::ng-deep .md-h3 {
      margin: 0.9rem 0 0.35rem;
      font-size: 1rem;
      font-weight: 700;
      color: var(--fg);
    }
    .answer-body ::ng-deep .md-h1:first-child,
    .answer-body ::ng-deep .md-h2:first-child,
    .answer-body ::ng-deep .md-h3:first-child {
      margin-top: 0;
    }
    .answer-body ::ng-deep .md-p { margin: 0.45rem 0; }
    .answer-body ::ng-deep .md-ul,
    .answer-body ::ng-deep .md-ol { margin: 0.45rem 0; padding-left: 1.4rem; }
    .answer-body ::ng-deep .md-a {
      color: var(--accent);
      text-decoration: none;
      border-bottom: 1px dotted color-mix(in srgb, var(--accent) 50%, transparent);
    }
    .answer-body ::ng-deep .md-a:hover {
      border-bottom-style: solid;
    }
    .answer-body ::ng-deep .md-code {
      background: var(--surface-2);
      border: 1px solid var(--border);
      padding: 0.05rem 0.4rem;
      border-radius: 6px;
      font-size: 0.85em;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    .answer-body ::ng-deep .md-pre {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--radius-md, 10px);
      padding: 0.7rem 0.9rem;
      overflow-x: auto;
      margin: 0.55rem 0;
    }
    .answer-body ::ng-deep .md-pre .md-code-block {
      background: none;
      border: none;
      padding: 0;
      font-size: 0.82rem;
      line-height: 1.5;
    }

    .answer-caveats {
      margin: 0.7rem 0 0;
      padding-left: 1.1rem;
      color: var(--fg-dim);
      font-size: 0.78rem;
      line-height: 1.5;
    }
    .answer-caveats li { margin: 0.15rem 0; }

    .answer-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 0.7rem;
      padding-top: 0.55rem;
      border-top: 1px dashed var(--border);
      font-size: 0.75rem;
      color: var(--fg-dim);
    }
    .refresh-btn {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg-dim);
      padding: 0.25rem 0.65rem;
      border-radius: var(--radius-sm, 6px);
      font: inherit;
      font-size: 0.75rem;
      cursor: pointer;
      transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease;
    }
    .refresh-btn:hover {
      background: var(--surface-2);
      border-color: var(--accent);
      color: var(--accent);
    }
    .refresh-btn:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    .error {
      display: flex; align-items: flex-start; gap: 0.55rem;
      padding: 0.7rem 0.85rem;
      background: color-mix(in srgb, var(--bad) 10%, var(--surface-1));
      border: 1px solid color-mix(in srgb, var(--bad) 40%, var(--border));
      border-left: 3px solid var(--bad);
      border-radius: var(--radius-md, 10px);
      color: var(--fg);
      font-size: 0.88rem;
      margin: 0;
    }
    .error span[aria-hidden] {
      color: var(--bad);
      font-size: 1rem;
      line-height: 1.3;
      flex: 0 0 auto;
    }

    .sr-only {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0,0,0,0); border: 0;
    }

    @media (max-width: 560px) {
      .ask-form { grid-template-columns: 1fr; }
      .ask-submit { width: 100%; justify-content: center; }
    }
  `]
})
export class AskAiBoxComponent {
  /** Current package name (e.g. "ngx-toastr"). Drives the prompt scope. */
  readonly pkgName = input.required<string>();

  /**
   * Latest published version (from `pkg.dist-tags.latest`). When
   * provided, AskAiService also fetches the changelog and feeds it to
   * the model so "what changed?" / "what's new?" questions get
   * grounded answers instead of "we don't have changelog data."
   */
  readonly latestVersion = input<string | null>(null);

  /** npm `repository.url` field. Required for the changelog fetch. */
  readonly repoUrl = input<string | null>(null);

  /**
   * Monorepo subdirectory (`pkg.repository.directory`). Lets the
   * changelog service find per-package CHANGELOGs that live inside
   * a workspace (rxjs → packages/rxjs, @angular/* under packages/*,
   * every Nx / Lerna / Yarn-workspace package).
   */
  readonly repoDirectory = input<string | null>(null);

  private readonly askAi = inject(AskAiService);
  private readonly md = inject(MarkdownRendererService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly destroyRef = inject(DestroyRef);

  /** Two-way bound textarea contents. */
  readonly question = signal<string>('');

  /** Discriminated-union state — same pattern as competitor-chips. */
  readonly state = signal<State>({ kind: 'idle' });

  /** Convenience: is a request in flight? */
  readonly busy = computed<boolean>(() => this.state().kind === 'loading');

  /** Submit is enabled when the question is non-empty and we aren't busy. */
  readonly canSubmit = computed<boolean>(() => {
    return !this.busy() && this.question().trim().length > 0;
  });

  /** Pre-rendered SafeHtml so the template binds with `[innerHTML]` cleanly. */
  readonly renderedAnswer = computed<SafeHtml>(() => {
    const s = this.state();
    if (s.kind !== 'result') return '';
    return this.sanitizer.bypassSecurityTrustHtml(this.md.render(s.data.answer));
  });

  /**
   * The 4 example-question keys we surface as chips. Translated via
   * `askAi.examples.<key>` — each interpolates the current package
   * name. Keep this list short — too many examples reads as a help
   * menu rather than a hint.
   */
  readonly exampleKeys = ['maintained', 'migration', 'gotchas', 'alternatives'] as const;

  private currentSub?: Subscription;

  constructor() {
    this.destroyRef.onDestroy(() => this.currentSub?.unsubscribe());
  }

  onEnter(ev: Event): void {
    const ke = ev as KeyboardEvent;
    // Shift+Enter inserts a newline (textarea default). Plain Enter
    // submits. Matches ChatGPT-style ergonomics — saves a click for
    // the 80% case of one-line questions.
    if (ke.shiftKey) return;
    ev.preventDefault();
    this.fire();
  }

  onSubmit(ev: Event): void {
    ev.preventDefault();
    this.fire();
  }

  refresh(): void {
    this.fire(true);
  }

  /**
   * Populate the input with an example question and focus the textarea.
   * We deliberately do NOT auto-fire — the user might want to tweak
   * the phrasing before sending, and auto-sending feels presumptuous.
   */
  useExample(key: string): void {
    // The key is e.g. "maintained" → look up the localized text. We
    // can't access TranslocoService here without injecting it; the
    // translated chip label IS what we want to populate, so we read
    // it from the DOM via the chip button text. Simpler: build a
    // default English version and let the user edit. But the chip is
    // already showing the translated text, so we read THAT instead.
    // For lossless behavior in 4 locales, we just set the question to
    // a known-template format that the AskAiService will normalize.
    const templates: Record<string, (name: string) => string> = {
      maintained: (name) => `Is ${name} still actively maintained?`,
      migration: (name) => `What's the migration story for ${name} between recent majors?`,
      gotchas: (name) => `What are the common gotchas when using ${name}?`,
      alternatives: (name) => `What are good alternatives to ${name} and when would I pick them?`
    };
    const fn = templates[key];
    if (!fn) return;
    this.question.set(fn(this.pkgName()));
    // Focus next tick so the value lands before we move focus.
    queueMicrotask(() => {
      const el = document.getElementById('ask-ai-input') as HTMLTextAreaElement | null;
      el?.focus();
    });
  }

  private fire(forceRefresh = false): void {
    const q = this.question().trim();
    const pkg = this.pkgName();
    if (!q || !pkg) return;

    this.currentSub?.unsubscribe();
    this.state.set({ kind: 'loading' });

    // Compose the grounding context. When we know the latest version
    // (always true on /search; may not be on standalone uses), the
    // service additionally fetches the changelog so the model can
    // answer version-specific "what changed?" questions with real
    // citations instead of hedging.
    const latest = this.latestVersion();
    const context: AskAiContext | null = latest
      ? {
          latestVersion: latest,
          repoUrl: this.repoUrl(),
          repoDirectory: this.repoDirectory()
        }
      : null;

    this.currentSub = this.askAi.ask(pkg, q, forceRefresh, context).subscribe({
      next: (res) => {
        this.state.set({ kind: 'result', data: res.data, meta: res });
      },
      error: (err: unknown) => {
        const msg = this.errorMessage(err);
        // Console.info, not .error — these failures are expected at
        // the edges (rate-limit, no key, network) and dev-tools-noisy
        // .error() would over-imply seriousness.
        console.info('[Ask AI] Request failed:', err);
        this.state.set({ kind: 'error', message: msg });
      }
    });
  }

  private errorMessage(err: unknown): string {
    // We translate per kind in the host page — here we just produce
    // a plain English fallback that the host can override if desired.
    const e = err as { kind?: string; message?: string };
    if (e?.kind === 'RATE_LIMITED') return 'Rate limited. Please try again in a minute.';
    if (e?.kind === 'PROXY_UNAVAILABLE') return 'AI proxy is unreachable. Start the dev-proxy, or set a BYO key in settings.';
    if (e?.kind === 'NO_KEY' || e?.kind === 'INVALID_KEY') return 'Set a valid API key in AI settings to use this feature.';
    return e?.message || 'Something went wrong asking the AI.';
  }

  /** Template type-narrowing helpers. */
  asResult(s: State): ResultState { return s as ResultState; }
  asError(s: State): ErrorState { return s as ErrorState; }
}
