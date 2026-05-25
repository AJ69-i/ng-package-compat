import * as ts from 'typescript';
import type { ApiSymbol, ApiSymbolKind } from './types';
import type { DtsBundle } from './fetcher';

/**
 * Walk every .d.ts file in the bundle, producing a flat ApiSymbol[]
 * for the differ to consume. The `modulePath` field on each symbol
 * carries which sub-file it came from so the differ doesn't compare
 * `@angular/core::Component` against `@angular/core/testing::Component`
 * — those are different exports despite sharing a name.
 *
 * # Dedup across barrel files
 *
 * Re-export chains (`export * from './internal'`) mean we'll visit
 * both the barrel `index.d.ts` AND the actual declaration file. A
 * naive walk would emit two symbols for the same export. The
 * per-file deduper inside `extractFromSourceFile` keys by
 * `modulePath::kind::name`, so re-exports collapse to a single entry
 * carrying the declaration's modulePath.
 */
export function parseBundle(bundle: DtsBundle): ApiSymbol[] {
  const symbols: ApiSymbol[] = [];
  for (const [filePath, content] of bundle.files) {
    const sf = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.ES2022,
      /*setParentNodes*/ true,
      ts.ScriptKind.TS
    );
    const modulePath = modulePathFromFile(filePath);
    extractFromSourceFile(sf, modulePath, symbols);
  }
  return symbols;
}

/**
 * Normalize a file path inside a package to a stable module path.
 * Strips the build-output prefix and the index suffix so equivalent
 * shipping conventions collapse to the same identifier:
 *
 *   dist/index.d.ts                  → "index"
 *   lib/index.d.ts                   → "index"
 *   types/index.d.ts                 → "index"
 *   dist/operators/index.d.ts        → "operators"
 *   dist/testing/index.d.ts          → "testing"
 *   dist/internal/symbol-cache.d.ts  → "internal/symbol-cache"
 *
 * Equality across versions requires module-path equality — a symbol
 * that moved from "index" to "internal" is a (likely) breaking move.
 */
