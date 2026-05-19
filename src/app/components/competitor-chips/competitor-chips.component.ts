import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslocoModule } from '@jsverse/transloco';
import { Subscription } from 'rxjs';

import { CompetitorSuggestionsService } from '../../services/ai/competitor-suggestions.service';
import {
  Competitor,
  CompetitorsResponse
} from '../../services/ai/schemas/competitors.schema';

/**
 * AI-suggested competitor chips (Feature 3).
 *
 * Renders zero, one, or three small clickable chips below an input
 * field, each suggesting a package the user might want to compare
 * against. Clicking a chip emits `picked` with the name — the host
 * component decides what to do with that (typically: populate the
 * sibling input and kick off the fetch).
 *
 * # Render gating
 *
 * Three signals decide what renders:
 *   - `targetPackage` — the package to find competitors FOR (the
 *     OPPOSITE input's value, e.g. nameA when this strip is under
 *     input B). Empty string → nothing renders.
 *   - `siblingValue` — the value of the input this strip sits under,
 *     i.e. the one we'd populate when clicked. Non-empty string →
 *     nothing renders, because the user has already made their choice.
 *   - internal `state` — idle / loading / result / error.
 *
 * The combination produces this UX:
 *   1. User picks A → strip under B starts fetching → shows
 *      "AI is thinking..." for ~3s → renders 3 chips.
 *   2. User types in B → chips instantly hide (sibling has value now).
 *   3. User clears B → chips reappear from cache instantly (no API call).
 *   4. User picks a different A → fresh fetch triggered, chips replace.
 *
 * # Silent error model
 *
 * Suggestions are "nice to have" — never user-facing on failure.
 * On error, we render NOTHING (not a toast, not an error chip, not
 * a retry button). Devs see the error in DevTools console via the
 * service's catchError, which is sufficient.
 */
@Component({
  selector: 'app-competitor-chips',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TranslocoModule],
  template: `
    <!-- Outer wrap renders only when there's something meaningful to
         show, so we keep zero layout footprint in the dormant case
         (most page loads will land in this branch — no Package A yet). -->
    @if (visible()) {
      <div class="cc-strip" role="group" [attr.aria-label]="'competitors.ariaLabel' | transloco">
        @switch (state().kind) {
          @case ('loading') {
            <span class="cc-thinking" role="status">
              <span class="cc-sparkle" aria-hidden="true">✨</span>
              {{ 'competitors.thinking' | transloco }}
            </span>
          }
          @case ('result') {
            @let r = asResult(state());
            <!-- Two-row layout: the label is "context" (informational)
                 and the chips are "actions" (interactive). Mixing them
                 on one flex row makes the third chip wrap awkwardly
                 onto its own line — which reads as "different" when
                 it's actually equal. Splitting label-above / chips-
                 below mirrors the form-field pattern (label on top,
                 control below) and groups the three chips visually
                 as one cohesive set of options. -->
            <span class="cc-label">
              {{ 'competitors.title' | transloco: { name: targetPackage() } }}
            </span>
            <div class="cc-chips-row">
              @for (c of r.data.competitors; track c.name) {
                <!-- Two-line chip — name on top, reason on the dimmed
                     second line. Always visible (no hover, no tap-to-
                     reveal) because: 1) native title tooltips are slow
                     and OS-themed (breaks dark mode), 2) touch devices
                     have no hover, 3) the reason field is the AI's
                     actual value-add — hiding it behind any interaction
                     undersells the feature. aria-label combines both
                     for screen readers. -->
                <button
                  type="button"
                  class="cc-chip"
                  [attr.aria-label]="c.name + ' — ' + c.reason"
                  (click)="pick(c.name)"
                >
                  <span class="cc-chip-name">
                    <span class="cc-sparkle" aria-hidden="true">✨</span>
                    {{ c.name }}
                  </span>
                  <span class="cc-chip-reason">{{ c.reason }}</span>
                </button>
              }
            </div>
          }
        }
      </div>
    }
  `,
  styles: [`
    :host { display: block; }

    /* Strip is a vertical container: label on top, then chips row
       (or loading pill) below. Switching from a single wrap-flex row
       to a column-stack avoids the awkward "label + 2 chips on row 1,
       3rd chip wraps alone to row 2" pattern that read as accidental.
       Now context and action live on separate visual planes. */
    .cc-strip {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 0.5rem;
      margin-top: 0.4rem;
    }

    /* Section label — small, dim, sits alone on its own line as
       orientation for the chips that follow ("here come alternatives
       to X"). Slightly larger than before because it no longer has to
       share a row with chips and can afford a bit more presence. */
    .cc-label {
      font-size: 0.76rem;
      color: var(--fg-dim, #64748b);
      letter-spacing: 0.01em;
    }

    /* Chips row — separate flex container so the three chips wrap
       together as a single visual group, independent of the label
       above. They stay grouped at narrow widths instead of having
       the label steal space from them. */
    .cc-chips-row {
      display: flex;
      flex-wrap: wrap;
      align-items: stretch;
      gap: 0.4rem;
    }

    /* Thinking placeholder — shimmer pill that occupies roughly the
       same vertical space as the final chips so when results land we
       don't get a layout shift. */
    .cc-thinking {
      display: inline-flex; align-items: center; gap: 0.35rem;
      padding: 0.25rem 0.65rem;
      border-radius: var(--radius-pill, 999px);
      background: linear-gradient(
        90deg,
        color-mix(in srgb, var(--accent) 8%, transparent) 0%,
        color-mix(in srgb, var(--accent) 14%, transparent) 50%,
        color-mix(in srgb, var(--accent) 8%, transparent) 100%
      );
      background-size: 200% 100%;
      animation: cc-shimmer 1.4s ease-in-out infinite;
      color: var(--fg-dim, #64748b);
      font-size: 0.78rem;
      font-style: italic;
    }
    @keyframes cc-shimmer { to { background-position: -200% 0; } }
    @media (prefers-reduced-motion: reduce) {
      .cc-thinking { animation: none; }
    }

    /* The chip itself — two-line affordance with name on top and the
       AI's reason on a smaller dimmed second line. Designed to read
       as "AI suggestion" via the sparkle prefix + accent-tinted
       border. Border-radius is a rounded rectangle (not full pill)
       because pills look awkward with stacked multi-line content. */
    .cc-chip {
      display: inline-flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      padding: 0.45rem 0.8rem;
      border-radius: var(--radius-md, 10px);
      border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border, #e5e7eb));
      background: color-mix(in srgb, var(--accent) 6%, var(--surface-1, #fff));
      color: var(--fg, #0f172a);
      font: inherit;
      cursor: pointer;
      text-align: left;
      max-width: 280px;
      transition: border-color 140ms ease, background 140ms ease, transform 100ms ease;
    }
    .cc-chip:hover {
      border-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 12%, var(--surface-1, #fff));
      transform: translateY(-1px);
    }
    .cc-chip:active { transform: translateY(0); }
    .cc-chip:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    /* Top line: sparkle + package name. Bold enough to read as the
       primary action target, sized to match nearby UI text. */
    .cc-chip-name {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      font-size: 0.85rem;
      font-weight: 600;
      line-height: 1.2;
      color: var(--fg, #0f172a);
    }

    /* Second line: the AI's reason. Smaller and dimmed so it reads
       as context, not equal-weight to the action. Uses dim foreground
       token which is theme-aware (dark/light). Ellipsis on overflow
       at the chip's max-width so very long reasons don't break the
       grid — the full text is still in the accessible name. */
    .cc-chip-reason {
      font-size: 0.72rem;
      font-weight: 400;
      line-height: 1.35;
      color: var(--fg-dim, #64748b);
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Sparkle emoji — slightly smaller than the name text to read as
       a prefix decoration rather than an equal-weight icon. */
    .cc-sparkle {
      font-size: 0.85em;
      line-height: 1;
    }
  `]
})
export class CompetitorChipsComponent {
  private readonly service = inject(CompetitorSuggestionsService);
  private readonly destroyRef = inject(DestroyRef);

