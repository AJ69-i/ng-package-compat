/**
 * V2 type contracts. Two distinct layers:
 *
 *   LAYER 1: ApiSurfaceDiff — structural ground truth produced by the
 *            parser + differ. NO AI involvement. Cacheable indefinitely
 *            (the diff between two specific published versions is
 *            immutable). This is what the HTTP endpoint returns.
 *
 *   LAYER 2: MigrationReport — AI-narrated translation of LAYER 1 into
 *            developer-readable prose + per-change human summaries +
 *            code examples. Returned by the client-side AI orchestrator,
 *            not by this server.
 *
 * The split is load-bearing: LAYER 1 is exact, deterministic, fast to
 * cache. LAYER 2 is the part that benefits from AI. By keeping LAYER 1
 * provider-agnostic and storing it server-side, every user (and every
 * AI provider) benefits from the same canonical structural analysis.
 */

/* ───────────────────────── LAYER 1: structural ───────────────────────── */

/**
 * A single top-level exported symbol extracted from one of the package's
 * .d.ts files. Seven `kind` values cover every TypeScript declaration
 * shape we care about; anything else (modules, ambient declarations,
 * triple-slash references) is dropped during parsing — they don't
 * appear in the public consumer-facing API surface.
 */
export interface ApiSymbol {
  name: string;
  kind: ApiSymbolKind;
  /**
   * Normalized signature text, produced by `ts.createPrinter`. Whitespace,
   * comment positions, and trailing punctuation are all canonicalized
   * so two semantically identical signatures compare equal even when
   * the source code formatting differs.
   *
   * Shape per kind:
   *   function   "<T>(a: A, b: B) => Promise<T>"
   *   class      "class<T> { constructor(...); foo(): X; bar: Y }"
   *   interface  "interface<T> extends Y { a: A; b(): B }"
   *   type       "{ ... }" — the right-hand side of the alias
   *   enum       "enum { A = 0, B = 1 }"
   *   const      "TypeOfTheConstant"
   *   namespace  "namespace" — body is intentionally NOT included
   *              (drilling into namespace bodies would explode payload
   *              size and most consumers care only about presence)
   */
  signature: string;
  /**
   * Sub-path within the package this symbol came from. Distinguishes
   * monorepo entry points: `@angular/core::Component` lives at
   * modulePath="index" while `@angular/core/testing::ComponentFixture`
   * lives at modulePath="testing". Single-entry packages always use
   * "index". Equality across versions requires modulePath to match
   * — moving a symbol from index to /testing is a breaking change.
   */
  modulePath: string;
  /**
   * JSDoc tags we care about for diffing. Anything else the maintainer
   * wrote in the docblock is dropped — the AI step generates its own
   * prose. Two tags matter structurally:
   *   - @deprecated: presence triggers a `newlyDeprecated` entry
   *                  when it appears on the to-version but not the from
   *   - @since: useful for the AI to ground "this was added in v17.0"
   *             claims in actual JSDoc metadata
   */
  jsDoc?: {
    deprecated?: string;    // value of @deprecated tag if any (empty string if tag present without text)
    since?: string;         // value of @since tag if any
  };
  /** 1-indexed line number in the source .d.ts, for debug + future UI deep-linking. */
  line: number;
}

export type ApiSymbolKind =
  | 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const' | 'namespace';

/**
 * The full structural diff. Ground truth produced by the differ, with
 * no AI involvement. Designed to be a self-contained payload — the AI
 * step needs nothing beyond what's in here to narrate the migration.
 */
export interface ApiSurfaceDiff {
  /** Echoed from the request so cached payloads are self-describing. */
  pkg: string;
  fromVersion: string;
  toVersion: string;

  /** Symbols that exist in toVersion but not fromVersion. Almost always non-breaking. */
  added: ApiSymbol[];
  /** Symbols that existed in fromVersion but are gone in toVersion. Almost always breaking. */
  removed: ApiSymbol[];
  /**
   * Same name + kind + modulePath, but the signature changed. The
   * breakingScore is a 0..1 heuristic so the UI/AI can prioritize:
   *   < 0.4    likely additive (optional param added, etc.)
   *   0.4–0.7  changed signature, may break some callers
   *   > 0.7    structural break (required param, return type changed)
   */
  signatureChanged: SignatureChangeEntry[];
  /**
   * Removed-then-added pairs the differ classifies as renames based on
   * signature similarity. The AI is told to TREAT these as candidates
   * — it may confirm them as renames in the report, or split them back
   * into separate removed+added entries if the signatures suggest
   * fundamentally different operations.
   */
  renameCandidates: RenameCandidateEntry[];
  /**
   * Symbols that exist in both versions but acquired an @deprecated
   * JSDoc tag in the to-version. Less severe than removal but still
   * a future-breaking signal.
   */
  newlyDeprecated: DeprecatedEntry[];

  /** ─── Capacity / honesty fields the UI surfaces directly ─── */

  /**
   * When the differ had to cap a bucket, this counts how many entries
   * were dropped from each. Always sorted breaking-first within each
   * bucket so truncation drops the least-impactful items. UI surfaces
   * a banner so users know the analysis was partial.
   */
  truncation: { added: number; removed: number; signatureChanged: number };

  /**
   * Where the .d.ts data came from for each side. Lets the UI explain
   * its confidence (own-types > DefinitelyTyped fallback > none) and
   * lets the AI calibrate its confidence field appropriately.
   */
  sources: { from: ApiSourceDescriptor; to: ApiSourceDescriptor };
}

export interface SignatureChangeEntry {
  name: string;
  kind: ApiSymbolKind;
  modulePath: string;
  before: string;
  after: string;
  /** 0..1 heuristic; see ApiSurfaceDiff.signatureChanged JSDoc. */
  breakingScore: number;
}

