import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Observable, defer, of, shareReplay } from 'rxjs';
import { finalize, tap } from 'rxjs/operators';
import {
  AiCompletionResponse,
  AiProviderId
} from './ai-provider.service';

/**
 * Two-tier sync cache for AI completion responses, with centralized
 * in-flight deduplication.
 *
 *   - **L1 (memory)**: a plain `Map<string, AiCompletionResponse<unknown>>`.
 *     Read-on-hit is synchronous so cache-hit UX feels instant. Bounded
 *     to `L1_MAX` entries with simple LRU eviction so a long session
 *     can't unbound-grow memory.
 *
 *   - **L2 (localStorage)**: versioned namespace `aicache:v1:<feature>:<hash>`,
 *     each entry stores `{ value, expiresAt, lastAccessedAt }`. On
 *     QuotaExceededError we sort all `aicache:v1:*` keys by
 *     `lastAccessedAt` and drop the oldest 20% — true LRU.
 *
 *   - **In-flight dedup**: a `Map<key, Observable>` of currently-pending
 *     requests, shared via `shareReplay({ bufferSize: 1, refCount: true })`
 *     so two simultaneous identical calls (e.g. user clicks "Generate"
 *     twice before the first finishes) share one network call.
 *
 * # Why this design over IndexedDB
 *
 * AI completion responses are tiny — a few KB of JSON — and they fit
 * comfortably in localStorage's ~5–10 MB origin quota even with hundreds
 * of cached entries. localStorage is synchronous, which means cache
 * hits show up in the same microtask, no extra await/then. IndexedDB
 * would add async ceremony and either a dependency (idb, Dexie) or
 * ~150 lines of raw-API plumbing — for no measurable benefit at this
 * data scale.
 *
 * # Cache key composition
 *
 * The key includes every input that could change the model's output:
 *
 *   sorted(packageA, packageB) + provider + model + schemaVersion + promptVersion
 *
 * - Sorted pair = symmetric (A vs B and B vs A share an entry).
 * - Provider + model = switching from Groq Llama to Gemini Flash
 *   correctly bypasses the cache rather than serving stale output.
 * - Schema/prompt versions = shipping a schema or prompt change
 *   automatically invalidates every entry generated with the old shape.
 *
 * # TTL strategy
 *
 * TTL is set per-call by the orchestrator. Recommended values:
 *   - Pros & Cons: 7 days (relies on slow-moving fact data — downloads,
 *     bundle size, repo metrics)
 *   - Usage Guide: 24 hours (code examples can rot faster as APIs evolve)
 *
 * Both have a manual escape hatch: the panel's "Refresh" button calls
 * `getOrFetch` with `bypassCache: true`, which skips the read but still
 * writes the fresh result so future calls hit the cache again.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Identifier for each AI feature — keeps namespaces isolated. */
export type AiCacheFeature = 'pros-cons' | 'usage-guide' | 'competitors' | 'version-migration';

export interface AiCacheKey {
  feature: AiCacheFeature;
  pair: [string, string];
  provider: AiProviderId;
  model: string;
  /** Bumped when the JSON schema shape changes — invalidates old entries. */
  schemaVersion: number;
  /** Bumped when the system prompt changes — invalidates old entries. */
  promptVersion: number;
}

