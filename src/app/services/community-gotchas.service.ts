import { Injectable, computed, signal } from '@angular/core';

/**
 * Community-contributed "gotchas" keyed by `packageName@targetAngularMajor`.
 *
 * Two storage paths, intentionally separate:
 *   - **Anonymous** users: notes live in `localStorage` so they survive
 *     reload but stay on the device.
 *   - **Signed-in** users: notes are mirrored to the `public.user_gotchas`
 *     Supabase table by `SupabaseSyncService`. The sync service is the
 *     authoritative writer in that mode — it calls `replaceUserNotes()` on
 *     PULL and observes `userNotes()` to know when to PUSH.
 *
 * The strict-separation rule the rest of the app uses ("anonymous data is
 * NOT promoted to a signed-in account") applies here too: signing in pulls
 * the user's cloud notes and replaces local; signing out wipes the local
 * view, leaving the cloud copy intact.
 *
 * The service is SSR-safe — all `localStorage` access is feature-detected.
 */

export interface CommunityNote {
  id: string;
  pkg: string;
  ng: number;
  author?: string;
  body: string;
  createdAt: string; // ISO timestamp
  upvotes?: number;
  source?: 'curated' | 'user';
}

const STORAGE_KEY = 'ng-package-compat:community-notes:v1';

@Injectable({ providedIn: 'root' })
export class CommunityGotchasService {
  private readonly seed: CommunityNote[] = [
    {
      id: 'seed-mat-17-mdc',
      pkg: '@angular/material',
      ng: 17,
      author: 'community',
      body:
        'Official compatibility says v17 works, but the MDC refactor may break custom `mat-form-field` themes. ' +
        'Run `ng generate @angular/material:mdc-migration` and visually review every form on every page.',
      createdAt: '2024-01-14T00:00:00.000Z',
      upvotes: 48,
      source: 'curated'
    },
    {
      id: 'seed-primeng-17-theming',
      pkg: 'primeng',
      ng: 17,
      author: 'community',
      body:
        'PrimeNG 17 forces the Lara theme. If you relied on the Saga-Blue SCSS vars, your build will compile but ' +
        'components will look unstyled at runtime. Import the new theme CSS from `primeng/resources/themes/lara-dark-blue/theme.css`.',
      createdAt: '2024-02-03T00:00:00.000Z',
      upvotes: 31,
      source: 'curated'
    },
    {
      id: 'seed-rxjs-8-topromise',
      pkg: 'rxjs',
      ng: 18,
      author: 'community',
      body:
        '`toPromise()` is hard-removed in rxjs 8. Any code written before 2022 likely still uses it. Grep for `.toPromise()` ' +
        'before running the upgrade to estimate the blast radius.',
      createdAt: '2024-05-21T00:00:00.000Z',
      upvotes: 62,
      source: 'curated'
    },
    {
      id: 'seed-ssr-17-memleak',
      pkg: '@angular/ssr',
      ng: 17,
      author: 'community',
      body:
        'Officially compatible, but v17.0.x leaked memory in long-running Node processes. ' +
        'Upgrade to v17.3+ or you will see RSS climb in production after ~12h.',
      createdAt: '2024-03-09T00:00:00.000Z',
      upvotes: 27,
      source: 'curated'
    },
    {
      id: 'seed-ngrx-19-signalstore',
      pkg: '@ngrx/store',
      ng: 19,
      author: 'community',
      body:
        'NgRx 19 added deprecation warnings for class-based actions even with `useFactory: false`. Existing apps compile ' +
        'but flood the console. Switch to `createAction` or silence via `NGRX_ALLOW_CLASSIC_ACTIONS` token.',
      createdAt: '2024-11-18T00:00:00.000Z',
      upvotes: 15,
      source: 'curated'
    }
  ];

  /**
   * Just the user's contributions (the part that's owned by the current
   * device / account). The sync service watches this signal to know when
   * to push to Supabase, and calls `replaceUserNotes()` on PULL.
   */
  private readonly _userNotes = signal<CommunityNote[]>(this.loadUserNotes());

  /** Exposed read-only — sync service depends on it. */
  readonly userNotes = this._userNotes.asReadonly();

  /** Composite of seed + user notes — what the UI actually renders. */
  readonly notes = computed<CommunityNote[]>(() => [
    ...this.seed,
    ...this._userNotes()
  ]);

  for(pkg: string, ngMajor: number): CommunityNote[] {
    return this.notes()
      .filter((n) => n.pkg === pkg && n.ng === ngMajor)
      .sort((a, b) => (b.upvotes ?? 0) - (a.upvotes ?? 0));
  }

  add(note: Omit<CommunityNote, 'id' | 'createdAt' | 'source'>): void {
    const entry: CommunityNote = {
      ...note,
      id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      upvotes: 0,
      source: 'user'
    };
    this._userNotes.update((cur) => [entry, ...cur]);
    this.persist();
  }

  upvote(id: string): void {
    // Only user-added notes mutate persisted state — seed upvotes are
    // session-only (curated counts come from the seed values).
    this._userNotes.update((cur) =>
      cur.map((n) =>
        n.id === id ? { ...n, upvotes: (n.upvotes ?? 0) + 1 } : n
      )
    );
    this.persist();
  }

  remove(id: string): void {
    this._userNotes.update((cur) => cur.filter((n) => n.id !== id));
    this.persist();
  }

  /**
   * Replace the entire user-notes set. Called by `SupabaseSyncService` on
   * PULL after sign-in (cloud → local) and on `wipeLocalWorkspace()` after
   * sign-out (clears the device's view of the signed-in data).
   *
   * `persistLocal` is `true` so anonymous workflows keep using localStorage,
   * but the sync service can pass `false` when it's restoring state during
   * sign-in (we don't want to pollute the local cache with cloud content
   * the user might want to drop on sign-out).
   */
  replaceUserNotes(notes: CommunityNote[], persistLocal = true): void {
    this._userNotes.set([...notes]);
    if (persistLocal) this.persist();
    else this.clearLocalCache();
  }

  /**
   * Wipe just the user's contributions. Curated seed remains. Used during
   * sign-out to clear the device's view of the signed-in data without
   * touching the cloud copy.
   */
  clearUserNotes(): void {
    this._userNotes.set([]);
    this.clearLocalCache();
  }

  private loadUserNotes(): CommunityNote[] {
    try {
      if (typeof localStorage === 'undefined') return [];
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const stored = JSON.parse(raw) as CommunityNote[];
      return Array.isArray(stored) ? stored.filter((n) => n?.source === 'user') : [];
    } catch {
      return [];
    }
  }

  private persist(): void {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._userNotes()));
    } catch {
      // Ignore — storage may be disabled / quota'd / private mode.
    }
  }

  private clearLocalCache(): void {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore.
    }
  }
}
