import { Injectable, inject } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import { ChangelogRagService, ChangelogResult } from '../changelog-rag.service';
import { AiProviderService, AiCompletionResponse, AiError } from './ai-provider.service';
import { AiCacheService } from './ai-cache.service';
import {
  MigrationResponse,
  VERSION_MIGRATION_JSON_SCHEMA,
  VERSION_MIGRATION_SCHEMA_VERSION
} from './schemas/version-migration.schema';

/**
 * Version Migration orchestrator — the AI side of the self-version
 * comparison feature (e.g. "ngx-toastr 15 → 17").
 *
 * Pipeline:
 *
 *   1. ChangelogRagService — pulls GitHub Releases (preferred) or
 *      CHANGELOG.md (fallback) between the two versions and packs them
 *      into a single ~24k-char text blob with version headers.
 *
 *   2. AiProviderService — provider-agnostic completion call with the
 *      Migration system prompt + schema-validated response.
 *
 *   3. AiCacheService — 7-day TTL persistence. Changelog text is
 *      effectively immutable for any given (pkg, from, to) tuple
 *      because the underlying GitHub releases don't get rewritten, so
 *      we can be aggressive about cache lifetime. The Refresh button
 *      bypasses the read but writes a fresh result.
 *
 * # Why this is its own service (and not a flag on UsageGuideService)
 *
 * The Migration prompt is fundamentally different from Pros & Cons or
 * Usage Guide: those compare two PACKAGES, Migration compares two
 * VERSIONS of one package. Different input shape (changelog text vs
 * package facts), different schema (breakingChanges array vs code
 * blocks), different output UX. Trying to overload UsageGuideService
 * to handle both modes would have meant a 3-way switch on every method
 * and a union-typed schema that no provider could enforce.
 *
 * # Pair key shape
 *
 * The cache key uses `[pkg@from, pkg@to]` so the symmetric-sort step
 * in AiCacheService still produces a stable key regardless of which
 * version the user typed first. Same package on both sides + sorted
 * `from..to` semver means one cache entry per real migration.
 */
@Injectable({ providedIn: 'root' })
export class VersionMigrationService {
  private readonly rag = inject(ChangelogRagService);
  private readonly ai = inject(AiProviderService);
  private readonly cache = inject(AiCacheService);

  /**
   * Generate a migration plan for `pkg` from `fromVersion` to
   * `toVersion`. The order of the two versions is normalized by
   * ChangelogRagService — passing v17 then v15 is equivalent to v15
   * then v17.
   *
   * @param repoUrl npm `repository.url` field — used to resolve the
   *                GitHub slug for the RAG fetch.
   * @param forceRefresh Bypass cache read (always writes fresh result).
   */
  generate(
    pkg: string,
    fromVersion: string,
    toVersion: string,
    repoUrl: string | undefined | null,
    forceRefresh = false
  ): Observable<AiCompletionResponse<MigrationResponse>> {
    return this.cache.getOrFetch<MigrationResponse>({
      feature: 'version-migration',
      // Encode "pkg@version" pair so the cache key sorts correctly even
      // for self-package comparisons (otherwise both halves of the pair
      // would be identical and the sort would collapse them).
      pair: [`${pkg}@${fromVersion}`, `${pkg}@${toVersion}`],
      provider: this.ai.activeProvider(),
      model: 'default',
      schemaVersion: VERSION_MIGRATION_SCHEMA_VERSION,
      promptVersion: PROMPT_VERSION,
      // 7 days — changelog content for a published version is
      // immutable, so a long TTL is safe and saves a lot of quota.
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      bypassCache: forceRefresh,
      factory: () =>
        this.rag.between(pkg, fromVersion, toVersion, repoUrl).pipe(
          switchMap((ctx) => this.callModel(pkg, ctx))
        )
    });
  }

  private callModel(
    pkg: string,
    ctx: ChangelogResult
  ): Observable<AiCompletionResponse<MigrationResponse>> {
    return this.ai
      .complete<MigrationResponse>({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: this.buildUserPrompt(pkg, ctx),
        responseSchema: VERSION_MIGRATION_JSON_SCHEMA,
        // The output can be long when the migration crosses several
        // majors with multiple breaking changes. 4000 tokens covers
        // the realistic worst case (~10 breaks + 10 deprecations +
        // 10 migration steps with code blocks) and matches the budget
        // used by UsageGuideService.
        maxTokens: 4000,
        // Slightly higher than UsageGuide (0.1) but still very low —
        // we want the model to occasionally synthesize when the
        // changelog is terse, not just transcribe.
        temperature: 0.2
      })
      .pipe(
        map((res) => ({
          ...res,
          // Defensive normalization — guarantee the echoed names match
          // the request even if the model returned a slight casing
          // variant ("Ngx-Toastr" vs "ngx-toastr").
          data: {
            ...res.data,
            packageName: pkg,
            fromVersion: ctx.fromVersion,
            toVersion: ctx.toVersion
          }
        })),
        catchError((err: AiError | Error) => throwError(() => err))
      );
  }

