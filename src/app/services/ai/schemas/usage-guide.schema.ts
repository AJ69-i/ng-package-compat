/**
 * Strict JSON schema for the Usage Guide response. Written in the same
 * dialect as pros-cons.schema.ts:
 *
 *   - Top-level `type: "object"`, `additionalProperties: false`
 *   - All keys listed in `required`
 *   - Primitives + arrays + nested objects only (no $ref, oneOf, anyOf)
 *
 * Each code block carries its own language tag so the UI can pick the
 * right syntax highlighter per block — `installCommand` is bash,
 * `setupCode` is typescript, `basicExample` could be html or typescript
 * depending on the package (a UI library example renders HTML; a HTTP
 * client example renders TS). One language for the whole guide would
 * have papered over that real-world variance.
 */

/**
 * Cache-busting version of this schema. Bump when any of these change:
 *   - shape of `UsageGuideResponse` / `PackageUsageGuide`
 *   - the `notes` field semantics
 *   - the language tag enum
 *
 * Increment is intentional — bumping invalidates every entry in the
 * cache generated under the old schema.
 */
export const USAGE_GUIDE_SCHEMA_VERSION = 1;

/**
 * Languages the UI knows how to render. Constrained enum so the
 * highlighter doesn't have to handle arbitrary strings. `text` is the
 * fallback for output the model decides isn't any of the others
 * (e.g. a JSON config snippet).
 */
export const USAGE_GUIDE_LANGUAGES = [
  'bash',
  'typescript',
  'javascript',
  'html',
  'json',
  'scss',
  'text'
] as const;

export type UsageGuideLanguage = (typeof USAGE_GUIDE_LANGUAGES)[number];

/** A single code block plus its highlighting language. */
export interface UsageCodeBlock {
  language: UsageGuideLanguage;
  /**
   * The actual code. The model is instructed to keep each block
   * focused and runnable — no commentary, no ellipses-placeholders,
   * no `// ... rest of the file`. ≤ 60 lines per block.
   */
  code: string;
}

/** Per-package usage guide. Returned for BOTH packages in the response. */
export interface PackageUsageGuide {
  /** Echoed back from the request so the UI can pair output ↔ input. */
  packageName: string;
  /**
   * The exact shell command to install — typically `npm install <name>`
   * but can vary: `--save-dev` for build tooling, `npx schematics`
   * for Angular libraries that ship `ng add`. ≤ 200 chars.
   */
  installCommand: UsageCodeBlock;
  /**
   * Bootstrap code — module/provider registration, root-level imports.
   * In Angular this is usually a `providers: [...]` array or an
   * `app.config.ts` `provideX()` call. ≤ 60 lines.
   */
  setupCode: UsageCodeBlock;
  /**
   * Minimum working example showing the package actually doing its
   * job. Should be copy-pasteable into a component or service and
   * actually run. ≤ 60 lines.
   */
  basicExample: UsageCodeBlock;
  /**
   * Optional caveats — e.g. "requires Angular 17+", "incompatible
   * with Zone.js < 0.14", "expects a peer-installed @types package".
   * Empty string if nothing notable.
   */
  notes: string;
}

/** Top-level response — symmetric over the two compared packages. */
export interface UsageGuideResponse {
  packageA: PackageUsageGuide;
  packageB: PackageUsageGuide;
  /**
   * 1-sentence summary of the integration-shape difference between
   * the two packages, e.g. "Package A registers via `provideX()` in
   * `app.config.ts`; Package B uses a `forRoot()` import in
   * `AppModule`." Helps the user see the integration delta at a
   * glance without diffing the code blocks themselves.
   */
  integrationDelta: string;
}

// ---------------------------------------------------------------------------
// JSON Schema literal
// ---------------------------------------------------------------------------

/** Reused for each code block. */
const CODE_BLOCK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['language', 'code'],
  properties: {
    language: {
      type: 'string',
      enum: [...USAGE_GUIDE_LANGUAGES],
      description:
        'Syntax highlighting tag for this block. Pick the one that matches the code content.'
    },
    code: {
      type: 'string',
      description:
        'The actual code or command. No commentary, no ellipses, no placeholder TODOs.'
    }
  }
} as const;

/** Reused for each per-package guide. */
const PACKAGE_GUIDE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'packageName',
    'installCommand',
    'setupCode',
    'basicExample',
    'notes'
  ],
  properties: {
    packageName: {
      type: 'string',
      description:
        'The package name (matching the input). Echoed for output pairing.'
    },
    installCommand: CODE_BLOCK_SCHEMA,
    setupCode: CODE_BLOCK_SCHEMA,
    basicExample: CODE_BLOCK_SCHEMA,
    notes: {
      type: 'string',
      description:
        'Caveats or version requirements. Empty string if nothing to flag.'
    }
  }
} as const;

/**
 * Top-level Usage Guide schema. Passed verbatim to:
 *   - OpenAI's `response_format.json_schema.schema` (strict mode)
 *   - Gemini's `generationConfig.responseSchema`
 */
export const USAGE_GUIDE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['packageA', 'packageB', 'integrationDelta'],
  properties: {
    packageA: PACKAGE_GUIDE_SCHEMA,
    packageB: PACKAGE_GUIDE_SCHEMA,
    integrationDelta: {
      type: 'string',
      description:
        'One-sentence summary of how the two packages differ in their integration shape (where you put code, how you register, etc.). Max 200 chars.'
    }
  }
} as const;
