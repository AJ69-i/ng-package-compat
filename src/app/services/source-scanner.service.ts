import { Injectable, signal } from '@angular/core';
import {
  BreakingChange,
  SourceScanResult,
  SymbolCitation
} from '../models/npm-package.model';

/**
 * A single source file that the user handed us (via drop-zone or paste).
 * We keep the content in memory — this is a local, zero-upload tool.
 */
export interface ScannedFile {
  /** Path relative to project root (e.g. `src/app/app.component.ts`). */
  path: string;
  /** Raw contents, UTF-8. */
  content: string;
}

/**
 * Regexes for extracting what a given source file uses from a given package.
 * The goal is NOT to be a TypeScript compiler — it's to be ~90% correct at
 * low cost for the simple pattern "does this project reference API X of pkg Y".
 *
 * For TS/JS we look for:
 *   - `import { A, B as C } from 'pkg'`
 *   - `import D from 'pkg'`
 *   - `import * as P from 'pkg'` — then any `P.Symbol` reference
 *   - `require('pkg')` and destructuring of its result
 *
 * For HTML templates we look for:
 *   - structural directives (`*ngIf`, `*ngFor`, `*ngSwitch*`)
 *   - Material / Ionic / PrimeNG tag names (best-effort by prefix)
 */
const IMPORT_FROM = /import\s+(?:type\s+)?([\s\S]+?)\s+from\s+['"]([^'"]+)['"]/g;
const REQUIRE_CALL = /(?:const|let|var)\s+([\s\S]+?)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
const STAR_IMPORT = /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;

/**
 * Static helper — strips whitespace/comments from an `import { ... }` clause
 * and returns the bare local names, respecting `as` aliases (we keep the
 * original name since that's what we'll match against breaking-change symbols).
 */
function parseNamedClause(clause: string): string[] {
  // Strip the opening `{` / closing `}` if present.
  const inner = clause.replace(/^\s*{/, '').replace(/}\s*$/, '');
  const parts = inner.split(',').map((s) => s.trim()).filter(Boolean);
  const names: string[] = [];
  for (const p of parts) {
    // `toPromise as tp` → `toPromise`
    const [orig] = p.split(/\s+as\s+/);
    if (orig) names.push(orig.trim());
  }
  return names;
}

/**
 * Maps a raw import specifier (`rxjs/operators`) back to its package name
 * (`rxjs`). Handles scoped packages and sub-paths.
 */
