import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

/**
 * One persisted comparison — pair of packages plus a few metadata fields
 * that the History page renders without re-fetching anything.
 */
export interface CompareHistoryEntry {
  /** Stable id; we don't use it for dedup (that's `pairKey`) — it's just
   *  the IndexedDB primary key. */
  id: string;
  /** Unix ms when the comparison was most recently viewed. Updated on
   *  re-record so revisiting an old pair bumps it to the top. */
  createdAt: number;
  /** Original input strings, preserved exactly as the user typed them. */
  packageA: string;
  packageB: string;
  /**
   * Stable dedup key — sorted, lowercased, pipe-joined. Two records for
   * "ngx-toastr vs ngx-sonner" and "ngx-sonner vs ngx-toastr" share this
   * key and collapse into one history entry. Stored on the row so we
   * can query by it directly via the IDB index.
   */
  pairKey: string;
  /** Angular majors both packages support — pre-computed at record time
   *  so the history list renders without re-fetching the npm packument. */
  sharedAngularMajors: number[];
  /**
   * Which AI features this comparison has results for. Drives the ✨
   * indicator on the history chip. `hasCompetitors` is excluded
   * because competitor suggestions auto-fetch (they'd always be true,
   * making the flag carry no information). The other two require
   * explicit "Generate" clicks, so seeing the icon means the user
   * intentionally generated that content.
   */
  aiHighlights: {
    hasProsCons: boolean;
    hasUsageGuide: boolean;
  };
}

const DB_NAME = 'ngpc-compare-history';
const DB_VERSION = 1;
const STORE = 'entries';
const PAIR_INDEX = 'pairKey';
const MAX_ENTRIES = 50;

/**
 * Persistent history of two-package comparisons the user has viewed.
 *
 * # Why this exists as its own service (separate from `HistoryDbService`)
 *
 * `HistoryDbService` stores full `CompatibilityReport` snapshots (300kB
 * each, scoped to single-package analyses). Compare entries are tiny
 * (~1kB each) and have a completely different schema — bolting them
 * into the same store would mean conditional schemas and union types
 * everywhere. A dedicated service keeps both clean.
 *
 * # Storage strategy
 *
 *   - Anonymous users: IndexedDB only. Bounded at 50 entries with
 *     FIFO eviction by `createdAt`.
 *   - Signed-in users: IndexedDB locally for snappy reads, with
 *     `SupabaseSyncService` mirroring to `public.user_compares` for
 *     cross-device persistence. Same strict-separation rule as
 *     favorites and search history.
 *
 * # Dedup
 *
 * Comparisons are deduped by `pairKey` (sorted, lowercased,
 * pipe-joined). Re-comparing the same pair bumps `createdAt` and
 * potentially updates the AI flags rather than creating a new row.
 * Without this, a user who flips between two packages would clutter
 * their history with near-duplicate entries.
 *
 * # SSR-safe
 *
 * Every method is a no-op during prerender via `available()`. The
 * service is otherwise eagerly instantiated to refresh the signal
 * on app load so the History page renders without a flash of
 * "no data yet."
 */
@Injectable({ providedIn: 'root' })
export class CompareHistoryService {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** Live entries sorted newest → oldest, mirroring the IDB store. */
  readonly entries = signal<CompareHistoryEntry[]>([]);

  constructor() {
    if (this.available()) {
      void this.refresh();
    }
  }

  available(): boolean {
    return this.isBrowser && typeof indexedDB !== 'undefined';
  }

  /**
   * Record (or refresh) a comparison. If an entry already exists for
   * this pair, its `createdAt` is bumped and its `sharedAngularMajors`
   * field is updated — AI flags are PRESERVED so a user who generated
   * Pros & Cons last week and re-opens the pair today doesn't lose
   * the ✨ indicator just because they haven't regenerated.
   */
  async record(
    packageA: string,
    packageB: string,
    sharedAngularMajors: number[]
  ): Promise<void> {
    if (!this.available()) return;
    const a = packageA.trim();
    const b = packageB.trim();
    if (!a || !b) return;

    const pairKey = makePairKey(a, b);
    const existing = await this.findByPairKey(pairKey);

    const entry: CompareHistoryEntry = existing
      ? {
          ...existing,
          createdAt: Date.now(),
          packageA: a,
          packageB: b,
          sharedAngularMajors: [...sharedAngularMajors].sort((x, y) => y - x)
        }
      : {
          id: this.uuid(),
          createdAt: Date.now(),
          packageA: a,
          packageB: b,
          pairKey,
          sharedAngularMajors: [...sharedAngularMajors].sort((x, y) => y - x),
          aiHighlights: { hasProsCons: false, hasUsageGuide: false }
        };

    await this.put(entry);
    await this.enforceLimit();
    await this.refresh();
  }

