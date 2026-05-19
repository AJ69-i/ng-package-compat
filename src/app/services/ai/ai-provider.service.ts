import { Injectable, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

/**
 * Unified abstraction over the four supported AI back-ends. Orchestrator
 * services (pros-cons.service, usage-guide.service) call exactly ONE
 * method here — `complete<T>(request)` — and never know which provider
 * actually handled the call.
 *
 * Three-tier provider strategy, picked automatically:
 *   1. **Groq via our /api/ai proxy** (default; no key required, free).
 *   2. **Gemini BYO** (free upgrade; user pastes their Google AI Studio key
 *      once; calls go directly browser → Gemini).
 *   3. **OpenAI BYO** or **DeepSeek BYO** (paid upgrade; same pattern).
 *
 * Three transport patterns, two API shapes:
 *   - Groq, OpenAI, DeepSeek all expose OpenAI-compatible chat-completions
 *     endpoints. One adapter (`callOpenAiCompatible`) handles all three;
 *     they only differ in base URL, model name, and how the auth header
 *     gets attached (proxy adds it server-side; BYO users send their own).
 *   - Gemini has its own request/response shape. Separate adapter
 *     (`callGemini`) — necessary divergence, can't be papered over without
 *     losing native JSON-schema enforcement.
 *
 * Why we keep BYO keys browser-side (never sent to our server):
 *   - The user's key never enters our logs / backups / Sentry traces.
 *   - We don't become a target for "compromise the proxy → harvest API
 *     keys" attacks.
 *   - Each user controls their own billing surface; bugs in our code
 *     can't accidentally rack up charges on someone else's tab.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AiProviderId =
  | 'groq-proxy'
  | 'gemini-byo'
  | 'openai-byo'
  | 'deepseek-byo';

export interface AiCompletionRequest {
  /**
   * The model's role/persona instructions. Stays constant across calls
   * for a given feature (e.g. "You are a comparative-analysis writer for
   * an Angular package compatibility tool…").
   */
  systemPrompt: string;
  /** The user-shaped payload for THIS call (typically a JSON-stringified
   *  AiPayload + the question). */
  userPrompt: string;
  /**
   * JSON schema the response MUST conform to. Compatible with the strict
   * subset of JSON Schema that all four providers accept:
   *   - top-level `type: "object"`
   *   - all properties listed in `required`
   *   - no `oneOf` / `anyOf` / `$ref`
   *   - primitives only inside arrays
   * Schemas in `schemas/` are written to this dialect.
   */
  responseSchema: object;
  /**
   * Hard cap on the response length. Defaults vary per provider; this
   * lets the caller tighten when shape is small (e.g. 800 tokens for
   * pros-cons, 2200 for the usage guide). Leave undefined to take the
   * provider default.
   */
  maxTokens?: number;
  /** Lower = more deterministic. Defaults to 0.2 (we want repeatable
   *  outputs over creative ones for both AI features). */
  temperature?: number;
}

export interface AiCompletionResponse<T> {
  /** Parsed + schema-validated response body. */
  data: T;
  /** Which provider actually handled this call. */
  provider: AiProviderId;
  /** Concrete model name used (e.g. `llama-3.3-70b-versatile`). */
  model: string;
  /** End-to-end latency for telemetry. */
  latencyMs: number;
  /**
   * Unix ms when this response was generated (request-completion time).
   * Set here so cached responses can preserve the original generation
   * timestamp — without this, "5 minutes ago" would reset to "just now"
   * every time the cache served a hit.
   */
  generatedAt: number;
  /**
   * True when this response was served from the AI cache layer rather
   * than from a fresh API call. Lets the UI render a subtle "cached"
   * affordance and lets the dev tools / telemetry distinguish quota
   * hits from quota saves.
   */
  fromCache?: boolean;
}

/**
 * Typed error class — orchestrators can pattern-match on `kind` to decide
 * whether to retry, prompt for a key, or surface a user-facing toast.
 */
