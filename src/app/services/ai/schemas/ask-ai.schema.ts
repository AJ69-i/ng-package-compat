/**
 * Strict JSON schema for the "Ask AI about this package" answer shape.
 *
 * Lives alongside the other ai/schemas/* files so it inherits the same
 * tooling conventions (versioning header, strict subset that all four
 * providers accept: top-level `type: object`, every property listed in
 * `required`, no `oneOf` / `anyOf` / `$ref`, primitives only inside
 * arrays, additionalProperties: false).
 *
 * # Shape choice
 *
 * Three fields:
 *   - `answer`   The model's main response in plain markdown (we render
 *                via MarkdownRendererService so the user gets headings,
 *                code blocks, lists, links).
 *   - `confidence` One of high/medium/low. Surfaces calibrated
 *                  uncertainty — a high-confidence "yes this is still
 *                  maintained" reads differently from a low-confidence
 *                  "I'm not sure". Maps directly to a small inline
 *                  badge on the answer card.
 *   - `caveats`  Up to 3 short qualifiers ("based on facts as of X",
 *                "based on training data, not live data", etc.). Renders
 *                under the answer as bullet-list footnotes. Surfacing
 *                caveats from the model itself is far better than
 *                trying to invent them client-side.
 *
 * The schema enforces array-length on `caveats` via `maxItems` so the
 * model can't pad the response with noise.
 */
export const ASK_AI_SCHEMA_VERSION = 1;

export interface AskAiResponse {
  answer: string;
  confidence: 'high' | 'medium' | 'low';
  caveats: string[];
}

export const ASK_AI_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    answer: {
      type: 'string',
      description:
        'Markdown answer to the user\'s question about the package. Keep concise (under 400 words). Use code blocks, headings, lists where they add clarity. Never invent API surfaces.'
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description:
        'Self-assessed confidence. "high" only when grounded in concrete facts from the payload; "low" when speculating from general knowledge.'
    },
    caveats: {
      type: 'array',
      maxItems: 3,
      items: { type: 'string' },
      description:
        'Up to 3 short qualifiers about the answer (e.g. "based on training data, not the live registry"). Empty array is fine.'
    }
  },
  required: ['answer', 'confidence', 'caveats']
} as const;
