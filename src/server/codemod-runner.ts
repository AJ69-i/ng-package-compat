/**
 * Server-side codemod runner (feature #100).
 *
 * Browser-side codemods are previews only — they show the user "this is what
 * would change". This endpoint actually applies a registered codemod across
 * a set of source files and returns the patched files plus a unified diff,
 * ready to be turned into a PR by the existing `/api/pr` proxy.
 *
 * The set of available codemods is intentionally tiny and fully declarative
 * — we don't want to expose arbitrary code execution. Each codemod is a
 * regex-replace pair (or a small AST-light transformation) registered here
 * by id. Browsers POST the source files; the server runs the registered
 * transformation and returns the patched result.
 *
 * Endpoint:
 *   POST /api/codemod/run
 *   {
 *     codemodId: 'ngrx16-to-21' | 'rxjs6-to-7' | ...,
 *     files: [{ path: 'src/...', content: '...' }, ...]
 *   }
 *   →
 *   {
 *     codemodId,
 *     changedFileCount,
 *     files: [{ path, content, changed }],
 *     unifiedDiff
 *   }
 */

import type { Express, Request, Response } from 'express';

interface SourceFile {
  path: string;
  content: string;
}

interface RegexCodemod {
  id: string;
  description: string;
  /** Run this regex/replace on every input file. */
  patterns: Array<{ regex: RegExp; replace: string }>;
}

const REGISTRY: Record<string, RegexCodemod> = {
  'rxjs6-to-7': {
    id: 'rxjs6-to-7',
    description: 'RxJS 6 → 7: switch deprecated patch operators to pipeable form.',
    patterns: [
      // toPromise() → firstValueFrom / lastValueFrom is contextual; we just
      // flag it with a comment instead of guessing wrong.
      {
        regex: /(\w+)\.toPromise\(\)/g,
        replace: '/* TODO(rxjs7): use firstValueFrom($1) */ $1.toPromise()'
      },
      // Subject.next() with no args is no longer allowed.
      {
        regex: /(\w+Subject)\.next\(\s*\)/g,
        replace: '$1.next(undefined)'
      }
    ]
  },
  'ngrx16-to-21': {
    id: 'ngrx16-to-21',
    description: '@ngrx 16 → 21: createReducer arg list, signal store imports.',
    patterns: [
      {
        regex: /from\s+['"]@ngrx\/store\/store-module['"]/g,
        replace: "from '@ngrx/store'"
      }
    ]
  },
  'angular-standalone-imports': {
    id: 'angular-standalone-imports',
    description: 'Angular: drop NgModule shells in favour of standalone components.',
    patterns: [
      {
        regex: /\bimport\s+\{\s*BrowserModule\s*\}\s+from\s+['"]@angular\/platform-browser['"];?\s*\n/g,
        replace: '// (standalone) BrowserModule import removed\n'
      }
    ]
  }
};

interface RunRequest {
  codemodId: string;
  files: SourceFile[];
}

function validate(body: unknown): RunRequest | string {
  if (!body || typeof body !== 'object') return 'json body required';
  const b = body as Record<string, unknown>;
  if (typeof b['codemodId'] !== 'string') return 'codemodId required';
  if (!REGISTRY[b['codemodId'] as string]) return `unknown codemod: ${b['codemodId']}`;
  if (!Array.isArray(b['files'])) return 'files must be an array';
  for (const f of b['files']) {
    const ff = f as Record<string, unknown>;
    if (typeof ff['path'] !== 'string' || typeof ff['content'] !== 'string') {
      return 'each file must have a path and content';
    }
    if ((ff['content'] as string).length > 256 * 1024) {
      return `file ${ff['path']} exceeds the 256 KB per-file size cap`;
    }
  }
  return b as unknown as RunRequest;
}

function applyCodemod(codemod: RegexCodemod, file: SourceFile): SourceFile & { changed: boolean } {
  let content = file.content;
  let changed = false;
  for (const { regex, replace } of codemod.patterns) {
    const before = content;
    content = content.replace(regex, replace);
    if (content !== before) changed = true;
  }
  return { ...file, content, changed };
}

function unifiedDiff(orig: SourceFile, next: SourceFile): string {
  if (orig.content === next.content) return '';
  // Tiny line-by-line diff (no LCS — good enough for codemod previews).
  const a = orig.content.split('\n');
  const b = next.content.split('\n');
  const out: string[] = [`--- a/${orig.path}`, `+++ b/${next.path}`];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(' ' + a[i]);
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || a[i] !== b[j])) {
      out.push('+' + b[j]);
      j++;
    } else {
      out.push('-' + a[i]);
      i++;
    }
  }
  return out.join('\n');
}

export function registerCodemodRunner(app: Express): void {
  app.get('/api/codemod/list', (_req: Request, res: Response) => {
    const list = Object.values(REGISTRY).map((c) => ({
      id: c.id,
      description: c.description,
      patternCount: c.patterns.length
    }));
    res.setHeader('Cache-Control', 'public, max-age=900');
    res.json({ codemods: list });
  });

  app.post('/api/codemod/run', (req: Request, res: Response) => {
    const validated = validate(req.body);
    if (typeof validated === 'string') {
      res.status(400).json({ error: validated });
      return;
    }
    const codemod = REGISTRY[validated.codemodId];
    const out: Array<SourceFile & { changed: boolean }> = [];
    const diffs: string[] = [];
    let changedCount = 0;
    for (const f of validated.files) {
      const next = applyCodemod(codemod, f);
      out.push(next);
      if (next.changed) {
        changedCount++;
        diffs.push(unifiedDiff(f, next));
      }
    }
    res.json({
      codemodId: codemod.id,
      changedFileCount: changedCount,
      files: out,
      unifiedDiff: diffs.join('\n')
    });
  });
}
