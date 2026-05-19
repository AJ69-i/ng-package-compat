import { Injectable, inject } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import { AiPayloadService, PackageFacts } from './ai-payload.service';
import {
  AiCompletionResponse,
  AiProviderService,
  AiError
} from './ai-provider.service';
import { AiCacheService } from './ai-cache.service';
import {
  COMPETITORS_JSON_SCHEMA,
  COMPETITORS_SCHEMA_VERSION,
  Competitor,
  CompetitorsResponse
} from './schemas/competitors.schema';

/**
 * Competitor Suggestions orchestrator (Feature 3).
 *
 * Given one package name, ask the AI to suggest 3 alternative packages
 * a developer might compare it against. The result is rendered as
 * clickable chips under the empty input on /compare — one click
 * selects the suggestion as the second package and kicks off the
 * comparison flow.
 *
 * # Why this exists as its own service
 *
 * Architecturally identical to ProsConsService and UsageGuideService:
 * pull facts → build prompt → call AiProviderService → cache via
 * AiCacheService. Reusing the same shape gives us provider
 * abstraction, in-flight dedup, and 7-day cross-session caching for
 * free. The orchestrator does NOT need to know whether the call lands
 * on Groq, Gemini, OpenAI, or DeepSeek — that's resolved at
 * `AiProviderService.complete()` time from the user's settings.
 *
 * # The "exactly 3" constraint
 *
 * Top-3 is enforced in three places: the JSON schema (minItems/
 * maxItems), the system prompt ("EXACTLY 3"), and the
 * `sanitizeResponse()` post-parse step below that defensively slices
 * to 3 and drops any echo of the target package. The rationale —
 * Hick's law, mobile chip wrapping, hallucination risk per item —
 * lives in the product discussion that produced this feature; the
 * code just enforces what was decided there.
 *
 * # Cache key
 *
 * `pair: [name, '']` — the cache layer's `[...pair].sort()` puts the
 * empty string first, so we get a stable single-package cache key
 * with zero changes to the cache service's API. Lookups for the same
 * target name from any UI surface share one cache entry.
 *
 * # Silent error model
 *
 * Competitor chips are a "nice to have" jump-start, not critical UX.
 * The component subscribes with its own `catchError(() => of(null))`
 * and renders nothing on failure. We surface errors in DevTools
 * console (so devs can diagnose) but never to the user — failing
 * loud here would teach users to associate the tool with flakiness
 * even when everything else is working.
 */
@Injectable({ providedIn: 'root' })
export class CompetitorSuggestionsService {
  private readonly payload = inject(AiPayloadService);
  private readonly ai = inject(AiProviderService);
  private readonly cache = inject(AiCacheService);

  /**
   * Suggest 3 competitor packages for the given target package.
   *
   * @param packageName the npm package to find alternatives for
   * @param forceRefresh true to bypass the cache read (still writes
   *   the fresh result). Not currently called by the UI — there's
   *   no refresh button on the chips by design — but kept for parity
   *   with the other orchestrators and for potential future use.
   */
  suggest(
    packageName: string,
    forceRefresh = false
  ): Observable<AiCompletionResponse<CompetitorsResponse>> {
    return this.cache.getOrFetch<CompetitorsResponse>({
      feature: 'competitors',
      // Single-package lookup — the cache layer's sort() puts '' first,
      // giving us a stable single-name cache key without an API change.
      pair: [packageName, ''],
      provider: this.ai.activeProvider(),
      model: 'default',
      schemaVersion: COMPETITORS_SCHEMA_VERSION,
      promptVersion: PROMPT_VERSION,
      // 7-day TTL — competitor landscapes shift slowly. The same
      // package generally has the same 2-3 obvious alternatives for
      // months at a time. Hard refresh on prompt-version bump if we
      // change the system prompt meaningfully.
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      bypassCache: forceRefresh,
      factory: () =>
        // Single-package facts — we only need the target. Using the
        // single-package convenience method (instead of forPackages
        // with a null second arg) makes the intent clearer at the
        // call site and avoids the wasted forkJoin over an `of(null)`.
        this.payload.forSinglePackage(packageName).pipe(
          switchMap((facts) => this.callModel(facts, packageName))
        )
    });
  }

  private callModel(
    target: PackageFacts,
    targetName: string
  ): Observable<AiCompletionResponse<CompetitorsResponse>> {
    return this.ai
      .complete<CompetitorsResponse>({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: this.buildUserPrompt(target),
        responseSchema: COMPETITORS_JSON_SCHEMA,
        // 3 names + 80-char reasons fits comfortably in 500 tokens
        // with headroom. Smaller budget = faster generation, which
        // matters because the chips render reactively while the user
        // is deciding what to compare against.
        maxTokens: 500,
        // 0.35 — slightly above the very deterministic settings we
        // use elsewhere. Some variety is good (we don't want the
        // exact same 3 suggestions every time the model encounters
        // a fresh package), but not so creative that names start
        // drifting away from packages that actually exist.
        temperature: 0.35
      })
      .pipe(
        // Defensive post-processing — see sanitizeResponse() for the
        // three guards (cap to 3, drop target-echo, normalize names).
        map((res) => ({
          ...res,
          data: { competitors: sanitizeResponse(res.data.competitors, targetName) }
        })),
        catchError((err: AiError | Error) => throwError(() => err))
      );
  }

