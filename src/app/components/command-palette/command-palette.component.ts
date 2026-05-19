import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { StorageService } from '../../services/storage.service';
import { ThemeService } from '../../services/theme.service';

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon?: string;
  /** Optional extra tokens to match against (aliases, tags). */
  tags?: string[];
  run: () => void;
}

/**
 * Tiny fuzzy scorer — no Fuse.js dependency.
 *
 * Returns a positive score for any item whose characters appear in order in
 * the text (subsequence match). Higher score = better:
 *   - Consecutive-character bonus
 *   - Word-boundary bonus (match starts at a separator)
 *   - Full-prefix bonus (entire query is a prefix of a token)
 * Returns null if query doesn't match at all.
 */
function fuzzyScore(query: string, text: string): { score: number; indices: number[] } | null {
  if (!query) return { score: 0, indices: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) {
    const idx = t.indexOf(q);
    const boundaryBonus = idx === 0 || /\W/.test(t[idx - 1]) ? 40 : 10;
    return { score: 120 + boundaryBonus - idx, indices: Array.from({ length: q.length }, (_, k) => idx + k) };
  }
  let ti = 0;
  let score = 0;
  let lastMatch = -1;
  const indices: number[] = [];
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    for (let j = ti; j < t.length; j++) {
      if (t[j] === ch) { found = j; break; }
    }
    if (found === -1) return null;
    indices.push(found);
    if (found === lastMatch + 1) score += 5;
    if (found === 0 || /\W/.test(t[found - 1])) score += 3;
    score += 1;
    lastMatch = found;
    ti = found + 1;
  }
  return { score, indices };
}

@Component({
  selector: 'app-command-palette',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  template: `
    @if (open()) {
      <div class="overlay" (click)="close()" role="presentation"></div>
      <div
        class="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <input
          #input
          type="search"
          class="query"
          [(ngModel)]="query"
          (ngModelChange)="onQuery($event)"
          (keydown)="onKey($event)"
          placeholder="Type a command, package name, or shortcut…"
          aria-label="Command palette input"
        />
        <ul class="list" role="listbox">
          @for (c of filtered(); track c.id; let i = $index) {
            <li
              role="option"
              [class.active]="i === active()"
              (mouseenter)="active.set(i)"
              (click)="runCommand(c)"
            >
              <span class="icon" aria-hidden="true">{{ c.icon || '›' }}</span>
              <span class="label">{{ c.label }}</span>
              @if (c.hint) { <span class="hint">{{ c.hint }}</span> }
            </li>
          }
          @if (filtered().length === 0) {
            <li class="empty">No matches. Press Enter to search the registry for "{{ query() }}".</li>
          }
        </ul>
        <footer>
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>Enter</kbd> run</span>
          <span><kbd>Esc</kbd> close</span>
        </footer>
      </div>
    }
  `,
  styles: [`
    .overlay {
      position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 90;
      backdrop-filter: blur(2px);
    }
    .palette {
      position: fixed; top: 10vh; left: 50%; transform: translateX(-50%);
      width: min(640px, 92vw); z-index: 100;
      background: var(--surface-1); border: 1px solid var(--border);
      border-radius: 14px; box-shadow: 0 24px 60px rgba(0,0,0,0.5);
      overflow: hidden; display: flex; flex-direction: column; max-height: 72vh;
    }
    .query {
      width: 100%; padding: 1rem 1.25rem; font-size: 1rem;
      background: transparent; color: var(--fg); border: none; outline: none;
      border-bottom: 1px solid var(--border);
    }
    .list { list-style: none; padding: 0.25rem; margin: 0; overflow-y: auto; }
    .list li {
      display: flex; align-items: center; gap: 0.65rem;
      padding: 0.6rem 0.85rem; border-radius: 8px; cursor: pointer;
      color: var(--fg);
    }
    .list li.active, .list li:hover { background: var(--surface-2); }
    .icon { color: var(--accent); width: 1.1rem; }
    .label { flex: 1 1 auto; }
    .hint { color: var(--fg-dim); font-size: 0.8rem; }
    .empty { color: var(--fg-dim); padding: 1rem; cursor: default; }
    footer {
      display: flex; gap: 1rem; padding: 0.5rem 0.9rem;
      border-top: 1px solid var(--border); color: var(--fg-dim); font-size: 0.78rem;
      background: var(--surface-2); flex-wrap: wrap;
    }
    kbd {
      background: var(--surface-1); border: 1px solid var(--border);
      border-radius: 4px; padding: 1px 5px; font-size: 0.7rem; color: var(--fg);
      margin-right: 2px;
    }
  `]
})
export class CommandPaletteComponent {
  private readonly router = inject(Router);
  private readonly storage = inject(StorageService);
  private readonly themeSvc = inject(ThemeService);