export interface RenameCandidateEntry {
  fromSymbol: ApiSymbol;
  toSymbol: ApiSymbol;
  /** 0..1 Jaccard similarity on signature tokens. >= 0.7 to land here. */
  similarity: number;
}

export interface DeprecatedEntry {
  symbol: ApiSymbol;
  /** Maintainer's @deprecated message, if they wrote one. Empty string when tag present without text. */
  message: string;
}

export interface ApiSourceDescriptor {
  /**
   * Where the entry .d.ts ultimately came from. The first three are
   * authoritative (the package's own types); 'dt-fallback' means we
   * fell back to DefinitelyTyped (@types/&lt;pkg&gt;) which is often
   * out-of-date; 'none' means no types at all.
   */
  origin:
    | 'package-types-field'      // package.json `"types"` field — strongest signal
    | 'package-typings-field'    // legacy `"typings"` — equivalent confidence
    | 'index.d.ts'               // conventional default, no manifest entry
    | 'dt-fallback'              // @types/&lt;pkg&gt; — older, possibly stale
    | 'none';                    // nothing found; AI works narrative-only
  /** Number of .d.ts files the recursive re-export resolver visited. */
  filesAnalyzed: number;
  /**
   * Re-export targets we couldn't resolve. Cross-package re-exports
   * (`export * from 'react'`) land here — we deliberately don't chase
   * them. Surfaces as "partial analysis — N cross-package re-exports
   * not followed" in the UI when non-empty.
   */
  unresolved: string[];
}

/* ───────────────────────── LAYER 2: AI-narrated ───────────────────────── */

/**
 * The full migration report the AI orchestrator returns. Strict
 * JSON-schema-shaped so providers (Groq, Gemini, OpenAI, DeepSeek)
 * can return it as a structured response. The schema literal lives
 * in `src/app/services/ai/schemas/migration-report.schema.ts` so
 * the AI provider can pass it as `response_format`.
 *
 * # Confidence semantics
 *
 *   high    API_DIFF data is rich AND at least one narrative source
 *           (release notes / changelog) corroborates the structural
 *           changes the AI is describing
 *   medium  API_DIFF data is rich but no narrative confirmation, OR
 *           narrative-only with strong source quality
 *   low     No API_DIFF (types unavailable) and only weak narrative;
 *           output is best-effort from general knowledge
 *
 * The model is told to be honest — `low` is a valid answer, and
 * surfaced prominently in the UI as a "may be incomplete" warning.
 */
export interface MigrationReport {
  packageName: string;
  fromVersion: string;
  toVersion: string;

  /** 2–3 sentence executive summary in prose. ≤ 400 chars. */
  summary: string;

  severity: MigrationSeverity;
  effort: MigrationEffort;
  confidence: MigrationConfidence;

  /** Which sources fed the analysis — surfaced in the UI footer for transparency. */
  sourcesUsed: {
    apiDiff: boolean;
    releaseNotes: boolean;
    changelog: boolean;
    migrationGuide: boolean;
  };

  /**
   * One entry per structural change in the API_DIFF. The AI is
   * forbidden from dropping entries or inventing new ones — every
   * ApiSurfaceDiff entry maps to exactly one ApiChange.
   */
  apiChanges: ApiChange[];

  /** Things the .d.ts diff cannot show: peer-dep bumps, engine requirements, runtime drops. */
  ecosystemChanges: EcosystemChange[];

  /** Headline new capabilities pulled from release notes, not from the API diff. ≤ 5 items. */
  newCapabilities: string[];

  /** Ordered list of concrete steps. May include code blocks. */
  migrationSteps: MigrationStep[];
}

export type MigrationSeverity = 'patch' | 'minor' | 'major-safe' | 'major-breaking';
export type MigrationEffort = 'minutes' | 'hours' | 'day' | 'days' | 'unknown';
export type MigrationConfidence = 'high' | 'medium' | 'low';

export interface ApiChange {
  symbolName: string;
  symbolKind: ApiSymbolKind;
  modulePath: string;
  change: 'added' | 'removed' | 'renamed' | 'signature-changed' | 'deprecated';
  /** Original signature; set when change ∈ {removed, renamed, signature-changed, deprecated}. */
  before?: string;
  /** New signature; set when change ∈ {added, renamed, signature-changed}. */
  after?: string;
  /** Set only when change === 'renamed' — the AI promotes a RenameCandidateEntry to this state. */
  renamedTo?: string;
  /**
   * Severity rollup at the per-change level. The AI uses the per-symbol
   * breakingScore + its own judgment to assign:
   *   breaking       — consumer code must change
   *   non-breaking   — backward-compatible addition or improvement
   *   informational  — deprecation or pure type-level change
   */
  severity: 'breaking' | 'non-breaking' | 'informational';
  /** AI-authored one-sentence "what must the user do?" ≤ 240 chars. */
  humanSummary: string;
  /**
   * AI-authored code example demonstrating the migration. Optional —
   * the AI is told to leave it absent rather than fabricate code when
   * neither source provided an example.
   */
  migrationExample?: {
    before: string;
    after: string;
    language: 'typescript' | 'javascript' | 'html';
  };
}

export interface EcosystemChange {
  area: 'peer-dependencies' | 'engines' | 'runtime' | 'tooling';
  description: string;          // ≤ 200 chars
  severity: 'breaking' | 'non-breaking';
}

export interface MigrationStep {
  /** Imperative instruction. ≤ 140 chars. */
  step: string;
  /** Optional code snippet illustrating the step. */
  code?: string;
  language?: 'bash' | 'typescript' | 'javascript' | 'html' | 'json';
}
