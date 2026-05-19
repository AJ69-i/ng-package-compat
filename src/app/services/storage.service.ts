import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { StoredSearch } from '../models/npm-package.model';

const KEY_HISTORY = 'ngpc.history';
const KEY_FAVORITES = 'ngpc.favorites';
const HISTORY_MAX = 25;

/**
 * SSR-safe, localStorage-backed persistence for search history and starred favorites.
 * Exposes writable signals so components can react to changes reactively.
 */
@Injectable({ providedIn: 'root' })
export class StorageService {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  readonly history = signal<StoredSearch[]>(this.read<StoredSearch[]>(KEY_HISTORY, []));
  readonly favorites = signal<string[]>(this.read<string[]>(KEY_FAVORITES, []));

  recordSearch(name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    const now = Date.now();
    const next = [{ name: trimmed, ts: now }]
      .concat(this.history().filter((h) => h.name !== trimmed))
      .slice(0, HISTORY_MAX);
    this.history.set(next);
    this.write(KEY_HISTORY, next);
  }

  clearHistory(): void {
    this.history.set([]);
    this.write(KEY_HISTORY, []);
  }

  toggleFavorite(name: string): void {
    const set = new Set(this.favorites());
    if (set.has(name)) set.delete(name);
    else set.add(name);
    const next = [...set].sort();
    this.favorites.set(next);
    this.write(KEY_FAVORITES, next);
  }

  isFavorite(name: string): boolean {
    return this.favorites().includes(name);
  }

  /**
   * Replace the entire history list. Used by SupabaseSyncService on PULL.
   * Caller is expected to have already merged with whatever was local.
   */
  replaceHistory(next: StoredSearch[]): void {
    this.history.set([...next]);
    this.write(KEY_HISTORY, next);
  }

  /** Replace the entire favorites list. Used by SupabaseSyncService on PULL. */
  replaceFavorites(next: string[]): void {
    this.favorites.set([...next]);
    this.write(KEY_FAVORITES, next);
  }

  /**
   * Wipe all locally-stored personal data (history + legacy favorites).
   * Used on sign-out so signed-in data doesn't leak into the next anonymous
   * session on this device.
   */
  clearAll(): void {
    this.history.set([]);
    this.favorites.set([]);
    this.write(KEY_HISTORY, []);
    this.write(KEY_FAVORITES, []);
  }

  private read<T>(key: string, fallback: T): T {
    if (!this.isBrowser) return fallback;
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  }

  private write(key: string, value: unknown): void {
    if (!this.isBrowser) return;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Ignore quota / private-mode errors
    }
  }
}
