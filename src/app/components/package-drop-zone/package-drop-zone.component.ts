import {
  ChangeDetectionStrategy,
  Component,
  output,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';

/** A recognized uploaded file kind. */
export type UploadedKind =
  | 'package-json'
  | 'angular-json'
  | 'tsconfig'
  | 'browserslist'
  | 'lockfile'
  | 'unknown';

/** A single ingested file. */
export interface UploadedFile {
  kind: UploadedKind;
  name: string;
  content: string;
}

/**
 * Drag-and-drop / click-to-browse / paste zone for an entire Angular project
 * (or a single `package.json`). Accepts multiple files and auto-classifies
 * each one by its filename.
 *
 * Emits one `UploadedFile[]` per drop event — the caller decides how to
 * combine them into a single analysis.
 */
@Component({
  selector: 'app-package-drop-zone',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  template: `
    <div
      class="drop"
      [class.drag]="dragging()"
      [class.err]="!!error()"
      role="button"
      tabindex="0"
      (click)="fileInput.click()"
      (keydown.enter)="fileInput.click()"
      (keydown.space)="$event.preventDefault(); fileInput.click()"
      (dragover)="onDragOver($event)"
      (dragleave)="onDragLeave($event)"
      (drop)="onDrop($event)"
      (paste)="onPaste($event)"
      aria-label="Drop a package.json (and optional angular.json, tsconfig.json, .browserslistrc, lockfile) here"
    >
      <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <path d="M12 16V4m0 0-4 4m4-4 4 4" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <div class="body">
        <p class="head">Drop your project files here</p>
        <p class="sub">
          Supports <code>package.json</code> (one or many), <code>angular.json</code>,
          <code>tsconfig.json</code>, <code>.browserslistrc</code>, and
          <code>package-lock.json</code> / <code>yarn.lock</code> / <code>pnpm-lock.yaml</code>.
          <br />
          <strong>Click to browse</strong>, or <strong>paste</strong> JSON
          <span class="sep">&middot;</span>
          <button type="button" class="link" (click)="$event.stopPropagation(); sample.emit()">
            try a sample
          </button>
        </p>
        @if (loaded().length) {
          <ul class="loaded" aria-live="polite">
            @for (f of loaded(); track f.name) {
              <li>
                <span class="badge" [attr.data-kind]="f.kind">{{ kindLabel(f.kind) }}</span>
                <code>{{ f.name }}</code>
              </li>
            }
          </ul>
        }
        @if (error()) {
          <p class="err-msg" aria-live="assertive">{{ error() }}</p>
        }
      </div>
      <input
        #fileInput
        type="file"
        accept=".json,.yaml,.yml,.lock,.browserslistrc,application/json,text/plain"
        multiple
        (change)="onFile($event)"
        hidden
      />
    </div>
  `,
  styles: [`
    :host { display: block; }
    .drop {
      display: flex; align-items: flex-start; gap: 1rem; width: 100%;
      padding: 1.2rem 1.25rem; border-radius: 14px;
      border: 2px dashed var(--border); background: var(--surface-1);
      color: var(--fg); cursor: pointer;
      transition: background .15s ease, border-color .15s ease, box-shadow .15s ease;
      min-height: 96px;
    }
    .drop:hover, .drop:focus-visible {
      border-color: var(--accent); background: var(--surface-2);
      outline: none; box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
    }
    .drop.drag {
      border-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 8%, var(--surface-2));
    }
    .drop.err { border-color: #ef4444; }
    .ic { width: 38px; height: 38px; flex: 0 0 38px; color: var(--accent); margin-top: 4px; }
    .body { min-width: 0; flex: 1 1 auto; }
    .head { font-weight: 600; font-size: 0.98rem; margin: 0 0 0.25rem; }
    .sub { color: var(--fg-dim); font-size: 0.85rem; margin: 0; }
    .sep { margin: 0 0.35rem; opacity: 0.5; }
    .loaded { list-style: none; padding: 0; margin: 0.55rem 0 0; display: grid; gap: 0.25rem; }
    .loaded li { display: flex; align-items: center; gap: 0.4rem; font-size: 0.82rem; color: var(--fg); }
    .err-msg { margin: 0.35rem 0 0; color: #fca5a5; font-size: 0.82rem; }
    code { background: var(--surface-2); padding: 1px 6px; border-radius: 4px; border: 1px solid var(--border); font-size: 0.82rem; }
    .badge {
      font-size: 0.66rem; padding: 1px 8px; border-radius: 999px; font-weight: 600;
      background: var(--surface-2); border: 1px solid var(--border); color: var(--fg-dim);
      text-transform: uppercase; letter-spacing: 0.04em;
    }
    .badge[data-kind="package-json"] { color: #86efac; border-color: color-mix(in srgb, #22c55e 40%, transparent); }
    .badge[data-kind="angular-json"] { color: #93c5fd; border-color: color-mix(in srgb, #3b82f6 40%, transparent); }
    .badge[data-kind="tsconfig"] { color: #c4b5fd; border-color: color-mix(in srgb, #8b5cf6 40%, transparent); }
    .badge[data-kind="browserslist"] { color: #fcd34d; border-color: color-mix(in srgb, #f59e0b 40%, transparent); }
    .badge[data-kind="lockfile"] { color: #f9a8d4; border-color: color-mix(in srgb, #ec4899 40%, transparent); }
    .link {
      background: none; border: none; color: var(--accent); font: inherit;
      cursor: pointer; padding: 0; text-decoration: underline; text-underline-offset: 2px;
    }
    @media (max-width: 520px) {
      .drop { flex-direction: column; align-items: flex-start; }
      .ic { width: 32px; height: 32px; }
    }
  `]
})
export class PackageDropZoneComponent {
  readonly files = output<UploadedFile[]>();
  readonly sample = output<void>();

  readonly dragging = signal(false);
  readonly loaded = signal<UploadedFile[]>([]);
  readonly error = signal<string | null>(null);

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
    const files = Array.from(ev.dataTransfer?.files ?? []);
    if (!files.length) return;
    await this.ingest(files);
  }

  async onFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    if (!files.length) return;
    await this.ingest(files);
    input.value = '';
  }

  onPaste(ev: ClipboardEvent): void {
    const data = ev.clipboardData?.getData('text');
    if (!data) return;
    ev.preventDefault();
    const kind = this.detectKind('(pasted)', data);
    this.error.set(null);
    const file: UploadedFile = { kind, name: '(pasted)', content: data };
    this.loaded.set([file]);
    this.files.emit([file]);
  }

  kindLabel(kind: UploadedKind): string {
    switch (kind) {
      case 'package-json': return 'package.json';
      case 'angular-json': return 'angular.json';
      case 'tsconfig': return 'tsconfig';
      case 'browserslist': return 'browserslist';
      case 'lockfile': return 'lockfile';
      default: return 'file';
    }
  }

  private async ingest(files: File[]): Promise<void> {
    const accepted: UploadedFile[] = [];
    for (const file of files) {
      if (file.size > 5 * 1024 * 1024) {
        this.error.set(`${file.name}: file too large (max 5 MB).`);
        continue;
      }
      try {
        const content = await file.text();
        const kind = this.detectKind(file.name, content);
        accepted.push({ kind, name: file.name, content });
      } catch {
        this.error.set(`${file.name}: could not read file.`);
      }
    }
    if (!accepted.length) return;
    this.error.set(null);
    this.loaded.set(accepted);
    this.files.emit(accepted);
  }

  private detectKind(name: string, content: string): UploadedKind {
    const lower = name.toLowerCase();
    if (lower === 'package.json' || lower.endsWith('/package.json')) return 'package-json';
    if (lower === 'angular.json' || lower.endsWith('/angular.json') || lower === 'project.json') return 'angular-json';
    if (lower.startsWith('tsconfig') && lower.endsWith('.json')) return 'tsconfig';
    if (lower.endsWith('.browserslistrc') || lower === '.browserslistrc' || lower === 'browserslist') return 'browserslist';
    if (lower.endsWith('package-lock.json') ||
        lower.endsWith('npm-shrinkwrap.json') ||
        lower.endsWith('yarn.lock') ||
        lower.endsWith('pnpm-lock.yaml')) return 'lockfile';

    // Fall back to content sniffing for pasted data.
    const trimmed = content.trim();
    if (trimmed.startsWith('{') && trimmed.includes('"dependencies"')) return 'package-json';
    if (trimmed.startsWith('{') && trimmed.includes('"$schema"') && trimmed.includes('angular')) return 'angular-json';
    if (trimmed.startsWith('{') && trimmed.includes('"compilerOptions"')) return 'tsconfig';
    if (/^(chrome|firefox|safari|edge|ie|and_chr|ios_saf|defaults|>)/im.test(trimmed)) return 'browserslist';
    return 'unknown';
  }
}