  /**
   * Flag an AI feature as "generated" for a given pair. Called by the
   * Pros & Cons panel and the Usage Guide panel when their result
   * state lands successfully. No-op if the pair has no history entry
   * yet (shouldn't happen — record() runs first on page load — but
   * defensive in case of races).
   */
  async flagAiHighlight(
    packageA: string,
    packageB: string,
    kind: 'pros-cons' | 'usage-guide'
  ): Promise<void> {
    if (!this.available()) return;
    const pairKey = makePairKey(packageA, packageB);
    const existing = await this.findByPairKey(pairKey);
    if (!existing) return;

    const next: CompareHistoryEntry = {
      ...existing,
      aiHighlights: {
        hasProsCons: existing.aiHighlights.hasProsCons || kind === 'pros-cons',
        hasUsageGuide:
          existing.aiHighlights.hasUsageGuide || kind === 'usage-guide'
      }
    };
    // Only write if something actually changed — avoids unnecessary
    // Supabase push echoes for repeated flag calls on the same kind.
    if (
      next.aiHighlights.hasProsCons === existing.aiHighlights.hasProsCons &&
      next.aiHighlights.hasUsageGuide === existing.aiHighlights.hasUsageGuide
    ) {
      return;
    }
    await this.put(next);
    await this.refresh();
  }

  async refresh(): Promise<CompareHistoryEntry[]> {
    if (!this.available()) return [];
    const all = await this.getAll();
    all.sort((a, b) => b.createdAt - a.createdAt);
    this.entries.set(all);
    return all;
  }

  /** Delete a single entry — used by the per-row remove button. */
  async delete(id: string): Promise<void> {
    if (!this.available()) return;
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await this.refresh();
  }

  /** Clear all entries — used by the "Clear history" button. */
  async clear(): Promise<void> {
    if (!this.available()) return;
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await this.refresh();
  }

  /**
   * Replace the entire local store with a cloud-sourced list. Used by
   * SupabaseSyncService on the pull side — strict separation means
   * cloud REPLACES local, it doesn't merge with anonymous history.
   */
  async replaceAll(entries: CompareHistoryEntry[]): Promise<void> {
    if (!this.available()) return;
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.clear();
      // Cap at 50 even when pulling from cloud — protects against a
      // bug where the cloud copy somehow exceeded the cap.
      const sorted = [...entries]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, MAX_ENTRIES);
      for (const e of sorted) store.put(e);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await this.refresh();
  }

  /** Synchronous snapshot — used by the sync push effect to serialize
   *  the current state to JSON without awaiting an IDB read. */
  snapshot(): CompareHistoryEntry[] {
    return this.entries();
  }

  // -------------------------------------------------------------------------
  // IndexedDB plumbing
  // -------------------------------------------------------------------------

  private async findByPairKey(pairKey: string): Promise<CompareHistoryEntry | null> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const index = tx.objectStore(STORE).index(PAIR_INDEX);
      const req = index.get(pairKey);
      req.onsuccess = () =>
        resolve((req.result as CompareHistoryEntry) ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  private async enforceLimit(): Promise<void> {
    const all = await this.getAll();
    if (all.length <= MAX_ENTRIES) return;
    all.sort((a, b) => b.createdAt - a.createdAt);
    const toDrop = all.slice(MAX_ENTRIES);
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const e of toDrop) store.delete(e.id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt', { unique: false });
          store.createIndex(PAIR_INDEX, 'pairKey', { unique: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private async put(entry: CompareHistoryEntry): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private async getAll(): Promise<CompareHistoryEntry[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result as CompareHistoryEntry[]) ?? []);
      req.onerror = () => reject(req.error);
    });
  }

  private uuid(): string {
    if (this.isBrowser && 'randomUUID' in crypto) return crypto.randomUUID();
    return 'cmp-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }
}

/**
 * Stable dedup key for a pair. Sorted alphabetically + lowercased so the
 * order the user typed packages in (A=foo, B=bar vs A=bar, B=foo) doesn't
 * matter. Pipe-joined because pipes are invalid in npm package names so
 * there's no ambiguity in parsing back if we ever need to.
 */
export function makePairKey(a: string, b: string): string {
  const norm = [a.trim().toLowerCase(), b.trim().toLowerCase()].sort();
  return `${norm[0]}|${norm[1]}`;
}
