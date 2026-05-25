import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ApiSurfaceDiff } from './types';

/**
 * Two-layer cache:
 *
 *   L1 — In-memory Map (this process). LRU-bounded. Hot path; reads
 *        are synchronous-fast. Survives the process lifetime only;
 *        a deploy or restart loses it.
 *
 *   L2 — Filesystem under .api-diff-cache/. Survives restarts. 30-day
 *        TTL because a (pkg, from, to) diff is immutable — two specific
 *        published versions of the same package will always produce the
 *        same surface diff. The only reason for a TTL at all is to let
 *        cache entries age out if we ever change the parser/differ
 *        output shape and want stale cached entries to refresh.
 *
 * Layer ordering: writes go to both layers; reads check L1 first,
 * then L2 with a write-back to L1 on hit. That makes L1 a transparent
 * accelerator over L2 — restart and the same query still hits cache,
 * just one disk read away from full speed.
 */

const CACHE_DIR = path.join(process.cwd(), '.api-diff-cache');
const TTL_MS = 30 * 24 * 60 * 60 * 1000;          // 30 days
const MEM_CACHE_MAX_ENTRIES = 100;                 // ~tens of MB total in practice

/**
 * In-memory hot cache. Map maintains insertion order; we evict the
 * oldest entry when we exceed the cap. Not a true LRU (would need
 * to update-on-read to be strict) but for our access pattern —
 * burst-y "scan a popular package" traffic — insertion-order eviction
 * is fine and avoids the overhead of touching the Map on every read.
 */
const memCache = new Map<string, ApiSurfaceDiff>();

/** Read from L1 → L2. Returns null on cache miss or stale entry. */
export async function readCache(
  pkg: string, fromVersion: string, toVersion: string
): Promise<ApiSurfaceDiff | null> {
  const cacheKey = key(pkg, fromVersion, toVersion);

  // L1 hit — synchronous-fast return.
  const hit = memCache.get(cacheKey);
  if (hit) return hit;

  // L2 lookup.
  try {
    const filePath = path.join(CACHE_DIR, cacheKey);
    const stats = await fs.stat(filePath);
    if (Date.now() - stats.mtimeMs > TTL_MS) return null;

    const blob = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(blob) as ApiSurfaceDiff;

    // Write-back to L1 so subsequent reads hit memory.
    promoteToMemory(cacheKey, parsed);
    return parsed;
  } catch {
    // File missing, unparseable, or filesystem permission error —
    // treated as cache miss. Disk-cache failures should NEVER prevent
    // a fresh fetch from succeeding.
    return null;
  }
}

/** Write to both layers. Disk write is best-effort; L1 always succeeds. */
export async function writeCache(diff: ApiSurfaceDiff): Promise<void> {
  const cacheKey = key(diff.pkg, diff.fromVersion, diff.toVersion);

  promoteToMemory(cacheKey, diff);

  // Best-effort disk write — out-of-space, no permissions, read-only
  // filesystem all silently fall through to L1-only mode.
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(path.join(CACHE_DIR, cacheKey), JSON.stringify(diff));
  } catch {
    /* L1-only — cache still works, just doesn't survive a restart */
  }
}

/* ─────────────────── helpers ─────────────────── */

/**
 * Cache key. Two requirements:
 *   - Filesystem-safe: replace `/` in scoped package names so we don't
 *     accidentally write into a subdirectory.
 *   - Self-describing: `@scope__name@1.0.0..2.0.0.json` lets a human
 *     read the cache directory and understand what's there.
 */
function key(pkg: string, fromVersion: string, toVersion: string): string {
  const safePkg = pkg.replace(/\//g, '__');
  return `${safePkg}@${fromVersion}..${toVersion}.json`;
}

/**
 * Insert into L1 with size-bounded eviction. Map preserves insertion
 * order; when over capacity we delete the first (oldest) key.
 */
function promoteToMemory(cacheKey: string, diff: ApiSurfaceDiff): void {
  // Touching an existing key WITHOUT delete-then-set would keep its
  // original insertion position — which defeats the freshness signal.
  // Delete first so the (potentially new) value lands at the tail.
  memCache.delete(cacheKey);
  memCache.set(cacheKey, diff);

  while (memCache.size > MEM_CACHE_MAX_ENTRIES) {
    const oldestKey = memCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    memCache.delete(oldestKey);
  }
}
