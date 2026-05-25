/**
 * Strict JSON schema for the V2 MigrationReport response.
 *
 * # Same dialect as the V1 AI schemas (pros-cons, usage-guide, etc.)
 *
 *   - Top-level `type: "object"`, `additionalProperties: false`.
 *   - Every property in `required` — no optional top-level fields.
 *     Optional FIELDS within nested objects are also enumerated so
 *     the model emits empty strings or empty arrays instead of
 *     dropping keys.
 *   - Primitives + arrays + nested objects only. No $ref, oneOf,
 *     anyOf, allOf — Gemini's OpenAPI subset rejects these and we
 *     already sanitize the schema for Gemini in AiProviderService.
 *
 * # Why repeat the TypeScript types here
 *
 * The MigrationReport interface lives in `src/server/api-diff/types.ts`
 * for the structural / typed view. This schema literal is what the AI
 * provider's response_format / responseSchema field consumes — same
 * shape, different serialization. Keeping them as two artifacts is
 * the same V1 pattern (UsageGuideResponse interface +
 * USAGE_GUIDE_JSON_SCHEMA literal).
 */

/**
 * Bump when the shape of MigrationReport changes. Invalidates every
 * cached entry generated under the old shape — V1's AiCacheService
 * keys on `(feature, pair, provider, model, schemaVersion, promptVersion)`,
 * so a schemaVersion bump cleanly retires old entries.
 */
export const MIGRATION_REPORT_SCHEMA_VERSION = 1;

/* ───── Reusable schema fragments (DRY across nested arrays) ───── */

const API_CHANGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'symbolName', 'symbolKind', 'modulePath', 'change',
    'before', 'after', 'renamedTo', 'severity', 'humanSummary', 'migrationExample'
  ],
  properties: {
    symbolName: {
      type: 'string',
      description: 'Name of the affected symbol. Copy verbatim from API_DIFF.'
    },
    symbolKind: {
      type: 'string',
      enum: ['function', 'class', 'interface', 'type', 'enum', 'const', 'namespace'],
      description: 'Declaration kind. Copy from API_DIFF.'
    },
    modulePath: {
      type: 'string',
      description: 'Sub-module path. Copy from API_DIFF.'
    },
    change: {
      type: 'string',
      enum: ['added', 'removed', 'renamed', 'signature-changed', 'deprecated'],
      description: 'Kind of structural change.'
    },
    before: {
      type: 'string',
      description:
        'Signature before the change. Required for removed/renamed/signature-changed/deprecated. Empty string for added.'
    },
    after: {
      type: 'string',
      description:
        'Signature after the change. Required for added/renamed/signature-changed. Empty string for removed/deprecated.'
    },
    renamedTo: {
      type: 'string',
      description:
        'New symbol name when change="renamed". Empty string otherwise. Required field; emit empty string, do not omit.'
    },
    severity: {
      type: 'string',
      enum: ['breaking', 'non-breaking', 'informational'],
      description:
        'breaking = consumer code must change. non-breaking = backward-compatible. informational = deprecation or pure type-level change.'
    },
    humanSummary: {
      type: 'string',
      description:
        'One-sentence answer to "what does the user have to do?" ≤ 240 chars. Concrete and specific — no platitudes.'
    },
    migrationExample: {
      type: 'object',
      additionalProperties: false,
      required: ['before', 'after', 'language'],
      properties: {
        before: { type: 'string', description: 'Code before the migration. Empty string when no example is justified.' },
        after: { type: 'string', description: 'Code after the migration. Empty string when no example is justified.' },
        language: {
          type: 'string',
          enum: ['typescript', 'javascript', 'html'],
          description: 'Highlight tag for the example.'
        }
      },
      description:
        'Concrete code example. When neither narrative source provides one, set before="" and after="" — do NOT fabricate code.'
    }
  }
} as const;

const ECOSYSTEM_CHANGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['area', 'description', 'severity'],
  properties: {
    area: {
      type: 'string',
      enum: ['peer-dependencies', 'engines', 'runtime', 'tooling']
    },
    description: { type: 'string', description: '≤ 200 chars. Concrete: name versions, name dropped support, etc.' },
    severity: { type: 'string', enum: ['breaking', 'non-breaking'] }
  }
} as const;

const MIGRATION_STEP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['step', 'code', 'language'],
  properties: {
    step: { type: 'string', description: 'Imperative instruction. ≤ 140 chars.' },
    code: { type: 'string', description: 'Optional snippet. Empty string when no code is needed.' },
    language: {
      type: 'string',
      enum: ['bash', 'typescript', 'javascript', 'html', 'json'],
      description: 'Highlight tag. Pick "bash" for empty code blocks too.'
    }
  }
} as const;

/* ───── Top-level schema ───── */

export const MIGRATION_REPORT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'packageName', 'fromVersion', 'toVersion',
    'summary', 'severity', 'effort', 'confidence',
    'sourcesUsed', 'apiChanges', 'ecosystemChanges',
    'newCapabilities', 'migrationSteps'
  ],
  properties: {
    packageName: { type: 'string', description: 'Echo of input. Must match the request exactly.' },
    fromVersion: { type: 'string', description: 'Echo of input. Lower of the two versions.' },
    toVersion: { type: 'string', description: 'Echo of input. Higher of the two versions.' },

    summary: { type: 'string', description: '2–3 sentence executive summary in prose. ≤ 400 chars.' },

    severity: {
      type: 'string',
      enum: ['patch', 'minor', 'major-safe', 'major-breaking'],
      description:
        'Rollup. major-breaking requires at least one breaking apiChanges entry. major-safe = major version bump with no breaking changes affecting typical usage.'
    },
    effort: {
      type: 'string',
      enum: ['minutes', 'hours', 'day', 'days', 'unknown'],
      description: 'Coarse migration effort. unknown when sources are insufficient to estimate.'
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description:
        'high = API_DIFF + narrative agree. medium = API_DIFF alone or strong narrative alone. low = narrative-only with no API_DIFF; say so in summary.'
    },

    sourcesUsed: {
      type: 'object',
      additionalProperties: false,
      required: ['apiDiff', 'releaseNotes', 'changelog', 'migrationGuide'],
      properties: {
        apiDiff: { type: 'boolean', description: 'true when the API_DIFF section contained any structural data.' },
        releaseNotes: { type: 'boolean' },
        changelog: { type: 'boolean' },
        migrationGuide: { type: 'boolean' }
      }
    },

    apiChanges: {
      type: 'array',
      items: API_CHANGE_SCHEMA,
      description:
        'One entry per structural change in API_DIFF. Do NOT drop entries. Do NOT invent entries. Empty array only when API_DIFF was empty.'
    },
    ecosystemChanges: {
      type: 'array',
      items: ECOSYSTEM_CHANGE_SCHEMA,
      description:
        'Peer-dep / engine / runtime / tooling changes — things the .d.ts cannot show. Empty array when none.'
    },
    newCapabilities: {
      type: 'array',
      items: { type: 'string', description: '≤ 120 chars per item.' },
      description:
        'Headline new capabilities pulled from RELEASE_NOTES, not from API_DIFF. ≤ 5 items. Empty when nothing notable.'
    },
    migrationSteps: {
      type: 'array',
      items: MIGRATION_STEP_SCHEMA,
      description:
        'Ordered list of concrete steps. Top-to-bottom execution order. Empty for trivial patch bumps.'
    }
  }
} as const;