export interface AiCacheGetOptions<T> extends AiCacheKey {
  /** How long a fresh write is considered usable. */
  ttlMs: number;
  /** Network call to run on cache miss (or when bypassCache is true). */
  factory: () => Observable<AiCompletionResponse<T>>;
  /**
   * Skip the cache read (force a fresh fetch), but still write the
   * result to the cache. Used by the "Refresh" button in the UI when
   * the user wants newer output than the cache has on hand.
   */
  bypassCache?: boolean;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Stored shape in both L1 and L2. */
interface CacheEntry<T> {
  value: AiCompletionResponse<T>;
  expiresAt: number;
  lastAccessedAt: number;
}

/** Namespace prefix; bump if we ever ship a backwards-incompatible change. */
const NS = 'aicache:v1';

/** Max L1 entries. Each entry is small but unbounded growth in a long
 *  session is still bad form. 200 covers ~10 sessions of heavy use. */
const L1_MAX = 200;

/** Fraction of L2 keys to evict when we hit QuotaExceededError. */
const L2_EVICT_RATIO = 0.2;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable({ providedIn: 'root' })
export class AiCacheService {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** L1 — in-memory map. Insertion order is access order (Map preserves
   *  insertion order; we re-insert on hit so the oldest key is at the
   *  iterator's front). */
  private readonly l1 = new Map<string, CacheEntry<unknown>>();

  /** In-flight pending observables — keyed identically to L1/L2 so the
   *  three layers share one cache key. */
  private readonly inFlight = new Map<
    string,
    Observable<AiCompletionResponse<unknown>>
  >();

  /**
   * Get-or-fetch with in-flight dedup. The orchestrators (pros-cons,
   * usage-guide) call exactly this method and never touch L1/L2 directly.
   *
   *   1. If a request with this key is already pending → return that
   *      same Observable (shareReplay handles the multi-cast).
   *   2. If a fresh value lives in L1 → emit synchronously, no network.
   *   3. If a fresh value lives in L2 → promote to L1, emit synchronously.
   *   4. Otherwise → call factory(), cache the result, emit it.
   */
  getOrFetch<T>(opts: AiCacheGetOptions<T>): Observable<AiCompletionResponse<T>> {
    const key = this.makeKey(opts);
    const now = Date.now();

    // 1. In-flight dedup — same key, request already running.
    if (this.inFlight.has(key)) {
      return this.inFlight.get(key)! as Observable<AiCompletionResponse<T>>;
    }

    // 2 + 3. Cache lookup (skip if bypassCache).
    if (!opts.bypassCache) {
      const hit = this.read<T>(key, now);
      if (hit) {
        return of({ ...hit.value, fromCache: true });
      }
    }

    // 4. Cache miss — invoke the factory. defer() ensures the network
    // call doesn't start until something subscribes. shareReplay with
    // refCount=true unsubscribes the upstream when no one is listening,
    // so a user navigating away mid-request doesn't keep the call alive.
    const call$ = defer(() => opts.factory()).pipe(
      tap((res) => {
        this.write(key, res, now + opts.ttlMs);
      }),
      finalize(() => {
        // Always clear the in-flight slot — both on success and error.
        // If we left a failed observable cached here, subsequent retries
        // would replay the same error forever.
        this.inFlight.delete(key);
      }),
      shareReplay({ bufferSize: 1, refCount: true })
    );

    this.inFlight.set(key, call$ as Observable<AiCompletionResponse<unknown>>);
    return call$;
  }

  /**
   * Force-evict a specific entry from both tiers. Used when the user
   * resets feature state, or when a corrupt cached value is suspected.
   */
  invalidate(key: AiCacheKey): void {
    const k = this.makeKey(key);
    this.l1.delete(k);
    this.inFlight.delete(k);
    if (this.isBrowser) {
      try {
        localStorage.removeItem(k);
      } catch {
        /* storage blocked — non-fatal */
      }
    }
  }

  /**
   * Clear every cached entry, optionally restricted to one feature.
   * Useful from settings UI ("Clear AI cache") and from tests.
   */
  clearAll(feature?: AiCacheFeature): void {
    if (feature) {
      const prefix = `${NS}:${feature}:`;
      for (const k of [...this.l1.keys()]) {
        if (k.startsWith(prefix)) this.l1.delete(k);
      }
      for (const k of [...this.inFlight.keys()]) {
        if (k.startsWith(prefix)) this.inFlight.delete(k);
      }
      this.purgeL2(prefix);
    } else {
      this.l1.clear();
      this.inFlight.clear();
      this.purgeL2(`${NS}:`);
    }
  }

  // -------------------------------------------------------------------------
  // L1/L2 plumbing
  // -------------------------------------------------------------------------

  private read<T>(key: string, now: number): CacheEntry<T> | null {
    // L1 first — sync, fast.
    const l1Hit = this.l1.get(key);
    if (l1Hit) {
      if (l1Hit.expiresAt > now) {
        // Touch: move to the back of insertion order so LRU eviction
        // discards the truly oldest entries.
        this.l1.delete(key);
        l1Hit.lastAccessedAt = now;
        this.l1.set(key, l1Hit);
        return l1Hit as CacheEntry<T>;
      }
      this.l1.delete(key);
    }

    // L2 fallback.
    if (!this.isBrowser) return null;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(key);
    } catch {
      return null;
    }
    if (!raw) return null;

    let parsed: CacheEntry<T> | null = null;
    try {
      parsed = JSON.parse(raw) as CacheEntry<T>;
    } catch {
      // Corrupt entry — evict and move on.
      try { localStorage.removeItem(key); } catch { /* */ }
      return null;
    }
    if (!parsed || parsed.expiresAt <= now) {
      try { localStorage.removeItem(key); } catch { /* */ }
      return null;
    }

    // Touch + promote to L1.
    parsed.lastAccessedAt = now;
    try {
      localStorage.setItem(key, JSON.stringify(parsed));
    } catch {
      /* quota — non-fatal, the L1 promote still wins */
    }
    this.promoteToL1(key, parsed);
    return parsed;
  }

