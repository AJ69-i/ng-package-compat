import { Injectable, inject } from '@angular/core';
import { Observable, of, throwError } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import { ApiDiffClientService, ApiSurfaceDiff } from '../api-diff-client.service';
import { ChangelogRagService, ChangelogResult } from '../changelog-rag.service';
import { AiCacheService } from './ai-cache.service';
import {
  AiCompletionResponse,
  AiError,
  AiProviderService
} from './ai-provider.service';
import {
  MIGRATION_REPORT_JSON_SCHEMA,
  MIGRATION_REPORT_SCHEMA_VERSION
} from './schemas/migration-report.schema';
import type { MigrationReport } from '../../../server/api-diff/types';

/**
 * V2 Migration Intelligence orchestrator. Replaces V1's
 * VersionMigrationService for the Compare page.
 *
 * # Pipeline
 *
 *   1. ApiDiffClientService — fetches the structural API surface diff
 *      from the server's /api/api-diff endpoint. This is the
 *      GROUND-TRUTH input. May be null when types are unavailable.
 *
 *   2. ChangelogRagService — same as V1, fetches GitHub Releases +
 *      CHANGELOG.md between the two versions. NARRATIVE-only input.
 *
 *   3. AiProviderService.complete() — sends the composed prompt with
 *      strict JSON schema. The system prompt enforces "API_DIFF is
 *      ground truth, you're a commentator not a referee."
 *
 *   4. AiCacheService — 7-day persistence keyed by
 *      (pkg, from, to, provider, model, schemaVersion, promptVersion).
 *      Pair sorting is symmetric so v17→v15 and v15→v17 share a key.
 *
 * # Trust hierarchy enforced in the prompt
 *
 *   API_DIFF       (structural ground truth — must be reflected exactly)
 *     > RELEASE_NOTES (maintainer-authored, version-scoped)
 *       > CHANGELOG   (less authoritative, may lag)
 *
 * The system prompt tells the model: when sources DISAGREE with
 * API_DIFF, API_DIFF wins. The narrative sources exist to supply
 * intent (why a change happened, what the migration looks like in
 * code) — never to override structure.
 */
@Injectable({ providedIn: 'root' })
export class MigrationIntelligenceService {
  private readonly apiDiff = inject(ApiDiffClientService);
  private readonly rag = inject(ChangelogRagService);
  private readonly ai = inject(AiProviderService);
  private readonly cache = inject(AiCacheService);

  /**
   * Generate the full MigrationReport. Two-stage flow under the hood:
   *
   *   Stage 1: scan API surface (server call)
   *   Stage 2: AI narration (AI provider call)
   *
   * The caller (the panel) typically wants to surface the two stages
   * separately in the UI. We provide `scanApiDiff` and `narrate` as
   * separately-callable methods so the panel can render Stage 1
   * progress, then Stage 2 progress, then the final report.
   *
   * For callers that don't care about stage breakdown,
   * `generate(pkg, from, to)` is the one-shot helper that does both.
   */
  generate(
    pkg: string,
    fromVersion: string,
    toVersion: string,
    repoUrl: string | undefined | null,
    forceRefresh = false
  ): Observable<AiCompletionResponse<MigrationReport>> {
    return this.scanApiDiff(pkg, fromVersion, toVersion).pipe(
      switchMap((diff) => this.narrate(pkg, fromVersion, toVersion, diff, repoUrl, forceRefresh))
    );
  }

  /**
   * Stage 1: fetch the API surface diff. Stays out of the cache layer
   * because the server already caches; this lets the panel render the
   * Stage 2 "Found N changes" upgrade-banner with real numbers.
   */
  scanApiDiff(pkg: string, fromVersion: string, toVersion: string): Observable<ApiSurfaceDiff | null> {
    return this.apiDiff.diff(pkg, fromVersion, toVersion);
  }

