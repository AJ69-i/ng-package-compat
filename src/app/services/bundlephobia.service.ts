import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { isPlatformBrowser } from '@angular/common';
import { Observable, of } from 'rxjs';
import { catchError, map, shareReplay } from 'rxjs/operators';
import { BundleSize } from '../models/npm-package.model';

/**
 * Cache entry shape — `result: null` is valid (means "looked up and
 * bundlephobia 4xx'd"), separate from "key absent" (cache miss).
 */
interface CacheEntry {
  result: BundleSize | null;
  ts: number;
}

const CACHE_KEY = 'ngpc.bundlephobia.v1';
/**
 * 7-day TTL. Bundle sizes per published version are immutable — a
 * given `pkg@version` always produces the same bundle artifact.
 * The only reason to expire entries at all is in case Bundlephobia
 * recomputes with a different bundler/minifier; weekly is plenty.
 */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable({ providedIn: 'root' })
export class BundlephobiaService {
  private readonly http = inject(HttpClient);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly base = 'https://bundlephobia.com/api/size';

  /**
   * In-flight dedup so two concurrent renders of the same package
   * (search page + upgrade page on the same session) share a single
   * fetch. Keyed by `pkg@version`.
   */
  private readonly inFlight = new Map<string, Observable<BundleSize | null>>();

  /**
   * Returns bundle size (min + gzip + dependency count) for a specific
   * version. Returns `null` when Bundlephobia 4xx'd (common for very
   * new packages it hasn't computed yet, deprecated packages, or
   * packages with no real bundle artifact).
   *
   * # Caching strategy
   *
   *   1. localStorage (7d TTL) — survives reloads
   *   2. In-flight Observable dedup — same-tab burst protection
   *   3. shareReplay(1) — multiple subscribers per Observable share the result
   *
   * SSR-safe: localStorage no-ops on the server, the HTTP call still
   * works (Node fetch), just with no persistence.
   */
  size(packageName: string, version: string): Observable<BundleSize | null> {
    if (!packageName || !version) return of(null);
    const key = `${packageName}@${version}`;

    const cached = this.readCache(key);
    if (cached !== undefined) return of(cached);

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const req$ = this.http
      .get<BundleSize>(this.base, { params: { package: key } })
      .pipe(
        map((res): BundleSize | null => {
          // Defensive — bundlephobia occasionally returns an error
          // object with a 200 status (legacy API quirk). The real
          // response always has a numeric `gzip` field.
          if (!res || typeof res.gzip !== 'number') return null;
          return res;
        }),
        catchError(() => of<BundleSize | null>(null)),
        map((result) => {
          this.writeCache(key, result);
          this.inFlight.delete(key);
          return result;
        }),
        shareReplay({ bufferSize: 1, refCount: false })
      );
    this.inFlight.set(key, req$);
    return req$;
  }

  /**
   * Tier banding for the chip color. Empirically tuned for Angular
   * library expectations:
   *
   *   < 10 kB        small        → green (safe drop-in)
   *   10 – 40 kB     moderate     → neutral (typical library)
   *   40 – 100 kB    heavy        → amber (think before adopting)
   *   > 100 kB       very-heavy   → red (consider lazy-loading)
   *
   * Sizes are in gzipped bytes — minified-only would inflate every
   * tier by ~3×. Gzip is what actually crosses the wire.
   */
  band(gzipBytes: number): 'small' | 'moderate' | 'heavy' | 'very-heavy' {
    if (gzipBytes < 10_000) return 'small';
    if (gzipBytes < 40_000) return 'moderate';
    if (gzipBytes < 100_000) return 'heavy';
    return 'very-heavy';
  }

  // ─────────── localStorage cache ───────────

  private readCache(key: string): BundleSize | null | undefined {
    if (!this.isBrowser) return undefined;
    try {
      const blob = window.localStorage.getItem(`${CACHE_KEY}.${key}`);
      if (!blob) return undefined;
      const entry = JSON.parse(blob) as CacheEntry;
      if (!entry || typeof entry.ts !== 'number') return undefined;
      if (Date.now() - entry.ts > CACHE_TTL_MS) return undefined;
      return entry.result;          // null is a valid cached "we know it's missing"
    } catch {
      return undefined;
    }
  }

  private writeCache(key: string, result: BundleSize | null): void {
    if (!this.isBrowser) return;
    try {
      const entry: CacheEntry = { result, ts: Date.now() };
      window.localStorage.setItem(`${CACHE_KEY}.${key}`, JSON.stringify(entry));
    } catch {
      // Quota or private-mode — acceptable, just re-fetches next time.
    }
  }
}
