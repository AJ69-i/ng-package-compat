import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

/**
 * Shape of the upgrade-page draft. Keep loose on purpose — pages may add
 * fields over time and we want older drafts to still round-trip.
 */
export interface SessionDraft {
  /** ISO timestamp of the last save. */
  savedAt: string;
  /** Page identifier so we don't cross-restore between unrelated pages. */
  page: string;
  /** Arbitrary state blob. */
  state: Record<string, unknown>;
}

const DB_NAME = 'ngpc-drafts';
const DB_VERSION = 1;
const STORE = 'drafts';

/**
 * Persists in-progress page state to IndexedDB so that refreshing, crashing,
 * or accidentally closing the tab never loses work.
 *
 * Usage inside a component:
 *   constructor() {
 *     effect(() => {
 *       this.drafts.save('upgrade', { target: this.target(), filter: this.filter() });
 *     });
 *     this.drafts.load('upgrade').then((d) => d && this.restorePrompt(d));
 *   }
 */
@Injectable({ providedIn: 'root' })
export class SessionDraftService {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private dbPromise: Promise<IDBDatabase> | null = null;
  private saveTimer = 0;
  private lastPayload = new Map<string, string>();

  /** Debounced save — coalesces bursts of signal changes into one IDB write. */
  save(page: string, state: Record<string, unknown>, debounceMs = 400): void {
    if (!this.isBrowser) return;
    const payload: SessionDraft = { page, state, savedAt: new Date().toISOString() };
    const serialized = JSON.stringify(payload.state);
    // Skip no-op saves.
    if (this.lastPayload.get(page) === serialized) return;
    this.lastPayload.set(page, serialized);

    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.writeNow(payload).catch(() => { /* swallow — drafts are best-effort */ });
    }, debounceMs);
  }

  async load(page: string): Promise<SessionDraft | null> {
    if (!this.isBrowser) return null;
    try {
      const db = await this.db();
      return await new Promise<SessionDraft | null>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(page);
        req.onsuccess = () => resolve((req.result as SessionDraft) ?? null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    }
  }

  async discard(page: string): Promise<void> {
    if (!this.isBrowser) return;
    this.lastPayload.delete(page);
    try {
      const db = await this.db();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const req = tx.objectStore(STORE).delete(page);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch {
      /* ignore */
    }
  }

  async clearAll(): Promise<void> {
    if (!this.isBrowser) return;
    this.lastPayload.clear();
    try {
      const db = await this.db();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const req = tx.objectStore(STORE).clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch {
      /* ignore */
    }
  }

  private async writeNow(payload: SessionDraft): Promise<void> {
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).put(payload, payload.page);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.dbPromise;
  }
}
