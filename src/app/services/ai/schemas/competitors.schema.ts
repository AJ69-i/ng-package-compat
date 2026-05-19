/**
 * Strict JSON schema for the Competitor-Suggestions response (Feature 3).
 *
 * Same dialect as the other AI feature schemas in this folder:
 *   - Top-level object with `additionalProperties: false`
 *   - All keys listed in `required`
 *   - Primitives + arrays + nested objects only (no oneOf/anyOf/$ref)
 *   - Array constrained to EXACTLY 3 items via minItems/maxItems
 *
 * The "exactly 3" constraint is intentional and load-bearing — see the
 * product discussion in the service file for the UX rationale (Hick's
 * law, mobile chip wrapping, hallucination risk). The schema enforces
 * it, the prompt restates it, and the orchestrator defensively slices
 * to 3 again post-parse. Belt + braces + harness.
 */

/**
 * Cache-busting version for this schema. BUMP when any of the
 * following change in a way that would make old cached responses
 * look wrong:
 *   - shape of `Competitor` or `CompetitorsResponse`
 *   - the `required` keys here
 *   - the cardinality constraint (3 → something else)
 */
export const COMPETITORS_SCHEMA_VERSION = 1;

/** A single suggested competitor package. */
export interface Competitor {
  /**
   * Real npm package name — lowercase, hyphenated, exactly as it
   * would appear in `npm install <name>`. The model is told to only
   * suggest packages it's confident actually exist on the registry;
   * if a user clicks a chip for a non-existent package, the regular
   * "not found" path handles it (so we don't pre-validate here to
   * save round-trips).
   */
  name: string;
  /**
   * Short one-sentence reason this package competes with the target.
   * Capped at ~80 chars in the prompt — surfaced as a tooltip on the
   * chip so users can see "why this one" on hover without burning
   * any extra screen real estate.
   */
  reason: string;
}

/** Top-level shape — `competitors` is always an array of exactly 3. */
export interface CompetitorsResponse {
  competitors: Competitor[];
}

/**
 * Strict JSON schema literal. Passed verbatim to OpenAI strict mode,
 * Gemini's responseSchema (after sanitization for the Gemini-specific
 * subset), and restated in the system prompt for providers using
 * `json_object` mode (Groq, DeepSeek).
 */
export const COMPETITORS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['competitors'],
  properties: {
    competitors: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      description:
        'EXACTLY 3 alternative npm packages that compete with the target — one mainstream, one modern/trending, one niche-but-quality.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'reason'],
        properties: {
          name: {
            type: 'string',
            description:
              'Real npm package name (lowercase, hyphenated). Do not invent names; if uncertain, do not suggest.'
          },
          reason: {
            type: 'string',
            description:
              'Short concrete reason this package is an alternative. Max 80 characters. Specific ("modern signal-first toast API"), not generic ("great library").'
          }
        }
      }
    }
  }
} as const;
