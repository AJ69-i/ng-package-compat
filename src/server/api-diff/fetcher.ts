import type { ApiSourceDescriptor } from './types';

/**
 * Bundle of .d.ts files extracted for one (pkg, version) pair, ready
 * to feed the parser. Keys are sub-paths relative to the package root
 * ("dist/index.d.ts", "dist/operators/index.d.ts", etc.). The parser
 * walks every file in this map and dedupes symbols across them.
 */
export interface DtsBundle {
  files: Map<string, string>;
  source: ApiSourceDescriptor;
}

/**
 * CDN hosts we try in order. unpkg has historically been first-class
 * for npm-package serving but occasionally rate-limits; jsdelivr is
 * the secondary with the same URL pattern. We deliberately do NOT
 * extract tarballs from registry.npmjs.org — both CDNs already do
 * that work and serve individual files, which is exactly what we want.
 */
const CDN_HOSTS = [
  'https://unpkg.com',
  'https://cdn.jsdelivr.net/npm'
] as const;

/**
 * Maximum number of .d.ts files we'll follow via same-package
 * re-exports before stopping. Bounds analysis for monorepo packages
 * like @angular/core whose internal barrel structure has hundreds of
 * sub-files. Hitting the cap = partial-but-correct analysis (the diff
 * over visited files is still accurate); the AI is told it's working
 * with capped data so it can hedge appropriately.
 */
const MAX_FILES_PER_BUNDLE = 64;

/**
 * Order of attempts to resolve the typed entry point from a
 * package.json. We try the package's own declarations first (always
 * authoritative when present), then conventional locations, and only
 * fall back to DefinitelyTyped as a last resort.
 *
 * Each resolver returns the relative path within the package +
 * the `origin` label that explains where we found it.
 */
const ENTRY_RESOLVERS: Array<
  (pkgJson: Record<string, unknown>) =>
    { path: string; origin: ApiSourceDescriptor['origin'] } | null
> = [
  (p) => (typeof p['types'] === 'string'
    ? { path: p['types'] as string, origin: 'package-types-field' }
    : null),
  (p) => (typeof p['typings'] === 'string'
    ? { path: p['typings'] as string, origin: 'package-typings-field' }
    : null),
  // Conventional default — no manifest entry needed.
  () => ({ path: 'index.d.ts', origin: 'index.d.ts' })
];

/**
 * Fetch the complete .d.ts bundle for a (pkg, version) pair.
 *
 * Strategy:
 *
 *   1. Read package.json from unpkg (jsdelivr fallback) — gives us
 *      the `types` / `typings` entry point.
 *   2. Try each ENTRY_RESOLVER until one resolves a fetchable file.
 *   3. Once we have the root .d.ts, recursively follow
 *      `export * from './...'` and `export { ... } from './...'`
 *      until the bundle is closed OR we hit MAX_FILES_PER_BUNDLE.
 *   4. If the package ships no types of its own, try
 *      `@types/{normalizedName}` from DefinitelyTyped.
 *   5. If THAT also fails, return source.origin = 'none' and an
 *      empty file map. The AI step is told to fall back to
 *      narrative-only mode and lower confidence to 'low'.
 */
export async function fetchDtsBundle(pkg: string, version: string): Promise<DtsBundle> {
  // ── 1. Try the package's own types ──
  const ownPkgJson = await fetchPackageJson(pkg, version);
  if (ownPkgJson) {
    for (const resolver of ENTRY_RESOLVERS) {
      const entry = resolver(ownPkgJson);
      if (!entry) continue;
      const normalizedEntry = normalizeEntryPath(entry.path);
      const rootContent = await tryFetch(`${pkg}@${version}`, normalizedEntry);
      if (rootContent) {
        return walkReExports(
          `${pkg}@${version}`, normalizedEntry, rootContent, entry.origin
        );
      }
    }
  }

  // ── 2. Fall back to DefinitelyTyped @types/<pkg> ──
  //
  // Scope normalization:
  //   lodash       → @types/lodash
  //   @foo/bar     → @types/foo__bar          (scope flattened with __)
  //
  // DT packages don't follow the original package's version, so we
  // always pull `latest` — DT's own publication cadence determines
  // currency, and we tag this as `origin: 'dt-fallback'` so the UI/AI
  // can warn that the types may be lagging the runtime.
  const dtName = pkg.startsWith('@')
    ? `@types/${pkg.slice(1).replace('/', '__')}`
    : `@types/${pkg}`;
  const dtPkgJson = await fetchPackageJson(dtName, 'latest');
  if (dtPkgJson) {
    for (const resolver of ENTRY_RESOLVERS) {
      const entry = resolver(dtPkgJson);
      if (!entry) continue;
      const normalizedEntry = normalizeEntryPath(entry.path);
      const rootContent = await tryFetch(`${dtName}@latest`, normalizedEntry);
      if (rootContent) {
        return walkReExports(
          `${dtName}@latest`, normalizedEntry, rootContent, 'dt-fallback'
        );
      }
    }
  }

  // ── 3. No types available anywhere ──
  return {
    files: new Map(),
    source: { origin: 'none', filesAnalyzed: 0, unresolved: [] }
  };
}

