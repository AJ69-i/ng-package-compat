/**
 * Standalone JS port of src/server/api-diff/{fetcher,parser,differ}.ts
 * for the dev-proxy. Mirrors the TS implementation field-for-field so
 * dev-mode behavior matches production exactly — same fetch fallback
 * chain, same TS-compiler-based parsing, same diff + rename heuristic,
 * same JSON output shape.
 *
 * Why a parallel JS file vs importing the TS:
 *   - dev-proxy.mjs runs as a standalone Node script (no Angular SSR
 *     build to compile the .ts files)
 *   - We avoid pulling in tsx/ts-node as a dev dep just for this
 *   - The TS version stays the canonical source for the SSR Express
 *     route in src/server.ts — this is the dev shim only
 *
 * Trade-off accepted: the JS and TS engines duplicate logic. The two
 * are co-located in the repo so a future PR can refactor to a shared
 * .mjs core + a thin TS wrapper. For now, V2.0 ships with both.
 */

import ts from 'typescript';

/* ─────────────────────── fetcher ─────────────────────── */

const CDN_HOSTS = [
  'https://unpkg.com',
  'https://cdn.jsdelivr.net/npm'
];

const MAX_FILES_PER_BUNDLE = 64;

const ENTRY_RESOLVERS = [
  (p) => (typeof p.types === 'string' ? { path: p.types, origin: 'package-types-field' } : null),
  (p) => (typeof p.typings === 'string' ? { path: p.typings, origin: 'package-typings-field' } : null),
  () => ({ path: 'index.d.ts', origin: 'index.d.ts' })
];

async function tryFetch(pkgRef, path) {
  for (const host of CDN_HOSTS) {
    try {
      const res = await fetch(`${host}/${pkgRef}/${path}`);
      if (res.ok) return await res.text();
    } catch { /* try next host */ }
  }
  return null;
}

