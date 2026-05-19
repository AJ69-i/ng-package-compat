import { Injectable, signal } from '@angular/core';

/**
 * A codemod transforms a user's source code (in place) to migrate away from
 * a known breaking change. We keep transforms small, regex-based, and
 * *reversible* — a preview always shows the full before/after so the user
 * can eyeball it before applying.
 */
export interface Codemod {
  /** Stable id, e.g. `rxjs-to-promise-to-last-value-from`. */
  id: string;
  /** Package the codemod targets. */
  pkg: string;
  /** Human-readable title. */
  title: string;
  /** One-liner description of what it does. */
  detail: string;
  /** Since which major version of the package this migration applies. */
  since: string;
  /** Transform function — return the new text (or the original if no change). */
  run(src: string): string;
}

/** Result of previewing a codemod against a single file. */
export interface CodemodDiff {
  file: string;
  before: string;
  after: string;
  /** Line-level summary for the UI. */
  changed: number;
}

/**
 * Curated registry of small, safe codemods that correspond 1:1 with entries
 * in KnowledgeBaseService.breakingChanges. Keeping them here (rather than
 * inline in each component) means we can surface a shared "preview" UI and
 * also let the AutomatedPrService assemble a patch.
 */
@Injectable({ providedIn: 'root' })
export class CodemodRegistryService {
  readonly codemods = signal<Codemod[]>([
    {
      id: 'rxjs/to-promise-to-last-value-from',
      pkg: 'rxjs',
      title: '`toPromise()` → `lastValueFrom()`',
      detail: 'Replaces `.toPromise()` calls with the `lastValueFrom()` function import.',
      since: '8.0.0',
      run: (src) => {
        let changed = src.replace(
          /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*|\([^)]+\))\s*\.toPromise\(\s*\)/g,
          'lastValueFrom($1)'
        );
        if (changed !== src && !/from\s+['"]rxjs['"]/.test(changed)) {
          // Add the import at top of the file.
          changed = `import { lastValueFrom } from 'rxjs';\n${changed}`;
        } else if (changed !== src) {
          // Extend an existing named import from 'rxjs'.
          changed = changed.replace(
            /import\s*\{([^}]+)\}\s*from\s*['"]rxjs['"]/,
            (m, names: string) => {
              const list = names.split(',').map((s) => s.trim()).filter(Boolean);
              if (!list.includes('lastValueFrom')) list.push('lastValueFrom');
              return `import { ${list.join(', ')} } from 'rxjs'`;
            }
          );
        }
        return changed;
      }
    },
    {
      id: '@angular/core/ng-if-to-control-flow',
      pkg: '@angular/core',
      title: '`*ngIf` → `@if`',
      detail: 'Converts simple `*ngIf="x"` usages to the new `@if (x) { ... }` control-flow block.',
      since: '17.0.0',
      run: (src) => {
        // Simple <tag *ngIf="expr">…</tag> on a single line.
        return src.replace(
          /<(\w[\w-]*)([^>]*?)\s\*ngIf="([^"]+)"([^>]*)>([\s\S]*?)<\/\1>/g,
          (_m, tag, pre, expr, post, inner) =>
            `@if (${expr}) { <${tag}${pre}${post}>${inner}</${tag}> }`
        );
      }
    },
    {
      id: '@angular/core/ng-for-to-control-flow',
      pkg: '@angular/core',
      title: '`*ngFor` → `@for`',
      detail: 'Converts `*ngFor="let x of list; trackBy: t"` to `@for (x of list; track t)`.',
      since: '17.0.0',
      run: (src) => {
        return src.replace(
          /<(\w[\w-]*)([^>]*?)\s\*ngFor="let\s+(\w+)\s+of\s+([^";]+)(?:;\s*trackBy:\s*([\w.]+))?"([^>]*)>([\s\S]*?)<\/\1>/g,
          (_m, tag, pre, varName, list, track, post, inner) => {
            const trackPart = track ? `track ${track}` : `track ${varName}`;
            return `@for (${varName} of ${list}; ${trackPart}) { <${tag}${pre}${post}>${inner}</${tag}> }`;
          }
        );
      }
    },
    {
      id: '@angular/router/class-guards-to-fn',
      pkg: '@angular/router',
      title: '`CanActivate` class → `CanActivateFn`',
      detail:
        'Flags class-based `implements CanActivate` usages for manual conversion to `CanActivateFn`.',
      since: '15.0.0',
      run: (src) => {
        return src.replace(
          /implements\s+CanActivate\b/g,
          '/* TODO: migrate to CanActivateFn */ implements CanActivate'
        );
      }
    },
    {
      id: '@ngrx/store/typed-action-creators',
      pkg: '@ngrx/store',
      title: '`new Action()` → `createAction`',
      detail:
        'Flags legacy class-based action usages for migration to `createAction` factories.',
      since: '15.0.0',
      run: (src) => {
        return src.replace(
          /class\s+(\w+)\s+implements\s+Action\b/g,
          '/* TODO: switch to createAction(\'$1\', props<...>()) */ class $1 implements Action'
        );
      }
    },
    {
      id: '@ionic/angular/ionic-module-to-standalone',
      pkg: '@ionic/angular',
      title: 'Remove `IonicModule`',
      detail:
        'Flags `IonicModule.forRoot()` / import so you can replace with per-component standalone imports.',
      since: '7.0.0',
      run: (src) => {
        return src.replace(
          /\bIonicModule(\.forRoot\(\))?/g,
          '/* TODO: replace IonicModule with standalone Ion* imports */ IonicModule$1'
        );
      }
    }
  ]);

  /** Find codemods that apply to a given package. */
  forPackage(pkg: string): Codemod[] {
    return this.codemods().filter((c) => c.pkg === pkg);
  }

  /** Find a single codemod by id. */
  find(id: string): Codemod | null {
    return this.codemods().find((c) => c.id === id) ?? null;
  }

  /** Preview a codemod against a set of files. */
  preview(codemodId: string, files: Array<{ path: string; content: string }>): CodemodDiff[] {
    const cm = this.find(codemodId);
    if (!cm) return [];
    const diffs: CodemodDiff[] = [];
    for (const f of files) {
      const after = cm.run(f.content);
      if (after === f.content) continue;
      diffs.push({
        file: f.path,
        before: f.content,
        after,
        changed: countChangedLines(f.content, after)
      });
    }
    return diffs;
  }
}

function countChangedLines(before: string, after: string): number {
  const a = before.split('\n');
  const b = after.split('\n');
  let changed = Math.abs(a.length - b.length);
  const min = Math.min(a.length, b.length);
  for (let i = 0; i < min; i++) if (a[i] !== b[i]) changed++;
  return changed;
}
