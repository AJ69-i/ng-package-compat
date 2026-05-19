import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { CompatibilityReport, ReportEntry } from '../models/npm-package.model';

/** One persisted analysis snapshot. */
export interface HistorySnapshot {
  id: string;
  createdAt: number;
  /** User-supplied label, e.g. "Before Angular 18 upgrade". */
  label: string;
  /** Target Angular major at the time of the snapshot. */
  targetAngular: number | null;
  currentAngular: number | null;
  /** Summary counts, stored so the list view renders without re-hydrating. */
  summary: {
    total: number;
    conflict: number;
    warning: number;
    safe: number;
    unknown: number;
  };
  /** Slimmed-down per-package state for diffing. */
  entries: Array<{
    name: string;
    currentRange: string | null;
    currentVersion: string | null;
    recommended: string | null;
    status: ReportEntry['status'];
    deprecated: boolean;
  }>;
}

/** Per-package diff emitted by `diff()`. */
export interface SnapshotDelta {
  name: string;
  change:
    | 'added'
    | 'removed'
    | 'status-upgrade'
    | 'status-regression'
    | 'version-bump'
    | 'version-drop'
    | 'unchanged';
  from?: { version: string | null; status: ReportEntry['status'] };
  to?: { version: string | null; status: ReportEntry['status'] };
}

export interface SnapshotDiff {
  from: HistorySnapshot;
  to: HistorySnapshot;
  added: SnapshotDelta[];
  removed: SnapshotDelta[];
  changed: SnapshotDelta[];
  unchangedCount: number;
}

const DB_NAME = 'ngpc-history';
const DB_VERSION = 1;
const STORE = 'snapshots';
const MAX_SNAPSHOTS = 50;

/**
 * Persistent analysis history — backed by IndexedDB so users can audit their
 * migration progress across weeks, not just within one page load.
 *
 * Why IndexedDB and not just localStorage:
 *   - A single CompatibilityReport with 120 packages can easily be 300kB; that
 *     eats through the 5MB localStorage quota in 15 snapshots.
 *   - IndexedDB gives us structured queries (sort by createdAt desc) and a
 *     dedicated per-object-store quota.
 *   - All work is wrapped in Promises for a clean signals-based UI.
 *
 * API surface:
 *   - save(report, label) → snapshot id
 *   - list() → sorted snapshot list (most recent first)
 *   - delete(id)
 *   - diff(fromId, toId) → SnapshotDiff
 *   - clear()  — nuke the whole history (user-initiated)
 *
 * SSR-safe: every method is a no-op during prerender; `this.available()`
 * tells callers whether IDB is usable in the current environment.
 */
@Injectable({ providedIn: 'root' })
export class HistoryDbService {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** Snapshots cached in-memory, kept in sync with IndexedDB. */
  readonly snapshots = signal<HistorySnapshot[]>([]);

  constructor() {
    if (this.available()) {
      void this.refresh();
    }
  }

  available(): boolean {
    return this.isBrowser && typeof indexedDB !== 'undefined';
  }

  /** Save a full compatibility report as a new snapshot; returns the id. */
  async save(report: CompatibilityReport, label: string, target?: number | null, current?: number | null): Promise<string> {
    if (!this.available()) throw new Error('IndexedDB is not available in this context.');
    const snap: HistorySnapshot = {
      id: this.uuid(),
      createdAt: Date.now(),
      label: label?.trim() || 'Untitled snapshot',
      targetAngular: target ?? null,
      currentAngular: current ?? null,
      summary: {
        total: report.entries.length,
        conflict: report.conflictCount,
        warning: report.warningCount,
        safe: report.safeCount,
        unknown: report.unknownCount
      },
      entries: report.entries.map((e) => ({
        name: e.name,
        currentRange: e.currentRange,
        currentVersion: e.currentVersion,
        recommended: e.recommendedForTarget?.version ?? null,
        status: e.status,
        deprecated: !!e.deprecation?.npmDeprecated
      }))
    };

    await this.put(snap);
    await this.enforceLimit();
    await this.refresh();
    return snap.id;
  }

  /** Load the full snapshot list sorted newest → oldest. */
  async refresh(): Promise<HistorySnapshot[]> {
    if (!this.available()) return [];
    const all = await this.getAll();
    all.sort((a, b) => b.createdAt - a.createdAt);
    this.snapshots.set(all);
    return all;
  }

  async get(id: string): Promise<HistorySnapshot | null> {
    if (!this.available()) return null;
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve((req.result as HistorySnapshot) ?? null);
      req.onerror = () => reject(req.error);
    });
  }

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
   * Compute a per-package diff between two snapshots. Ordering matters:
   * `fromId` is the baseline, `toId` is the newer state.
   */
  async diff(fromId: string, toId: string): Promise<SnapshotDiff | null> {
    const [from, to] = await Promise.all([this.get(fromId), this.get(toId)]);
    if (!from || !to) return null;

    const fromMap = new Map(from.entries.map((e) => [e.name, e]));
    const toMap = new Map(to.entries.map((e) => [e.name, e]));

    const added: SnapshotDelta[] = [];
    const removed: SnapshotDelta[] = [];
    const changed: SnapshotDelta[] = [];
    let unchangedCount = 0;

    for (const [name, toE] of toMap) {
      const fromE = fromMap.get(name);
      if (!fromE) {
        added.push({
          name,
          change: 'added',
          to: { version: toE.currentVersion, status: toE.status }
        });
        continue;
      }
      const delta = this.computeChange(fromE, toE);
      if (delta.change === 'unchanged') unchangedCount++;
      else changed.push(delta);
    }

    for (const [name, fromE] of fromMap) {
      if (!toMap.has(name)) {
        removed.push({
          name,
          change: 'removed',
          from: { version: fromE.currentVersion, status: fromE.status }
        });
      }
    }

    return { from, to, added, removed, changed, unchangedCount };
  }

  private computeChange(
    f: HistorySnapshot['entries'][number],
    t: HistorySnapshot['entries'][number]
  ): SnapshotDelta {
    const statusRank: Record<ReportEntry['status'], number> = {
      safe: 3,
      warning: 2,
      unknown: 1,
      conflict: 0
    };

    const statusChanged = f.status !== t.status;
    const versionChanged = (f.currentVersion ?? '') !== (t.currentVersion ?? '');

    if (!statusChanged && !versionChanged) {
      return { name: t.name, change: 'unchanged' };
    }

    let change: SnapshotDelta['change'] = 'version-bump';
    if (statusChanged) {
      change =
        statusRank[t.status] > statusRank[f.status] ? 'status-upgrade' : 'status-regression';
    } else if (versionChanged) {
      const fv = f.currentVersion ?? '';
      const tv = t.currentVersion ?? '';
      change = fv && tv && tv < fv ? 'version-drop' : 'version-bump';
    }

    return {
      name: t.name,
      change,
      from: { version: f.currentVersion, status: f.status },
      to: { version: t.currentVersion, status: t.status }
    };
  }

  private async enforceLimit(): Promise<void> {
    const all = await this.getAll();
    if (all.length <= MAX_SNAPSHOTS) return;
    all.sort((a, b) => b.createdAt - a.createdAt);
    const trimmed = all.slice(MAX_SNAPSHOTS);
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const s of trimmed) store.delete(s.id);
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
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private async put(snap: HistorySnapshot): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(snap);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private async getAll(): Promise<HistorySnapshot[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result as HistorySnapshot[]) ?? []);
      req.onerror = () => reject(req.error);
    });
  }

  private uuid(): string {
    if (this.isBrowser && 'randomUUID' in crypto) return crypto.randomUUID();
    return 'snap-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }
}
