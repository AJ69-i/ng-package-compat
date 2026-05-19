/**
 * Server-side packument cache (feature #85).
 *
 * Why this exists:
 *   The browser hits the npm registry directly today. That's fine for low
 *   traffic but it (a) sends every user's install/upgrade flow through
 *   their own laptop's connection, (b) doesn't share cache between users
 *   on the same deployment, and (c) gives us no way to add a CDN.
 *
 *   This endpoint exposes a slim packument over the SSR server. The same
 *   on-disk layout the CLI uses (~/.cache/ngpc/packuments/) is reused so
 *   one box's CLI runs warm the cache for the browser too.
 *
 * Endpoint:
 *   GET /api/registry/packument/:name → slim packument JSON, or 502 if
 *   the upstream registry can't be reached and we have no cache copy.
 *
 *   The package name is URL-encoded by the caller. Scoped packages work
 *   as `@scope%2Fname`.
 *
 * Caching:
 *   - On disk: same layout as the CLI cache so the two warm each other.
 *   - HTTP: we send `Cache-Control: public, max-age=900` (15 minutes) so
 *     a CDN in front of the SSR server can absorb the bulk of traffic.
 *   - ETag passthrough: we forward the upstream ETag to the client via
 *     `ETag` header so browsers can revalidate in the same way.
 */

import type { Express, Request, Response } from 'express';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const REGISTRY = 'https://registry.npmjs.org';
const SLIM_ACCEPT = 'application/vnd.npm.install-v1+json';
const TTL_MS = 24 * 60 * 60 * 1000; // 24h

function cacheDir(): string {
  const xdg = process.env['XDG_CACHE_HOME'];
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.cache');
  return join(base, 'ngpc', 'packuments');
}

function fileFor(name: string): string {
  return join(cacheDir(), encodeURIComponent(name) + '.json');
}

interface CacheEntry {
  fetchedAt: string;
  etag: string | null;
  data: unknown;
}

async function readCache(name: string): Promise<CacheEntry | null> {
  const path = fileFor(name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function writeCache(name: string, entry: CacheEntry): Promise<void> {
  const path = fileFor(name);
  if (!existsSync(dirname(path))) await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(entry));
}

async function fetchUpstream(
  name: string,
  ifNoneMatch: string | null
): Promise<{ status: number; etag: string | null; data: unknown | null }> {
  const url = `${REGISTRY}/${encodeURIComponent(name).replace('%40', '@')}`;
  const headers: Record<string, string> = { accept: SLIM_ACCEPT };
  if (ifNoneMatch) headers['if-none-match'] = ifNoneMatch;
  const res = await fetch(url, { headers });
  if (res.status === 304) return { status: 304, etag: ifNoneMatch, data: null };
  if (!res.ok) return { status: res.status, etag: null, data: null };
  return {
    status: 200,
    etag: res.headers.get('etag'),
    data: await res.json()
  };
}

export function registerRegistryCache(app: Express): void {
  app.get('/api/registry/packument/:name', async (req: Request, res: Response) => {
    const raw = req.params['name'];
    if (!raw) {
      res.status(400).json({ error: 'package name required' });
      return;
    }
    const name = decodeURIComponent(raw);
    if (!/^@?[a-z0-9][\w.-]*\/?[\w.-]*$/i.test(name) || name.length > 214) {
      res.status(400).json({ error: 'invalid package name' });
      return;
    }

    const cached = await readCache(name);
    const fresh = cached && Date.now() - new Date(cached.fetchedAt).getTime() < TTL_MS;
    if (fresh) {
      res.setHeader('Cache-Control', 'public, max-age=900');
      if (cached!.etag) res.setHeader('ETag', cached!.etag);
      res.json(cached!.data);
      return;
    }

    try {
      const upstream = await fetchUpstream(name, cached?.etag ?? null);
      if (upstream.status === 304 && cached) {
        cached.fetchedAt = new Date().toISOString();
        await writeCache(name, cached);
        res.setHeader('Cache-Control', 'public, max-age=900');
        if (cached.etag) res.setHeader('ETag', cached.etag);
        res.json(cached.data);
        return;
      }
      if (upstream.status === 404) {
        res.status(404).json({ error: 'package not found' });
        return;
      }
      if (upstream.status >= 400 || upstream.data == null) {
        // Upstream failed; if we have *any* cache copy, serve stale.
        if (cached) {
          res.setHeader('Cache-Control', 'public, max-age=60');
          res.setHeader('X-Cache-Status', 'stale');
          res.json(cached.data);
          return;
        }
        res.status(502).json({ error: 'registry unavailable' });
        return;
      }
      const entry: CacheEntry = {
        fetchedAt: new Date().toISOString(),
        etag: upstream.etag,
        data: upstream.data
      };
      await writeCache(name, entry);
      res.setHeader('Cache-Control', 'public, max-age=900');
      if (upstream.etag) res.setHeader('ETag', upstream.etag);
      res.json(upstream.data);
    } catch (e) {
      // Network failure; serve stale if available.
      if (cached) {
        res.setHeader('X-Cache-Status', 'stale');
        res.json(cached.data);
        return;
      }
      res.status(502).json({ error: (e as Error)?.message ?? 'fetch failed' });
    }
  });
}