  readonly open = signal(false);
  readonly query = signal('');
  readonly active = signal(0);

  private readonly input = viewChild<ElementRef<HTMLInputElement>>('input');

  readonly baseCommands: Command[] = [
    { id: 'go-search', label: 'Go to search', icon: '🔎', tags: ['home', 'find'],
      run: () => this.router.navigate(['/']) },
    { id: 'go-compare', label: 'Go to compare', icon: '↔', tags: ['diff', 'versus'],
      run: () => this.router.navigate(['/compare']) },
    { id: 'go-upgrade', label: 'Upgrade assistant', icon: '⇪', tags: ['migrate', 'plan'],
      run: () => this.router.navigate(['/upgrade']) },
    { id: 'go-history', label: 'History & snapshots', icon: '⏱', tags: ['past', 'snapshot'],
      run: () => this.router.navigate(['/history']) },
    { id: 'go-favorites', label: 'Favorites dashboard', icon: '★', tags: ['starred', 'watchlist'],
      run: () => this.router.navigate(['/favorites']) },
    { id: 'go-diff', label: 'Snapshot diff', icon: 'Δ', tags: ['trend', 'change'],
      run: () => this.router.navigate(['/diff']) },
    { id: 'go-about', label: 'About methodology', icon: 'ⓘ', tags: ['help', 'docs'],
      run: () => this.router.navigate(['/about']) },
    { id: 'theme-light', label: 'Switch to light theme', icon: '☾', tags: ['appearance'],
      run: () => this.themeSvc.set('light') },
    { id: 'theme-dark', label: 'Switch to dark theme', icon: '☀', tags: ['appearance'],
      run: () => this.themeSvc.set('dark') },
    { id: 'theme-system', label: 'Use system theme', icon: '⬒', tags: ['appearance'],
      run: () => this.themeSvc.set('system') }
  ];

  readonly filtered = computed<Command[]>(() => {
    const q = this.query().trim();
    const history = this.storage.history();
    const fav = this.storage.favorites();

    const historyCmds: Command[] = history.slice(0, 8).map((h) => ({
      id: 'hist-' + h.name,
      label: h.name,
      icon: '⏱',
      hint: 'Recent',
      tags: ['package', 'history', 'recent'],
      run: () => this.router.navigate(['/'], { queryParams: { q: h.name } })
    }));
    const favCmds: Command[] = fav.map((name) => ({
      id: 'fav-' + name,
      label: name,
      icon: '★',
      hint: 'Favorite',
      tags: ['package', 'starred', 'watchlist'],
      run: () => this.router.navigate(['/'], { queryParams: { q: name } })
    }));

    const all = [...favCmds, ...historyCmds, ...this.baseCommands];
    if (!q) return all;

    // Score each command against both its label and its tags, take the best.
    const scored: { cmd: Command; score: number }[] = [];
    for (const c of all) {
      const candidates = [c.label, ...(c.tags ?? [])];
      let best = -Infinity;
      for (const cand of candidates) {
        const r = fuzzyScore(q, cand);
        if (r && r.score > best) best = r.score;
      }
      if (best > -Infinity) scored.push({ cmd: c, score: best });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 12).map((s) => s.cmd);
  });

  show(): void {
    this.query.set('');
    this.active.set(0);
    this.open.set(true);
    queueMicrotask(() => {
      setTimeout(() => this.input()?.nativeElement.focus(), 0);
    });
  }

  close(): void {
    this.open.set(false);
  }

  onQuery(_: string): void {
    this.active.set(0);
  }

  onKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.active.update((i) => Math.min(i + 1, this.filtered().length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.active.update((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const sel = this.filtered()[this.active()];
      if (sel) this.runCommand(sel);
      else this.runSearchFallback();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    }
  }

  runCommand(c: Command): void {
    c.run();
    this.close();
  }

  private runSearchFallback(): void {
    const q = this.query().trim();
    if (!q) return;
    this.router.navigate(['/'], { queryParams: { q } });
    this.close();
  }

  @HostListener('window:keydown', ['$event'])
  onShortcut(e: KeyboardEvent): void {
    const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
    const modifier = isMac ? e.metaKey : e.ctrlKey;
    if (modifier && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (this.open()) this.close();
      else this.show();
    }
  }
}