  private write<T>(
    key: string,
    value: AiCompletionResponse<T>,
    expiresAt: number
  ): void {
    const entry: CacheEntry<T> = {
      value,
      expiresAt,
      lastAccessedAt: Date.now()
    };
    this.promoteToL1(key, entry);
    if (!this.isBrowser) return;
    try {
      localStorage.setItem(key, JSON.stringify(entry));
    } catch (err) {
      // Most likely QuotaExceededError. Evict the oldest L2 entries and
      // retry once — if it still fails, we silently give up on L2 but
      // keep the L1 entry, so the current session still gets dedup.
      if (this.looksLikeQuota(err)) {
        this.evictL2();
        try {
          localStorage.setItem(key, JSON.stringify(entry));
        } catch {
          /* abandon L2 write */
        }
      }
    }
  }

  private promoteToL1<T>(key: string, entry: CacheEntry<T>): void {
    this.l1.set(key, entry as CacheEntry<unknown>);
    // Bounded LRU — evict the oldest (front of iterator) until we're
    // back under L1_MAX. Map preserves insertion order, and we re-insert
    // on hit, so the oldest entry is always at the front.
    while (this.l1.size > L1_MAX) {
      const oldestKey = this.l1.keys().next().value;
      if (oldestKey === undefined) break;
      this.l1.delete(oldestKey);
    }
  }

  // -------------------------------------------------------------------------
  // L2 housekeeping
  // -------------------------------------------------------------------------

  private evictL2(): void {
    if (!this.isBrowser) return;
    const entries: Array<{ key: string; lastAccessedAt: number }> = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(`${NS}:`)) continue;
        const raw = localStorage.getItem(k);
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw) as CacheEntry<unknown>;
          entries.push({ key: k, lastAccessedAt: parsed.lastAccessedAt ?? 0 });
        } catch {
          // Corrupt — schedule for eviction regardless.
          entries.push({ key: k, lastAccessedAt: 0 });
        }
      }
    } catch {
      return;
    }
    entries.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
    const toDrop = Math.max(1, Math.floor(entries.length * L2_EVICT_RATIO));
    for (let i = 0; i < toDrop; i++) {
      try { localStorage.removeItem(entries[i].key); } catch { /* */ }
    }
  }

  private purgeL2(prefix: string): void {
    if (!this.isBrowser) return;
    const toRemove: string[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) toRemove.push(k);
      }
      for (const k of toRemove) localStorage.removeItem(k);
    } catch {
      /* */
    }
  }

  private looksLikeQuota(err: unknown): boolean {
    if (!err) return false;
    if (err instanceof DOMException) {
      // Modern: 'QuotaExceededError'; legacy WebKit: 'QUOTA_EXCEEDED_ERR'.
      return err.name === 'QuotaExceededError' || err.code === 22;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Key composition
  // -------------------------------------------------------------------------

  /**
   * Build the cache key. The package pair is sorted so A-vs-B and
   * B-vs-A share one entry. Everything else is appended verbatim with
   * `:` separators — keys are human-readable in DevTools, which makes
   * debugging "why didn't this hit?" cases trivial.
   */
  private makeKey(k: AiCacheKey): string {
    const [a, b] = [...k.pair].sort();
    return [
      NS,
      k.feature,
      `${a}|${b}`,
      k.provider,
      k.model,
      `s${k.schemaVersion}`,
      `p${k.promptVersion}`
    ].join(':');
  }
}