  /** Package whose competitors we want — typically the OPPOSITE input's value. */
  readonly targetPackage = input<string>('');

  /**
   * Current value of the input this strip sits UNDER (the one we'd
   * populate when a chip is clicked). When non-empty, chips hide
   * because the user has already made their choice.
   */
  readonly siblingValue = input<string>('');

  /** Fires the chosen package name when the user clicks a chip. */
  readonly picked = output<string>();

  /** Discriminated-union state mirrors the AI panel pattern. */
  readonly state = signal<State>({ kind: 'idle' });

  /**
   * Whether the strip is rendered at all. False when there's no
   * target package (nothing to suggest competitors for), or when
   * the sibling input already has a value (user has chosen), or
   * when the state is idle/error.
   */
  readonly visible = computed(() => {
    const target = this.targetPackage().trim();
    const sibling = this.siblingValue().trim();
    if (!target || sibling) return false;
    const kind = this.state().kind;
    return kind === 'loading' || kind === 'result';
  });

  /**
   * In-flight subscription — tracked so a fresh `targetPackage`
   * change can cancel the previous fetch. Without this, rapid A-input
   * changes would leak overlapping requests and the last response
   * to arrive (not the latest one fired) would win on the UI.
   */
  private current?: Subscription;

  constructor() {
    // Fetch whenever the target package changes to a non-empty value.
    // We do NOT gate on siblingValue here: prefetching even when the
    // sibling is filled is fine because the cache layer will serve
    // L1 instantly on the next user clear-then-look. Only the
    // VISIBILITY gates on siblingValue.
    effect(() => {
      const target = this.targetPackage().trim();
      this.current?.unsubscribe();
      if (!target) {
        this.state.set({ kind: 'idle' });
        return;
      }
      this.state.set({ kind: 'loading' });
      this.current = this.service.suggest(target).subscribe({
        next: (res) => {
          // Defensive: orchestrator already sanitizes to ≤3 and drops
          // target-echoes, but if for some reason we got 0 useful
          // chips back, fall through to error (renders nothing).
          if (!res.data.competitors.length) {
            this.state.set({ kind: 'error' });
            return;
          }
          this.state.set({ kind: 'result', data: res.data });
        },
        error: (err) => {
          // Console.info, not .error — these failures are expected
          // (rate limits, provider down, model returned malformed
          // output) and don't warrant a noisy red entry. The user-
          // facing behaviour is "no chips" which speaks for itself.
          console.info(
            '[Competitor chips] Failed to fetch suggestions; rendering nothing.',
            err
          );
          this.state.set({ kind: 'error' });
        }
      });
    });

    // Clean up any pending request when the component is destroyed,
    // e.g. navigating away from /compare mid-fetch.
    this.destroyRef.onDestroy(() => this.current?.unsubscribe());
  }

  /** Emit when the user clicks a chip. The host wires this to its picker. */
  pick(name: string): void {
    this.picked.emit(name);
  }

  /** Template helper: narrow PanelState to ResultState. */
  asResult(s: State): ResultState {
    return s as ResultState;
  }
}

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

interface IdleState { kind: 'idle'; }
interface LoadingState { kind: 'loading'; }
interface ResultState {
  kind: 'result';
  data: CompetitorsResponse;
}
interface ErrorState { kind: 'error'; }
type State = IdleState | LoadingState | ResultState | ErrorState;

// Re-export so the host page can import the type if it ever needs to.
export type { Competitor };
