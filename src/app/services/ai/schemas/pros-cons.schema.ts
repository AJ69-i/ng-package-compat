/**
 * Strict JSON schema for the Pros & Cons response. Written in the
 * dialect both OpenAI strict-mode AND Gemini's responseSchema accept:
 *
 *   - Top-level `type: "object"`
 *   - `additionalProperties: false`
 *   - All keys listed in `required`
 *   - Primitives + arrays only inside; no $ref, no oneOf/anyOf
 *   - Enum-constrained string axes for stable downstream styling
 *
 * The same shape is restated to the model in the system prompt as
 * belt-and-braces enforcement (see pros-cons.service.ts).
 */

/**
 * Cache-busting version of this schema. BUMP when any of the following
 * change in a way that would make old cached responses look wrong:
 *   - shape of `ProsConsResponse` or `ProsConsAxis`
 *   - the `PROS_CONS_AXES` enum (added/removed/renamed an axis id)
 *   - the JSON schema constants below (different required fields, etc.)
 *
 * Increment is intentional — bumping invalidates every entry in the
 * cache that was generated with the old schema, so users always see
 * output that matches the current UI's rendering expectations.
 */
export const PROS_CONS_SCHEMA_VERSION = 1;

export const PROS_CONS_AXES = [
  'bundle-size',
  'performance',
  'maintenance',
  'api-stability',
  'adoption',
  'ecosystem-fit'
] as const;

export type ProsConsAxisId = (typeof PROS_CONS_AXES)[number];

export interface ProsConsAxis {
  /** Which dimension we're comparing on. Constrained enum so the UI
   *  can map these to icons/colours without string-matching. */
  axis: ProsConsAxisId;
  /** Who wins on this axis. `tie` when the difference is negligible
   *  or both are roughly equivalent. */
  winner: 'a' | 'b' | 'tie';
  /**
   * Quantified delta in plain English, e.g. "12 KB smaller gzipped"
   * or "3.2× more weekly downloads". The model is told to keep this
   * short (≤ 100 chars) and to anchor numbers in the provided fact
   * sources, never invent.
   */
  delta: string;
  /**
   * Which fact source(s) backed this claim, e.g. "Bundlephobia" or
   * "GitHub stars + last-pushed-at". Used in the UI as a small
   * provenance pill so users can see why the verdict landed where
   * it did.
   */
  evidence: string;
}

/** Top-level response shape returned by the Pros & Cons feature. */
export interface ProsConsResponse {
  /**
   * One-sentence headline (≤ 200 chars). What's the most important
   * thing a developer needs to know about this comparison? Rendered
   * large at the top of the panel.
   */
  verdict: string;
  /**
   * 4-6 axes the model selected as most relevant to this specific
   * comparison. Not every comparison has all six axes; the model is
   * told "pick the ones that actually matter, skip the ones that
   * are tied with no story to tell."
   */
  axes: ProsConsAxis[];
  /**
   * Concrete risk callouts a developer adopting one of these
   * packages should know — abandoned-warning, churning-API-warning,
   * tiny-author-bus-factor, etc. Empty array if nothing to flag.
   */
  warnings: string[];
  /**
   * Final actionable recommendation. Tells the user "you should
   * probably pick A if X, pick B if Y" — the synthesis of the axes
   * into a decision. Always present, never empty.
   */
  recommendation: string;
}

/**
 * Strict JSON schema literal. Passed verbatim to both:
 *   - OpenAI's `response_format.json_schema.schema` (strict mode)
 *   - Gemini's `generationConfig.responseSchema`
 */
export const PROS_CONS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'axes', 'warnings', 'recommendation'],
  properties: {
    verdict: {
      type: 'string',
      description:
        'One-sentence headline capturing the single most important difference. Max 200 characters.'
    },
    axes: {
      type: 'array',
      description:
        '4-6 axis comparisons. Pick the dimensions that actually have a story; skip ties.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['axis', 'winner', 'delta', 'evidence'],
        properties: {
          axis: {
            type: 'string',
            enum: [...PROS_CONS_AXES],
            description:
              'Which comparison dimension. Choose the most apt enum value.'
          },
          winner: {
            type: 'string',
            enum: ['a', 'b', 'tie'],
            description:
              'Which package wins on this axis. Use "tie" only if the difference is negligible.'
          },
          delta: {
            type: 'string',
            description:
              'Quantified difference in plain English, e.g. "12 KB smaller gzipped" or "3.2x more weekly downloads". Max 100 characters.'
          },
          evidence: {
            type: 'string',
            description:
              'Fact source backing this claim, e.g. "Bundlephobia" or "NPM downloads, last 90 days". Max 80 characters.'
          }
        }
      }
    },
    warnings: {
      type: 'array',
      description:
        'Concrete risk callouts. Empty array if nothing concerning. Avoid generic advice.',
      items: {
        type: 'string'
      }
    },
    recommendation: {
      type: 'string',
      description:
        'Final actionable recommendation: who should pick A, who should pick B, and why. Synthesizes the axes into a decision.'
    }
  }
} as const;
