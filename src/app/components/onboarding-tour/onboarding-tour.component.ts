import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  HostListener,
  PLATFORM_ID,
  computed,
  effect,
  inject,
  signal
} from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { TranslocoModule } from '@jsverse/transloco';
import { OnboardingService } from '../../services/onboarding.service';

interface SpotlightRect {
  top: number; left: number; width: number; height: number;
}

/**
 * Guided first-run overlay.
 *
 * Renders a full-viewport SVG mask that punches a rounded-rect "hole" over the
 * current step's target element, a tooltip positioned next to the hole, and
 * Back / Skip / Next controls. The geometry recomputes on every scroll and
 * resize, and uses requestAnimationFrame to stay smooth.
 *
 * i18n: each step reads its title and body from `onboarding.steps.<id>.title`
 * and `onboarding.steps.<id>.body` translation keys.
 */
@Component({
  selector: 'app-onboarding-tour',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TranslocoModule],
  template: `
    @if (onboarding.running() && onboarding.current()) {
      <div class="ob-root" role="dialog" aria-modal="true"
           [attr.aria-label]="'onboarding.title' | transloco">

        <svg class="ob-mask" aria-hidden="true">
          <defs>
            <mask id="ob-cutout">
              <rect width="100%" height="100%" fill="white"/>
              @if (rect()) {
                <rect
                  [attr.x]="rect()!.left - 8"
                  [attr.y]="rect()!.top - 8"
                  [attr.width]="rect()!.width + 16"
                  [attr.height]="rect()!.height + 16"
                  rx="10" ry="10"
                  fill="black"/>
              }
            </mask>
          </defs>
          <rect width="100%" height="100%" fill="rgba(15,23,42,0.62)" mask="url(#ob-cutout)"/>
          @if (rect()) {
            <rect
              class="ob-ring"
              [attr.x]="rect()!.left - 8"
              [attr.y]="rect()!.top - 8"
              [attr.width]="rect()!.width + 16"
              [attr.height]="rect()!.height + 16"
              rx="10" ry="10"
              fill="none"/>
          }
        </svg>

        <div class="ob-tip"
             [style.top.px]="tipPos().top"
             [style.left.px]="tipPos().left"
             [class.centered]="!rect()">
          <div class="ob-step">{{ stepLabel() }}</div>
          <h3 class="ob-title">{{ titleKey() | transloco }}</h3>
          <p class="ob-body">{{ bodyKey() | transloco }}</p>
          <div class="ob-actions">
            <button type="button" class="ob-skip" (click)="skip()">
              {{ 'onboarding.skip' | transloco }}
            </button>
            <div class="ob-nav">
              @if (!onboarding.isFirst()) {
                <button type="button" class="ob-prev" (click)="prev()">
                  {{ 'onboarding.back' | transloco }}
                </button>
              }
              <button type="button" class="ob-next" (click)="next()">
                {{ (onboarding.isLast() ? 'onboarding.done' : 'onboarding.next') | transloco }}
              </button>
            </div>
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    `
      :host { display: contents; }
      .ob-root {
        position: fixed; inset: 0;
        z-index: 90;
        pointer-events: auto;
        animation: fade-in 0.18s ease-out;
      }
      @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
      body.reduced-motion .ob-root { animation: none; }

      .ob-mask {
        position: absolute; inset: 0;
        width: 100%; height: 100%;
      }
      .ob-ring {
        stroke: var(--accent, #6366f1);
        stroke-width: 2;
        filter: drop-shadow(0 0 8px rgba(99,102,241,0.55));
      }

      .ob-tip {
        position: absolute;
        width: min(340px, 92vw);
        background: var(--surface-1, #fff);
        color: var(--fg, #111);
        border: 1px solid var(--border, #e5e7eb);
        border-radius: 14px;
        padding: 1rem 1.1rem;
        box-shadow: 0 24px 48px rgba(0,0,0,0.28);
        pointer-events: auto;
      }
      .ob-tip.centered {
        top: 50% !important;
        left: 50% !important;
        transform: translate(-50%, -50%);
      }
      .ob-step {
        font-size: 0.72rem;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--accent, #6366f1);
        font-weight: 700;
        margin-bottom: 0.25rem;
      }
      .ob-title { margin: 0 0 0.35rem; font-size: 1.05rem; }
      .ob-body { margin: 0 0 0.85rem; color: var(--fg-dim, #555); font-size: 0.9rem; line-height: 1.5; }

      .ob-actions { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
      .ob-nav { display: flex; gap: 0.4rem; }
      .ob-skip {
        background: transparent;
        border: none;
        color: var(--fg-dim, #777);
        cursor: pointer;
        font-size: 0.82rem;
        text-decoration: underline;
      }
      .ob-prev, .ob-next {
        border: 1px solid var(--border, #e5e7eb);
        background: var(--surface-2, #f9fafb);
        color: var(--fg, #111);
        border-radius: 8px;
        padding: 0.4rem 0.85rem;
        font-size: 0.85rem;
        cursor: pointer;
      }
      .ob-next {
        background: var(--accent, #6366f1);
        border-color: var(--accent, #6366f1);
        color: #fff;
      }
      .ob-next:hover { filter: brightness(1.07); }
    `
  ]
})
export class OnboardingTourComponent implements AfterViewInit {
  protected readonly onboarding = inject(OnboardingService);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly destroyRef = inject(DestroyRef);

  /** Rect of the currently-highlighted element (null when step is centered). */
  readonly rect = signal<SpotlightRect | null>(null);

  private rafHandle = 0;

  readonly stepLabel = computed(() => {
    const total = this.onboarding.steps().length;
    const i = this.onboarding.stepIndex() + 1;
    return `${i} / ${total}`;
  });

  readonly titleKey = computed(() => {
    const c = this.onboarding.current();
    return c ? `onboarding.steps.${c.id}.title` : '';
  });

  readonly bodyKey = computed(() => {
    const c = this.onboarding.current();
    return c ? `onboarding.steps.${c.id}.body` : '';
  });

  readonly tipPos = computed(() => {
    const r = this.rect();
    if (!r) return { top: 0, left: 0 };
    const step = this.onboarding.current();
    const placement = step?.placement ?? 'bottom';
    const gap = 18;
    const tipW = Math.min(340, typeof window !== 'undefined' ? window.innerWidth * 0.92 : 340);
    const tipH = 180; // estimated — browser corrects via transform when clipped
    let top = 0, left = 0;
    switch (placement) {
      case 'top':
        top = r.top - tipH - gap;
        left = r.left + (r.width - tipW) / 2;
        break;
      case 'start':
        top = r.top + (r.height - tipH) / 2;
        left = r.left - tipW - gap;
        break;
      case 'end':
        top = r.top + (r.height - tipH) / 2;
        left = r.left + r.width + gap;
        break;
      case 'center':
        top = 0; left = 0;
        break;
      case 'bottom':
      default:
        top = r.top + r.height + gap;
        left = r.left + (r.width - tipW) / 2;
    }
    // Clamp to viewport
    if (typeof window !== 'undefined') {
      top = Math.max(12, Math.min(window.innerHeight - tipH - 12, top));
      left = Math.max(12, Math.min(window.innerWidth - tipW - 12, left));
    }
    return { top, left };
  });

  constructor() {
    // Recompute rect whenever the step changes.
    effect(() => {
      // Track the current step signal.
      const _ = this.onboarding.current();
      if (!this.isBrowser) return;
      this.scheduleMeasure();
    });
  }

  ngAfterViewInit(): void {
    if (!this.isBrowser) return;
    this.scheduleMeasure();
  }

  @HostListener('window:resize')
  @HostListener('window:scroll')
  onViewportChange(): void {
    if (!this.isBrowser || !this.onboarding.running()) return;
    this.scheduleMeasure();
  }

  @HostListener('window:keydown', ['$event'])
  onKey(ev: KeyboardEvent): void {
    if (!this.onboarding.running()) return;
    if (ev.key === 'Escape') { this.skip(); ev.preventDefault(); return; }
    if (ev.key === 'ArrowRight' || ev.key === 'Enter') { this.next(); ev.preventDefault(); return; }
    if (ev.key === 'ArrowLeft') { this.prev(); ev.preventDefault(); return; }
  }

  next(): void { this.onboarding.next(); }
  prev(): void { this.onboarding.prev(); }
  skip(): void { this.onboarding.skip(); }

  private scheduleMeasure(): void {
    if (!this.isBrowser) return;
    cancelAnimationFrame(this.rafHandle);
    this.rafHandle = requestAnimationFrame(() => this.measure());
  }

  private measure(): void {
    const step = this.onboarding.current();
    if (!step || !step.target) { this.rect.set(null); return; }
    const el = document.querySelector<HTMLElement>(step.target);
    if (!el) {
      // Target not mounted — fall back to centered mode rather than blocking the tour.
      this.rect.set(null);
      return;
    }
    // Scroll into view so the spotlight is visible.
    const r = el.getBoundingClientRect();
    const offscreen = r.top < 0 || r.bottom > window.innerHeight
      || r.left < 0 || r.right > window.innerWidth;
    if (offscreen) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      // Re-measure after the scroll settles.
      setTimeout(() => {
        const rr = el.getBoundingClientRect();
        this.rect.set({ top: rr.top, left: rr.left, width: rr.width, height: rr.height });
      }, 260);
    } else {
      this.rect.set({ top: r.top, left: r.left, width: r.width, height: r.height });
    }
  }
}
