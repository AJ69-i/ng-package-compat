/**
 * Tiny read-through filesystem cache for npm packuments.
 *
 * Why this exists:
 *   On a 200-dependency package.json the CLI was firing 200 unauthenticated
 *   GETs against `registry.npmjs.org` per run. That's slow, rude to the
 *   registry, and makes CI runs unpredictable (rate-limited boxes 429 us).
 *
 * Strategy:
 *   - Read-through: lookup → check on-disk → if fresh, return; else fetch.
 *   - Slim format: we ask for `application/vnd.npm.install-v1+json` so we
 *     get just versions/peerDeps/deprecation/dist-tags, not full READMEs.
 *     Cuts cache size by ~10× on big packages.
 *   - ETag revalidation: stored entries keep the ETag; on TTL expiry we
 *     send `If-None-Match`. A 304 just bumps the timestamp — no payload.
 *   - Concurrency-limited fetch: a tiny semaphore around `fetch` so we
 *     don't fire all 200 requests in parallel.
 *
 * On-disk layout: one JSON file per package, name URL-encoded so `@scope/name`
 * works as a flat filename.
 *
 *     ~/.cache/ngpc/packuments/@scope%2Fname.json
 *     ~/.cache/ngpc/packuments/rxjs.json
 *
 * File payload:
 *
 *     { "fetchedAt": ISO, "etag": "W/...", "data": <slim packument> }
 */

import { mkdir, readFile, writeFile, readdir, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';

const REGISTRY = 'https://registry.npmjs.org';
const SLIM_ACCEPT = 'application/vnd.npm.install-v1+json';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_CONCURRENCY = 8;

function defaultCacheDir() {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.cache');
  return join(base, 'ngpc', 'packuments');
}

function fileFor(dir, name) {
  return join(dir, encodeURIComponent(name) + '.json');
}

/**
 * Tiny semaphore. `acquire()` returns a release function.
 * Used to cap concurrent fetches without pulling in a dep.
 */
function makeSemaphore(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || queue.length === 0) return;
    active++;
    const resolve = queue.shift();
    resolve(() => {
      active--;
      next();
    });
  };
  return {
    acquire() {
      return new Promise((resolve) => {
        queue.push(resolve);
        next();
      });
    }
  };
}

export class PackumentCache {
  constructor(opts = {}) {
    this.dir = opts.dir ?? defaultCacheDir();
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.disabled = !!opts.disabled;
    this.sem = makeSemaphore(opts.concurrency ?? DEFAULT_CONCURRENCY);
    this._stats = { hits: 0, revalidated: 0, misses: 0, errors: 0 };
  }

  stats() {
    return { ...this._stats, dir: this.dir };
  }

  async ensureDir() {
    if (!existsSync(this.dir)) await mkdir(this.dir, { recursive: true });
  }

  async clear() {
    if (!existsSync(this.dir)) return { removed: 0 };
    const files = await readdir(this.dir);
    let removed = 0;
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        await unlink(join(this.dir, f));
        removed++;
      } catch {
        /* ignore */
      }
    }
    return { removed };
  }

  /**
   * Read-through fetch for a packument. Returns the slim JSON payload, or
   * `null` if the registry returned 404 / network failed.
   */
  async get(name) {
    if (this.disabled) {
      return await this._fetchFresh(name, null);
    }
    await this.ensureDir();
    const path = fileFor(this.dir, name);
    let cached = null;
    if (existsSync(path)) {
      try {
        const raw = await readFile(path, 'utf8');
        cached = JSON.parse(raw);
      } catch {
        /* corrupt entry — ignore and refetch */
      }
    }
    const fresh =
      cached && Date.now() - new Date(cached.fetchedAt).getTime() < this.ttlMs;
    if (fresh) {
      this._stats.hits++;
      return cached.data;
    }

    // Stale or missing — go to the network with ETag revalidation.
    const res = await this._fetchFresh(name, cached?.etag ?? null);
    if (res === null) {
      // Network failure / 404. If we have any cached copy at all, prefer it
      // over nothing so offline-ish runs still produce a report.
      if (cached) return cached.data;
      this._stats.misses++;
      return null;
    }
    if (res.notModified && cached) {
      // Bump the timestamp without rewriting the body.
      cached.fetchedAt = new Date().toISOString();
      try {
        await writeFile(path, JSON.stringify(cached));
      } catch {
        /* non-fatal */
      }
      this._stats.revalidated++;
      return cached.data;
    }
    // Full miss: 200 OK with body.
    this._stats.misses++;
    try {
      await writeFile(
        path,
        JSON.stringify({
          fetchedAt: new Date().toISOString(),
          etag: res.etag ?? null,
          data: res.data
        })
      );
    } catch {
      /* non-fatal */
    }
    return res.data;
  }

  async _fetchFresh(name, ifNoneMatch) {
    const release = await this.sem.acquire();
    try {
      const url = `${REGISTRY}/${encodeURIComponent(name).replace('%40', '@')}`;
      const headers = { accept: SLIM_ACCEPT };
      if (ifNoneMatch) headers['if-none-match'] = ifNoneMatch;
      let res;
      try {
        res = await fetch(url, { headers });
      } catch {
        this._stats.errors++;
        return null;
      }
      if (res.status === 304) return { notModified: true, etag: ifNoneMatch };
      if (!res.ok) return null;
      let data;
      try {
        data = await res.json();
      } catch {
        this._stats.errors++;
        return null;
      }
      return { notModified: false, etag: res.headers.get('etag'), data };
    } finally {
      release();
    }
  }

  /**
   * Resolve many packuments in parallel (capped by the semaphore). Yields
   * `{ name, packument }` pairs as they complete so the CLI can stream
   * progress to stderr.
   */
  async *getMany(names, onProgress) {
    let done = 0;
    const total = names.length;
    const tasks = names.map((name) =>
      this.get(name).then((packument) => {
        done++;
        if (onProgress) onProgress({ name, done, total });
        return { name, packument };
      })
    );
    for (const promise of tasks) {
      // Yield in original order so per-package output is deterministic.
      yield await promise;
    }
  }

  /**
   * Compute disk usage of the cache directory in bytes.
   */
  async diskBytes() {
    if (!existsSync(this.dir)) return 0;
    const files = await readdir(this.dir);
    let total = 0;
    for (const f of files) {
      try {
        const s = await stat(join(this.dir, f));
        total += s.size;
      } catch {
        /* ignore */
      }
    }
    return total;
  }
}

export function defaultCache(opts = {}) {
  return new PackumentCache(opts);
}

export { defaultCacheDir };