  /**
   * Stage 2: AI narration. Takes the API diff (possibly null) plus
   * the version range and produces a MigrationReport. Cached by the
   * AiCacheService for 7 days — the inputs to this stage (API diff +
   * changelog text + system prompt) are all deterministic per
   * (pkg, from, to) tuple.
   */
  narrate(
    pkg: string,
    fromVersion: string,
    toVersion: string,
    apiDiff: ApiSurfaceDiff | null,
    repoUrl: string | undefined | null,
    forceRefresh = false
  ): Observable<AiCompletionResponse<MigrationReport>> {
    return this.cache.getOrFetch<MigrationReport>({
      feature: 'migration-intelligence',
      // Encode pkg@version on both sides so the cache key sorts
      // symmetrically (v17 vs v15 and v15 vs v17 collapse to one entry).
      pair: [`${pkg}@${fromVersion}`, `${pkg}@${toVersion}`],
      provider: this.ai.activeProvider(),
      model: 'default',
      schemaVersion: MIGRATION_REPORT_SCHEMA_VERSION,
      promptVersion: PROMPT_VERSION,
      // 7-day TTL — for a (pkg, from, to) tuple the inputs are
      // immutable (changelog text never changes for a published
      // version range), so a week of cache is fine and saves a lot
      // of provider quota.
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      bypassCache: forceRefresh,
      factory: () =>
        this.rag.between(pkg, fromVersion, toVersion, repoUrl).pipe(
          switchMap((changelog) => this.callModel(pkg, fromVersion, toVersion, apiDiff, changelog))
        )
    });
  }

  /**
   * The actual AI call. Builds the structured prompt (API diff section
   * + narrative section), enforces the strict JSON schema, normalizes
   * the response so the echoed identifiers always match the request
   * inputs (defends against the model occasionally re-casing the
   * package name or normalizing version strings).
   */
  private callModel(
    pkg: string,
    fromVersion: string,
    toVersion: string,
    apiDiff: ApiSurfaceDiff | null,
    changelog: ChangelogResult
  ): Observable<AiCompletionResponse<MigrationReport>> {
    return this.ai
      .complete<MigrationReport>({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: this.buildUserPrompt(pkg, fromVersion, toVersion, apiDiff, changelog),
        responseSchema: MIGRATION_REPORT_JSON_SCHEMA,
       // 6000 tokens — sized for the realistic worst case: a major
        // Angular upgrade with ~50 apiChanges entries, each carrying
        // a humanSummary + migrationExample code block. Groq Llama 3.3
        // 70b's actual ceiling is 32,768; the previous 4096 cap was
        // a conservative limit in scripts/dev-proxy.mjs that we lifted
        // for this service. Gemini Flash (via BYO key) handles this
        // easily; OpenAI/DeepSeek also comfortable at this size.
        //
        // If the response truncates mid-array on a particularly large
        // diff, the strict JSON-schema validator catches the malformed
        // output and surfaces a clear error — better than silently
        // serving a half-baked report.
        maxTokens: 6000,
        // Low temperature for structured factual narration. We're
        // not asking the model to be creative — we're asking it to
        // restate structural facts in plain English.
        temperature: 0.1
      })
      .pipe(
        map((res) => ({
          ...res,
          data: {
            ...res.data,
            packageName: pkg,
            fromVersion,
            toVersion
          }
        })),
        catchError((err: AiError | Error) => throwError(() => err))
      );
  }

