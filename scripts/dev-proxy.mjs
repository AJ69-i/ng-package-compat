#!/usr/bin/env node
/**
 * Standalone dev proxy for the /api/ai/* endpoints.
 *
 * Why this exists:
 *   `npm run serve:ssr` boots the full Angular SSR server, which has
 *   ride-along setup we don't actually need for testing the AI proxy.
 *   This script runs ONLY the proxy routes — pure Express, no Angular.
 *   Pair it with `npm start` (which proxies /api/* via proxy.conf.json)
 *   for a snappy local dev loop.
 *
 *   Logic is intentionally duplicated from src/server/ai-proxy.ts rather
 *   than imported, so we have zero coupling to the Angular build output.
 *   When the SSR boot issue is fixed and `serve:ssr` is the canonical
 *   entry, we can delete this file without touching anything else.
 *
 * Usage:
 *   1. Put your GROQ_API_KEY in `.env` at the project root
 *   2. node --env-file-if-exists=.env scripts/dev-proxy.mjs
 *      (or: npm run dev:proxy)
 *   3. In another terminal: npm start  (Angular dev server on :4200)
 *   4. Browser → http://localhost:4200/compare → AI panel works
 */

import express from 'express';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

const DEFAULT_GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'mixtral-8x7b-32768'
];

const ONE_MINUTE_MS = 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGES = 8;
const MAX_MESSAGE_CHARS = 32_000;
const MAX_TOTAL_CHARS = 80_000;

// ---------- env-driven config ----------

const groqKey = () => {
  const k = process.env.GROQ_API_KEY;
  return k && k.length > 0 ? k : null;
};
const allowedModels = () => {
  const raw = process.env.GROQ_MODELS_ALLOW;
  return new Set(
    raw && raw.trim()
      ? raw.split(',').map((s) => s.trim()).filter(Boolean)
      : DEFAULT_GROQ_MODELS
  );
};
const burstLimit = () => {
  const n = parseInt(process.env.AI_PROXY_BURST_LIMIT ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
};
const dailyLimit = () => {
  const n = parseInt(process.env.AI_PROXY_DAILY_LIMIT ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 50;
};
const trustForwardedFor = () => {
  const v = (process.env.AI_PROXY_TRUST_FORWARDED_FOR ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
};

// ---------- per-IP rate limiter ----------

const rateState = new Map();

function pruneIp(state, now) {
  const burstCutoff = now - ONE_MINUTE_MS;
  const dailyCutoff = now - ONE_DAY_MS;
  state.burst = state.burst.filter((t) => t > burstCutoff);
  state.daily = state.daily.filter((t) => t > dailyCutoff);
}

function checkRateLimit(ip, bLimit, dLimit) {
  const now = Date.now();
  const state = rateState.get(ip) ?? { burst: [], daily: [], lastSeen: now };
  pruneIp(state, now);

  if (state.burst.length >= bLimit) {
    const oldest = state.burst[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + ONE_MINUTE_MS - now) / 1000));
    state.lastSeen = now;
    rateState.set(ip, state);
    return { retryAfterSec };
  }
  if (state.daily.length >= dLimit) {
    const oldest = state.daily[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + ONE_DAY_MS - now) / 1000));
    state.lastSeen = now;
    rateState.set(ip, state);
    return { retryAfterSec };
  }

  state.burst.push(now);
  state.daily.push(now);
  state.lastSeen = now;
  rateState.set(ip, state);
  return null;
}

setInterval(() => {
  const cutoff = Date.now() - ONE_DAY_MS;
  for (const [ip, state] of rateState) {
    if (state.lastSeen < cutoff) rateState.delete(ip);
  }
}, 10 * 60 * 1000).unref();

// ---------- body validation ----------

