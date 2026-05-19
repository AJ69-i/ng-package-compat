import { Injectable, inject } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import { AiPayload, AiPayloadService, PackageFacts } from './ai-payload.service';
import {
  AiCompletionResponse,
  AiProviderService,
  AiError
} from './ai-provider.service';
import { AiCacheService } from './ai-cache.service';
import {
  USAGE_GUIDE_JSON_SCHEMA,
  USAGE_GUIDE_SCHEMA_VERSION,
  UsageGuideResponse
} from './schemas/usage-guide.schema';

/**
 * Usage Guide orchestrator — Feature 2 in the AI suite.
 *
 * Given two npm packages on the /compare page, produces a side-by-side
 * "how do I actually use this thing" guide with three code blocks per
 * package: install command, setup/bootstrap code, basic example.
 *
 * Architecturally identical to ProsConsService:
 *   1. AiPayloadService — fetches per-package facts (we use the
 *      truncated README here far more aggressively than Pros & Cons
 *      does, since the README is the primary source of integration
 *      examples).
 *   2. AiProviderService — provider-agnostic completion call.
 *   3. AiCacheService — 24h TTL persistence + in-flight dedup.
 *   4. Schema validation — guarantees `UsageGuideResponse` shape.
 *
 * # Why a SHORTER TTL than Pros & Cons (24h vs 7d)
 *
 * Pros & Cons leans on slow-moving metrics (downloads, bundle size,
 * GitHub stars). Usage Guide leans on the package's CURRENT API,
 * which can shift in any minor release — `provideRouter()` swapped
 * `routes` for `withRoutes()`, a library deprecates `forRoot()`, etc.
 * 24h is a reasonable middle ground between "always fresh" and "burn
 * quota every page view." Refresh button bypasses cache when needed.
 */
@Injectable({ providedIn: 'root' })
export class UsageGuideService {
  private readonly payload = inject(AiPayloadService);
  private readonly ai = inject(AiProviderService);
  private readonly cache = inject(AiCacheService);

  /**
   * Generate side-by-side usage guides for `pkgA` and `pkgB`. Returns
   * the parsed, schema-validated response plus provider metadata.
   *
   * @param forceRefresh true to bypass the cache read (writes the
   * fresh result regardless). Used by the panel's Refresh button.
   */
  generate(
    pkgA: string,
    pkgB: string,
    forceRefresh = false
  ): Observable<AiCompletionResponse<UsageGuideResponse>> {
    return this.cache.getOrFetch<UsageGuideResponse>({
      feature: 'usage-guide',
      pair: [pkgA, pkgB],
      provider: this.ai.activeProvider(),
      model: 'default',
      schemaVersion: USAGE_GUIDE_SCHEMA_VERSION,
      promptVersion: PROMPT_VERSION,
      // 24 hours — code examples can drift faster than Pros & Cons facts.
      ttlMs: 24 * 60 * 60 * 1000,
      bypassCache: forceRefresh,
      factory: () =>
        this.payload.forPackages({ name: pkgA }, { name: pkgB }).pipe(
          switchMap((payload) => this.callModel(payload, pkgA, pkgB))
        )
    });
  }

  private callModel(
    payload: AiPayload,
    pkgA: string,
    pkgB: string
  ): Observable<AiCompletionResponse<UsageGuideResponse>> {
    if (!payload.packageA || !payload.packageB) {
      return throwError(
        () => new Error('Usage Guide requires two packages.')
      );
    }
    return this.ai
      .complete<UsageGuideResponse>({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: this.buildUserPrompt(payload, pkgA, pkgB),
        responseSchema: USAGE_GUIDE_JSON_SCHEMA,
        // We're emitting three code blocks per package — install, setup,
        // example. Six blocks of up to ~60 lines of code each adds up,
        // and we want enough headroom that the model never truncates
        // mid-object. 4000 covers the realistic worst case (long readme
        // → verbose examples) and still fits comfortably in Gemini /
        // Groq / OpenAI single-response limits. We tried 2500 first and
        // it occasionally truncated when one of the packages had an
        // unusually code-heavy README; the extra 1500 token margin
        // costs ~$0.0001 on paid tiers and zero on free tiers, so
        // there's no reason to be stingy.
        maxTokens: 4000,
        // Code generation wants near-zero temperature so the output is
        // precise rather than creative. We want the canonical example
        // for each library, not "an interesting take on" it.
        temperature: 0.1
      })
      .pipe(
        map((res) => ({
          ...res,
          // Defensive normalization: the model occasionally returns the
          // wrong packageName casing (e.g. "Angular Material" instead
          // of "@angular/material"). Stamp the exact names from the
          // request so the UI's output ↔ input pairing is bulletproof.
          data: {
            ...res.data,
            packageA: { ...res.data.packageA, packageName: pkgA },
            packageB: { ...res.data.packageB, packageName: pkgB }
          }
        })),
        catchError((err: AiError | Error) => throwError(() => err))
      );
  }

