import { Injectable, PLATFORM_ID, computed, effect, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

const STORAGE_KEY = 'ngpc.favorites.v1';

/**
 * Small localStorage-backed set of "starred" package names.
 *
 * The favorites dashboard page consumes this signal to render a live
 * watch-list, and the upgrade table exposes a ⭐ affordance that flips
 * membership without leaving the row.
 */
@Injectable({ providedIn: 'root' })
export class FavoritesService {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  readonly names = signal<string[]>(this.load());

  readonly count = computed<number>(() => this.names().length);

  constructor() {
    effect(() => this.persist(this.names()));
  }

  has(name: string): boolean {
    return this.names().includes(name);
  }

  add(name: string): void {
    if (this.has(name)) return;
    this.names.update((list) => [...list, name]);
  }

  remove(name: string): void {
    this.names.update((list) => list.filter((n) => n !== name));
  }

  toggle(name: string): void {
    this.has(name) ? this.remove(name) : this.add(name);
  }

  clear(): void {
    this.names.set([]);
  }

  /**
   * Drag-to-reorder support (feature #96). Moves the entry at `from` to
   * position `to`. No-ops if the indices are equal or out of bounds.
   */
  move(from: number, to: number): void {
    const list = [...this.names()];
    if (
      from < 0 ||
      to < 0 ||
      from >= list.length ||
      to >= list.length ||
      from === to
    ) {
      return;
    }
    const [item] = list.splice(from, 1);
    list.splice(to, 0, item);
    this.names.set(list);
  }

  private load(): string[] {
    if (!this.isBrowser) return [];
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  private persist(list: string[]): void {
    if (!this.isBrowser) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch {
      /* ignore */
    }
  }
}