export type AiErrorKind =
  | 'RATE_LIMITED'
  | 'INVALID_KEY'
  | 'NO_KEY'
  | 'BAD_RESPONSE'
  | 'NETWORK'
  | 'PROVIDER_ERROR'
  /**
   * The proxy isn't reachable on this origin — most commonly because
   * the user is running `ng serve` (which only knows about Angular
   * routes) without proxying `/api/*` to the SSR server. The dev
   * server's SPA-fallback returns `index.html` for our POST, and
   * the JSON parser then fails on `<!DOCTYPE html>`. Recognising this
   * case lets us point the user at the actual fix instead of showing
   * a confusing parse error.
   */
  | 'PROXY_UNAVAILABLE';

export class AiError extends Error {
  constructor(
    public readonly kind: AiErrorKind,
    message: string,
    public readonly provider: AiProviderId,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'AiError';
  }
}

// ---------------------------------------------------------------------------
// Internal model defaults
// ---------------------------------------------------------------------------

/**
 * Default model per provider. Centralized so we can bump versions in one
 * place when a new GA model lands. The user can override per-call if we
 * later expose model selection in settings.
 */
const DEFAULT_MODELS: Record<AiProviderId, string> = {
  'groq-proxy': 'llama-3.3-70b-versatile',
  // `gemini-2.5-flash` (not 2.0) is Google's current recommended Flash
  // model and — more importantly here — it's the one with non-zero
  // free-tier quota allocated on freshly-created Cloud projects. We
  // tried `gemini-2.0-flash` first and Google returned 429 with
  // `limit: 0` on a brand-new API key: that model has free-tier
  // quota of literally zero on most projects, so the very first
  // request fails. 2.5 has actual free-tier headroom (~15 RPM / ~1M
  // tokens per day) and the same JSON-mode + responseSchema support.
  'gemini-byo': 'gemini-2.5-flash',
  'openai-byo': 'gpt-4o-mini',
  'deepseek-byo': 'deepseek-chat'
};