  /**
   * Compose the user prompt. Unlike Pros & Cons, we lean on the README
   * heavily here — it's the primary source for "this is how you import
   * and use this package today." We pass the full truncated README
   * (up to ~12k chars) so the model has enough context to produce
   * runnable code, not generic boilerplate.
   */
  private buildUserPrompt(
    payload: AiPayload,
    pkgA: string,
    pkgB: string
  ): string {
    const a = this.factsForPrompt(payload.packageA);
    const b = this.factsForPrompt(payload.packageB!);
    return [
      `Produce minimal usage guides for these two npm packages.`,
      ``,
      `Each guide MUST contain three runnable code blocks: install command, setup/bootstrap code, and a basic example. The code must be copy-pasteable into a real project and actually work — no commentary inside code, no \`// ...\` placeholders, no TODO comments, no fabricated APIs.`,
      ``,
      `Target audience: Angular developers. Prefer Angular-idiomatic patterns (provideX(), inject(), standalone components, app.config.ts) over older NgModule patterns when both work.`,
      ``,
      `## Package A: ${pkgA}`,
      '```json',
      JSON.stringify(a, null, 2),
      '```',
      ``,
      `## Package B: ${pkgB}`,
      '```json',
      JSON.stringify(b, null, 2),
      '```',
      ``,
      `Set "packageName" in each result to the EXACT names above ("${pkgA}" and "${pkgB}"). For each code block pick the matching language tag from the schema's enum.`
    ].join('\n');
  }

  /**
   * Trim each PackageFacts to what the model needs for code generation.
   * Crucially this INCLUDES the full truncated README (Pros & Cons uses
   * only a 1500-char excerpt) because integration examples live there.
   * We also drop the comparison-oriented fields (downloads, stars) that
   * are irrelevant to "how do I use this."
   */
  private factsForPrompt(facts: PackageFacts): Record<string, unknown> {
    return {
      name: facts.name,
      version: facts.version,
      description: facts.description,
      // Dependency list helps the model know whether RxJS / @angular/core
      // are peer dependencies it can rely on in examples.
      dependencies: facts.dependencies,
      // The README is the source of truth for current API. Send the
      // FULL truncated body — ai-payload.service caps this at ~12k
      // chars, which fits our 2500-token budget comfortably alongside
      // the second package's README.
      readme: facts.readme?.truncated ?? null
    };
  }
}

// ---------------------------------------------------------------------------
// System prompt — versioned constant
// ---------------------------------------------------------------------------

/**
 * Bump when SYSTEM_PROMPT below changes meaningfully. Invalidates
 * every cached usage-guide response generated under the old prompt.
 */
const PROMPT_VERSION = 1;

/**
 * System prompt for Usage Guide generation. Heavier emphasis on
 * runnable code, Angular idioms, and not-inventing-APIs compared to
 * the Pros & Cons prompt.
 */
const SYSTEM_PROMPT = `\
You are a senior Angular engineer writing minimal "how to use this package" guides for two npm packages displayed side-by-side. Developers will copy your code straight into a real Angular project.

You receive each package's name, version, description, dependencies, and the truncated README (the primary source for current API and integration patterns).

CRITICAL RULES — your output is rejected if you violate any of these:

1. RUNNABLE CODE ONLY. Every code block must be a complete, copy-pasteable snippet that actually compiles and runs in a typical Angular 17+ project. No \`// ... rest of code\` placeholders. No TODO comments. No fabricated function names or imports.

2. README IS YOUR API REFERENCE. Base your code on what the README actually shows. If the README documents \`provideX()\`, use \`provideX()\`. If it documents \`MyModule.forRoot()\`, use that. Do not invent APIs the README doesn't mention.

3. ANGULAR-IDIOMATIC. Prefer modern Angular patterns when the package supports them:
   - \`provideX()\` in \`app.config.ts\` over \`NgModule\` imports
   - \`inject()\` over constructor parameter injection (when the library doesn't require constructor injection)
   - Standalone components in examples
   - \`signal()\` / \`computed()\` over RxJS subjects when both are reasonable
   Fall back to NgModule patterns only when the package's README is NgModule-only.

4. MINIMUM VIABLE EXAMPLE. The basicExample block should be the SMALLEST piece of code that demonstrates the package doing its job. A toast library example shows triggering one toast. An HTTP client example shows one request. Resist the urge to show every option.

5. SEPARATE BLOCKS, SEPARATE CONCERNS. installCommand is a shell command. setupCode is bootstrap/registration only (e.g. \`provideX()\`, \`HttpClientModule\` import, root-level config). basicExample is component/service code that USES the package. Don't mix concerns across blocks.

6. PICK LANGUAGE TAGS CAREFULLY. installCommand is "bash". setupCode is "typescript". basicExample is "typescript" (most cases) or "html" (when the example is a template fragment). Use "json" only if the example is genuinely a config file.

7. SHORT NOTES OR NONE. The notes field is for caveats that matter for adoption: "requires Angular 17+", "incompatible with Zone.js zoneless mode", "expects a peer-installed @types/foo". If nothing notable, return an empty string. Don't pad with platitudes.

8. INTEGRATION DELTA IS ONE SENTENCE. One sentence describing how the two packages differ in their integration shape — where you put the code, how you register, what file you touch. Not a feature comparison. Max 200 chars.

Return ONLY a JSON object matching the schema. No prose around it, no markdown code fences.`;
