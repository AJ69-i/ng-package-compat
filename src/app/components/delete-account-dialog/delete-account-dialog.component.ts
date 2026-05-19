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
import { AccountDeletionService } from '../../services/account-deletion.service';
import { SupabaseService } from '../../services/supabase.service';

/**
 * Confirmation modal for the irreversible delete-my-account action.
 *
 * # Why a typed-confirmation gate
 *
 * Account deletion is destructive, irreversible, and triggered by a
 * single click. A plain "Are you sure? [Yes] [No]" modal has a real
 * failure mode: muscle memory clicks "Yes" before the user reads.
 * Requiring the user to physically type "DELETE" in a text field
 * before the destructive button enables forces a deliberate pause
 * that essentially eliminates accidental deletions — used by GitHub,
 * Stripe, Vercel, every serious SaaS for the same reason.
 *
 * # Same native dialog pattern as AI settings
 *
 * Uses the browser's native &lt;dialog&gt; element via showModal() — we
 * get focus trap, ESC-to-close, backdrop click handling, and modal
 * accessibility for free. Reusing the pattern keeps the dialog
 * vocabulary consistent across the app.
 */
@Component({
  selector: 'app-delete-account-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, TranslocoModule],
  template: `
    <dialog
      #dlg
      class="del-dialog"
      [attr.aria-labelledby]="'del-dialog-title'"
      [attr.aria-describedby]="'del-dialog-body'"
    >
      <header class="del-head">
        <h2 id="del-dialog-title">
          <span aria-hidden="true">⚠️</span>
          {{ 'deleteAccount.title' | transloco }}
        </h2>
        <button
          type="button"
          class="del-x"
          (click)="close()"
          [attr.aria-label]="'common.close' | transloco"
        >×</button>
      </header>

      <p id="del-dialog-body" class="del-body">
        {{ 'deleteAccount.warning' | transloco: { email: userEmail() } }}
      </p>

      <ul class="del-bullets">
        <li>{{ 'deleteAccount.willLose1' | transloco }}</li>
        <li>{{ 'deleteAccount.willLose2' | transloco }}</li>
        <li>{{ 'deleteAccount.willLose3' | transloco }}</li>
      </ul>

      <label class="del-confirm" [for]="'del-confirm-input'">
        {{ 'deleteAccount.typePrompt' | transloco }}
        <strong>DELETE</strong>
        {{ 'deleteAccount.typePromptSuffix' | transloco }}
      </label>
      <input
        id="del-confirm-input"
        type="text"
        class="del-input"
        [ngModel]="typed()"
        (ngModelChange)="typed.set($event)"
        name="confirmation"
        autocomplete="off"
        spellcheck="false"
        autocapitalize="none"
        autocorrect="off"
        [attr.aria-invalid]="!confirmed() && typed().length > 0"
      />

      <footer class="del-foot">
        <button
          type="button"
          class="del-btn del-btn-secondary"
          (click)="close()"
          [disabled]="busy()"
        >
          {{ 'common.cancel' | transloco }}
        </button>
        <button
          type="button"
          class="del-btn del-btn-danger"
          (click)="confirm()"
          [disabled]="!confirmed() || busy()"
          data-testid="deleteAccount.confirm"
        >
          @if (busy()) {
            <span aria-hidden="true">⌛</span>
            {{ 'deleteAccount.deleting' | transloco }}
          } @else {
            {{ 'deleteAccount.deleteButton' | transloco }}
          }
        </button>
      </footer>
    </dialog>
  `,
  styles: [`
    :host { display: contents; }

    .del-dialog {
      width: min(520px, calc(100vw - 2rem));
      max-width: 520px;
      padding: 0;
      border: 1px solid color-mix(in srgb, var(--bad, #ef4444) 30%, var(--border));
      border-radius: var(--radius-lg, 14px);
      background: var(--surface-2);
      color: var(--fg);
      box-shadow: 0 24px 48px rgba(0, 0, 0, 0.3);
    }
    .del-dialog::backdrop {
      background: rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(4px);
    }

    .del-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 1rem 1.2rem 0.5rem;
      gap: 1rem;
    }
    .del-head h2 {
      margin: 0;
      font-size: 1.05rem;
      display: inline-flex; align-items: center; gap: 0.45rem;
      color: var(--fg);
    }
    .del-x {
      width: 28px; height: 28px;
      display: inline-flex; align-items: center; justify-content: center;
      border: none; background: transparent; cursor: pointer;
      font-size: 1.4rem; line-height: 1; color: var(--fg-dim);
      border-radius: 50%;
    }
    .del-x:hover { color: var(--fg); background: var(--surface-1); }

    .del-body {
      margin: 0;
      padding: 0 1.2rem;
      color: var(--fg);
      font-size: 0.92rem;
      line-height: 1.55;
    }

    .del-bullets {
      margin: 0.65rem 0 1rem;
      padding: 0 1.2rem 0 2.4rem;
      display: grid; gap: 0.25rem;
      color: var(--fg-dim);
      font-size: 0.85rem;
      line-height: 1.5;
    }
    .del-bullets li::marker {
      color: color-mix(in srgb, var(--bad, #ef4444) 60%, var(--fg-dim));
    }

    .del-confirm {
      display: block;
      padding: 0 1.2rem;
      margin-bottom: 0.4rem;
      color: var(--fg-dim);
      font-size: 0.85rem;
    }
    .del-confirm strong {
      color: color-mix(in srgb, var(--bad, #ef4444) 80%, var(--fg));
      font-family: var(--code-font, ui-monospace, Menlo, Consolas, monospace);
      letter-spacing: 0.05em;
    }

    .del-input {
      width: calc(100% - 2.4rem);
      margin: 0 1.2rem 1rem;
      padding: 0.55rem 0.7rem;
      border: 1px solid var(--border);
      border-radius: var(--radius-md, 10px);
      background: var(--surface-1);
      color: var(--fg);
      font: 0.92rem var(--code-font, ui-monospace, Menlo, Consolas, monospace);
      outline: none;
    }
    .del-input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent);
    }
    .del-input[aria-invalid="true"] {
      border-color: color-mix(in srgb, var(--bad, #ef4444) 50%, var(--border));
    }

    .del-foot {
      display: flex; justify-content: flex-end; gap: 0.5rem;
      padding: 0 1.2rem 1.2rem;
    }
    .del-btn {
      padding: 0.55rem 1rem;
      border-radius: var(--radius-md, 10px);
      border: 1px solid var(--border);
      background: var(--surface-1);
      color: var(--fg);
      font: inherit;
      font-weight: 500;
      cursor: pointer;
      transition: border-color 140ms ease, background 140ms ease;
    }
    .del-btn-secondary:hover:not([disabled]) {
      border-color: var(--accent);
    }
    .del-btn-danger {
      background: color-mix(in srgb, var(--bad, #ef4444) 15%, var(--surface-1));
      color: color-mix(in srgb, var(--bad, #ef4444) 80%, var(--fg));
      border-color: color-mix(in srgb, var(--bad, #ef4444) 40%, var(--border));
    }
    .del-btn-danger:hover:not([disabled]) {
      background: color-mix(in srgb, var(--bad, #ef4444) 25%, var(--surface-1));
      border-color: color-mix(in srgb, var(--bad, #ef4444) 60%, var(--border));
    }
    .del-btn[disabled] { opacity: 0.5; cursor: not-allowed; }
  `]
})
export class DeleteAccountDialogComponent {
  private readonly deletion = inject(AccountDeletionService);
  private readonly supabase = inject(SupabaseService);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  @ViewChild('dlg') private dlgRef?: ElementRef<HTMLDialogElement>;

