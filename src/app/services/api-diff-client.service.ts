import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, of, throwError } from 'rxjs';
import { catchError, map, shareReplay } from 'rxjs/operators';

/**
 * Client-side mirror of the server's ApiSurfaceDiff types. Defined
 * here (not imported from src/server/) so the frontend has zero
 * dependency on server-only modules. The shapes must stay in lockstep
 * with `src/server/api-diff/types.ts` — a small price for keeping
 * frontend and backend cleanly decoupled.
 */
export type ApiSymbolKind =
  | 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const' | 'namespace';

export interface ApiSymbol {
  name: string;
  kind: ApiSymbolKind;
  signature: string;
  modulePath: string;
  jsDoc?: { deprecated?: string; since?: string };
  line: number;
}

export interface ApiSourceDescriptor {
  origin:
    | 'package-types-field'
    | 'package-typings-field'
    | 'index.d.ts'
    | 'dt-fallback'
    | 'none';
  filesAnalyzed: number;
  unresolved: string[];
}

export interface SignatureChangeEntry {
  name: string;
  kind: ApiSymbolKind;
  modulePath: string;
  before: string;
  after: string;
  breakingScore: number;
}

export interface RenameCandidateEntry {
  fromSymbol: ApiSymbol;
  toSymbol: ApiSymbol;
  similarity: number;
}

export interface DeprecatedEntry {
  symbol: ApiSymbol;
  message: string;
}

export interface ApiSurfaceDiff {
  pkg: string;
  fromVersion: string;
  toVersion: string;
  added: ApiSymbol[];
  removed: ApiSymbol[];
  signatureChanged: SignatureChangeEntry[];
  renameCandidates: RenameCandidateEntry[];
  newlyDeprecated: DeprecatedEntry[];
  truncation: { added: number; removed: number; signatureChanged: number };
  sources: { from: ApiSourceDescriptor; to: ApiSourceDescriptor };
}

/**
 * Thin Angular client for the /api/api-diff endpoint.
 *
 * # Responsibilities
 *
 *   - Issue the GET request with the right query params.
 *   - Convert transport-level errors (network down, 500) into a
 *     domain-level signal the AI orchestrator understands: returning
 *     null on failure means "no API diff available, fall back to
 *     narrative-only mode with low confidence." This is exactly the
 *     same fallback shape the server uses when types are unavailable
 *     (sources.origin === 'none'), so the orchestrator handles both
 *     paths with one branch.
 *
 *   - Cache the in-flight Observable per `(pkg, from, to)` triple so
 *     two simultaneous renders of the same Compare page don't fire
 *     two requests. The server already has its own L1/L2 cache; this
 *     in-flight dedup prevents the redundant network round-trip
 *     entirely.
 *
 * # Why not localStorage-cache here
 *
 * The server already caches the diff for 30 days. Adding another
 * client-side persistence layer would just create a third cache to
 * keep coherent. We trust the server's HTTP response (X-Cache header
 * tells us if it was a hit) and the browser's native HTTP cache to
 * handle short-term reuse.
 */
@Injectable({ providedIn: 'root' })
export class ApiDiffClientService {
  private readonly http = inject(HttpClient);

  /** In-flight Observable dedup per (pkg, from, to). */
  private readonly inFlight = new Map<string, Observable<ApiSurfaceDiff | null>>();

  /**
   * Fetch the API surface diff for `pkg` between `fromVersion` and
   * `toVersion`. Returns null on any transport-level failure so the
   * orchestrator can fall back gracefully — never throws.
   *
   * The server normalizes (low, high) ordering for its cache, so
   * passing (v17, v15) and (v15, v17) hit the same cached entry.
   * Clients shouldn't need to know about this; both orders work.
   */
  diff(pkg: string, fromVersion: string, toVersion: string): Observable<ApiSurfaceDiff | null> {
    if (!pkg || !fromVersion || !toVersion) {
      return of(null);
    }
    const key = `${pkg}@${fromVersion}..${toVersion}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const params = new URLSearchParams({ pkg, from: fromVersion, to: toVersion });
    const request$ = this.http
      .get<ApiSurfaceDiff>(`/api/api-diff?${params.toString()}`)
      .pipe(
        map((diff) => {
          // Defensive validation: server contract says ApiSurfaceDiff
          // always has these arrays even when empty, but we don't trust
          // the wire — a deploy mismatch could send back something
          // weird and we'd rather null-out than crash the UI.
          if (!diff || typeof diff !== 'object' || !Array.isArray(diff.added)) {
            return null;
          }
          return diff;
        }),
        catchError((err: HttpErrorResponse) => {
          // Server-side 500 OR network failure — both surface as the
          // same domain signal. Logging is fine in dev; in production
          // Sentry already picks this up via the HTTP interceptor.
          console.warn('[api-diff] fetch failed', err.status, err.message);
          return of<ApiSurfaceDiff | null>(null);
        }),
        // Once the value lands, remove from in-flight so subsequent
        // calls for the same key (after some user-visible time has
        // passed) re-fetch fresh from the server (whose cache will
        // probably still serve them instantly).
        shareReplay({ bufferSize: 1, refCount: false })
      );
    this.inFlight.set(key, request$);

    // Clear the in-flight entry once the request resolves either way,
    // so a future request doesn't replay an old shareReplay value past
    // the natural expiry. We use a one-shot subscription that's only
    // there to detect completion.
    request$.subscribe({
      next: () => this.inFlight.delete(key),
      error: () => this.inFlight.delete(key)
    });

    return request$;
  }

  /**
   * Convenience helper: returns `true` when the server signaled that
   * no types were available for either version. The orchestrator uses
   * this to decide whether to enter "narrative-only" mode.
   */
  isTypesUnavailable(diff: ApiSurfaceDiff | null): boolean {
    if (!diff) return true;
    return diff.sources.from.origin === 'none' && diff.sources.to.origin === 'none';
  }

  /**
   * Total count of structural changes across all buckets. Drives the
   * "Found N API changes across M modules" line in the Stage 2 loading
   * banner. Counts AT MOST the visible portion (truncated entries
   * aren't included in the count, which is the right number to show
   * — "found N" should match what the user can actually see).
   */
  changeCount(diff: ApiSurfaceDiff | null): number {
    if (!diff) return 0;
    return (
      diff.added.length +
      diff.removed.length +
      diff.signatureChanged.length +
      diff.renameCandidates.length +
      diff.newlyDeprecated.length
    );
  }

  /**
   * Distinct sub-module count for the Stage 2 banner. A diff that
   * touches multiple sub-packages of a monorepo (e.g. @angular/core
   * + @angular/core/testing) is meaningfully different from one
   * confined to the default entry, and that count helps the user
   * understand scope at a glance.
   */
  moduleCount(diff: ApiSurfaceDiff | null): number {
    if (!diff) return 0;
    const mods = new Set<string>();
    const visit = (sym: { modulePath: string }) => mods.add(sym.modulePath);
    diff.added.forEach(visit);
    diff.removed.forEach(visit);
    diff.signatureChanged.forEach((e) => mods.add(e.modulePath));
    diff.renameCandidates.forEach((e) => mods.add(e.toSymbol.modulePath));
    diff.newlyDeprecated.forEach((e) => mods.add(e.symbol.modulePath));
    return mods.size;
  }
}

/* throwError import kept for future use (intentional - silences unused warnings if removed later) */
void throwError;