function validateBody(body, models) {
  if (!body || typeof body !== 'object') return 'request body must be an object';
  if (body.provider !== 'groq') {
    return 'provider must be "groq" — other providers are browser-direct via BYO key.';
  }
  if (typeof body.model !== 'string' || !body.model) return 'model is required';
  if (!models.has(body.model)) {
    return `model "${body.model}" is not in the proxy allow-list. Allowed: ${[...models].join(', ')}`;
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return 'messages must be a non-empty array';
  }
  if (body.messages.length > MAX_MESSAGES) {
    return `messages exceeds max length of ${MAX_MESSAGES}`;
  }
  let totalChars = 0;
  const cleaned = [];
  for (let i = 0; i < body.messages.length; i++) {
    const m = body.messages[i];
    if (!m || typeof m !== 'object') return `messages[${i}] must be an object`;
    if (m.role !== 'system' && m.role !== 'user' && m.role !== 'assistant') {
      return `messages[${i}].role must be one of system | user | assistant`;
    }
    if (typeof m.content !== 'string') return `messages[${i}].content must be a string`;
    if (m.content.length > MAX_MESSAGE_CHARS) {
      return `messages[${i}].content exceeds max ${MAX_MESSAGE_CHARS} chars`;
    }
    totalChars += m.content.length;
    cleaned.push({ role: m.role, content: m.content });
  }
  if (totalChars > MAX_TOTAL_CHARS) {
    return `combined message length exceeds max ${MAX_TOTAL_CHARS} chars`;
  }

  const out = { provider: 'groq', model: body.model, messages: cleaned };
  if (body.temperature !== undefined) {
    const t = Number(body.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 1) {
      return 'temperature must be a number between 0 and 1';
    }
    out.temperature = t;
  }
  if (body.max_tokens !== undefined) {
    const n = Number(body.max_tokens);
    if (!Number.isFinite(n) || n < 1 || n > 4096) {
      return 'max_tokens must be an integer between 1 and 4096';
    }
    out.max_tokens = Math.floor(n);
  }
  if (body.response_format !== undefined) {
    const rf = body.response_format;
    if (!rf || typeof rf !== 'object') return 'response_format must be an object';
    if (rf.type === 'json_object') {
      out.response_format = { type: 'json_object' };
    } else if (rf.type === 'json_schema') {
      if (!rf.json_schema || typeof rf.json_schema !== 'object') {
        return 'response_format.json_schema must be an object';
      }
      out.response_format = { type: 'json_schema', json_schema: rf.json_schema };
    } else {
      return 'response_format.type must be "json_object" or "json_schema"';
    }
  }
  return out;
}

function clientIp(req) {
  if (trustForwardedFor()) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length) {
      const first = xff.split(',')[0]?.trim();
      if (first) return first;
    }
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

async function forwardToGroq(apiKey, payload) {
  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'user-agent': 'ng-package-compat/dev-proxy'
    },
    body: JSON.stringify(payload)
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, body, retryAfter: res.headers.get('retry-after') };
}

// ---------- Express app ----------

const app = express();
app.use(express.json({ limit: '256kb' }));

// CORS is unnecessary because `proxy.conf.json` (or your prod reverse
// proxy) forwards /api/* same-origin. We don't add Access-Control-*
// headers — keeping the proxy single-origin is safer.

app.post('/api/ai/complete', async (req, res) => {
  const apiKey = groqKey();
  if (!apiKey) {
    return res.status(503).json({
      error: 'AI proxy is not configured. Set GROQ_API_KEY in .env or your shell env.'
    });
  }

  const models = allowedModels();
  const validated = validateBody(req.body, models);
  if (typeof validated === 'string') {
    return res.status(400).json({ error: validated });
  }

  const rate = checkRateLimit(clientIp(req), burstLimit(), dailyLimit());
  if (rate) {
    res.setHeader('retry-after', String(rate.retryAfterSec));
    return res.status(429).json({
      error: 'Proxy rate limit exceeded.',
      retryAfterSec: rate.retryAfterSec,
      upgrade: 'Add your own Gemini key in Settings to bypass this limit.'
    });
  }

  try {
    const { provider: _drop, ...forwardPayload } = validated;
    const groqRes = await forwardToGroq(apiKey, forwardPayload);
    if (groqRes.retryAfter) res.setHeader('retry-after', groqRes.retryAfter);
    return res.status(groqRes.status).json(groqRes.body ?? {});
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown error';
    return res.status(502).json({ error: `Failed to reach Groq: ${msg}` });
  }
});

app.get('/api/ai/health', (_req, res) => {
  res.json({
    configured: !!groqKey(),
    defaultModel: 'llama-3.3-70b-versatile',
    modelsAllowed: Array.from(allowedModels()),
    burstLimitPerMinute: burstLimit(),
    dailyLimit: dailyLimit(),
    trustForwardedFor: trustForwardedFor(),
    runtime: 'dev-proxy.mjs (standalone)'
  });
});

// Friendly 404 for anything else — surfaces "you hit the proxy but with
// the wrong path", which is much more useful than a default Express 404.
app.use((req, res) => {
  res.status(404).json({
    error: `dev-proxy.mjs only serves /api/ai/*. Got: ${req.method} ${req.path}.`
  });
});

const port = process.env.PORT ?? 4000;
app.listen(port, () => {
  const configured = !!groqKey();
  console.log(`\n  Dev proxy listening on http://localhost:${port}`);
  console.log(`  GROQ_API_KEY: ${configured ? 'configured ✓' : 'MISSING — set it in .env'}`);
  console.log(`  Health probe: http://localhost:${port}/api/ai/health`);
  console.log(`  Endpoint:     POST http://localhost:${port}/api/ai/complete\n`);
});