  /**
   * Compose the user prompt. Four labeled sections, in order of trust
   * hierarchy. Each section is bounded in size:
   *
   *   API_DIFF        — full structural diff JSON, up to 6k tokens
   *   RELEASE_NOTES   — bounded by ChangelogRagService (24k chars cap)
   *   CHANGELOG       — falls back to changelog source when no releases
   *   MIGRATION_GUIDE — deferred to V2.1 (would need its own fetcher)
   *
   * The order is intentional: the model reads top-to-bottom, and
   * recency-bias means whatever appears last has the most weight on
   * the final answer. We deliberately put API_DIFF FIRST and end with
   * a restated task instruction so the structure-first framing
   * dominates the model's attention.
   */
  private buildUserPrompt(
    pkg: string,
    fromVersion: string,
    toVersion: string,
    apiDiff: ApiSurfaceDiff | null,
    changelog: ChangelogResult
  ): string {
    const hasApiDiff = !!apiDiff && (
      apiDiff.added.length > 0 ||
      apiDiff.removed.length > 0 ||
      apiDiff.signatureChanged.length > 0 ||
      apiDiff.renameCandidates.length > 0 ||
      apiDiff.newlyDeprecated.length > 0
    );
    const hasChangelog = changelog.text.length > 0;

    const parts: string[] = [];
    parts.push(`Analyze the migration from ${pkg}@${fromVersion} to ${pkg}@${toVersion}.`);
    parts.push('');

    // ── API_DIFF section ──
    if (hasApiDiff) {
      parts.push('## API_DIFF (structural ground truth — assume true)');
      parts.push('```json');
      parts.push(JSON.stringify(this.compactDiff(apiDiff!), null, 2));
      parts.push('```');
      if (apiDiff!.truncation.added > 0 || apiDiff!.truncation.removed > 0 || apiDiff!.truncation.signatureChanged > 0) {
        parts.push(`_Truncation note: ${apiDiff!.truncation.added} added + ${apiDiff!.truncation.removed} removed + ${apiDiff!.truncation.signatureChanged} signature-changed entries omitted for context-window budget. Reflect this in confidence: medium at best._`);
      }
    } else if (apiDiff && (apiDiff.sources.from.origin === 'none' || apiDiff.sources.to.origin === 'none')) {
      parts.push('## API_DIFF');
      parts.push('_NO TYPES AVAILABLE_ for at least one of the two versions. The package ships no .d.ts and is not on DefinitelyTyped. Fall back to narrative-only mode: lower confidence to "low" and say so in your summary.');
    } else {
      parts.push('## API_DIFF');
      parts.push('_EMPTY DIFF_ — no structural changes detected between these versions. This may indicate a patch-level release with bug fixes only, or that we couldn\'t resolve the type entry. Use narrative sources to confirm.');
    }
    parts.push('');

    // ── Narrative source ──
    const narrativeLabel =
      changelog.source === 'releases'
        ? 'RELEASE_NOTES (maintainer-authored, version-scoped — supporting context)'
        : changelog.source === 'changelog-md'
          ? 'CHANGELOG (less authoritative, may lag — supporting context)'
          : null;
    if (hasChangelog && narrativeLabel) {
      parts.push(`## ${narrativeLabel}`);
      parts.push('```markdown');
      parts.push(changelog.text);
      parts.push('```');
    } else {
      parts.push('## NARRATIVE_SOURCES');
      parts.push('_NONE FOUND_ — no GitHub Releases or CHANGELOG.md available for this version range. Operate from API_DIFF alone; if API_DIFF is also empty, hedge appropriately.');
    }
    parts.push('');

    // ── Re-stated task (recency-bias anchor) ──
    parts.push(`Return ONLY the JSON object matching the schema. Set packageName="${pkg}", fromVersion="${fromVersion}", toVersion="${toVersion}" exactly. Every entry in API_DIFF maps to exactly ONE apiChanges entry — do not drop any, do not invent any.`);

    return parts.join('\n');
  }

  /**
   * Strip the API diff payload to just the fields the AI needs.
   * Removes per-symbol line numbers, source descriptors, and other
   * metadata that don't influence the narration. This keeps the
   * token budget tight without losing any signal the AI uses.
   */
  private compactDiff(diff: ApiSurfaceDiff): unknown {
    const compactSym = (s: { name: string; kind: string; signature: string; modulePath: string; jsDoc?: { deprecated?: string; since?: string } }) => ({
      name: s.name,
      kind: s.kind,
      modulePath: s.modulePath,
      signature: s.signature,
      ...(s.jsDoc?.deprecated !== undefined ? { deprecated: s.jsDoc.deprecated } : {}),
      ...(s.jsDoc?.since ? { since: s.jsDoc.since } : {})
    });
    return {
      added: diff.added.map(compactSym),
      removed: diff.removed.map(compactSym),
      signatureChanged: diff.signatureChanged.map((e) => ({
        name: e.name, kind: e.kind, modulePath: e.modulePath,
        before: e.before, after: e.after,
        breakingScore: Math.round(e.breakingScore * 100) / 100
      })),
      renameCandidates: diff.renameCandidates.map((e) => ({
        from: compactSym(e.fromSymbol),
        to: compactSym(e.toSymbol),
        similarity: Math.round(e.similarity * 100) / 100
      })),
      newlyDeprecated: diff.newlyDeprecated.map((e) => ({
        name: e.symbol.name, kind: e.symbol.kind, modulePath: e.symbol.modulePath,
        signature: e.symbol.signature, message: e.message
      }))
    };
  }
}

