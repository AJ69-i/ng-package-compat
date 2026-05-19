import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  untracked
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslocoModule } from '@jsverse/transloco';
import { CelebrationService } from '../../services/celebration.service';
import { ToastService } from '../../services/toast.service';
import { AnnouncerService } from '../../services/announcer.service';

/**
 * Tiny headless component that fires a celebration (confetti + toast +
 * screen-reader announcement) the moment a health score crosses a threshold.
 *
 * Drop it next to your score display:
 *
 *   <app-health-celebration [score]="report().healthScore"/>
 *
 * Will fire once per "cross from below the threshold to ≥ threshold". If the
 * score drops and recovers, it fires again — so users get reinforcement every
 * time they fix the last remaining issue.
 */
@Component({
  selector: 'app-health-celebration',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TranslocoModule],
  template: `<!-- visual side-effects only; nothing to render -->`
})
export class HealthCelebrationComponent {
  readonly score = input<number | null>(null);
  readonly threshold = input<number>(100);
  /** Set to false to silence the toast (the confetti still fires). */
  readonly announce = input<boolean>(true);

  private readonly celebration = inject(CelebrationService);
  private readonly toast = inject(ToastService);
  private readonly announcer = inject(AnnouncerService);

  /** True once we've fired for the current "good" streak. Reset on dip. */
  private armed = true;

  constructor() {
    effect(() => {
      const s = this.score();
      const th = this.threshold();
      if (s === null || s === undefined) return;
      if (s >= th && this.armed) {
        this.armed = false;
        untracked(() => this.fire(s));
      } else if (s < th && !this.armed) {
        // Re-arm when score dips below the threshold.
        this.armed = true;
      }
    });
  }

  private fire(score: number): void {
    this.celebration.celebrate();
    if (!this.announce()) return;
    this.toast.success(`🎉 Perfect health score — ${score}/100!`, { ttl: 5000 });
    this.announcer.say(`Perfect health score reached: ${score} out of 100`, 'assertive');
  }
}