function rootPackage(specifier: string): string {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return '';
  const parts = specifier.split('/');
  if (parts[0].startsWith('@') && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

/**
 * Source-aware breaking-change scanner.
 *
 * Given a set of source files and a list of BreakingChange[] with `symbols`
 * populated, it returns only those that are *actually* referenced in user
 * code — each annotated with file:line citations.
 *
 * This turns a wall of "21 potential breaks" into "the 3 that matter".
 */
@Injectable({ providedIn: 'root' })
export class SourceScannerService {
  /** Most recent scan result — surfaced in the UI as a chip. */
  readonly lastScan = signal<SourceScanResult | null>(null);
  /** The raw files that were scanned — retained so codemods can patch them. */
  readonly lastFiles = signal<ScannedFile[]>([]);

  scan(files: ScannedFile[]): SourceScanResult {
    const importsByPackage: Record<string, Set<string>> = {};
    const hits: Record<string, SymbolCitation[]> = {};

    for (const file of files) {
      if (!file.content) continue;
      if (/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(file.path)) {
        this.scanScript(file, importsByPackage, hits);
      } else if (/\.html?$/i.test(file.path)) {
        this.scanTemplate(file, importsByPackage, hits);
      }
    }

    const result: SourceScanResult = {
      fileCount: files.length,
      importsByPackage,
      hits
    };
    this.lastScan.set(result);
    this.lastFiles.set(files);
    return result;
  }

  /** Reset — use when switching project. */
  clear(): void {
    this.lastScan.set(null);
    this.lastFiles.set([]);
  }

  /**
   * Filter a list of breaking changes down to only those whose symbols are
   * actually referenced by the user, attaching citations. Breaks without any
   * `symbols` annotation pass through unchanged (we can't prove they don't
   * apply, so we err on the side of showing them).
   */
  annotate(pkg: string, breaks: BreakingChange[]): BreakingChange[] {
    const scan = this.lastScan();
    if (!scan) return breaks;

    const out: BreakingChange[] = [];
    for (const bc of breaks) {
      if (!bc.symbols?.length) {
        // No annotation — keep as-is so we don't silently hide risks.
        out.push(bc);
        continue;
      }
      const citations: SymbolCitation[] = [];
      for (const sym of bc.symbols) {
        const key = `${pkg}::${sym}`;
        const found = scan.hits[key];
        if (found) citations.push(...found);
      }
      if (citations.length > 0) {
        out.push({ ...bc, citations });
      }
    }
    return out;
  }

  /** For the UI: how many distinct files referenced this package? */
  filesTouching(pkg: string): number {
    const scan = this.lastScan();
    if (!scan) return 0;
    const set = new Set<string>();
    for (const key of Object.keys(scan.hits)) {
      if (!key.startsWith(`${pkg}::`)) continue;
      for (const c of scan.hits[key]) set.add(c.file);
    }
    return set.size;
  }

  // ---------- Private scanners ----------

  private scanScript(
    file: ScannedFile,
    importsByPackage: Record<string, Set<string>>,
    hits: Record<string, SymbolCitation[]>
  ): void {
    const content = file.content;

    // Track `import * as X from 'pkg'` so we can later resolve `X.symbol`.
    const namespaces = new Map<string, string>(); // localName → pkg

    let m: RegExpExecArray | null;
    const star = new RegExp(STAR_IMPORT.source, 'g');
    while ((m = star.exec(content))) {
      const local = m[1];
      const pkg = rootPackage(m[2]);
      if (!pkg) continue;
      namespaces.set(local, pkg);
      addImport(importsByPackage, pkg, '*');
    }

    const named = new RegExp(IMPORT_FROM.source, 'g');
    while ((m = named.exec(content))) {
      const clause = m[1];
      const pkg = rootPackage(m[2]);
      if (!pkg) continue;
      if (/^\s*\*/.test(clause)) continue; // already captured above

      // Default import: `import D from 'pkg'`
      const trimmed = clause.trim();
      if (!trimmed.startsWith('{')) {
        // Could be `D, { A, B }` or just `D` or `D, * as X`
        const [defaultPart, restPart] = splitDefaultAndNamed(trimmed);
        if (defaultPart) addImport(importsByPackage, pkg, defaultPart);
        if (restPart && restPart.startsWith('{')) {
          for (const n of parseNamedClause(restPart)) {
            addImport(importsByPackage, pkg, n);
            recordUsage(content, file.path, pkg, n, hits);
          }
        }
        continue;
      }

      // Named-only: `import { A, B as C } from 'pkg'`
      for (const n of parseNamedClause(clause)) {
        addImport(importsByPackage, pkg, n);
        recordUsage(content, file.path, pkg, n, hits);
      }
    }

    // require()
    const req = new RegExp(REQUIRE_CALL.source, 'g');
    while ((m = req.exec(content))) {
      const pkg = rootPackage(m[2]);
      if (!pkg) continue;
      const lhs = m[1].trim();
      if (lhs.startsWith('{')) {
        for (const n of parseNamedClause(lhs)) {
          addImport(importsByPackage, pkg, n);
          recordUsage(content, file.path, pkg, n, hits);
        }
      } else {
        addImport(importsByPackage, pkg, lhs);
      }
    }

    // Namespaced usage: `rxjs.toPromise(` or `Tone.Transport.start`
    for (const [local, pkg] of namespaces) {
      const re = new RegExp(`\\b${escape(local)}\\.(\\w+)`, 'g');
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(content))) {
        const sym = mm[1];
        addImport(importsByPackage, pkg, sym);
        recordUsageAt(file.path, pkg, sym, content, mm.index, hits);
      }
    }
  }

  private scanTemplate(
    file: ScannedFile,
    importsByPackage: Record<string, Set<string>>,
    hits: Record<string, SymbolCitation[]>
  ): void {
    const directives: Array<{ re: RegExp; pkg: string; sym: string }> = [
      { re: /\*ngIf\b/g, pkg: '@angular/common', sym: '*ngIf' },
      { re: /\*ngFor\b/g, pkg: '@angular/common', sym: '*ngFor' },
      { re: /\*ngSwitch\w*\b/g, pkg: '@angular/common', sym: '*ngSwitch' },
      { re: /\[ngClass\]/g, pkg: '@angular/common', sym: 'ngClass' },
      { re: /\[ngStyle\]/g, pkg: '@angular/common', sym: 'ngStyle' },
      // UI framework prefixes — best-effort, useful for triggering UI alerts.
      { re: /<mat-[a-z][\w-]*/g, pkg: '@angular/material', sym: '<mat-*>' },
      { re: /<ion-[a-z][\w-]*/g, pkg: '@ionic/angular', sym: '<ion-*>' },
      { re: /<p-[a-z][\w-]*/g, pkg: 'primeng', sym: '<p-*>' },
      { re: /<nz-[a-z][\w-]*/g, pkg: 'ng-zorro-antd', sym: '<nz-*>' },
      { re: /<tui-[a-z][\w-]*/g, pkg: '@taiga-ui/core', sym: '<tui-*>' }
    ];

    for (const { re, pkg, sym } of directives) {
      const local = new RegExp(re.source, re.flags);
      let m: RegExpExecArray | null;
      while ((m = local.exec(file.content))) {
        addImport(importsByPackage, pkg, sym);
        recordUsageAt(file.path, pkg, sym, file.content, m.index, hits);
      }
    }
  }
}

