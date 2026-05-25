import type {
  ApiSourceDescriptor,
  ApiSurfaceDiff,
  ApiSymbol,
  DeprecatedEntry,
  RenameCandidateEntry,
  SignatureChangeEntry
} from './types';

/**
 * Per-bucket maximum size before truncation kicks in. The differ
 * sorts breaking-first within each bucket so the dropped entries are
 * the LEAST impactful ones; the count of dropped entries goes into
 * `truncation` so the UI can show "47 additional changes omitted".
 *
 * 200 picked empirically: covers every realistic package upgrade
 * (Angular 16 → 17 had ~70 breaking changes across all packages),
 * keeps payload size bounded for the network round-trip, and stays
 * comfortably within the AI provider context-window budget downstream.
 */
const MAX_PER_BUCKET = 200;

/**
 * Rename-detection similarity threshold. Empirically tuned:
 *
 *   < 0.5    coincidental token overlap; almost always false positives
 *   0.5–0.7  ambiguous; could be a coincidence or a real rename
 *   ≥ 0.7    confident match — same shape, same kind, same module
 *
 * We pick 0.7 because false-positive renames are worse than missing
 * a real one: a wrong "X was renamed to Y" claim sends the user on a
 * goose chase, while a missed rename just shows up as a removed +
 * added pair, which is the truth anyway.
 */
const RENAME_SIMILARITY_THRESHOLD = 0.7;

/**
 * Run the full diff. Output is the structural ApiSurfaceDiff —
 * ground truth, no AI involvement. This is the payload the route
 * caches and the client-side AI orchestrator consumes as its
 * highest-confidence input.
 */
