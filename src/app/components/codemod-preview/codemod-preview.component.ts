import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslocoModule } from '@jsverse/transloco';
import {
  CodemodRegistryService,
  CodemodDiff
} from '../../services/codemod-registry.service';
import { SourceScannerService } from '../../services/source-scanner.service';
import { ToastService } from '../../services/toast.service';

/**
 * Inline codemod preview — shows a before/after for each applicable codemod
 * against the last-scanned source files. Users can copy the patched text to
 * paste into their editor.
 */
@Component({
  selector: 'app-codemod-preview',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TranslocoModule],
  template: `
    <div class="cm">
      <h4>{{ 'codemod.title' | transloco }}</h4>
      @if (available().length === 0) {
        <p class="muted">{{ 'codemod.empty' | transloco }}</p>
      }
      @for (cm of available(); track cm.id) {
        <details class="cm-item">
          <summary>
            <strong>{{ cm.title }}</strong>
            <span class="muted">· {{ cm.detail }}</span>
            @if (diffCount(cm.id)(); as n) {
              @if (n > 0) { <span class="badge">{{ 'codemod.hits' | transloco: { n } }}</span> }
            }
          </summary>
          @if (diffs(cm.id)().length === 0) {
            <p class="muted">{{ 'codemod.noHits' | transloco }}</p>
          }
          @for (d of diffs(cm.id)(); track d.file) {
            <div class="diff">
              <header>
                <code>{{ d.file }}</code>
                <span class="muted">{{ 'codemod.changedLines' | transloco: { n: d.changed } }}</span>
                <button type="button" class="link" (click)="copy(d)">{{ 'codemod.copyPatched' | transloco }}</button>
              </header>
              <div class="split">
                <pre class="before"><code>{{ d.before }}</code></pre>
                <pre class="after"><code>{{ d.after }}</code></pre>
              </div>
            </div>
          }
        </details>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cm { padding: 0.75rem; border: 1px solid var(--brd, #e5e7eb); border-radius: var(--r-md, 10px); background: var(--bg-soft, #f9fafb); }
    h4 { margin: 0 0 0.5rem; font-size: 0.95rem; }
    .muted { color: var(--muted, #64748b); font-size: 0.85rem; }
    .cm-item { margin-top: 0.5rem; padding: 0.5rem 0.75rem; background: var(--bg, #fff); border-radius: var(--r-sm, 6px); }
    .cm-item summary { cursor: pointer; display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
    .badge { margin-left: auto; background: var(--accent-soft, #eff6ff); color: var(--accent, #2563eb); border-radius: 999px; padding: 0.15rem 0.55rem; font-size: 0.75rem; font-weight: 600; }
    .diff { margin-top: 0.6rem; border-top: 1px dashed var(--brd, #e5e7eb); padding-top: 0.5rem; }
    .diff header { display: flex; gap: 0.5rem; align-items: center; font-size: 0.82rem; }
    .diff header code { background: var(--bg-soft, #f1f5f9); padding: 0.05rem 0.35rem; border-radius: 4px; }
    .link { background: none; border: none; color: var(--accent, #2563eb); text-decoration: underline; cursor: pointer; font: inherit; margin-left: auto; }
    .split { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; margin-top: 0.35rem; }
    pre { margin: 0; padding: 0.5rem; border-radius: var(--r-sm, 6px); font-size: 0.78rem; overflow-x: auto; max-height: 260px; }
    pre.before { background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.25); }
    pre.after  { background: rgba(34, 197, 94, 0.08); border: 1px solid rgba(34, 197, 94, 0.25); }
    @media (max-width: 700px) { .split { grid-template-columns: 1fr; } }
  `]
})
export class CodemodPreviewComponent {
  readonly pkg = input.required<string>();

  private readonly registry = inject(CodemodRegistryService);
  private readonly scanner = inject(SourceScannerService);
  private readonly toast = inject(ToastService);

  readonly available = computed(() => this.registry.forPackage(this.pkg()));

  /** Memo of diffs per codemod id, keyed by last-scan identity. */
  private readonly cache = new Map<string, () => CodemodDiff[]>();

  diffs(id: string): () => CodemodDiff[] {
    let memo = this.cache.get(id);
    if (memo) return memo;
    memo = computed(() => {
      const files = this.scanner.lastFiles();
      if (!files.length) return [];
      return this.registry.preview(id, files);
    });
    this.cache.set(id, memo);
    return memo;
  }

  diffCount(id: string): () => number {
    return () => this.diffs(id)().length;
  }

  async copy(d: CodemodDiff): Promise<void> {
    try {
      await navigator.clipboard.writeText(d.after);
      this.toast.success(`Copied patched ${d.file}`);
    } catch {
      this.toast.error('Copy failed — your browser blocked clipboard access.');
    }
  }
}