  /**
   * Compact user prompt — facts about the target package, then the
   * directive. We deliberately send less context than Pros & Cons
   * does because the model doesn't need bundle size, download trend,
   * GitHub stars, or release cadence to know what alternatives
   * exist — those are competitive-comparison signals, not
   * landscape-knowledge signals. Name + description + a short
   * README excerpt is plenty.
   */
  private buildUserPrompt(target: PackageFacts): string {
    return [
      `Target package: ${target.name}`,
      target.description
        ? `Description: ${target.description}`
        : 'Description: (none)',
      target.readme
        ? `Positioning excerpt (first 600 chars of README):\n${target.readme.truncated.slice(0, 600)}`
        : '',
      '',
      `Suggest EXACTLY 3 alternative npm packages a developer might pick INSTEAD of ${target.name}. Follow the rules in your system prompt. Return the JSON object only.`
    ]
      .filter(Boolean)
      .join('\n');
  }
}

/**
 * Three defensive guards applied to every model response:
 *
 *   1. Drop any suggestion whose `name` matches the target package
 *      (case-insensitive, trimmed). The system prompt forbids this
 *      but models occasionally do it anyway.
 *
 *   2. Drop any suggestion missing a name or reason after
 *      whitespace-trimming. Empty strings would render as empty chips.
 *
 *   3. Cap to 3 items. The schema enforces it but providers using
 *      `json_object` mode (Groq, DeepSeek) don't enforce array
 *      bounds, so the model can occasionally return 4. We never want
 *      to render more than 3, so slice unconditionally.
 *
 * If after filtering we have fewer than 3, we render what we have
 * rather than dropping the whole response. Better one good chip than
 * three padded with garbage.
 */
function sanitizeResponse(
  competitors: Competitor[] | undefined,
  targetName: string
): Competitor[] {
  if (!Array.isArray(competitors)) return [];
  const targetLc = targetName.trim().toLowerCase();
  return competitors
    .filter(
      (c) =>
        c &&
        typeof c.name === 'string' &&
        typeof c.reason === 'string' &&
        c.name.trim() &&
        c.reason.trim() &&
        c.name.trim().toLowerCase() !== targetLc
    )
    .slice(0, 3)
    .map((c) => ({ name: c.name.trim(), reason: c.reason.trim() }));
}

// ---------------------------------------------------------------------------
// System prompt — versioned constant
// ---------------------------------------------------------------------------

/**
 * Bump when SYSTEM_PROMPT below changes meaningfully. The cache key
 * includes this value, so a bump invalidates every cached competitor
 * response generated under the old prompt — users see fresh output
 * after a prompt tweak without us having to manually clear caches.
 */
const PROMPT_VERSION = 1;

const SYSTEM_PROMPT = `\
You suggest direct competitor npm packages for a given target package.

A "competitor" is an alternative library a developer might pick INSTEAD of the target — same problem domain, drop-in or near-drop-in replacement scope.

CRITICAL RULES — your output is rejected if you violate any of these:

1. REAL PACKAGES ONLY. Suggest packages that genuinely exist on the npm registry. If you are not confident a package exists, do not suggest it. Inventing plausible-sounding names is the worst failure mode here — it sends users to a 404.

2. DROP-IN ALTERNATIVES. The user is asking "what else solves this exact problem?" A toast library competes with other toast libraries, NOT with general UI kits that happen to include a toast component. A date-picker competes with other date-pickers, not with broader form libraries. Stay tight.

3. MIX POPULARITY TIERS. Pick three packages that span the landscape:
   - one MAINSTREAM popular alternative (the obvious well-known choice)
   - one MODERN/TRENDING alternative (newer take on the same problem)
   - one NICHE-BUT-QUALITY alternative (smaller, well-built, less famous)
   This gives the user variety in their 3 chips: safety, novelty, depth.

4. NEVER ECHO THE TARGET. Do not include the target package itself in your suggestions. If asked for alternatives to ngx-toastr, do not return ngx-toastr.

5. PREFER ANGULAR-COMPATIBLE. The host application compares Angular packages, so prefer alternatives that work in Angular projects. A React-only library is not a useful suggestion for an Angular developer.

6. REASON IS SHORT AND CONCRETE. Each "reason" field is ONE sentence, ≤80 characters, explaining specifically why this package competes — "modern signal-first toast API", "zero-config alternative with TypeScript-first design", "minimal bundle for static-site use cases". Generic platitudes like "great library" or "popular choice" are not acceptable.

7. EXACTLY 3 SUGGESTIONS. Not 2, not 4. Three. The UI is built around three chips and the cache key assumes three. Always return three.

Return ONLY a JSON object matching the schema. No prose, no markdown, no code fences.`;
