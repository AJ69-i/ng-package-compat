/**
 * Server-side AI proxy (Step 2 of the AI feature backend).
 *
 * Why this exists:
 *   The browser-side `AiProviderService` has four routing targets — three
 *   browser-direct (Gemini, OpenAI, DeepSeek with BYO keys), and Groq via
 *   THIS proxy. The Groq path is the zero-friction default: the user
 *   doesn't have to paste a key, doesn't have to think about billing —
 *   they click Compare and it works.
 *
 *   For that to be true, the API key has to live somewhere the browser
 *   can't see. That's here — `GROQ_API_KEY` is a server env var, the
 *   browser POSTs to `/api/ai/complete` with no auth, and we forward
 *   the request to Groq with the key attached.
 *
 *   To prevent this from becoming a free OpenAI-compatible tunnel for
 *   the open internet, we apply three layers of defense:
 *     1. Strict input validation — only known shapes accepted.
 *     2. Model allow-list — only Groq models we've explicitly OK'd.
 *     3. Per-IP rate limits, both short-burst and daily, returning
 *        429 with a Retry-After header so the client's
 *        `AiError.kind === 'RATE_LIMITED'` path lights up cleanly.
 *
 * Configuration (env vars on the server):
 *   GROQ_API_KEY                 — required. Get one from groq.com/console.
 *   GROQ_MODELS_ALLOW            — optional comma-separated list. Defaults
 *                                  below. Operators with paid Groq plans
 *                                  can extend this.
 *   AI_PROXY_BURST_LIMIT         — optional. Per-IP burst cap, default 10
 *                                  requests per 60 seconds.
 *   AI_PROXY_DAILY_LIMIT         — optional. Per-IP daily cap, default 50
 *                                  requests per 24h.
 *   AI_PROXY_TRUST_FORWARDED_FOR — optional, "1"/"true" to honour the
 *                                  X-Forwarded-For header for client IP
 *                                  detection. Set this when running
 *                                  behind a CDN / reverse proxy.
 */