// ---------- Module-local helpers ----------

function addImport(
  importsByPackage: Record<string, Set<string>>,
  pkg: string,
  symbol: string
): void {
  if (!importsByPackage[pkg]) importsByPackage[pkg] = new Set<string>();
  importsByPackage[pkg].add(symbol);
}

function recordUsage(
  content: string,
  file: string,
  pkg: string,
  symbol: string,
  hits: Record<string, SymbolCitation[]>
): void {
  // Look for the first *usage* of the symbol after the import — not just the
  // import statement itself. This avoids false positives when someone imports
  // something but never actually uses it (linters catch that, but still).
  const re = new RegExp(`\\b${escape(symbol)}\\b`, 'g');
  let first: RegExpExecArray | null;
  let count = 0;
  while ((first = re.exec(content))) {
    // Skip the import line itself.
    const { line, lineText } = locate(content, first.index);
    if (/^\s*import\s+/.test(lineText)) continue;
    pushCitation(hits, pkg, symbol, file, line, lineText);
    if (++count >= 5) break; // cap citations per symbol per file
  }
}

function recordUsageAt(
  file: string,
  pkg: string,
  symbol: string,
  content: string,
  at: number,
  hits: Record<string, SymbolCitation[]>
): void {
  const { line, lineText } = locate(content, at);
  pushCitation(hits, pkg, symbol, file, line, lineText);
}

function pushCitation(
  hits: Record<string, SymbolCitation[]>,
  pkg: string,
  symbol: string,
  file: string,
  line: number,
  rawLine: string
): void {
  const key = `${pkg}::${symbol}`;
  const snippet = rawLine.trim().slice(0, 120);
  if (!hits[key]) hits[key] = [];
  // De-dupe: one citation per (file, line).
  if (hits[key].some((c) => c.file === file && c.line === line)) return;
  hits[key].push({ file, line, symbol, snippet });
}

function locate(content: string, offset: number): { line: number; lineText: string } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (content.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  let lineEnd = content.indexOf('\n', lineStart);
  if (lineEnd === -1) lineEnd = content.length;
  return { line, lineText: content.slice(lineStart, lineEnd) };
}

function splitDefaultAndNamed(clause: string): [string | null, string | null] {
  // `D` or `D, { A, B }` or `D, * as X`
  const commaIdx = clause.indexOf(',');
  if (commaIdx < 0) return [clause.trim(), null];
  return [clause.slice(0, commaIdx).trim(), clause.slice(commaIdx + 1).trim()];
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
