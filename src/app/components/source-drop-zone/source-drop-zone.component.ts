import {
  ChangeDetectionStrategy,
  Component,
  output,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslocoModule } from '@jsverse/transloco';
import { ScannedFile } from '../../services/source-scanner.service';

/**
 * Secondary drop zone — accepts .ts/.tsx/.js/.html files from the user's src/
 * folder, in addition to (or instead of) a package.json. Fires a `scan` event
 * with the collected {@link ScannedFile} list.
 *
 * This unlocks the "source-aware" half of the breaking-change analysis: rather
 * than a generic list of every potential break in the packages you use, we
 * only show the ones that your code actually touches, with file:line citations.
 */
@Component({
  selector: 'app-source-drop-zone',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TranslocoModule],
  template: `
    <div
      class="sz"
      [class.drag]="dragging()"
      [class.loaded]="files().length > 0"
      role="button"
      tabindex="0"
      (click)="fileInput.click()"
      (keydown.enter)="fileInput.click()"
      (keydown.space)="$event.preventDefault(); fileInput.click()"
      (dragover)="onDragOver($event)"
      (dragleave)="onDragLeave($event)"
      (drop)="onDrop($event)"
      [attr.aria-label]="'source.drop.aria' | transloco"
    >
      <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <div class="body">
        <p class="head">{{ 'source.drop.title' | transloco }}</p>
        <p class="sub">{{ 'source.drop.hint' | transloco }}</p>
        @if (files().length) {
          <p class="status" aria-live="polite">
            {{ 'source.drop.loaded' | transloco: { count: files().length } }}
            <button type="button" class="link" (click)="$event.stopPropagation(); clear()">
              {{ 'source.drop.clear' | transloco }}
            </button>
          </p>
        }
      </div>
      <input
        #fileInput
        type="file"
        multiple
        hidden
        accept=".ts,.tsx,.js,.jsx,.mjs,.cjs,.html,.htm"
        (change)="onPick($event)"
      />
    </div>
  `,
  styles: [`
    :host { display: block; }
    .sz {
      position: relative;
      display: flex;
      gap: 0.75rem;
      align-items: center;
      padding: 0.9rem 1rem;
      border: 2px dashed var(--brd, #d7dce1);
      border-radius: var(--r-md, 10px);
      background: var(--bg-soft, #f9fafb);
      color: var(--fg, #111827);
      cursor: pointer;
      transition: border-color 120ms ease, background-color 120ms ease;
    }
    .sz:hover, .sz:focus-visible { border-color: var(--accent, #2563eb); outline: none; }
    .sz.drag { border-color: var(--accent, #2563eb); background: var(--accent-soft, #eff6ff); }
    .sz.loaded { border-style: solid; border-color: var(--ok, #16a34a); background: var(--ok-soft, #f0fdf4); }
    .ic { width: 24px; height: 24px; flex: 0 0 auto; color: var(--muted, #64748b); }
    .body { flex: 1; min-width: 0; }
    .head { margin: 0; font-weight: 600; font-size: 0.95rem; }
    .sub { margin: 0.1rem 0 0; color: var(--muted, #64748b); font-size: 0.85rem; }
    .status { margin: 0.35rem 0 0; font-size: 0.85rem; color: var(--ok, #16a34a); font-weight: 500; }
    .link {
      background: none;
      border: none;
      color: var(--accent, #2563eb);
      text-decoration: underline;
      cursor: pointer;
      font: inherit;
      padding: 0 0 0 0.25rem;
    }
    .link:hover { color: var(--accent-strong, #1d4ed8); }
  `]
})
export class SourceDropZoneComponent {
  readonly scan = output<ScannedFile[]>();

  readonly dragging = signal(false);
  readonly files = signal<ScannedFile[]>([]);

  onDragOver(ev: DragEvent): void {
    ev.preventDefault();
    this.dragging.set(true);
  }

  onDragLeave(ev: DragEvent): void {
    ev.preventDefault();
    this.dragging.set(false);
  }

  async onDrop(ev: DragEvent): Promise<void> {
    ev.preventDefault();
    this.dragging.set(false);
    const items = Array.from(ev.dataTransfer?.files ?? []);
    await this.ingest(items);
  }

  async onPick(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const items = Array.from(input.files ?? []);
    await this.ingest(items);
    input.value = '';
  }

  clear(): void {
    this.files.set([]);
    this.scan.emit([]);
  }

  private async ingest(items: File[]): Promise<void> {
    const keep: ScannedFile[] = [];
    for (const f of items) {
      if (!/\.(tsx?|jsx?|mjs|cjs|html?)$/i.test(f.name)) continue;
      if (f.size > 512 * 1024) continue; // skip >512KB — almost certainly a minified bundle
      const content = await f.text();
      keep.push({
        path: (f as any).webkitRelativePath || f.name,
        content
      });
      if (keep.length >= 400) break; // cap for sanity
    }
    this.files.set(keep);
    this.scan.emit(keep);
  }
}