import type { Express, Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface AiProxyRequest {
  provider: 'groq';
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  response_format?:
    | { type: 'json_object' }
    | { type: 'json_schema'; json_schema: object };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'mixtral-8x7b-32768'
];

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

function getGroqKey(): string | null {
  const k = process.env['GROQ_API_KEY'];
  return k && k.length > 0 ? k : null;
}

function getModelAllowList(): Set<string> {
  const raw = process.env['GROQ_MODELS_ALLOW'];
  const list = raw && raw.trim()
    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_GROQ_MODELS;
  return new Set(list);
}

function getBurstLimit(): number {
  const n = parseInt(process.env['AI_PROXY_BURST_LIMIT'] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
}

function getDailyLimit(): number {
  const n = parseInt(process.env['AI_PROXY_DAILY_LIMIT'] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

function trustForwardedFor(): boolean {
  const v = (process.env['AI_PROXY_TRUST_FORWARDED_FOR'] ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

// ---------------------------------------------------------------------------
// Rate limiter (in-memory, per-IP, two-window)
//
// Short burst: N requests per 60s window — protects against a runaway
// client looping on the API.
// Daily: M requests per 24h — bounds total cost per IP for the day.
//
// Memory is stable: each IP holds at most BURST + DAILY timestamps,
// pruned on access. A periodic sweep also drops entries that have been
// idle for over 24h so a long-lived process doesn't accumulate stale IPs.
// ---------------------------------------------------------------------------

const ONE_MINUTE_MS = 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

interface IpState {
  burst: number[];   // timestamps within the last minute
  daily: number[];   // timestamps within the last 24h
  lastSeen: number;  // epoch ms — used for sweep eviction
}

const rateState = new Map<string, IpState>();

function pruneIp(state: IpState, now: number): void {
  const burstCutoff = now - ONE_MINUTE_MS;
  const dailyCutoff = now - ONE_DAY_MS;
  state.burst = state.burst.filter((t) => t > burstCutoff);
  state.daily = state.daily.filter((t) => t > dailyCutoff);
}

/**
 * Idempotent: returns `null` if the request is allowed (and records it),
 * or `{ retryAfterSec }` with the wait time before the next slot opens
 * up. Computes retry-after off whichever window is the bottleneck.
 */
function checkRateLimit(
  ip: string,
  burstLimit: number,
  dailyLimit: number
): { retryAfterSec: number } | null {
  const now = Date.now();
  const state = rateState.get(ip) ?? { burst: [], daily: [], lastSeen: now };
  pruneIp(state, now);

  // Burst check first — surfaces a tighter retry-after to the client.
  if (state.burst.length >= burstLimit) {
    const oldest = state.burst[0];
    const retryAfterSec = Math.max(
      1,
      Math.ceil((oldest + ONE_MINUTE_MS - now) / 1000)
    );
    state.lastSeen = now;
    rateState.set(ip, state);
    return { retryAfterSec };
  }
  if (state.daily.length >= dailyLimit) {
    const oldest = state.daily[0];
    const retryAfterSec = Math.max(
      1,
      Math.ceil((oldest + ONE_DAY_MS - now) / 1000)
    );
    state.lastSeen = now;
    rateState.set(ip, state);
    return { retryAfterSec };
  }

  // Allowed — record this request.
  state.burst.push(now);
  state.daily.push(now);
  state.lastSeen = now;
  rateState.set(ip, state);
  return null;
}

// Periodic sweep — every 10 minutes, drop IPs that have been idle for
// over 24h. Keeps the map's memory footprint stable on long-running
// servers.
let sweepTimer: ReturnType<typeof setInterval> | null = null;
function startSweep(): void {
  if (sweepTimer || typeof setInterval !== 'function') return;
  sweepTimer = setInterval(() => {
    const cutoff = Date.now() - ONE_DAY_MS;
    for (const [ip, state] of rateState) {
      if (state.lastSeen < cutoff) rateState.delete(ip);
    }
  }, 10 * 60 * 1000);
  // Don't keep the process alive just for this timer.
  if (typeof sweepTimer === 'object' && sweepTimer && 'unref' in sweepTimer) {
    (sweepTimer as { unref: () => void }).unref();
  }
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

const MAX_MESSAGES = 8;
const MAX_MESSAGE_CHARS = 32_000;
const MAX_TOTAL_CHARS = 80_000;

function validateBody(
  body: unknown,
  allowedModels: Set<string>
): AiProxyRequest | string {
  if (!body || typeof body !== 'object') return 'request body must be an object';
  const b = body as Record<string, unknown>;

  if (b['provider'] !== 'groq') {
    return 'provider must be "groq" — only Groq is proxied; other providers are browser-direct via BYO key.';
  }

  const model = b['model'];
  if (typeof model !== 'string' || !model) return 'model is required';
  if (!allowedModels.has(model)) {
    return `model "${model}" is not in the proxy allow-list. Allowed: ${[...allowedModels].join(', ')}`;
  }

  const messages = b['messages'];
  if (!Array.isArray(messages) || messages.length === 0) {
    return 'messages must be a non-empty array';
  }
  if (messages.length > MAX_MESSAGES) {
    return `messages exceeds max length of ${MAX_MESSAGES}`;
  }

  let totalChars = 0;
  const cleanedMessages: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== 'object') return `messages[${i}] must be an object`;
    const role = (m as Record<string, unknown>)['role'];
    const content = (m as Record<string, unknown>)['content'];
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      return `messages[${i}].role must be one of system | user | assistant`;
    }
    if (typeof content !== 'string') {
      return `messages[${i}].content must be a string`;
    }
    if (content.length > MAX_MESSAGE_CHARS) {
      return `messages[${i}].content exceeds max ${MAX_MESSAGE_CHARS} chars`;
    }
    totalChars += content.length;
    cleanedMessages.push({ role, content });
  }
  if (totalChars > MAX_TOTAL_CHARS) {
    return `combined message length exceeds max ${MAX_TOTAL_CHARS} chars`;
  }

  // Optional knobs — narrow ranges.
  let temperature: number | undefined;
  if (b['temperature'] !== undefined) {
    const t = Number(b['temperature']);
    if (!Number.isFinite(t) || t < 0 || t > 1) {
      return 'temperature must be a number between 0 and 1';
    }
    temperature = t;
  }
  let max_tokens: number | undefined;
  if (b['max_tokens'] !== undefined) {
    const n = Number(b['max_tokens']);
    if (!Number.isFinite(n) || n < 1 || n > 4096) {
      return 'max_tokens must be an integer between 1 and 4096';
    }
    max_tokens = Math.floor(n);
  }

  // response_format: only the two shapes our client emits.
  let response_format: AiProxyRequest['response_format'] | undefined;
  if (b['response_format'] !== undefined) {
    const rf = b['response_format'];
    if (!rf || typeof rf !== 'object') {
      return 'response_format must be an object';
    }
    const t = (rf as Record<string, unknown>)['type'];
    if (t === 'json_object') {
      response_format = { type: 'json_object' };
    } else if (t === 'json_schema') {
      const schema = (rf as Record<string, unknown>)['json_schema'];
      if (!schema || typeof schema !== 'object') {
        return 'response_format.json_schema must be an object';
      }
      response_format = { type: 'json_schema', json_schema: schema };
    } else {
      return 'response_format.type must be "json_object" or "json_schema"';
    }
  }

  return {
    provider: 'groq',
    model,
    messages: cleanedMessages,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(max_tokens !== undefined ? { max_tokens } : {}),
    ...(response_format ? { response_format } : {})
  };
}

// ---------------------------------------------------------------------------
// IP detection
// ---------------------------------------------------------------------------

function clientIp(req: Request): string {
  if (trustForwardedFor()) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length) {
      // Use the first entry — the original client.
      const first = xff.split(',')[0]?.trim();
      if (first) return first;
    }
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------------------
// Groq forwarding
// ---------------------------------------------------------------------------

/**
 * Forward a validated request to Groq with the server-held API key.
 * We pass through Groq's status code verbatim so the browser-side
 * `AiError.kind === 'RATE_LIMITED'` path lights up correctly when
 * Groq's own quota is exhausted (in addition to our local rate limit).
 */
async function forwardToGroq(
  apiKey: string,
  payload: Omit<AiProxyRequest, 'provider'>
): Promise<{ status: number; body: unknown; retryAfter: string | null }> {
  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'user-agent': 'ng-package-compat/ai-proxy'
    },
    body: JSON.stringify(payload)
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* some 5xx responses don't include JSON */
  }
  return {
    status: res.status,
    body,
    retryAfter: res.headers.get('retry-after')
  };
}

// ---------------------------------------------------------------------------
// Express registration
// ---------------------------------------------------------------------------

export function registerAiProxy(app: Express): void {
  startSweep();

  app.post('/api/ai/complete', async (req: Request, res: Response) => {
    const apiKey = getGroqKey();
    if (!apiKey) {
      res.status(503).json({
        error:
          'AI proxy is not configured. Set GROQ_API_KEY on the server to enable it.'
      });
      return;
    }

    const allowedModels = getModelAllowList();
    const validated = validateBody(req.body, allowedModels);
    if (typeof validated === 'string') {
      res.status(400).json({ error: validated });
      return;
    }

    // Apply rate limit AFTER validation — this way a malformed request
    // doesn't burn the IP's quota; only well-formed forwarded requests
    // count against the budget.
    const rate = checkRateLimit(
      clientIp(req),
      getBurstLimit(),
      getDailyLimit()
    );
    if (rate) {
      res.setHeader('retry-after', String(rate.retryAfterSec));
      res.status(429).json({
        error: 'Proxy rate limit exceeded.',
        retryAfterSec: rate.retryAfterSec,
        upgrade: 'Add your own Gemini key in Settings to bypass this limit.'
      });
      return;
    }

    try {
      const { provider: _drop, ...forwardPayload } = validated;
      const groqRes = await forwardToGroq(apiKey, forwardPayload);

      // Pass through Groq's retry-after header on 429s so the client
      // reports a meaningful "try again in Ns" message.
      if (groqRes.retryAfter) {
        res.setHeader('retry-after', groqRes.retryAfter);
      }
      res.status(groqRes.status).json(groqRes.body ?? {});
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown error';
      res
        .status(502)
        .json({ error: `Failed to reach Groq: ${msg}` });
    }
  });

  // Health probe — clients use this to detect "is the proxy actually
  // wired up?" before falling back to the BYO key prompt during dev.
  app.get('/api/ai/health', (_req: Request, res: Response) => {
    res.json({
      configured: !!getGroqKey(),
      defaultModel: 'llama-3.3-70b-versatile',
      modelsAllowed: Array.from(getModelAllowList()),
      burstLimitPerMinute: getBurstLimit(),
      dailyLimit: getDailyLimit(),
      trustForwardedFor: trustForwardedFor()
    });
  });
}