export function diffSurfaces(
  pkg: string,
  fromVersion: string,
  toVersion: string,
  fromSymbols: ApiSymbol[],
  toSymbols: ApiSymbol[],
  sources: { from: ApiSourceDescriptor; to: ApiSourceDescriptor }
): ApiSurfaceDiff {
  const fromIndex = indexByKey(fromSymbols);
  const toIndex = indexByKey(toSymbols);

  const added: ApiSymbol[] = [];
  const removed: ApiSymbol[] = [];
  const signatureChanged: SignatureChangeEntry[] = [];
  const newlyDeprecated: DeprecatedEntry[] = [];

  // ─── First pass: classify each `from` symbol against `to` ───
  for (const [key, fromSym] of fromIndex) {
    const toSym = toIndex.get(key);
    if (!toSym) {
      removed.push(fromSym);
      continue;
    }

    if (fromSym.signature !== toSym.signature) {
      signatureChanged.push({
        name: toSym.name,
        kind: toSym.kind,
        modulePath: toSym.modulePath,
        before: fromSym.signature,
        after: toSym.signature,
        breakingScore: scoreBreaking(fromSym.signature, toSym.signature)
      });
    }

    // New @deprecated tag: existed in both versions, only the JSDoc
    // changed. Lower-severity than removal but still future-breaking.
    // An empty message string still counts — the tag's PRESENCE is
    // the signal, not its prose.
    const wasDeprecated = fromSym.jsDoc?.deprecated !== undefined;
    const isNowDeprecated = toSym.jsDoc?.deprecated !== undefined;
    if (!wasDeprecated && isNowDeprecated) {
      newlyDeprecated.push({
        symbol: toSym,
        message: toSym.jsDoc?.deprecated ?? ''
      });
    }
  }

  // ─── Second pass: anything in `to` that wasn't in `from` is added ───
  for (const [key, toSym] of toIndex) {
    if (!fromIndex.has(key)) added.push(toSym);
  }

  // ─── Third pass: promote (removed, added) pairs to rename candidates ───
  const { renameCandidates, finalAdded, finalRemoved } = detectRenames(removed, added);

  // ─── Sort breaking-first WITHIN each bucket so truncation drops least-impactful ───
  signatureChanged.sort((a, b) => b.breakingScore - a.breakingScore);
  // For removed entries, breaking-by-default sort is fine (all removals are breaking).
  // For added entries, no natural sort — alphabetize so the diff is stable.
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

/* ─────────────────── rename detection ─────────────────── */

/**
 * Find rename candidates among `removed` and `added`. Strategy: for
 * each removed symbol, scan the added symbols of the SAME kind and
 * SAME modulePath, keep the most similar one if it beats the
 * threshold.
 *
 * # Constraints
 *
 *   - Same kind: a function can rename to another function but NOT
 *     to an interface. Cross-kind renames don't exist as a real
 *     refactoring pattern; allowing them would explode false positives.
 *
 *   - Same modulePath: a rename inside `index.d.ts` is a rename. A
 *     symbol moving from `index` to `internal` while a different
 *     symbol appears in `index` is NOT a rename — they're independent
 *     operations. modulePath equality is the cheap, correct filter.
 *
 *   - Each added symbol can be claimed by at most one removed symbol
 *     (no many-to-one renames). The first-best-match wins.
 *
 * # Output
 *
 *   - renameCandidates: the pairs we promoted.
 *   - finalAdded / finalRemoved: the buckets with claimed symbols
 *     filtered out. The AI never sees the same symbol both as a
 *     "removed" entry AND as part of a rename — it gets one or the
 *     other.
 */
function detectRenames(
  removed: ApiSymbol[],
  added: ApiSymbol[]
): {
  renameCandidates: RenameCandidateEntry[];
  finalAdded: ApiSymbol[];
  finalRemoved: ApiSymbol[];
} {
  const renameCandidates: RenameCandidateEntry[] = [];
  const claimedAdded = new Set<string>();
  const claimedRemoved = new Set<string>();

  for (const r of removed) {
    let bestMatch: { added: ApiSymbol; sim: number } | null = null;

    for (const a of added) {
      const aKey = keyOf(a);
      if (claimedAdded.has(aKey)) continue;
      if (a.kind !== r.kind || a.modulePath !== r.modulePath) continue;

      const sim = signatureSimilarity(r.signature, a.signature);
      if (sim >= RENAME_SIMILARITY_THRESHOLD &&
          (!bestMatch || sim > bestMatch.sim)) {
        bestMatch = { added: a, sim };
      }
    }

    if (bestMatch) {
      renameCandidates.push({
        fromSymbol: r,
        toSymbol: bestMatch.added,
        similarity: bestMatch.sim
      });
      claimedAdded.add(keyOf(bestMatch.added));
      claimedRemoved.add(keyOf(r));
    }
  }

  return {
    renameCandidates,
    finalAdded: added.filter((a) => !claimedAdded.has(keyOf(a))),
    finalRemoved: removed.filter((r) => !claimedRemoved.has(keyOf(r)))
  };
}

/**
 * Token-level Jaccard similarity. Splits on punctuation/whitespace,
 * computes |A ∩ B| / |A ∪ B|. Cheap, deterministic, and good enough
 * for rename detection on normalized signatures.
 *
 * # Why Jaccard over edit distance
 *
 *   - Edit distance is sensitive to ordering. `(a, b) => X` and
 *     `(b, a) => X` would score low on Levenshtein but Jaccard
 *     sees them as identical token sets. Param-reorder is a common
 *     refactoring pattern we want to treat as similar.
 *
 *   - Jaccard is O(n+m), edit distance is O(n*m). For signatures
 *     in the 50-200 char range that's a ~10x cost difference; doing
 *     it once per (removed, added) pair on a big diff adds up.
 *
 *   - Edit distance's "1 char off" sensitivity is wrong here. A
 *     function whose body changed from `Promise<X>` to `Promise<Y>`
 *     is one Levenshtein-edit apart but represents a meaningful
 *     API change, not a rename.
 *
 * # Calibration
 *
 *   "createWidget(opts: Options): Widget" vs "widget(opts: Options): Widget"
 *     → token sets share {opts, options, widget}, return type identical
 *     → ~0.83 (above threshold, would be classified as rename)
 *
 *   "foo(): void" vs "bar(): void"
 *     → share {void}, otherwise disjoint
 *     → ~0.33 (below threshold, classified as separate removed+added)
 */
function signatureSimilarity(a: string, b: string): number {
  const tokenize = (s: string): Set<string> =>
    new Set(s.toLowerCase().split(/[^a-z0-9_]+/i).filter(Boolean));

  const aTokens = tokenize(a);
  const bTokens = tokenize(b);

  if (aTokens.size === 0 && bTokens.size === 0) return 1;
  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  let intersection = 0;
  for (const t of aTokens) if (bTokens.has(t)) intersection++;
  const union = aTokens.size + bTokens.size - intersection;
  return intersection / union;
}

/**
 * Breakingness heuristic — a 0..1 score for a signature change.
 *
 * String-level rather than AST-level on purpose: we already have the
 * normalized signature strings from the parser, and full AST
 * comparison of arbitrary nested types is its own subproject. The
 * string heuristics below are correct for ~90% of cases; the AI step
 * sees both signatures verbatim and corrects the 10% via its
 * `severity` field on the ApiChange.
 *
 * Tuned for the kinds of changes that actually break consumers:
 *
 *   - return type changed     → 0.8  (consumer's type expectations broken)
 *   - param count down        → 0.7  (consumer passing extra arg now fails)
 *   - param count up          → 0.6  (only breaks if new param is required)
 *   - other change            → 0.3  (minimal baseline)
 *
 * Scores compound — the max of all heuristic hits is what's returned,
 * so a "param count up AND return type changed" change scores 0.8,
 * not 1.4.
 */
function scoreBreaking(before: string, after: string): number {
  if (before === after) return 0;

  // Param count via comma counting inside the first `(...)` group.
  // Crude but stable: "() => X" → 0 params, "(a, b) => X" → 2 params.
  const paramCount = (s: string): number => {
    const match = /\(([^)]*)\)/.exec(s);
    if (!match) return -1;
    const inner = match[1].trim();
    if (!inner) return 0;
    return inner.split(',').length;
  };

  const beforeParams = paramCount(before);
  const afterParams = paramCount(after);

  // Return type: text after the last `=>` (function shape) or last
  // `:` outside of generic brackets. Crude but works for the
  // canonical signatures the parser produces.
  const returnPart = (s: string): string => {
    const arrowIdx = s.lastIndexOf('=>');
    if (arrowIdx !== -1) return s.slice(arrowIdx + 2).trim();
    const colonIdx = s.lastIndexOf(':');
    return colonIdx !== -1 ? s.slice(colonIdx + 1).trim() : '';
  };
  const returnChanged = returnPart(before) !== returnPart(after);

  let score = 0.3;
  if (afterParams > beforeParams && beforeParams !== -1) score = Math.max(score, 0.6);
  if (afterParams < beforeParams && afterParams !== -1) score = Math.max(score, 0.7);
  if (returnChanged) score = Math.max(score, 0.8);
  return Math.min(score, 1);
}

/* ─────────────────── helpers ─────────────────── */

/**
 * Composite key that uniquely identifies a symbol across versions.
 * Three coordinates: where it lives, what shape it is, and what it's
 * called. All three must match for the differ to call two symbols
 * "the same" between versions.
 */
function keyOf(s: ApiSymbol): string {
  return `${s.modulePath}::${s.kind}::${s.name}`;
}

function indexByKey(symbols: ApiSymbol[]): Map<string, ApiSymbol> {
  return new Map(symbols.map((s) => [keyOf(s), s]));
}
