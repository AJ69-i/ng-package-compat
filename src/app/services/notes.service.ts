import { Injectable, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

export interface PackageNote {
  /** Package name, used as the primary key. */
  name: string;
  /** Free-form note text. */
  note: string;
  /** Pin/flag the package so it floats to the top of the upgrade list. */
  flagged: boolean;
  /** ISO timestamp of the last update. */
  updatedAt: string;
}

const DB_NAME = 'ngpc-notes';
const DB_VERSION = 1;
const STORE = 'notes';

/**
 * Per-package notes and flags — persisted to IndexedDB so they survive across
 * sessions and analysis runs. Teams use this to capture context like
 * "pinned to 4.5 for legal review" or "deferred until Q3 due to migration".
 *
 * Exposes a readonly signal `all()` keyed by name so UI tables can reactively
 * show the note/flag for each row without hitting IDB on every render.
 */
@Injectable({ providedIn: 'root' })
export class NotesService {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private dbPromise: Promise<IDBDatabase> | null = null;

  /** In-memory cache, synced from IDB on boot and on every write. */
  private readonly cache = signal<Record<string, PackageNote>>({});

  readonly all = this.cache.asReadonly();

  readonly flaggedCount = computed<number>(() =>
    Object.values(this.cache()).filter((n) => n.flagged).length
  );

  constructor() {
    if (this.isBrowser) {
      // Fire-and-forget load on first construction.
      this.hydrate().catch(() => { /* ignore */ });
    }
  }

  get(name: string): PackageNote | undefined {
    return this.cache()[name];
  }

  isFlagged(name: string): boolean {
    return !!this.cache()[name]?.flagged;
  }

  noteFor(name: string): string {
    return this.cache()[name]?.note ?? '';
  }

  async setNote(name: string, note: string): Promise<void> {
    const existing = this.cache()[name];
    const next: PackageNote = {
      name,
      note,
      flagged: existing?.flagged ?? false,
      updatedAt: new Date().toISOString()
    };
    await this.upsert(next);
  }

  async setFlag(name: string, flagged: boolean): Promise<void> {
    const existing = this.cache()[name];
    const next: PackageNote = {
      name,
      note: existing?.note ?? '',
      flagged,
      updatedAt: new Date().toISOString()
    };
    await this.upsert(next);
  }

  async toggleFlag(name: string): Promise<void> {
    await this.setFlag(name, !this.isFlagged(name));
  }

  async remove(name: string): Promise<void> {
    this.cache.update((map) => {
      const next = { ...map };
      delete next[name];
      return next;
    });
    if (!this.isBrowser) return;
    try {
      const db = await this.db();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const req = tx.objectStore(STORE).delete(name);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch { /* ignore */ }
  }

  async list(): Promise<PackageNote[]> {
    return Object.values(this.cache());
  }

  /**
   * Replace the entire notes map. Used by SupabaseSyncService on PULL —
   * the merge is performed by the sync layer (last-updatedAt-wins per
   * package), and the result is written back through here.
   */
  async replaceAll(notes: Record<string, PackageNote>): Promise<void> {
    this.cache.set({ ...notes });
    if (!this.isBrowser) return;
    try {
      const db = await this.db();
      // Replace all rows in one transaction: clear, then put each note.
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const clearReq = store.clear();
        clearReq.onerror = () => reject(clearReq.error);
        clearReq.onsuccess = () => {
          for (const n of Object.values(notes)) {
            store.put(n, n.name);
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      });
    } catch {
      /* best-effort persistence */
    }
  }

  private async upsert(note: PackageNote): Promise<void> {
    this.cache.update((map) => ({ ...map, [note.name]: note }));
    if (!this.isBrowser) return;
    try {
      const db = await this.db();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const req = tx.objectStore(STORE).put(note, note.name);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch { /* ignore */ }
  }

  private async hydrate(): Promise<void> {
    try {
      const db = await this.db();
      const items = await new Promise<PackageNote[]>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => resolve((req.result as PackageNote[]) ?? []);
        req.onerror = () => reject(req.error);
      });
      const map: Record<string, PackageNote> = {};
      for (const n of items) map[n.name] = n;
      this.cache.set(map);
    } catch { /* ignore — empty cache is fine */ }
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
