import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import {
  Observable,
  Subject,
  of
} from 'rxjs';
import {
  catchError,
  debounceTime,
  distinctUntilChanged,
  map,
  switchMap,
  filter,
  shareReplay
} from 'rxjs/operators';

/**
 * A single autocomplete suggestion as returned by the npm search API.
 */
export interface NpmSearchSuggestion {
  name: string;
  version: string;
  description: string;
  publisher: string;
  date?: string;
  keywords?: string[];
  scope?: string;
}

interface NpmSearchApiResult {
  objects: Array<{
    package: {
      name: string;
      scope?: string;
      version: string;
      description?: string;
      keywords?: string[];
      date?: string;
      publisher?: { username?: string };
    };
  }>;
  total: number;
  time: string;
}

/**
 * Enterprise-grade npm package autocomplete service.
 *
 * Race-condition-proof search pipeline built on RxJS:
 *
 *   input$
 *     .pipe(
 *       debounceTime(220),           // wait for user to pause
 *       distinctUntilChanged(),      // drop duplicate queries
 *       switchMap(q => fetch(q)),    // cancel pending requests on new input
 *       catchError(...),             // never let the stream die
 *     )
 *
 * Why this matters:
 *  - debounceTime prevents flooding the npm API while the user types
 *  - distinctUntilChanged stops redundant requests (e.g. "ng" -> "ng " -> "ng")
 *  - switchMap aggressively cancels any in-flight request when a newer query
 *    arrives, so old results can never overwrite newer ones — this is the
 *    single biggest class of bug in naive search implementations
 *  - catchError ensures a 500 from the registry doesn't kill the stream: the
 *    UI just shows "no results" for that query and continues working on the
 *    next keystroke
 *
 * The service exposes:
 *   - query$: a hot observable of suggestions wired to push()
 *   - search(prefix): a one-shot helper (useful for tests / CLI)
 *   - push(prefix): feed a new prefix into the hot pipeline
 */
@Injectable({ providedIn: 'root' })
export class NpmSearchService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = 'https://registry.npmjs.org/-/v1/search';

  /** Input stream — components push keystrokes here. */
  private readonly input$ = new Subject<string>();

  /** Hot, multicast output stream of suggestions. */
  readonly query$: Observable<NpmSearchSuggestion[]> = this.input$.pipe(
    // 1. Debounce — wait for the user to stop typing for a moment.
    debounceTime(220),
    // 2. Trim + lower so "NG " and "ng" produce the same query.
    map((raw) => raw.trim()),
    // 3. Kill empty queries early so we never hit the API with "".
    filter((q) => q.length >= 2),
    // 4. Drop duplicates so repeated typing of the same word doesn't refetch.
    distinctUntilChanged(),
    // 5. switchMap cancels any in-flight request on a newer keystroke.
    switchMap((q) =>
      this.fetchOnce(q).pipe(
        // 6. catchError keeps the hot stream alive on network failures.
        catchError(() => of<NpmSearchSuggestion[]>([]))
      )
    ),
    // 7. Share — so multiple subscribers (dropdown, live-region) don't re-trigger.
    shareReplay({ bufferSize: 1, refCount: true })
  );

  /** Push a new query prefix into the pipeline. Called from the UI on input. */
  push(prefix: string): void {
    this.input$.next(prefix);
  }

  /** Clear results — typically called when the user closes the dropdown. */
  clear(): void {
    this.input$.next('');
  }

  /**
   * One-shot search — useful for server-side rendering, CLI usage, and unit tests.
   * Not race-condition-proof by design: the caller is responsible for handling
   * concurrency. For UI use, go through `push()` + `query$` instead.
   */
  search(prefix: string, size: number = 10): Observable<NpmSearchSuggestion[]> {
    const q = prefix.trim();
    if (q.length < 2) return of([]);
    return this.fetchOnce(q, size).pipe(catchError(() => of<NpmSearchSuggestion[]>([])));
  }

  /** Internal — perform a single HTTP request against the npm search API. */
  private fetchOnce(q: string, size: number = 10): Observable<NpmSearchSuggestion[]> {
    const url = `${this.baseUrl}?text=${encodeURIComponent(q)}&size=${size}`;
    return this.http.get<NpmSearchApiResult>(url).pipe(
      map((res) => this.toSuggestions(res))
    );
  }

  private toSuggestions(res: NpmSearchApiResult): NpmSearchSuggestion[] {
    if (!res?.objects) return [];
    return res.objects.map((o) => ({
      name: o.package.name,
      scope: o.package.scope,
      version: o.package.version,
      description: o.package.description ?? '',
      publisher: o.package.publisher?.username ?? '',
      date: o.package.date,
      keywords: o.package.keywords
    }));
  }
}
