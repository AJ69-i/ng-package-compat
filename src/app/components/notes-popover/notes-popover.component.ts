import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
  computed,
  inject,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslocoModule } from '@jsverse/transloco';
import { NotesService } from '../../services/notes.service';

/**
 * Inline popover that lets the user edit a note and toggle the pin flag for a
 * single package, typically anchored to a row affordance in the upgrade table.
 *
 * Kept deliberately small — the outer table controls *where* the popover
 * appears; this component owns only the textarea, flag switch, save/clear.
 */
@Component({
  selector: 'app-notes-popover',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, TranslocoModule],
  template: `
    <div class="pop" role="dialog" aria-modal="false"
         [attr.aria-label]="'notes.title' | transloco">
      <header>
        <h4>{{ 'notes.for' | transloco }} <code>{{ packageName }}</code></h4>
        <button type="button" class="x" (click)="close.emit()" aria-label="Close">×</button>
      </header>

      <label class="flag">
        <input type="checkbox" [checked]="flagged()" (change)="toggleFlag()">
        <span>{{ 'notes.flag' | transloco }}</span>
      </label>

      <textarea
        [attr.aria-label]="'notes.placeholder' | transloco"
        [placeholder]="'notes.placeholder' | transloco"
        [(ngModel)]="draft"
        (ngModelChange)="onTyped($event)"
        rows="4"
      ></textarea>

      <div class="meta">
        @if (updatedAt()) {
          <small>{{ 'notes.updated' | transloco }} {{ updatedAt() }}</small>
        }
        <div class="spacer"></div>
        <button type="button" class="ghost" (click)="clear()">{{ 'notes.clear' | transloco }}</button>
        <button type="button" class="primary" (click)="save()">{{ 'notes.save' | transloco }}</button>
      </div>
    </div>
  `,
  styles: [
    `
      :host { display: block; }
      .pop {
        width: min(340px, 94vw);
        background: var(--surface-1, #fff);
        color: var(--fg, #111);
        border: 1px solid var(--border, #e5e7eb);
        border-radius: 12px;
        box-shadow: 0 18px 42px rgba(0,0,0,0.18);
        padding: 0.85rem 0.95rem;
      }
      header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.4rem; }
      header h4 { margin: 0; font-size: 0.92rem; font-weight: 600; }
      header code { font-family: ui-monospace, monospace; font-size: 0.82rem; color: var(--accent, #6366f1); }
      .x {
        border: none; background: none; font-size: 1.3rem; color: var(--fg-dim, #777); cursor: pointer;
      }
      .flag { display: inline-flex; gap: 0.45rem; align-items: center; font-size: 0.88rem; margin: 0.25rem 0 0.55rem; cursor: pointer; }
      textarea {
        width: 100%;
        min-height: 80px;
        resize: vertical;
        font-family: inherit;
        font-size: 0.88rem;
        background: var(--surface-2, #fafafa);
        color: var(--fg, #111);
        border: 1px solid var(--border, #e5e7eb);
        border-radius: 8px;
        padding: 0.55rem 0.65rem;
      }
      textarea:focus { outline: 2px solid var(--accent, #6366f1); outline-offset: 2px; }
      .meta { display: flex; align-items: center; gap: 0.4rem; margin-top: 0.6rem; }
      .meta small { color: var(--fg-dim, #777); font-size: 0.72rem; }
      .spacer { flex: 1; }
      .ghost, .primary {
        border-radius: 8px;
        padding: 0.4rem 0.85rem;
        font-size: 0.82rem;
        cursor: pointer;
      }
      .ghost { background: transparent; border: 1px solid var(--border, #e5e7eb); color: var(--fg-dim, #555); }
      .primary { background: var(--accent, #6366f1); border: 1px solid var(--accent, #6366f1); color: #fff; }
    `
  ]
})
export class NotesPopoverComponent {
  private readonly notes = inject(NotesService);

  @Input({ required: true }) packageName!: string;
  @Output() close = new EventEmitter<void>();

  readonly draft = signal<string>('');
  readonly flagged = computed<boolean>(() => this.notes.isFlagged(this.packageName));
  readonly updatedAt = computed<string>(() => {
    const n = this.notes.get(this.packageName);
    if (!n?.updatedAt) return '';
    try { return new Date(n.updatedAt).toLocaleString(); } catch { return ''; }
  });

  ngOnInit(): void {
    this.draft.set(this.notes.noteFor(this.packageName));
  }

  onTyped(v: string): void { this.draft.set(v); }

  async toggleFlag(): Promise<void> {
    await this.notes.toggleFlag(this.packageName);
  }

  async save(): Promise<void> {
    await this.notes.setNote(this.packageName, this.draft().trim());
    this.close.emit();
  }

  async clear(): Promise<void> {
    this.draft.set('');
    await this.notes.setNote(this.packageName, '');
  }
}