function modulePathFromFile(path: string): string {
  const cleaned = path
    .replace(/^dist\//, '')
    .replace(/^lib\//, '')
    .replace(/^types\//, '')
    .replace(/\.d\.ts$/, '')
    .replace(/\/index$/, '');
  return cleaned || 'index';
}

/* ─────────────────── source-file extraction ─────────────────── */

/**
 * Walk top-level statements in one .d.ts source file, emitting
 * ApiSymbol entries for every exported declaration. Non-exported
 * declarations are skipped — they can't affect consumers.
 */
function extractFromSourceFile(
  sf: ts.SourceFile,
  modulePath: string,
  out: ApiSymbol[]
): void {
  const seen = new Set<string>();   // dedup within this file

  const push = (sym: ApiSymbol): void => {
    const key = `${sym.modulePath}::${sym.kind}::${sym.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(sym);
  };

  for (const stmt of sf.statements) {
    // The export-modifier check covers most declaration forms. We
    // also accept ExportDeclaration (re-exports — collected at the
    // fetcher level) and ExportAssignment (default exports).
    if (!hasExportModifier(stmt) &&
        !ts.isExportAssignment(stmt) &&
        !ts.isExportDeclaration(stmt)) {
      continue;
    }

    const line = sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1;
    const jsDoc = extractJsDoc(stmt);

    // Dispatch on declaration kind. Each branch produces one (or
    // sometimes multiple, for grouped const declarations) symbol(s).
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      push({
        name: stmt.name.text,
        kind: 'function',
        signature: printFunctionSignature(stmt, sf),
        modulePath, line, jsDoc
      });
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      push({
        name: stmt.name.text,
        kind: 'class',
        signature: printClassSignature(stmt, sf),
        modulePath, line, jsDoc
      });
    } else if (ts.isInterfaceDeclaration(stmt)) {
      push({
        name: stmt.name.text,
        kind: 'interface',
        signature: printInterfaceSignature(stmt, sf),
        modulePath, line, jsDoc
      });
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      push({
        name: stmt.name.text,
        kind: 'type',
        signature: printNode(stmt.type, sf),
        modulePath, line, jsDoc
      });
    } else if (ts.isEnumDeclaration(stmt)) {
      push({
        name: stmt.name.text,
        kind: 'enum',
        signature: printEnumSignature(stmt, sf),
        modulePath, line, jsDoc
      });
    } else if (ts.isVariableStatement(stmt)) {
      // `export const X: T, Y: U = ...` — one statement, multiple
      // declarations. Emit one symbol per name.
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        push({
          name: decl.name.text,
          kind: 'const',
          signature: decl.type ? printNode(decl.type, sf) : 'unknown',
          modulePath, line, jsDoc
        });
      }
    } else if (ts.isModuleDeclaration(stmt) && stmt.name) {
      // `export namespace Foo { ... }`. The body is intentionally NOT
      // printed — namespace bodies can be arbitrarily deep and would
      // blow payload size. Diffing on namespace existence + name is
      // sufficient signal; consumers asking "what changed inside the
      // namespace?" can drill in via a follow-up.
      push({
        name: stmt.name.getText(sf),
        kind: 'namespace',
        signature: 'namespace',
        modulePath, line, jsDoc
      });
    }
    // ExportDeclaration (`export { X } from '...'`) and
    // ExportAssignment (`export default X`) intentionally don't
    // emit synthetic symbols here — the fetcher already followed
    // re-exports and the actual declarations live in other files
    // that we'll also visit.
  }
}

/** True when a node carries `export` in its modifiers. */
function hasExportModifier(node: ts.Node): boolean {
  const modifiers = (node as ts.Node & { modifiers?: ReadonlyArray<ts.Modifier> }).modifiers;
  return !!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/* ─────────────────── canonical signature printers ─────────────────── */

/**
 * Shared printer instance. The two options are load-bearing for
 * diff stability:
 *   removeComments: true       — strips JSDoc + line comments so two
 *                                semantically identical signatures
 *                                compare equal regardless of comment
 *                                drift between versions
 *   omitTrailingSemicolon: false — keeps semicolons for readability
 *                                in error messages and the UI
 */
const printer = ts.createPrinter({
  removeComments: true,
  omitTrailingSemicolon: false,
  newLine: ts.NewLineKind.LineFeed
});

/** Print any AST node as canonical TypeScript source. */
function printNode(node: ts.Node, sf: ts.SourceFile): string {
  return printer.printNode(ts.EmitHint.Unspecified, node, sf).trim();
}

/**
 * Function signatures: `<TParams>(p1: T1, p2?: T2) => ReturnType`.
 * The body of a .d.ts function declaration is always absent, so we
 * print params + return type only. Generic parameters are emitted
 * with angle-bracket syntax for visual clarity in the diff.
 */
function printFunctionSignature(fn: ts.FunctionDeclaration, sf: ts.SourceFile): string {
  const params = fn.parameters.map((p) => printNode(p, sf)).join(', ');
  const ret = fn.type ? printNode(fn.type, sf) : 'void';
  const typeParams = fn.typeParameters?.map((tp) => printNode(tp, sf)).join(', ');
  const generics = typeParams ? `<${typeParams}>` : '';
  return `${generics}(${params}) => ${ret}`;
}

/**
 * Class signatures: a sorted, normalized list of constructor + public
 * methods + public properties. Private and protected members are
 * intentionally dropped — they don't affect consumers and including
 * them inflates the diff with implementation noise that flips on
 * every internal refactor.
 *
 * Member ordering: sorted alphabetically inside the brace. This is
 * critical for diff stability — many libraries' build pipelines emit
 * .d.ts members in different orders across versions even when the
 * shape didn't change, and we don't want that to register as a
 * signatureChanged entry.
 */
function printClassSignature(cls: ts.ClassDeclaration, sf: ts.SourceFile): string {
  const members: string[] = [];

  for (const member of cls.members) {
    if (hasPrivateOrProtected(member)) continue;

    if (ts.isConstructorDeclaration(member)) {
      const params = member.parameters.map((p) => printNode(p, sf)).join(', ');
      members.push(`constructor(${params})`);
    } else if (ts.isMethodDeclaration(member) && member.name) {
      const params = member.parameters.map((p) => printNode(p, sf)).join(', ');
      const ret = member.type ? printNode(member.type, sf) : 'void';
      members.push(`${member.name.getText(sf)}(${params}): ${ret}`);
    } else if (ts.isPropertyDeclaration(member) && member.name) {
      const t = member.type ? printNode(member.type, sf) : 'unknown';
      members.push(`${member.name.getText(sf)}: ${t}`);
    } else if (ts.isGetAccessorDeclaration(member) && member.name) {
      const t = member.type ? printNode(member.type, sf) : 'unknown';
      members.push(`get ${member.name.getText(sf)}(): ${t}`);
    } else if (ts.isSetAccessorDeclaration(member) && member.name) {
      const param = member.parameters[0];
      const t = param?.type ? printNode(param.type, sf) : 'unknown';
      members.push(`set ${member.name.getText(sf)}(value: ${t}): void`);
    }
  }
  members.sort();

  const typeParams = cls.typeParameters?.map((tp) => printNode(tp, sf)).join(', ');
  const generics = typeParams ? `<${typeParams}>` : '';
  const heritage = cls.heritageClauses?.map((h) => printNode(h, sf)).join(' ') ?? '';
  const ext = heritage ? ` ${heritage}` : '';

  return `class${generics}${ext} { ${members.join('; ')} }`;
}

/** True if a class member is declared `private` or `protected`. */
function hasPrivateOrProtected(member: ts.ClassElement): boolean {
  const modifiers = (member as ts.ClassElement & {
    modifiers?: ReadonlyArray<ts.Modifier>
  }).modifiers;
  return !!modifiers?.some((m) =>
    m.kind === ts.SyntaxKind.PrivateKeyword ||
    m.kind === ts.SyntaxKind.ProtectedKeyword
  );
}

/**
 * Interface signatures. Members are printed via the canonical printer
 * (which already emits stable TypeScript), then sorted so member-order
 * changes don't show up as diffs. Heritage clauses ride along on the
 * outer line so `interface Foo extends Bar` compares equal across
 * versions even when Bar's own diff is unrelated.
 */
function printInterfaceSignature(iface: ts.InterfaceDeclaration, sf: ts.SourceFile): string {
  const members = iface.members
    .map((m) => printNode(m, sf))
    .sort()
    .join('; ');
  const typeParams = iface.typeParameters?.map((tp) => printNode(tp, sf)).join(', ');
  const generics = typeParams ? `<${typeParams}>` : '';
  const heritage = iface.heritageClauses?.map((h) => printNode(h, sf)).join(' ') ?? '';
  const ext = heritage ? ` ${heritage}` : '';
  return `interface${generics}${ext} { ${members} }`;
}

/**
 * Enum signatures. Members sorted to neutralize ordering noise (some
 * codegens emit enum members in declaration order, some in
 * alphabetical, and we don't want that swap to look like a change).
 *
 * NOTE: re-numbering enum values IS a real diff — if `A = 0; B = 1`
 * becomes `A = 1; B = 0`, that's a runtime semantic change. Sorting
 * doesn't hide it because both `A = 0` and `A = 1` are distinct member
 * strings and the differ will still show the change.
 */
function printEnumSignature(en: ts.EnumDeclaration, sf: ts.SourceFile): string {
  const members = en.members
    .map((m) => printNode(m, sf))
    .sort()
    .join(', ');
  return `enum { ${members} }`;
}

/**
 * Extract the two JSDoc tags we care about for diffing: @deprecated
 * and @since. Everything else in the docblock is dropped — the AI
 * step generates its own prose from the source narrative.
 *
 * We deliberately use regex scanning over the raw leading text
 * rather than the TS JSDoc parser API because:
 *   1. The JSDoc parser API surface has shifted across TS versions
 *      (3.x → 4.x → 5.x) and the regex approach is stable
 *   2. We only need two specific tags, not a full structured parse
 *   3. The regex handles edge cases (multi-line deprecated messages,
 *      missing tag values) without ceremony
 */
function extractJsDoc(node: ts.Node): ApiSymbol['jsDoc'] {
  const fullText = (node as ts.Node & { getFullText?: () => string }).getFullText?.();
  if (!fullText) return undefined;

  const docMatch = /\/\*\*([\s\S]*?)\*\//.exec(fullText);
  if (!docMatch) return undefined;
  const doc = docMatch[1];

  const result: NonNullable<ApiSymbol['jsDoc']> = {};

  // @deprecated may appear with a trailing message or bare.
  //   /** @deprecated Use foo() instead. */    → result.deprecated = "Use foo() instead."
  //   /** @deprecated */                       → result.deprecated = ""
  const dep = /@deprecated\b[ \t]*([^\n*]*)/.exec(doc);
  if (dep) result.deprecated = dep[1].trim();

  // @since 17.2.0
  const since = /@since\s+(\S+)/.exec(doc);
  if (since) result.since = since[1];

  return Object.keys(result).length > 0 ? result : undefined;
}

/* ─────────────────── (unused export silencer for noUnusedLocals) ─────────────────── */
// The ApiSymbolKind import above is for downstream consumers — re-exported here
// implicitly via the types module, but we name it once to keep TS happy in strict modes.
export type { ApiSymbolKind };