async function fetchPackageJson(pkg, version) {
  const text = await tryFetch(`${pkg}@${version}`, 'package.json');
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeEntryPath(rawPath) {
  let out = rawPath.replace(/^\.\//, '');
  if (!out.endsWith('.d.ts')) {
    out = out.endsWith('.ts') ? out.replace(/\.ts$/, '.d.ts') : `${out}.d.ts`;
  }
  return out;
}

function resolveRelativeDts(currentFile, relImport) {
  const segments = currentFile.split('/').slice(0, -1);
  for (const seg of relImport.split('/')) {
    if (seg === '..') segments.pop();
    else if (seg !== '.') segments.push(seg);
  }
  let path = segments.join('/');
  if (!path.endsWith('.d.ts')) path += '.d.ts';
  return path;
}

async function walkReExports(pkgRef, entryFile, entryContent, origin) {
  const files = new Map();
  const unresolved = [];
  const queue = [{ path: entryFile, content: entryContent }];
  const reExportRegex = /export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g;

  while (queue.length && files.size < MAX_FILES_PER_BUNDLE) {
    const { path, content } = queue.shift();
    if (files.has(path)) continue;
    files.set(path, content);
    reExportRegex.lastIndex = 0;
    let match;
    while ((match = reExportRegex.exec(content))) {
      const target = match[1];
      if (!target.startsWith('.')) {
        if (!unresolved.includes(target)) unresolved.push(target);
        continue;
      }
      const resolved = resolveRelativeDts(path, target);
      if (files.has(resolved)) continue;
      const child = await tryFetch(pkgRef, resolved);
      if (child) {
        queue.push({ path: resolved, content: child });
      } else {
        const indexed = resolved.replace(/\.d\.ts$/, '/index.d.ts');
        const indexedChild = await tryFetch(pkgRef, indexed);
        if (indexedChild) {
          queue.push({ path: indexed, content: indexedChild });
        } else if (!unresolved.includes(resolved)) {
          unresolved.push(resolved);
        }
      }
    }
  }
  for (const remaining of queue) {
    if (!unresolved.includes(remaining.path)) unresolved.push(remaining.path);
  }
  return { files, source: { origin, filesAnalyzed: files.size, unresolved } };
}

async function fetchDtsBundle(pkg, version) {
  const ownPkgJson = await fetchPackageJson(pkg, version);
  if (ownPkgJson) {
    for (const resolver of ENTRY_RESOLVERS) {
      const entry = resolver(ownPkgJson);
      if (!entry) continue;
      const normalized = normalizeEntryPath(entry.path);
      const root = await tryFetch(`${pkg}@${version}`, normalized);
      if (root) return walkReExports(`${pkg}@${version}`, normalized, root, entry.origin);
    }
  }
  const dtName = pkg.startsWith('@')
    ? `@types/${pkg.slice(1).replace('/', '__')}`
    : `@types/${pkg}`;
  const dtPkgJson = await fetchPackageJson(dtName, 'latest');
  if (dtPkgJson) {
    for (const resolver of ENTRY_RESOLVERS) {
      const entry = resolver(dtPkgJson);
      if (!entry) continue;
      const normalized = normalizeEntryPath(entry.path);
      const root = await tryFetch(`${dtName}@latest`, normalized);
      if (root) return walkReExports(`${dtName}@latest`, normalized, root, 'dt-fallback');
    }
  }
  return { files: new Map(), source: { origin: 'none', filesAnalyzed: 0, unresolved: [] } };
}

/* ─────────────────────── parser ─────────────────────── */

const printer = ts.createPrinter({
  removeComments: true,
  omitTrailingSemicolon: false,
  newLine: ts.NewLineKind.LineFeed
});

function modulePathFromFile(path) {
  const cleaned = path
    .replace(/^dist\//, '')
    .replace(/^lib\//, '')
    .replace(/^types\//, '')
    .replace(/\.d\.ts$/, '')
    .replace(/\/index$/, '');
  return cleaned || 'index';
}

function hasExportModifier(node) {
  return !!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function hasPrivateOrProtected(member) {
  return !!member.modifiers?.some((m) =>
    m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword
  );
}

function printNode(node, sf) {
  return printer.printNode(ts.EmitHint.Unspecified, node, sf).trim();
}

function printFunctionSignature(fn, sf) {
  const params = fn.parameters.map((p) => printNode(p, sf)).join(', ');
  const ret = fn.type ? printNode(fn.type, sf) : 'void';
  const typeParams = fn.typeParameters?.map((tp) => printNode(tp, sf)).join(', ');
  const generics = typeParams ? `<${typeParams}>` : '';
  return `${generics}(${params}) => ${ret}`;
}

function printClassSignature(cls, sf) {
  const members = [];
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

function printInterfaceSignature(iface, sf) {
  const members = iface.members.map((m) => printNode(m, sf)).sort().join('; ');
  const typeParams = iface.typeParameters?.map((tp) => printNode(tp, sf)).join(', ');
  const generics = typeParams ? `<${typeParams}>` : '';
  const heritage = iface.heritageClauses?.map((h) => printNode(h, sf)).join(' ') ?? '';
  const ext = heritage ? ` ${heritage}` : '';
  return `interface${generics}${ext} { ${members} }`;
}

function printEnumSignature(en, sf) {
  const members = en.members.map((m) => printNode(m, sf)).sort().join(', ');
  return `enum { ${members} }`;
}

function extractJsDoc(node) {
  const fullText = node.getFullText?.();
  if (!fullText) return undefined;
  const docMatch = /\/\*\*([\s\S]*?)\*\//.exec(fullText);
  if (!docMatch) return undefined;
  const doc = docMatch[1];
  const result = {};
  const dep = /@deprecated\b[ \t]*([^\n*]*)/.exec(doc);
  if (dep) result.deprecated = dep[1].trim();
  const since = /@since\s+(\S+)/.exec(doc);
  if (since) result.since = since[1];
  return Object.keys(result).length > 0 ? result : undefined;
}

function extractFromSourceFile(sf, modulePath, out) {
  const seen = new Set();
  const push = (sym) => {
    const key = `${sym.modulePath}::${sym.kind}::${sym.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(sym);
  };

  for (const stmt of sf.statements) {
    if (!hasExportModifier(stmt) && !ts.isExportAssignment(stmt) && !ts.isExportDeclaration(stmt)) {
      continue;
    }
    const line = sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1;
    const jsDoc = extractJsDoc(stmt);

    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      push({ name: stmt.name.text, kind: 'function', signature: printFunctionSignature(stmt, sf), modulePath, line, jsDoc });
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      push({ name: stmt.name.text, kind: 'class', signature: printClassSignature(stmt, sf), modulePath, line, jsDoc });
    } else if (ts.isInterfaceDeclaration(stmt)) {
      push({ name: stmt.name.text, kind: 'interface', signature: printInterfaceSignature(stmt, sf), modulePath, line, jsDoc });
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      push({ name: stmt.name.text, kind: 'type', signature: printNode(stmt.type, sf), modulePath, line, jsDoc });
    } else if (ts.isEnumDeclaration(stmt)) {
      push({ name: stmt.name.text, kind: 'enum', signature: printEnumSignature(stmt, sf), modulePath, line, jsDoc });
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        push({
          name: decl.name.text, kind: 'const',
          signature: decl.type ? printNode(decl.type, sf) : 'unknown',
          modulePath, line, jsDoc
        });
      }
    } else if (ts.isModuleDeclaration(stmt) && stmt.name) {
      push({ name: stmt.name.getText(sf), kind: 'namespace', signature: 'namespace', modulePath, line, jsDoc });
    }
  }
}

function parseBundle(bundle) {
  const symbols = [];
  for (const [filePath, content] of bundle.files) {
    const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    extractFromSourceFile(sf, modulePathFromFile(filePath), symbols);
  }
  return symbols;
}

/* ─────────────────────── differ ─────────────────────── */

const MAX_PER_BUCKET = 200;
const RENAME_SIMILARITY_THRESHOLD = 0.7;

function keyOf(s) { return `${s.modulePath}::${s.kind}::${s.name}`; }
function indexByKey(symbols) { return new Map(symbols.map((s) => [keyOf(s), s])); }

function signatureSimilarity(a, b) {
  const tokenize = (s) => new Set(s.toLowerCase().split(/[^a-z0-9_]+/i).filter(Boolean));
  const aTok = tokenize(a);
  const bTok = tokenize(b);
  if (aTok.size === 0 && bTok.size === 0) return 1;
  if (aTok.size === 0 || bTok.size === 0) return 0;
  let inter = 0;
  for (const t of aTok) if (bTok.has(t)) inter++;
  return inter / (aTok.size + bTok.size - inter);
}

function scoreBreaking(before, after) {
  if (before === after) return 0;
  const paramCount = (s) => {
    const m = /\(([^)]*)\)/.exec(s);
    if (!m) return -1;
    const inner = m[1].trim();
    return inner ? inner.split(',').length : 0;
  };
  const beforeP = paramCount(before);
  const afterP = paramCount(after);
  const returnPart = (s) => {
    const arrowIdx = s.lastIndexOf('=>');
    if (arrowIdx !== -1) return s.slice(arrowIdx + 2).trim();
    const colonIdx = s.lastIndexOf(':');
    return colonIdx !== -1 ? s.slice(colonIdx + 1).trim() : '';
  };
  const returnChanged = returnPart(before) !== returnPart(after);

  let score = 0.3;
  if (afterP > beforeP && beforeP !== -1) score = Math.max(score, 0.6);
  if (afterP < beforeP && afterP !== -1) score = Math.max(score, 0.7);
  if (returnChanged) score = Math.max(score, 0.8);
  return Math.min(score, 1);
}

function detectRenames(removed, added) {
  const renameCandidates = [];
  const claimedAdded = new Set();
  const claimedRemoved = new Set();
  for (const r of removed) {
    let best = null;
    for (const a of added) {
      const aKey = keyOf(a);
      if (claimedAdded.has(aKey)) continue;
      if (a.kind !== r.kind || a.modulePath !== r.modulePath) continue;
      const sim = signatureSimilarity(r.signature, a.signature);
      if (sim >= RENAME_SIMILARITY_THRESHOLD && (!best || sim > best.sim)) {
        best = { added: a, sim };
      }
    }
    if (best) {
      renameCandidates.push({ fromSymbol: r, toSymbol: best.added, similarity: best.sim });
      claimedAdded.add(keyOf(best.added));
      claimedRemoved.add(keyOf(r));
    }
  }
  return {
    renameCandidates,
    finalAdded: added.filter((a) => !claimedAdded.has(keyOf(a))),
    finalRemoved: removed.filter((r) => !claimedRemoved.has(keyOf(r)))
  };
}

function diffSurfaces(pkg, fromVersion, toVersion, fromSymbols, toSymbols, sources) {
  const fromIndex = indexByKey(fromSymbols);
  const toIndex = indexByKey(toSymbols);
  const added = [];
  const removed = [];
  const signatureChanged = [];
  const newlyDeprecated = [];

  for (const [key, fromSym] of fromIndex) {
    const toSym = toIndex.get(key);
    if (!toSym) { removed.push(fromSym); continue; }
    if (fromSym.signature !== toSym.signature) {
      signatureChanged.push({
        name: toSym.name, kind: toSym.kind, modulePath: toSym.modulePath,
        before: fromSym.signature, after: toSym.signature,
        breakingScore: scoreBreaking(fromSym.signature, toSym.signature)
      });
    }
    const wasDep = fromSym.jsDoc?.deprecated !== undefined;
    const isDep = toSym.jsDoc?.deprecated !== undefined;
    if (!wasDep && isDep) {
      newlyDeprecated.push({ symbol: toSym, message: toSym.jsDoc?.deprecated ?? '' });
    }
  }
  for (const [key, toSym] of toIndex) {
    if (!fromIndex.has(key)) added.push(toSym);
  }

  const { renameCandidates, finalAdded, finalRemoved } = detectRenames(removed, added);

  signatureChanged.sort((a, b) => b.breakingScore - a.breakingScore);
  finalAdded.sort((a, b) => a.name.localeCompare(b.name));
  finalRemoved.sort((a, b) => a.name.localeCompare(b.name));

  const truncation = {
    added: Math.max(0, finalAdded.length - MAX_PER_BUCKET),
    removed: Math.max(0, finalRemoved.length - MAX_PER_BUCKET),
    signatureChanged: Math.max(0, signatureChanged.length - MAX_PER_BUCKET)
  };

  return {
    pkg, fromVersion, toVersion,
    added: finalAdded.slice(0, MAX_PER_BUCKET),
    removed: finalRemoved.slice(0, MAX_PER_BUCKET),
    signatureChanged: signatureChanged.slice(0, MAX_PER_BUCKET),
    renameCandidates,
    newlyDeprecated,
    truncation,
    sources
  };
}

/* ─────────────────────── cache (memory-only in dev) ─────────────────────── */

const memCache = new Map();
const MEM_CACHE_MAX = 50;

function cacheKey(pkg, lo, hi) { return `${pkg}@${lo}..${hi}`; }

function readMemCache(pkg, lo, hi) {
  return memCache.get(cacheKey(pkg, lo, hi)) ?? null;
}

function writeMemCache(diff) {
  const k = cacheKey(diff.pkg, diff.fromVersion, diff.toVersion);
  memCache.delete(k);
  memCache.set(k, diff);
  while (memCache.size > MEM_CACHE_MAX) {
    const oldest = memCache.keys().next().value;
    if (!oldest) break;
    memCache.delete(oldest);
  }
}

/* ─────────────────────── route handler (public export) ─────────────────────── */

function compareSemver(a, b) {
  const split = (v) => {
    const [core, ...pre] = v.split('-');
    return [core.split('.').map((n) => Number(n) || 0), pre.join('-')];
  };
  const [aNums, aPre] = split(a);
  const [bNums, bPre] = split(b);
  for (let i = 0; i < Math.max(aNums.length, bNums.length); i++) {
    const an = aNums[i] ?? 0;
    const bn = bNums[i] ?? 0;
    if (an !== bn) return an - bn;
  }
  if (aPre && !bPre) return -1;
  if (!aPre && bPre) return 1;
  return aPre.localeCompare(bPre);
}

/**
 * Express handler. Mirrors src/server/api-diff/route.ts in dev.
 * Map this on dev-proxy.mjs as: app.get('/api/api-diff', apiDiffHandler).
 */
export async function apiDiffHandler(req, res) {
  const pkg = String(req.query.pkg || '').trim();
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();

  if (!pkg || !from || !to) {
    res.status(400).json({ error: 'missing-params', detail: 'pkg, from, to are required.' });
    return;
  }

  const [lo, hi] = compareSemver(from, to) <= 0 ? [from, to] : [to, from];

  const cached = readMemCache(pkg, lo, hi);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    res.json(cached);
    return;
  }

  try {
    const [fromBundle, toBundle] = await Promise.all([
      fetchDtsBundle(pkg, lo),
      fetchDtsBundle(pkg, hi)
    ]);
    const fromSymbols = parseBundle(fromBundle);
    const toSymbols = parseBundle(toBundle);
    const diff = diffSurfaces(pkg, lo, hi, fromSymbols, toSymbols, {
      from: fromBundle.source,
      to: toBundle.source
    });
    writeMemCache(diff);
    res.setHeader('X-Cache', 'MISS');
    res.json(diff);
  } catch (err) {
    console.error('[dev-proxy api-diff] error', { pkg, lo, hi, err });
    res.status(500).json({ error: 'diff-failed', detail: err?.message ?? String(err) });
  }
}