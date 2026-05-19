/**
 * Strict JSON schema for the Version Migration response. Same dialect
 * as the other AI schemas in this app:
 *
 *   - Top-level `type: "object"`, `additionalProperties: false`
 *   - All keys listed in `required` (no optional fields — the model
 *     fills empty arrays / empty strings when there's nothing to say)
 *   - Primitives + arrays + nested objects only (no $ref / oneOf / anyOf,
 *     which Gemini's OpenAPI subset can't handle)
 *
 * # Why a flat, opinionated shape
 *
 * The AI is allowed exactly four "buckets" of output: breaking changes,
 * deprecations, migration steps, and one severity rollup. Anything more
 * granular (e.g. "additions", "fixes", "perf") becomes noise in a
 * migration prompt — the user is here to figure out what's going to
 * break, not to read a marketing changelog. Constraining the shape
 * forces the model to put each item in the right bucket and keeps the
 * UI dead simple.
 */

/**
 * Cache-busting version. Bump when the shape of MigrationResponse or
 * any nested type changes. Increment invalidates every cached entry.
 */
export const VERSION_MIGRATION_SCHEMA_VERSION = 1;

/**
 * Severity rollup — drives the colored chip at the top of the panel.
 * The model picks ONE of these based on the totality of the diff:
 *
 *   - patch         Bug fixes only, no API changes. Safe drop-in.
 *   - minor         New APIs, no breaking changes. Safe drop-in but
 *                   you may want to read the notes for new features.
 *   - major-safe    Major-version bump but with no breaking changes
 *                   relevant to typical usage (e.g. internal refactor,
 *                   peer-dep bump only). Still safe in most apps.
 *   - major-breaking Breaking changes present. Read the migration
 *                    steps before upgrading.
 */
export const MIGRATION_SEVERITIES = [
  'patch',
  'minor',
  'major-safe',
  'major-breaking'
] as const;
export type MigrationSeverity = (typeof MIGRATION_SEVERITIES)[number];

/**
 * Coarse effort estimate. Anything finer is fiction — we have no idea
 * how big the user's codebase is. These five buckets at least let us
 * give a meaningful expectation: minutes vs days is a real signal.
 */
export const MIGRATION_EFFORTS = [
  'minutes',
  'hours',
  'day',
  'days',
  'unknown'
] as const;
export type MigrationEffort = (typeof MIGRATION_EFFORTS)[number];

/** A single breaking change the user has to address. */
export interface BreakingChangeEntry {
  /** Short headline — 1 line, ≤ 100 chars. */
  title: string;
  /** Longer explanation — what specifically broke. ≤ 600 chars. */
  detail: string;
  /**
   * Which version introduced the break (helps the user grep their
   * package-lock for transitive impact). Plain semver, no leading "v".
   */
  sinceVersion: string;
  /** Concrete migration step — what code to change, in one sentence. */
  action: string;
}

/** A deprecation — still works in the target version, but flagged. */
export interface DeprecationEntry {
  /** The API that's now deprecated (function/class/option name). */
  api: string;
  /** Replacement API — empty string if there's no direct replacement. */
  replacement: string;
  /** Version that introduced the deprecation. */
  sinceVersion: string;
  /** Optional one-line note (e.g. "removed in 18.0", "renamed only"). */
  note: string;
}

/** A single migration step the user should perform. */
export interface MigrationStep {
  /** 1-line imperative instruction. ≤ 140 chars. */
  step: string;
  /**
   * Optional code snippet that illustrates the change. Empty string
   * when the step is purely procedural ("run `ng update <pkg>`").
   * Language is inferred from content but typed as language tag below.
   */
  code: string;
  /** Highlighting tag — same enum as the Usage Guide. */
  language: 'bash' | 'typescript' | 'javascript' | 'html' | 'json' | 'scss' | 'text';
}

/** Top-level response. */
export interface MigrationResponse {
  /** Echoed for output ↔ input pairing. */
  packageName: string;
  fromVersion: string;
  toVersion: string;
  /** 1-2 sentence rollup. Always present. ≤ 400 chars. */
  summary: string;
  severity: MigrationSeverity;
  effortEstimate: MigrationEffort;
  /** May be empty when severity is `patch`/`minor`/`major-safe`. */
  breakingChanges: BreakingChangeEntry[];
  /** May be empty. */
  deprecations: DeprecationEntry[];
  /** Ordered list of steps to perform. May be empty for trivial bumps. */
  migrationSteps: MigrationStep[];
  /**
   * Confidence the model has in the output, based on how much
   * changelog material it had to work with. One of:
   *   - high   GitHub Releases provided dense, structured notes
   *   - medium CHANGELOG.md was available but less structured
   *   - low    No changelog source — output is based on general
   *            knowledge and the model should hedge accordingly
   */
  confidence: 'high' | 'medium' | 'low';
}

// ---------------------------------------------------------------------------
// JSON Schema literal
// ---------------------------------------------------------------------------

const BREAKING_CHANGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'detail', 'sinceVersion', 'action'],
  properties: {
    title: { type: 'string', description: 'Short headline (≤ 100 chars).' },
    detail: { type: 'string', description: 'Explanation of what broke (≤ 600 chars).' },
    sinceVersion: { type: 'string', description: 'Semver of the release that introduced this break.' },
    action: { type: 'string', description: 'Concrete migration step in one sentence.' }
  }
} as const;

const DEPRECATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['api', 'replacement', 'sinceVersion', 'note'],
  properties: {
    api: { type: 'string', description: 'The API name that is now deprecated.' },
    replacement: { type: 'string', description: 'Replacement API, or empty string if none.' },
    sinceVersion: { type: 'string', description: 'Semver of the deprecation announcement.' },
    note: { type: 'string', description: 'Optional caveat — empty if nothing notable.' }
  }
} as const;

const MIGRATION_STEP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['step', 'code', 'language'],
  properties: {
    step: { type: 'string', description: '1-line imperative instruction (≤ 140 chars).' },
    code: { type: 'string', description: 'Optional code snippet. Empty string when not needed.' },
    language: {
      type: 'string',
      enum: ['bash', 'typescript', 'javascript', 'html', 'json', 'scss', 'text'],
      description: 'Syntax highlight tag for the code field.'
    }
  }
} as const;

export const VERSION_MIGRATION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'packageName',
    'fromVersion',
    'toVersion',
    'summary',
    'severity',
    'effortEstimate',
    'breakingChanges',
    'deprecations',
    'migrationSteps',
    'confidence'
  ],
  properties: {
    packageName: { type: 'string' },
    fromVersion: { type: 'string' },
    toVersion: { type: 'string' },
    summary: {
      type: 'string',
      description: '1-2 sentence rollup of the migration (≤ 400 chars).'
    },
    severity: {
      type: 'string',
      enum: [...MIGRATION_SEVERITIES],
      description: 'Overall risk of the upgrade.'
    },
    effortEstimate: {
      type: 'string',
      enum: [...MIGRATION_EFFORTS],
      description: 'Coarse effort estimate — minutes / hours / day / days / unknown.'
    },
    breakingChanges: {
      type: 'array',
      items: BREAKING_CHANGE_SCHEMA,
      description: 'Empty array when severity is patch / minor / major-safe.'
    },
    deprecations: {
      type: 'array',
      items: DEPRECATION_SCHEMA,
      description: 'Empty array when nothing was deprecated in this range.'
    },
    migrationSteps: {
      type: 'array',
      items: MIGRATION_STEP_SCHEMA,
      description: 'Ordered list of steps. Empty array for trivial bumps.'
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description: 'How much changelog source material the model had.'
    }
  }
} as const;
