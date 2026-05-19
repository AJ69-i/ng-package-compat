import { Injectable, signal } from '@angular/core';

export interface ShortcutEntry {
  /** Keys to press, e.g. ['?'], ['Ctrl', 'K'], ['g', 'u']. */
  keys: string[];
  /** Human-readable description — shown in the help overlay. */
  description: string;
  /** Grouping shown as a section header. */
  group: 'Navigation' | 'Analysis' | 'Export' | 'Help';
}

/**
 * Static registry of every keyboard shortcut the app ships with. The help
 * overlay reads this list so new shortcuts show up in the cheat sheet
 * automatically with no template edits.
 *
 * Runtime registration (from a plugin) is supported via `register()`.
 */
@Injectable({ providedIn: 'root' })
export class ShortcutsService {
  readonly helpOpen = signal<boolean>(false);

  private readonly builtIns: ShortcutEntry[] = [
    { keys: ['?'], description: 'Open this shortcuts cheat sheet', group: 'Help' },
    { keys: ['Esc'], description: 'Close any open modal or palette', group: 'Help' },
    { keys: ['Ctrl', 'K'], description: 'Open command palette', group: 'Navigation' },
    { keys: ['Cmd', 'K'], description: 'Open command palette (macOS)', group: 'Navigation' },
    { keys: ['/'], description: 'Focus the search input', group: 'Navigation' },
    { keys: ['g', 's'], description: 'Go to Search page', group: 'Navigation' },
    { keys: ['g', 'u'], description: 'Go to Upgrade page', group: 'Navigation' },
    { keys: ['g', 'c'], description: 'Go to Compare page', group: 'Navigation' },
    { keys: ['g', 'h'], description: 'Go to History page', group: 'Navigation' },
    { keys: ['g', 'f'], description: 'Go to Favorites page', group: 'Navigation' },
    { keys: ['1'], description: 'Filter to Critical only', group: 'Analysis' },
    { keys: ['2'], description: 'Filter to Warning only', group: 'Analysis' },
    { keys: ['3'], description: 'Filter to Healthy only', group: 'Analysis' },
    { keys: ['0'], description: 'Clear severity filter', group: 'Analysis' },
    { keys: ['s'], description: 'Save current analysis as a snapshot', group: 'Analysis' },
    { keys: ['e'], description: 'Export PDF of current report', group: 'Export' },
    { keys: ['c'], description: 'Copy shareable link', group: 'Export' },
    { keys: ['j'], description: 'Export Jira CSV', group: 'Export' }
  ];

  private readonly registered = signal<ShortcutEntry[]>([]);

  all(): ShortcutEntry[] {
    return [...this.builtIns, ...this.registered()];
  }

  grouped(): Record<ShortcutEntry['group'], ShortcutEntry[]> {
    const out: Record<ShortcutEntry['group'], ShortcutEntry[]> = {
      Navigation: [],
      Analysis: [],
      Export: [],
      Help: []
    };
    for (const s of this.all()) out[s.group].push(s);
    return out;
  }

  register(entry: ShortcutEntry): void {
    this.registered.update((list) => [...list, entry]);
  }

  openHelp(): void { this.helpOpen.set(true); }
  closeHelp(): void { this.helpOpen.set(false); }
  toggleHelp(): void { this.helpOpen.update((v) => !v); }
}