  /**
   * Build the user-side prompt. The prompt structure makes the input
   * unambiguous to the model:
   *
   *   - State the package and the version range up front.
   *   - State the changelog source (releases / changelog-md / none) so
   *     the model can calibrate its confidence honestly.
   *   - Hand over the raw changelog text inside a fenced block so the
   *     model treats it as data, not instructions.
   *   - Restate the task at the end (recency bias helps the model
   *     return well-formed JSON in long contexts).
   */
  private buildUserPrompt(pkg: string, ctx: ChangelogResult): string {
    const haveContent = ctx.text.length > 0;
    const sourceLine =
      ctx.source === 'releases'
        ? `Changelog source: GitHub Releases (${ctx.releases.length} entries in range).`
        : ctx.source === 'changelog-md'
          ? 'Changelog source: CHANGELOG.md from the default branch (less structured).'
          : 'Changelog source: NONE — no GitHub releases or CHANGELOG.md found.';

    return [
      `Analyze the migration from ${pkg}@${ctx.fromVersion} to ${pkg}@${ctx.toVersion}.`,
      ``,
      sourceLine,
      ``,
      haveContent
        ? '```markdown'
        : '_No changelog text available. Use general knowledge of this package, hedge with confidence: "low", and explicitly say so in the summary._',
      haveContent ? ctx.text : '',
      haveContent ? '```' : '',
      ``,
      `Return ONLY the JSON object matching the schema. Set "packageName" to "${pkg}" exactly. Set "fromVersion" to "${ctx.fromVersion}" and "toVersion" to "${ctx.toVersion}" — these are the versions the user is migrating between, in semver order (low → high).`
    ].join('\n');
  }
}

// ---------------------------------------------------------------------------
// System prompt — versioned constant
// ---------------------------------------------------------------------------

/**
 * Bump when SYSTEM_PROMPT below changes meaningfully. Invalidates every
 * cached version-migration entry generated under the old prompt.
 */
const PROMPT_VERSION = 1;

const SYSTEM_PROMPT = `\
You are a senior engineer producing a structured upgrade report for a single npm package as it migrates between two versions. The audience is a developer who wants to know, in concrete terms, what they have to do to upgrade.

You receive: the package name, the from/to versions in semver order, and the raw changelog text for every release in between (either from GitHub Releases or from a CHANGELOG.md file). You return a single JSON object matching the schema.

CRITICAL RULES — your output is rejected if you violate any of these:

1. SCOPE STRICTLY TO THE VERSION RANGE. Only include changes that occurred between fromVersion (exclusive) and toVersion (inclusive). Ignore breaks that landed in a release outside the range, even if you remember them.

2. BREAKING CHANGES MUST BE ACTIONABLE. Every breakingChanges entry needs a concrete \`action\` — what code does the user change, and to what. "Update your code" is not an action. "Replace \`HttpClientModule\` imports with \`provideHttpClient()\` in app.config.ts" is an action.

3. DEPRECATIONS ARE WARNINGS, NOT BREAKS. If an API was DEPRECATED but still works in toVersion, it belongs in \`deprecations\`. If it was REMOVED, it belongs in \`breakingChanges\`. Don't double-list.

4. NO FABRICATED VERSIONS. Every \`sinceVersion\` MUST be a real release in the changelog text. If you're unsure, use the lowest version in the range and lower your overall confidence.

5. SEVERITY ROLLUP IS THE WORST CASE.
   - \`major-breaking\`: at least one breakingChanges entry that requires code edits.
   - \`major-safe\`: major bump but no breaking changes affect typical usage (e.g. internal refactor, peer-dep bump only).
   - \`minor\`: only additions, no breaks.
   - \`patch\`: bug fixes only.
   When in doubt, pick the more conservative (more dangerous-sounding) bucket.

6. EFFORT ESTIMATE IS COARSE. Pick \`minutes\` for ≤3 small string edits. \`hours\` for ≤10 edits or one config rewrite. \`day\` for a meaningful refactor. \`days\` for cross-cutting changes (e.g. NgModule → standalone). \`unknown\` if the changelog doesn't give you enough signal.

7. CONFIDENCE FOLLOWS SOURCE.
   - \`high\`: GitHub Releases with dense, structured notes.
   - \`medium\`: CHANGELOG.md or terse releases — you had to read between the lines.
   - \`low\`: no source at all — output is based on general knowledge; SAY SO in the summary.

8. MIGRATION STEPS ARE ORDERED. The user will follow them top to bottom. Put "run \`ng update <pkg>\`" or "bump the version in package.json" first. Then code-level changes. Then any post-upgrade verification ("run \`ng test\`").

9. CODE BLOCKS ARE RUNNABLE. Same rule as the Usage Guide — no \`// ...\` placeholders, no \`TODO\` comments, no fabricated APIs. If you can't produce a real snippet, leave \`code\` empty.

10. EMPTY ARRAYS ARE FINE. If there are no breaking changes, return \`"breakingChanges": []\`. Don't pad with fake entries.

Return ONLY a JSON object matching the schema. No prose around it, no markdown code fences around the JSON.`;