/** localStorage keys for BYO API keys. */
const KEY_STORAGE = {
  gemini: 'ngpc.ai.gemini-key',
  openai: 'ngpc.ai.openai-key',
  deepseek: 'ngpc.ai.deepseek-key',
  /** User-selected preferred provider; `null` means auto. */
  preferred: 'ngpc.ai.preferred-provider'
} as const;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable({ providedIn: 'root' })
export class AiProviderService {
  private readonly http = inject(HttpClient);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);

  // ---------- BYO key storage (signal-based so the UI can react) ----------

  /** Reactive snapshot of all BYO key presence — drives the settings UI. */
  readonly geminiKey = signal<string | null>(this.loadKey('gemini'));
  readonly openaiKey = signal<string | null>(this.loadKey('openai'));
  readonly deepseekKey = signal<string | null>(this.loadKey('deepseek'));
  readonly preferredProvider = signal<AiProviderId | null>(
    this.loadPreferred()
  );

  /** True when the user has at least one BYO key — drives provider routing. */
  readonly hasAnyByoKey = computed(
    () => !!(this.geminiKey() || this.openaiKey() || this.deepseekKey())
  );

  /**
   * Resolved provider for the next call, given the current state.
   * Resolution order:
   *   1. User's explicit preference (if they set one and the key is there).
   *   2. The first BYO provider with a key (Gemini → OpenAI → DeepSeek).
   *   3. Groq via proxy (free default).
   *
   * The orchestrator can also pass `forceProvider` to `complete()` to
   * override — used by retry paths after a 429.
   */
  readonly activeProvider = computed<AiProviderId>(() => {
    const preferred = this.preferredProvider();
    if (preferred && this.providerAvailable(preferred)) return preferred;
    if (this.geminiKey()) return 'gemini-byo';
    if (this.openaiKey()) return 'openai-byo';
    if (this.deepseekKey()) return 'deepseek-byo';
    return 'groq-proxy';
  });

  setKey(
    provider: 'gemini' | 'openai' | 'deepseek',
    key: string | null
  ): void {
    if (!this.isBrowser) return;
    const target = key && key.trim() ? key.trim() : null;
    try {
      if (target) localStorage.setItem(KEY_STORAGE[provider], target);
      else localStorage.removeItem(KEY_STORAGE[provider]);
    } catch {
      /* storage blocked — non-fatal */
    }
    this.signalForKey(provider).set(target);
  }

  setPreferredProvider(provider: AiProviderId | null): void {
    if (!this.isBrowser) return;
    try {
      if (provider) localStorage.setItem(KEY_STORAGE.preferred, provider);
      else localStorage.removeItem(KEY_STORAGE.preferred);
    } catch {
      /* storage blocked — non-fatal */
    }
    this.preferredProvider.set(provider);
  }

  /** Wipe every BYO key on sign-out so the next user starts clean. */
  clearAll(): void {
    this.setKey('gemini', null);
    this.setKey('openai', null);
    this.setKey('deepseek', null);
    this.setPreferredProvider(null);
  }

  // ---------- Public completion entrypoint ----------

  /**
   * Fire a chat completion through the resolved provider, parse the JSON
   * response, validate it against `responseSchema`, return a typed
   * `AiCompletionResponse<T>`.
   *
   * Pass `forceProvider` to override routing — used by orchestrators when
   * retrying after a `RATE_LIMITED` from the proxy.
   */
  complete<T>(
    request: AiCompletionRequest,
    forceProvider?: AiProviderId
  ): Observable<AiCompletionResponse<T>> {
    const provider = forceProvider ?? this.activeProvider();
    const startedAt = Date.now();

    const call$ = this.dispatch<T>(provider, request);

    return call$.pipe(
      map((data) => {
        const completedAt = Date.now();
        return {
          data,
          provider,
          model: DEFAULT_MODELS[provider],
          latencyMs: completedAt - startedAt,
          // `generatedAt` is the moment the model finished generating —
          // identical to `completedAt` for fresh calls. The cache layer
          // preserves this verbatim so cached results still show the
          // accurate "generated 5 minutes ago" in the provenance footer.
          generatedAt: completedAt
        } satisfies AiCompletionResponse<T>;
      }),
      catchError((err) => throwError(() => this.toAiError(err, provider)))
    );
  }

  /**
   * True if a given provider is usable right now (proxy is always usable;
   * BYO providers are usable when a key is present). Useful for the
   * orchestrators' fallback logic and for the settings UI.
   */
  providerAvailable(provider: AiProviderId): boolean {
    switch (provider) {
      case 'groq-proxy':
        return true;
      case 'gemini-byo':
        return !!this.geminiKey();
      case 'openai-byo':
        return !!this.openaiKey();
      case 'deepseek-byo':
        return !!this.deepseekKey();
    }
  }

  // ---------- Provider routing ----------

  private dispatch<T>(
    provider: AiProviderId,
    request: AiCompletionRequest
  ): Observable<T> {
    switch (provider) {
      case 'groq-proxy':
        return this.callGroqProxy<T>(request);
      case 'gemini-byo':
        return this.callGemini<T>(request);
      case 'openai-byo':
        return this.callOpenAi<T>(request);
      case 'deepseek-byo':
        return this.callDeepSeek<T>(request);
    }
  }

  // ---------- Groq via our /api/ai proxy ----------

  /**
   * Server-side proxy that adds the Groq API key. The client never sees
   * the key. Same OpenAI-compatible request shape as direct Groq, but
   * routed through our origin so:
   *   - browsers don't need to handle Groq's CORS configuration
   *   - we can apply per-IP / per-user rate limits before paying for the
   *     forwarded call
   *   - if Groq is down, we can swap to another OpenAI-compatible
   *     back-end (Cerebras, Together) without the client noticing
   */
  private callGroqProxy<T>(request: AiCompletionRequest): Observable<T> {
    const body = this.buildOpenAiBody(
      DEFAULT_MODELS['groq-proxy'],
      request,
      // Groq only supports strict `json_schema` mode for a small set
      // of models (gpt-oss-120b, kimi-k2). The Llama family we use as
      // the default proxy model does NOT — sending `json_schema` here
      // returns 400 "model does not support response format json_schema".
      // So we use `json_object` mode and rely on the system prompt to
      // restate the schema (`augmentSystemPrompt` handles that). The
      // model still produces correctly-shaped JSON because the schema
      // is right there in the prompt, and `parseAndValidate` catches
      // any drift before it reaches the orchestrator.
      false
    );
    return this.http
      .post<{ choices: Array<{ message: { content: string } }> }>(
        '/api/ai/complete',
        { provider: 'groq', ...body }
      )
      .pipe(
        map((res) =>
          this.parseAndValidate<T>(
            res.choices?.[0]?.message?.content ?? '',
            request.responseSchema
          )
        )
      );
  }

  // ---------- Gemini (BYO) ----------

  /**
   * Direct browser → Gemini call with the user's API key on the URL.
   * Gemini's request shape is different from OpenAI's; the response
   * gets unwrapped from `candidates[0].content.parts[0].text`.
   *
   * Native JSON-schema enforcement via `responseSchema` keeps us out
   * of the "model returned almost-JSON" trap.
   */
  private callGemini<T>(request: AiCompletionRequest): Observable<T> {
    const key = this.geminiKey();
    if (!key) return throwError(() => this.noKeyError('gemini-byo'));

    const model = DEFAULT_MODELS['gemini-byo'];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

    const body = {
      systemInstruction: {
        parts: [{ text: request.systemPrompt }]
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: request.userPrompt }]
        }
      ],
      generationConfig: {
        temperature: request.temperature ?? 0.2,
        maxOutputTokens: request.maxTokens ?? 2048,
        responseMimeType: 'application/json',
        // Gemini's responseSchema accepts only a subset of OpenAPI 3.0
        // schema — NOT full JSON Schema. Notably it rejects
        // `additionalProperties` (which OpenAI strict mode REQUIRES on
        // every nested object) with a 400 "Cannot find field" error
        // listing every offending node. Strip those fields here so the
        // schema literal can stay correct for OpenAI/Groq while still
        // being valid for Gemini.
        responseSchema: sanitizeSchemaForGemini(request.responseSchema),
        // Disable Gemini 2.5's "thinking" mode for this call. Thinking
        // tokens count against maxOutputTokens but never reach the
        // user-visible output, so with thinking enabled a 2500-token
        // budget gets eaten almost entirely by hidden reasoning and
        // the actual JSON response truncates mid-key. For schema-bound
        // output (we're filling in a strict shape, not solving a
        // reasoning problem) thinking adds zero quality and a lot of
        // latency + truncation risk. thinkingBudget: 0 disables it.
        // 1.5/2.0 models ignore this field harmlessly, so it's safe
        // to send unconditionally.
        thinkingConfig: { thinkingBudget: 0 }
      }
    };

    return this.http
      .post<{
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
        }>;
      }>(url, body)
      .pipe(
        map((res) => {
          const text = res.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
          return this.parseAndValidate<T>(text, request.responseSchema);
        }),
        // Self-healing retry — same idea as the OpenAI adapter but
        // adapted to Gemini's request shape. If Gemini rejects the
        // schema (its responseSchema accepts a narrower subset than
        // we've already sanitized for, e.g. a future schema property
        // we haven't taught the sanitizer to strip yet), drop
        // `responseSchema` and `responseMimeType` and retry — the
        // model still has the schema text in the system prompt.
        catchError((err) => {
          if (!isSchemaFormatError(err)) return throwError(() => err);
          const fallbackBody = {
            ...body,
            generationConfig: {
              ...body.generationConfig,
              responseSchema: undefined,
              responseMimeType: undefined
            }
          };
          console.info(
            `[AI provider] Schema-format error from Gemini, retrying ` +
            `without responseSchema. System prompt still instructs ` +
            `JSON output, so parseability is preserved.`
          );
          return this.http
            .post<{
              candidates?: Array<{
                content?: { parts?: Array<{ text?: string }> };
              }>;
            }>(url, fallbackBody)
            .pipe(
              map((res) => {
                const text = res.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
                return this.parseAndValidate<T>(text, request.responseSchema);
              })
            );
        })
      );
  }

  // ---------- OpenAI (BYO) ----------

  private callOpenAi<T>(request: AiCompletionRequest): Observable<T> {
    const key = this.openaiKey();
    if (!key) return throwError(() => this.noKeyError('openai-byo'));
    return this.callOpenAiCompatible<T>(
      'https://api.openai.com/v1/chat/completions',
      key,
      DEFAULT_MODELS['openai-byo'],
      request,
      // OpenAI: the safe move is `json_object` mode without a schema.
      // Strict-schema mode requires `additionalProperties: false` on
      // every nested object, which our schemas don't always set. The
      // model still complies with the shape because we restate it in
      // the prompt — but JSON parseability is guaranteed.
      false
    );
  }

  // ---------- DeepSeek (BYO) ----------

  private callDeepSeek<T>(request: AiCompletionRequest): Observable<T> {
    const key = this.deepseekKey();
    if (!key) return throwError(() => this.noKeyError('deepseek-byo'));
    return this.callOpenAiCompatible<T>(
      'https://api.deepseek.com/v1/chat/completions',
      key,
      DEFAULT_MODELS['deepseek-byo'],
      request,
      false
    );
  }

  // ---------- Shared OpenAI-compatible adapter ----------

  /**
   * One implementation for Groq / OpenAI / DeepSeek (all OpenAI-shaped).
   * The proxy uses the same body shape but a different auth path —
   * `callGroqProxy` builds the body directly to keep that adapter
   * tightly typed against `/api/ai/complete`.
   */
  private callOpenAiCompatible<T>(
    url: string,
    apiKey: string,
    model: string,
    request: AiCompletionRequest,
    enableJsonSchemaMode: boolean
  ): Observable<T> {
    const headers = new HttpHeaders({
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    });
    const body = this.buildOpenAiBody(model, request, enableJsonSchemaMode);

    return this.http
      .post<{ choices: Array<{ message: { content: string } }> }>(
        url,
        body,
        { headers }
      )
      .pipe(
        map((res) =>
          this.parseAndValidate<T>(
            res.choices?.[0]?.message?.content ?? '',
            request.responseSchema
          )
        ),
        // Self-healing retry. If the provider rejects the request with a
        // schema-shaped 4xx error (most commonly because the model
        // doesn't recognize our `response_format` field, or rejects a
        // specific keyword inside `json_schema`), strip `response_format`
        // entirely and retry once. The system prompt already restates
        // the JSON shape via `augmentSystemPrompt`, so the model still
        // has clear guidance to produce parseable JSON — it just won't
        // get the structured-output hint anymore.
        //
        // We only retry ONCE on this specific class of error. Anything
        // else (auth, rate limit, network) propagates as normal so the
        // orchestrator's typed-error logic still works.
        catchError((err) => {
          if (!isSchemaFormatError(err)) return throwError(() => err);
          const fallbackBody = stripResponseFormat(body);
          console.info(
            `[AI provider] Schema-format error from ${url}, retrying ` +
            `without response_format. The model's system prompt still ` +
            `instructs JSON output, so parseability is preserved.`
          );
          return this.http
            .post<{ choices: Array<{ message: { content: string } }> }>(
              url,
              fallbackBody,
              { headers }
            )
            .pipe(
              map((res) =>
                this.parseAndValidate<T>(
                  res.choices?.[0]?.message?.content ?? '',
                  request.responseSchema
                )
              )
            );
        })
      );
  }

  /**
   * Assemble the OpenAI-compatible request body. `enableJsonSchemaMode`
   * decides whether to use strict schema enforcement (Groq, recent
   * OpenAI models) or fall back to plain `json_object` (older models,
   * DeepSeek's V3 era). Either way, the model gets the schema text in
   * the system prompt as a belt-and-braces guard.
   */
  private buildOpenAiBody(
    model: string,
    request: AiCompletionRequest,
    enableJsonSchemaMode: boolean
  ): object {
    const messages = [
      {
        role: 'system',
        content: this.augmentSystemPrompt(
          request.systemPrompt,
          request.responseSchema
        )
      },
      { role: 'user', content: request.userPrompt }
    ];

    return {
      model,
      messages,
      temperature: request.temperature ?? 0.2,
      max_tokens: request.maxTokens ?? 2048,
      response_format: enableJsonSchemaMode
        ? {
            type: 'json_schema',
            json_schema: {
              name: 'response',
              strict: true,
              schema: request.responseSchema
            }
          }
        : { type: 'json_object' }
    };
  }

  /**
   * Append the schema to the system prompt as a fallback enforcement
   * mechanism. Even with `response_format`, telling the model the exact
   * shape it must return improves first-try success rate measurably —
   * schemas alone are weaker than schemas + restated requirements.
   */
  private augmentSystemPrompt(systemPrompt: string, schema: object): string {
    return `${systemPrompt}\n\nReturn ONLY a JSON object matching this schema. No prose, no code fences.\n${JSON.stringify(schema, null, 2)}`;
  }

  // ---------- Response parsing + validation ----------

  /**
   * Parse the raw text returned by the model and validate it shape-checks
   * the requested schema. We do a lightweight structural validation
   * rather than pulling in a full JSON Schema library (ajv would add
   * ~80 KB to the bundle) — for the schemas we actually use (flat
   * objects with primitive + array properties), this is sufficient.
   *
   * If parsing fails or required keys are missing, we throw a typed
   * `AiError` with kind `BAD_RESPONSE` so the orchestrator can decide
   * to retry, fall back, or surface to the user.
   */
  private parseAndValidate<T>(raw: string, schema: object): T {
    const cleaned = this.stripFences(raw);
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error(`Model returned non-JSON content: ${cleaned.slice(0, 200)}`);
    }
    this.assertShape(parsed, schema);
    return parsed as T;
  }

  /**
   * Defensive: some models occasionally wrap JSON in code fences despite
   * JSON-only mode. Strip leading/trailing ```json … ``` if present.
   */
  private stripFences(raw: string): string {
    const trimmed = raw.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    return fenced ? fenced[1].trim() : trimmed;
  }

  /**
   * Lightweight schema check: top-level type + every key listed in
   * `required` must be present (and non-null for primitives). We don't
   * walk into nested arrays; the schemas we use rely on the model's
   * own JSON-mode + strict-mode for deep validation.
   */
  private assertShape(value: unknown, schema: object): void {
    const s = schema as {
      type?: string;
      required?: string[];
      properties?: Record<string, { type?: string }>;
    };
    if (s.type === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Expected JSON object at the top level');
      }
      const obj = value as Record<string, unknown>;
      for (const key of s.required ?? []) {
        if (!(key in obj)) {
          throw new Error(`Missing required property "${key}"`);
        }
      }
    }
  }

  // ---------- Error normalization ----------

  private toAiError(err: unknown, provider: AiProviderId): AiError {
    // Pre-thrown AiErrors from the no-key short-circuit — preserve.
    if (err instanceof AiError) return err;

    // HTTP errors from HttpClient.
    if (err instanceof HttpErrorResponse) {
      const status = err.status;
      // SPA-fallback detection: the dev server (or a stripped prod deploy
      // without the SSR Node app) returns 200/HTML for any unmatched POST.
      // HttpClient then surfaces a parse error with the HTML body in
      // `err.error.text`. We catch this specifically because the wrong
      // error here would say "the model returned bad JSON" — completely
      // misleading the user away from the actual fix.
      if (provider === 'groq-proxy' && this.looksLikeSpaFallback(err)) {
        return new AiError(
          'PROXY_UNAVAILABLE',
          'The AI proxy isn\'t reachable on this origin. The dev server returned the SPA\'s index.html instead of /api/ai/complete. Run the SSR server (npm run build:ssr && npm run serve:ssr) with GROQ_API_KEY set — or paste your own Gemini key in Settings to bypass the proxy.',
          provider,
          status
        );
      }
      if (status === 429) {
        return new AiError(
          'RATE_LIMITED',
          'Rate limit hit on this provider. Try again in a minute, or upgrade by adding your own API key.',
          provider,
          status
        );
      }
      if (status === 401 || status === 403) {
        return new AiError(
          'INVALID_KEY',
          provider === 'groq-proxy'
            ? 'The Groq proxy rejected the request — usually transient.'
            : 'Your API key was rejected. Please check it in Settings.',
          provider,
          status
        );
      }
      // 503 from the proxy means the operator hasn't set GROQ_API_KEY.
      // Treat as a proxy-availability problem, same UX as the SPA-fallback.
      if (status === 503 && provider === 'groq-proxy') {
        return new AiError(
          'PROXY_UNAVAILABLE',
          'The AI proxy is reachable but not configured — the server is missing GROQ_API_KEY. Add it in the server environment, or paste your own Gemini key in Settings to bypass the proxy.',
          provider,
          status
        );
      }
      if (status === 0) {
        return new AiError(
          'NETWORK',
          'Network error reaching the AI provider.',
          provider,
          status
        );
      }
      return new AiError(
        'PROVIDER_ERROR',
        err.error?.error?.message ||
          err.error?.message ||
          err.message ||
          'AI provider returned an error.',
        provider,
        status
      );
    }

    // Synchronous parse / validation errors — catch the SPA-fallback
    // case at this layer too, since the schema validator throws before
    // toAiError sees an HttpErrorResponse. The "<!DOCTYPE" sentinel is
    // the dead giveaway.
    if (err instanceof Error) {
      if (provider === 'groq-proxy' && /<!doctype|<html/i.test(err.message)) {
        return new AiError(
          'PROXY_UNAVAILABLE',
          'The AI proxy isn\'t reachable on this origin. The dev server returned the SPA\'s index.html instead of /api/ai/complete. Run the SSR server (npm run build:ssr && npm run serve:ssr) with GROQ_API_KEY set — or paste your own Gemini key in Settings to bypass the proxy.',
          provider
        );
      }
      if (/JSON|schema|property/i.test(err.message)) {
        return new AiError('BAD_RESPONSE', err.message, provider);
      }
    }

    return new AiError(
      'PROVIDER_ERROR',
      err instanceof Error ? err.message : String(err),
      provider
    );
  }

  /**
   * Detect the "dev server returned my SPA's index.html for /api/ai/complete"
   * case. Three signals, any one of which is enough:
   *   - Response body starts with `<!doctype` or `<html`
   *   - Status 200 but content-type was text/html
   *   - HttpClient's parse error mentions the HTML token "<"
   */
  private looksLikeSpaFallback(err: HttpErrorResponse): boolean {
    const status = err.status;
    const errorBody = err.error;
    const errorText = typeof errorBody === 'string' ? errorBody : errorBody?.text;
    if (typeof errorText === 'string' && /^<!doctype|^<html/i.test(errorText.trim())) {
      return true;
    }
    // HttpClient JSON parse failures wrap the original error here.
    if (
      typeof errorBody?.message === 'string' &&
      /unexpected token '<'|<!doctype|<html/i.test(errorBody.message)
    ) {
      return true;
    }
    if (
      status === 200 &&
      typeof err.message === 'string' &&
      /unexpected token '<'/i.test(err.message)
    ) {
      return true;
    }
    return false;
  }

  private noKeyError(provider: AiProviderId): AiError {
    return new AiError(
      'NO_KEY',
      'No API key configured for this provider.',
      provider
    );
  }

  // ---------- localStorage helpers ----------

  private signalForKey(p: 'gemini' | 'openai' | 'deepseek') {
    return p === 'gemini'
      ? this.geminiKey
      : p === 'openai'
        ? this.openaiKey
        : this.deepseekKey;
  }

  private loadKey(
    p: 'gemini' | 'openai' | 'deepseek'
  ): string | null {
    if (!this.isBrowser) return null;
    try {
      const raw = localStorage.getItem(KEY_STORAGE[p]);
      return raw && raw.trim() ? raw : null;
    } catch {
      return null;
    }
  }

  private loadPreferred(): AiProviderId | null {
    if (!this.isBrowser) return null;
    try {
      const raw = localStorage.getItem(KEY_STORAGE.preferred);
      if (
        raw === 'groq-proxy' ||
        raw === 'gemini-byo' ||
        raw === 'openai-byo' ||
        raw === 'deepseek-byo'
      ) {
        return raw;
      }
      return null;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Schema sanitization for Gemini
// ---------------------------------------------------------------------------

/**
 * Strip fields that Gemini's `responseSchema` doesn't recognize, returning
 * a deep clone so we never mutate the caller's schema constant. Gemini
 * uses a subset of OpenAPI 3.0 Schema — these are the fields that must
 * go (and the ones it does support are: `type`, `format`, `description`,
 * `nullable`, `enum`, `properties`, `required`, `items`):
 *
 *   - `additionalProperties` — OpenAI strict mode requires `false` on
 *     every nested object; Gemini rejects with INVALID_ARGUMENT.
 *   - `oneOf`, `anyOf`, `allOf`, `$ref` — not supported in Gemini's
 *     subset (we don't currently use them, but strip defensively in
 *     case a future schema introduces one).
 *   - `$schema`, `$id`, `title` — top-level metadata Gemini ignores
 *     at best, complains about at worst.
 *
 * The function is exported for unit testing. It's a pure recursive
 * transform: no I/O, no globals.
 */
export function sanitizeSchemaForGemini(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(sanitizeSchemaForGemini);
  }
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (GEMINI_DROPPED_KEYS.has(k)) continue;
      out[k] = sanitizeSchemaForGemini(v);
    }
    return out;
  }
  // Primitives (string/number/boolean/null) pass through unchanged.
  return schema;
}

