import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ToastService, Toast } from '../../services/toast.service';
import { SwipeToDismissDirective } from '../../directives/swipe-to-dismiss.directive';

/**
 * Renders all active toasts in a fixed-position stack.
 *
 * Two live regions — `role=status` (aria-live=polite) for success/info/warning
 * and `role=alert` (aria-live=assertive) for errors — so screen readers announce
 * each variant with appropriate urgency without shouting over success messages.
 *
 * The component is deliberately dumb: all state lives in `ToastService`.
 */
@Component({
  selector: 'app-toast-host',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, SwipeToDismissDirective],
  template: `
    <div class="toast-stack" aria-label="Notifications">
      <div class="polite" role="status" aria-live="polite" aria-relevant="additions">
        @for (t of polite(); track t.id) {
          <article class="toast {{ t.variant }}" appSwipeToDismiss (dismissed)="dismiss(t.id)" (click)="dismiss(t.id)">
            <span class="icon" aria-hidden="true">{{ iconFor(t.variant) }}</span>
            <span class="msg">{{ t.message }}</span>
            @if (t.action) {
              <button type="button" class="action" (click)="runAction($event, t)">{{ t.action.label }}</button>
            }
            <button type="button" class="close" aria-label="Dismiss" (click)="dismiss(t.id); $event.stopPropagation()">×</button>
          </article>
        }
      </div>
      <div class="assertive" role="alert" aria-live="assertive" aria-relevant="additions">
        @for (t of assertive(); track t.id) {
          <article class="toast {{ t.variant }}" appSwipeToDismiss (dismissed)="dismiss(t.id)" (click)="dismiss(t.id)">
            <span class="icon" aria-hidden="true">{{ iconFor(t.variant) }}</span>
            <span class="msg">{{ t.message }}</span>
            <button type="button" class="close" aria-label="Dismiss" (click)="dismiss(t.id); $event.stopPropagation()">×</button>
          </article>
        }
      </div>
    </div>
  `,
  styles: [
    `
      :host { display: contents; }
      .toast-stack {
        position: fixed;
        inset-inline-end: 1rem;
        bottom: 1rem;
        z-index: 60;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        pointer-events: none;
        max-width: min(92vw, 420px);
      }
      .toast-stack > div { display: flex; flex-direction: column; gap: 0.5rem; }
      .toast {
        pointer-events: auto;
        display: flex;
        align-items: center;
        gap: 0.6rem;
        padding: 0.65rem 0.85rem 0.65rem 0.75rem;
        border-radius: 12px;
        background: var(--surface-1, #fff);
        border: 1px solid var(--border, #e5e7eb);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.10);
        font-size: 0.9rem;
        color: var(--fg, #111);
        cursor: pointer;
        animation: toast-in 0.24s ease-out;
      }
      @media (prefers-reduced-motion: reduce) {
        .toast { animation: none; }
      }
      @keyframes toast-in {
        from { transform: translateY(14px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
      .icon { font-size: 1.05rem; flex: 0 0 auto; }
      .msg { flex: 1; line-height: 1.35; }
      .action {
        border: none;
        background: transparent;
        color: var(--accent, #6366f1);
        font-weight: 700;
        cursor: pointer;
        font-size: 0.82rem;
      }
      .close {
        border: none;
        background: transparent;
        color: var(--fg-dim, #777);
        font-size: 1.1rem;
        cursor: pointer;
        padding: 0 0.25rem;
        line-height: 1;
      }
      .toast.success { border-color: rgba(15, 157, 88, 0.45); }
      .toast.success .icon { color: #0f9d58; }
      .toast.error   { border-color: rgba(217, 48, 37, 0.5); background: rgba(217,48,37,0.04); }
      .toast.error   .icon { color: #d93025; }
      .toast.warning { border-color: rgba(242, 161, 0, 0.5); }
      .toast.warning .icon { color: #a66c00; }
      .toast.info    { border-color: rgba(99, 102, 241, 0.45); }
      .toast.info    .icon { color: var(--accent, #6366f1); }
    `
  ]
})
export class ToastHostComponent {
  private readonly svc = inject(ToastService);

  readonly polite = () => this.svc.items().filter((t) => t.variant !== 'error');
  readonly assertive = () => this.svc.items().filter((t) => t.variant === 'error');

  dismiss(id: string): void {
    this.svc.dismiss(id);
  }

  runAction(ev: MouseEvent, t: Toast): void {
    ev.stopPropagation();
    t.action?.run();
    this.svc.dismiss(t.id);
  }

  iconFor(v: Toast['variant']): string {
    switch (v) {
      case 'success': return '✓';
      case 'error': return '⚠';
      case 'warning': return '!';
      default: return 'ℹ';
    }
  }
}