/**
 * BFS over same-package re-exports, starting from the entry file.
 *
 * Re-export forms we follow (all start with `./` or `../`):
 *   export * from './foo'
 *   export { A, B } from './foo'
 *   export { A as Renamed } from './foo'
 *   export type { T } from './foo'
 *
 * Re-exports we deliberately DON'T follow:
 *   - Cross-package: `export * from 'other-package'`
 *     Tracked in `unresolved` so the UI can show "N cross-package
 *     re-exports not followed". Following them would explode the
 *     analysis time budget and produce diffs that mix multiple
 *     packages' API surfaces.
 *   - TS path aliases: `export * from '~/internal'`
 *     We'd need to read tsconfig paths to resolve these, which
 *     varies between packages. Recorded in `unresolved`.
 *
 * Cap behavior: when we hit MAX_FILES_PER_BUNDLE, we stop visiting
 * new files but the bundle is still well-formed. Remaining queued
 * files land in `unresolved` so transparency is preserved.
 */
async function walkReExports(
  pkgRef: string,
  entryFile: string,
  entryContent: string,
  origin: ApiSourceDescriptor['origin']
): Promise<DtsBundle> {
  const files = new Map<string, string>();
  const unresolved: string[] = [];
  const queue: Array<{ path: string; content: string }> = [
    { path: entryFile, content: entryContent }
  ];

  // We don't need the full TypeScript parser to extract re-export
  // targets — re-export statements are syntactically simple and a
  // focused regex is an order of magnitude faster than spinning up
  // a TS source file just to walk imports.
  //
  // Pattern explanation:
  //   export                    literal
  //   \s+(?:type\s+)?          optional "type" keyword (TS 3.8+ type-only re-exports)
  //   (?:\*|\{[^}]*\})         either `*` or `{ named imports }`
  //   \s+from\s+               "from" keyword
  //   ['"]([^'"]+)['"]         the quoted module path (captured)
  const reExportRegex =
    /export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g;

  while (queue.length && files.size < MAX_FILES_PER_BUNDLE) {
    const { path, content } = queue.shift()!;
    if (files.has(path)) continue;        // already visited via another path
    files.set(path, content);

    // Reset the regex state — exec() is stateful across calls when
    // `g` flag is set.
    reExportRegex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = reExportRegex.exec(content))) {
      const target = match[1];
      if (!target.startsWith('.')) {
        // Cross-package or TS-path-alias — don't follow.
        if (!unresolved.includes(target)) unresolved.push(target);
        continue;
      }
      const resolved = resolveRelativeDts(path, target);
      if (files.has(resolved)) continue;
      const child = await tryFetch(pkgRef, resolved);
      if (child) {
        queue.push({ path: resolved, content: child });
      } else {
        // The path resolved but the file 404'd. Could be a re-export
        // that maps to a different file extension or to a directory's
        // index. Try one more: append `/index.d.ts`.
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

  // Anything left in the queue at cap time also goes to unresolved.
  for (const remaining of queue) {
    if (!unresolved.includes(remaining.path)) unresolved.push(remaining.path);
  }

  return {
    files,
    source: { origin, filesAnalyzed: files.size, unresolved }
  };
}

/**
 * Best-effort HTTP GET with CDN failover. Tries each CDN in order,
 * returns the first 2xx body it gets, null otherwise. We don't bother
 * with timeouts at this layer — Node's default fetch has reasonable
 * defaults and we'd rather wait than time out for a slow CDN; the
 * route-level handler has its own overall budget.
 */
async function tryFetch(pkgRef: string, path: string): Promise<string | null> {
  for (const host of CDN_HOSTS) {
    try {
      const url = `${host}/${pkgRef}/${path}`;
      const res = await fetch(url);
      if (res.ok) return await res.text();
    } catch {
      // Network error — fall through to next host.
    }
  }
  return null;
}

/**
 * Fetch + parse package.json for a (pkg, version) pair. Returns null
 * if the file isn't found, isn't valid JSON, or isn't an object.
 * Permissive Record type because we only read a few fields and tight
 * typing here would invite a tsc rabbit hole.
 */
async function fetchPackageJson(
  pkg: string, version: string
): Promise<Record<string, unknown> | null> {
  const text = await tryFetch(`${pkg}@${version}`, 'package.json');
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Normalize a typed-entry path declared in package.json. Maintainers
 * write these inconsistently across the ecosystem; the four variants
 * below cover ~98% of what we see:
 *
 *   "./dist/index.d.ts"      → "dist/index.d.ts"
 *   "dist/index.d.ts"        → "dist/index.d.ts"        (already clean)
 *   "dist/index"             → "dist/index.d.ts"        (no extension)
 *   "./types/index.ts"       → "types/index.d.ts"       (oddball .ts ext)
 *
 * The remaining 2% (custom path with weird casing, conditional
 * exports map, etc.) will 404 in tryFetch and trigger the @types
 * fallback — which is exactly the safe behavior.
 */
function normalizeEntryPath(rawPath: string): string {
  let out = rawPath.replace(/^\.\//, '');
  if (!out.endsWith('.d.ts')) {
    out = out.endsWith('.ts') ? out.replace(/\.ts$/, '.d.ts') : `${out}.d.ts`;
  }
  return out;
}

/**
 * Resolve a relative re-export path against the file that contains
 * it. Standard relative-path semantics:
 *
 *   currentFile: "dist/index.d.ts"
 *   relImport:   "./sub"
 *   → result:    "dist/sub.d.ts"
 *
 *   currentFile: "dist/foo/bar.d.ts"
 *   relImport:   "../baz"
 *   → result:    "dist/baz.d.ts"
 */
function resolveRelativeDts(currentFile: string, relImport: string): string {
  const segments = currentFile.split('/').slice(0, -1);  // drop file name
  for (const seg of relImport.split('/')) {
    if (seg === '..') segments.pop();
    else if (seg !== '.') segments.push(seg);
  }
  let path = segments.join('/');
  if (!path.endsWith('.d.ts')) path += '.d.ts';
  return path;
}