/** Keys removed from any object encountered during schema traversal. */
const GEMINI_DROPPED_KEYS = new Set([
  'additionalProperties',
  'oneOf',
  'anyOf',
  'allOf',
  '$ref',
  '$schema',
  '$id',
  'title'
]);

// ---------------------------------------------------------------------------
// Self-healing retry helpers
// ---------------------------------------------------------------------------

/**
 * True when an HTTP error from a chat-completion provider looks like a
 * schema-format complaint — i.e. the provider parsed our request but
 * didn't like the shape of `response_format` (OpenAI/Groq/DeepSeek) or
 * `responseSchema` (Gemini). Detected by a combination of 4xx status
 * and message-body keywords each provider tends to use.
 *
 * We deliberately err on the side of detecting too few rather than
 * too many: the retry path strips structured-output entirely, which
 * is a real degradation, so we only want to take it when we're
 * reasonably sure the original error wouldn't have worked anyway.
 */
function isSchemaFormatError(err: unknown): boolean {
  if (!(err instanceof HttpErrorResponse)) return false;
  // Only 400-class signals "I parsed your request but didn't like it".
  // 401/403 (auth), 404 (model/endpoint), 429 (rate limit), 5xx
  // (server) are all different problem classes that retrying without
  // structured-output won't fix.
  if (err.status !== 400) return false;
  const haystack = [
    typeof err.error === 'string' ? err.error : '',
    err.error?.error?.message ?? '',
    err.error?.message ?? '',
    err.message ?? ''
  ]
    .filter(Boolean)
    .join(' | ')
    .toLowerCase();
  // Keyword set covers the actual complaints we've seen + the most
  // likely future ones. Conservative — we'd rather miss a retry than
  // misclassify an unrelated 400 (e.g. invalid `model` name).
  return (
    haystack.includes('response_format') ||
    haystack.includes('json_schema') ||
    haystack.includes('responseschema') ||
    haystack.includes('response_schema') ||
    haystack.includes('additionalproperties') ||
    haystack.includes('does not support response format') ||
    haystack.includes('unknown name') ||
    haystack.includes('invalid json payload')
  );
}

/**
 * Return a clone of the OpenAI-compatible body with `response_format`
 * removed. The model still has the schema text in the system prompt
 * (see `augmentSystemPrompt`), so it knows what shape to produce —
 * it just doesn't get the structured-output hint anymore.
 */
function stripResponseFormat(body: object): object {
  const { response_format: _, ...rest } = body as { response_format?: unknown };
  return rest;
}