// ---------------------------------------------------------------------------
// System prompt — versioned constant. Bumping PROMPT_VERSION invalidates
// every cached entry generated under the old prompt.
// ---------------------------------------------------------------------------

const PROMPT_VERSION = 1;

const SYSTEM_PROMPT = `\
You are a senior engineer producing a structured migration report when a user upgrades an npm package between two versions. The audience is a developer who wants to know, in concrete and accurate terms, what they have to do to upgrade.

You receive labeled sections. Trust hierarchy from highest to lowest:

  1. API_DIFF        — structural ground truth from parsed .d.ts diffs.
                       When this section is present and non-empty, IT WINS.
  2. RELEASE_NOTES   — maintainer-authored, version-scoped. Provides INTENT and
                       CODE EXAMPLES that API_DIFF can't.
  3. CHANGELOG       — less authoritative; may lag the actual release.

You are a COMMENTATOR on structural facts, not a referee judging which source is correct. Your job is to translate the API_DIFF into developer-readable prose, using the narrative sources for intent and examples.

CRITICAL RULES — your output is rejected if you violate any of these:

1. EVERY API_DIFF ENTRY MAPS TO EXACTLY ONE apiChanges ENTRY. Do not drop entries. Do not invent entries. The count of apiChanges should equal the total structural changes in API_DIFF (added + removed + signatureChanged + renameCandidates + newlyDeprecated). Empty arrays in API_DIFF mean an empty apiChanges section is correct.

2. NO HALLUCINATED VERSIONS. Every sinceVersion / version-string mention must come from API_DIFF jsDoc.since fields OR from the narrative sources. If you're unsure, omit the version reference.

3. RENAME CANDIDATES ARE CANDIDATES. The differ flagged them based on signature similarity. Use your judgment: if the new signature serves the SAME PURPOSE, emit change="renamed" and set renamedTo. If the purposes are fundamentally different (e.g. an overload was removed and an unrelated function was added with a similar shape), emit them as separate "removed" and "added" entries — do NOT force a rename that isn't a rename.

4. SEVERITY ROLLUP IS THE WORST CASE.
   - major-breaking: at least one apiChanges entry has severity="breaking" AND severity classification is rooted in API_DIFF, not narrative.
   - major-safe: a major version was published but no API_DIFF entry has severity="breaking" for typical usage. Internal refactors that don't break consumers count as major-safe.
   - minor: only additive changes.
   - patch: bug fixes only (empty API_DIFF + narrative confirms patch).

5. CONFIDENCE IS HONEST.
   - high: API_DIFF is non-empty AND at least one narrative source corroborates the structural changes you're describing.
   - medium: API_DIFF is non-empty but no narrative confirmation, OR narrative-only with strong source quality.
   - low: API_DIFF is empty/unavailable AND narrative sources are weak — output is best-effort general knowledge; say so explicitly in summary.

6. ecosystemChanges ARE THINGS API_DIFF CAN'T SHOW. Peer-dep version bumps, dropped Node-version support, new runtime requirements (Angular ≥ 18), removed SSR support. Pull these from narrative sources. Do not duplicate API-level changes here.

7. newCapabilities IS HEADLINES, NOT INVENTORY. ≤ 5 strings, pulled from RELEASE_NOTES, describing features the user would brag about adopting. Do not list every new export — that's apiChanges' job.

8. CODE IN migrationExample IS REAL OR ABSENT. If the narrative sources gave you a before/after example, use it (transcribed faithfully). If they didn't, set before="" and after="" — do NOT fabricate code from memory.

9. humanSummary IS CONCRETE, NOT META. Bad: "This is a significant breaking change." Good: "Replace MyModule.forRoot(opts) with provideMy(opts) in app.config.ts." Each humanSummary must answer "what does the user have to TYPE differently?"

10. RESPECT THE TRUNCATION NOTE. When API_DIFF carries a truncation note, lower confidence to medium and say in summary that analysis covered the top-N changes.

Return ONLY a JSON object matching the schema. No prose around it, no markdown code fences around the JSON.`;
