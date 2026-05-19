import { Injectable, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

export interface OnboardingStep {
  /** Unique id, also used as the transloco key suffix: onboarding.steps.<id>.title / .body. */
  id: string;
  /** CSS selector of the element to highlight. If null, the step is centered. */
  target: string | null;
  /** Preferred tooltip placement relative to the target. */
  placement?: 'top' | 'bottom' | 'start' | 'end' | 'center';
}

const STORAGE_KEY = 'ngpc.onboarding.v1';

/**
 * First-run onboarding tour.
 *
 * A tiny state machine that drives the overlay component: current step index,
 * whether the tour is running, and a localStorage flag so returning users
 * don't see it again. The actual spotlight + tooltip rendering lives in
 * OnboardingTourComponent — this service is deliberately UI-agnostic so it
 * can be driven from anywhere (help menu "Replay tour", deep link, Cypress).
 */
@Injectable({ providedIn: 'root' })
export class OnboardingService {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** Ordered list of steps shown by the tour. */
  readonly steps = signal<OnboardingStep[]>([
    { id: 'welcome',    target: null,                           placement: 'center' },
    { id: 'search',     target: '[data-tour="search"]',          placement: 'bottom' },
    { id: 'analyze',    target: '[data-tour="analyze"]',         placement: 'bottom' },
    { id: 'upgrade',    target: '[data-tour="upgrade-panel"]',   placement: 'top'    },
    { id: 'preferences', target: '[data-tour="preferences"]',    placement: 'top'    },
    { id: 'shortcuts',  target: '[data-tour="shortcuts"]',       placement: 'top'    }
  ]);

  readonly stepIndex = signal<number>(0);
  readonly running = signal<boolean>(false);

  readonly current = computed<OnboardingStep | null>(() => {
    const list = this.steps();
    const i = this.stepIndex();
    return i >= 0 && i < list.length ? list[i] : null;
  });

  readonly isLast = computed<boolean>(() => this.stepIndex() === this.steps().length - 1);
  readonly isFirst = computed<boolean>(() => this.stepIndex() === 0);

  /** Call on app boot to start the tour if the user hasn't seen it before. */
  maybeAutoStart(): void {
    if (!this.isBrowser) return;
    if (this.hasSeen()) return;
    // Give the rest of the app a chance to render before we try to highlight.
    setTimeout(() => this.start(), 650);
  }

  start(): void {
    this.stepIndex.set(0);
    this.running.set(true);
  }

  next(): void {
    if (this.isLast()) {
      this.complete();
      return;
    }
    this.stepIndex.update((i) => i + 1);
  }

  prev(): void {
    this.stepIndex.update((i) => Math.max(0, i - 1));
  }

  skip(): void {
    this.complete();
  }

  /** Mark the tour as seen and hide the overlay. */
  complete(): void {
    this.running.set(false);
    if (this.isBrowser) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ seenAt: Date.now() })); }
      catch { /* ignore */ }
    }
  }

  /** Re-triggerable from the Help menu; does not touch the seen flag. */
  replay(): void {
    this.start();
  }

  /** Clear the seen flag (mainly for tests/admins). */
  reset(): void {
    if (this.isBrowser) {
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    }
    this.stepIndex.set(0);
    this.running.set(false);
  }

  hasSeen(): boolean {
    if (!this.isBrowser) return true;
    try { return !!localStorage.getItem(STORAGE_KEY); }
    catch { return false; }
  }
}
