import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';

export type Serializable = string | number | boolean | null | undefined;

/**
 * Minimal two-way URL query-param <-> signal binding.
 *
 * Usage inside a component:
 *
 *   const qs = inject(QueryStateService);
 *   readonly filter = qs.bind<string>('filter', 'all');
 *   readonly target = qs.bind<number>('target', 21, {
 *     encode: (v) => String(v),
 *     decode: (s) => parseInt(s ?? '', 10) || 21
 *   });
 *
 *   // setting the signal updates the URL; pushState off by default
 *   this.filter.set('conflict');
 *
 * Multiple bindings compose: the service batches query-param writes inside a
 * microtask so `filter.set(...)` immediately followed by `target.set(...)`
 * results in a single navigation (no intermediate history entry).
 *
 * Intentionally small — this is a quality-of-life wrapper, not a store. Deep
 * shareable state (filters, sort, target Angular) gets first-class URL
 * representation for free, which powers deep links, back/forward navigation,
 * and the share-URL feature.
 */
@Injectable({ providedIn: 'root' })
export class QueryStateService {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  private pending: Record<string, string | null> = {};
  private flushScheduled = false;

  bind<T extends Serializable>(
    key: string,
    initial: T,
    opts?: {
      encode?: (v: T) => string | null;
      decode?: (s: string | null) => T;
      /** replace current history entry instead of pushing a new one. Default: true. */
      replaceUrl?: boolean;
    }
  ) {
    const encode = opts?.encode ?? ((v: T) => (v === '' || v == null ? null : String(v)));
    const decode = opts?.decode ?? ((s: string | null) => (s as unknown as T));
    const replaceUrl = opts?.replaceUrl ?? true;

    // Seed from current URL snapshot.
    const current = this.route.snapshot.queryParamMap.get(key);
    const s = signal<T>(current !== null ? decode(current) : initial);

    // Subscribe to URL changes — external navigations (back button, deep link)
    // propagate back into the signal.
    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((pm) => {
        const raw = pm.get(key);
        const next = raw !== null ? decode(raw) : initial;
        if (next !== s()) s.set(next);
      });

    // Wrap set/update so signal writes also push into the URL.
    const origSet = s.set.bind(s);
    const origUpdate = s.update.bind(s);
    s.set = (v: T) => {
      if (v === s()) return;
      origSet(v);
      this.queue(key, encode(v), replaceUrl);
    };
    s.update = (fn) => {
      const next = fn(s());
      if (next === s()) return;
      origUpdate(() => next);
      this.queue(key, encode(next), replaceUrl);
    };

    return s;
  }

  private queue(key: string, encoded: string | null, replaceUrl: boolean): void {
    this.pending[key] = encoded;
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      const updates = this.pending;
      this.pending = {};
      this.flushScheduled = false;
      this.router.navigate([], {
        queryParams: updates,
        queryParamsHandling: 'merge',
        replaceUrl
      });
    });
  }
}