  /** Live email shown in the warning copy, so the user sees which account they're about to nuke. */
  readonly userEmail = computed(() => this.supabase.user()?.email ?? '');

  /**
   * Text typed into the confirmation field. MUST be a signal so the
   * `confirmed` computed below re-evaluates on each keystroke; if this
   * were a plain class property the computed would only run once at
   * init time (computed signals track signal reads, not property
   * reads) and the destructive button would stay permanently disabled
   * — which is exactly what happened in the first cut.
   */
  readonly typed = signal('');

  /** True only when the typed text is exactly "DELETE" — enables the destructive button. */
  readonly confirmed = computed(() => this.typed().trim() === 'DELETE');

  /** True while the RPC + local wipe + sign-out chain is in flight. */
  readonly busy = signal(false);

  /** Imperative open — called from the host page's "Delete account" button. */
  open(): void {
    if (!this.isBrowser) return;
    this.typed.set('');
    this.dlgRef?.nativeElement.showModal();
  }

  close(): void {
    if (this.busy()) return; // don't allow cancel mid-delete
    this.dlgRef?.nativeElement.close();
  }

  async confirm(): Promise<void> {
    if (!this.confirmed() || this.busy()) return;
    this.busy.set(true);
    try {
      const ok = await this.deletion.deleteAccount();
      if (ok) {
        this.dlgRef?.nativeElement.close();
      }
    } finally {
      this.busy.set(false);
    }
  }
}
