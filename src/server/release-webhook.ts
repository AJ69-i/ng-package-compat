/**
 * npm-release webhook ingest (feature #86).
 *
 * Why this exists:
 *   The monitor digest tells the user what changed since their last manual
 *   recheck. With this endpoint, an external CI / a cron job / an npm
 *   webhook proxy can push a "package X published version Y" event and we
 *   record it in a small in-memory ring buffer. The browser polls
 *   `/api/webhooks/npm-release/recent` to surface a "new versions you might
 *   care about" badge.
 *
 *   Endpoints are public (no signature checking yet — that's #99 territory)
 *   but rate-limited per IP and capped to 100 entries in memory so a flood
 *   of events can't OOM the box.
 *
 * Endpoints:
 *   POST /api/webhooks/npm-release  { name, version, time? }    → 202
 *   GET  /api/webhooks/npm-release/recent[?since=ISO]           → []
 */

import type { Express, Request, Response } from 'express';

interface ReleaseEvent {
  name: string;
  version: string;
  receivedAt: string;
  publishedAt: string | null;
}

const MAX_EVENTS = 100;
const events: ReleaseEvent[] = [];

// Per-IP simple rate limit: max 60 posts / minute.
const rateLimit = new Map<string, { window: number; count: number }>();
function allow(ip: string): boolean {
  const now = Math.floor(Date.now() / 60000);
  const slot = rateLimit.get(ip);
  if (!slot || slot.window !== now) {
    rateLimit.set(ip, { window: now, count: 1 });
    return true;
  }
  slot.count++;
  return slot.count <= 60;
}

export function registerReleaseWebhook(app: Express): void {
  app.post('/api/webhooks/npm-release', (req: Request, res: Response) => {
    const ip = (req.ip ?? req.socket.remoteAddress ?? 'unknown') as string;
    if (!allow(ip)) {
      res.status(429).json({ error: 'rate limited' });
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'json body required' });
      return;
    }
    const name = body['name'];
    const version = body['version'];
    const time = body['time'];
    if (typeof name !== 'string' || !/^[@\w./-]+$/.test(name) || name.length > 214) {
      res.status(400).json({ error: 'invalid name' });
      return;
    }
    if (typeof version !== 'string' || !/^[\w.+-]+$/.test(version) || version.length > 64) {
      res.status(400).json({ error: 'invalid version' });
      return;
    }
    const evt: ReleaseEvent = {
      name,
      version,
      receivedAt: new Date().toISOString(),
      publishedAt: typeof time === 'string' ? time : null
    };
    events.unshift(evt);
    if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
    res.status(202).json({ accepted: true });
  });

  app.get('/api/webhooks/npm-release/recent', (req: Request, res: Response) => {
    const sinceParam = req.query['since'];
    let since = 0;
    if (typeof sinceParam === 'string') {
      const ms = Date.parse(sinceParam);
      if (!Number.isNaN(ms)) since = ms;
    }
    const out = since
      ? events.filter((e) => Date.parse(e.receivedAt) > since)
      : events.slice(0, 50);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ events: out, total: events.length });
  });
}
