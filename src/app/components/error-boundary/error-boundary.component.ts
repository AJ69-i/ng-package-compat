import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-error-boundary',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  template: `
    @if (error()) {
      <div class="err" role="alert">
        <div class="icon" aria-hidden="true">!</div>
        <div class="body">
          <p class="title">{{ title() }}</p>
          <p class="message">{{ error() }}</p>
          @if (canRetry()) {
            <button type="button" class="retry" (click)="retry.emit()">Try again</button>
          }
        </div>
      </div>
    }
  `,
  styles: [`
    /* Block host so the error boundary takes a full page row in the
       layout. The inner .err already owns margin: 1rem 0 — this rule
       just guarantees the host doesn't collapse to inline when no
       error is present. */
    :host { display: block; }
    .err {
      margin: 1rem 0; padding: 0.9rem 1rem;
      background: color-mix(in srgb, #ef4444 10%, transparent);
      border: 1px solid color-mix(in srgb, #ef4444 45%, transparent);
      border-radius: 12px;
      display: flex; gap: 0.75rem; align-items: flex-start;
    }
    .icon {
      width: 32px; height: 32px; border-radius: 50%;
      background: color-mix(in srgb, #ef4444 35%, transparent);
      color: #fee2e2; display: grid; place-items: center; font-weight: 700;
      flex: 0 0 auto;
    }
    .body { flex: 1 1 auto; min-width: 0; }
    .title { margin: 0; color: #fecaca; font-weight: 600; }
    .message { margin: 0.1rem 0 0; color: #fca5a5; font-size: 0.9rem; word-break: break-word; }
    .retry {
      margin-top: 0.5rem; padding: 0.4rem 0.85rem;
      background: color-mix(in srgb, #ef4444 15%, transparent);
      border: 1px solid color-mix(in srgb, #ef4444 45%, transparent);
      border-radius: 8px; color: #fee2e2; cursor: pointer;
      min-height: 36px;
    }
    .retry:hover { border-color: #fca5a5; }
  `]
})
export class ErrorBoundaryComponent {
  readonly error = input<string | null>(null);
  readonly title = input<string>('Something went wrong');
  readonly canRetry = input<boolean>(true);
  readonly retry = output<void>();
}
