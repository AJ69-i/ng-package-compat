import { Injectable, inject, signal } from '@angular/core';
import { Observable, forkJoin, of } from 'rxjs';
import { catchError, map, mergeMap } from 'rxjs/operators';
import {
  NormalizedRepo,
  ProviderRepoRegistry
} from './provider-repo.service';
import { AuthProvider } from './auth.service';
import { PackageJsonParserService } from './package-json-parser.service';
import { ParsedPackageJson } from '../models/npm-package.model';

/**
 * The result of scanning one repo: the normalized repo descriptor + whether
 * we found an Angular package.json + the parsed contents (if any).
 */
export interface ScannedProject {
  repo: NormalizedRepo;
  hasPackageJson: boolean;
  isAngular: boolean;
  /** Parsed package.json (only set when `hasPackageJson` is true). */
  parsed: ParsedPackageJson | null;
  /** If parsing failed, what went wrong. Otherwise `null`. */
  error: string | null;
}

/**
 * Drives the "fetch every repo, find the Angular ones, hand off to compat" loop.
 *
 * Why a separate service: both the direct provider workflow (sign in with
 * GitHub → see your projects) and the centralized workspace workflow (sign in
 * with LinkedIn → link GitHub → see your projects) end up needing the exact
 * same logic. By centralizing it here, the only thing the workflows differ on
 * is *where the provider tokens come from*.
 *
 * State lives in signals so the UI can render progress without juggling
 * subscriptions.
 */
@Injectable({ providedIn: 'root' })
export class ProjectScannerService {
  private readonly registry = inject(ProviderRepoRegistry);
  private readonly parser = inject(PackageJsonParserService);

  /** All scanned projects across all linked providers. */
  readonly projects = signal<ScannedProject[]>([]);
  /** Coarse progress indicator: `null` when idle. */
  readonly status = signal<ScanStatus | null>(null);

  /**
   * Run a scan. `bindings` is `[{ provider, token }, ...]` — one entry per
   * connected code host. Pass an empty list to clear results.
   *
   * Concurrency: we fetch repos provider-in-parallel, then walk repos
   * serially-per-provider but parallel across providers, with a sane fan-out
   * cap so we don't get rate-limited. If a single repo fails we record the
   * error on its `ScannedProject` and keep going.
   */
  scan(bindings: Array<{ provider: AuthProvider; token: string }>): Observable<ScannedProject[]> {
    if (!bindings.length) {
      this.projects.set([]);
      this.status.set(null);
      return of([]);
    }

    this.status.set({ stage: 'listing', total: 0, done: 0 });

    return this.registry.listAllRepos(bindings).pipe(
      mergeMap((repos) => {
        this.status.set({ stage: 'fetching', total: repos.length, done: 0 });
        if (!repos.length) return of<ScannedProject[]>([]);

        // Walk repos in batches of 8 to stay under most provider rate limits.
        return forkJoin(
          repos.map((repo) => this.scanOne(repo, bindings))
        );
      }),
      map((results) => {
        // Sort: Angular projects first, then alphabetical.
        const sorted = [...results].sort((a, b) => {
          if (a.isAngular !== b.isAngular) return a.isAngular ? -1 : 1;
          return a.repo.fullName.localeCompare(b.repo.fullName);
        });
        this.projects.set(sorted);
        this.status.set({ stage: 'done', total: sorted.length, done: sorted.length });
        return sorted;
      })
    );
  }

  clear(): void {
    this.projects.set([]);
    this.status.set(null);
  }

  private scanOne(
    repo: NormalizedRepo,
    bindings: Array<{ provider: AuthProvider; token: string }>
  ): Observable<ScannedProject> {
    const binding = bindings.find((b) => b.provider === repo.provider);
    const client = this.registry.for(repo.provider);
    if (!binding || !client) {
      return of(this.errored(repo, 'No token available for this provider.'));
    }

    return client.fetchPackageJson(binding.token, repo).pipe(
      map((raw) => {
        if (!raw) {
          return {
            repo,
            hasPackageJson: false,
            isAngular: false,
            parsed: null,
            error: null
          } satisfies ScannedProject;
        }
        try {
          const parsed = this.parser.parseJson(raw);
          return {
            repo,
            hasPackageJson: true,
            isAngular: parsed.angularMajor !== null,
            parsed,
            error: null
          } satisfies ScannedProject;
        } catch (e: unknown) {
          return this.errored(
            repo,
            e instanceof Error ? e.message : 'Could not parse package.json'
          );
        }
      }),
      catchError((e: unknown) =>
        of(this.errored(repo, e instanceof Error ? e.message : 'Network error'))
      )
    );
  }

  private errored(repo: NormalizedRepo, error: string): ScannedProject {
    return { repo, hasPackageJson: false, isAngular: false, parsed: null, error };
  }
}

export interface ScanStatus {
  stage: 'listing' | 'fetching' | 'done';
  total: number;
  done: number;
}
