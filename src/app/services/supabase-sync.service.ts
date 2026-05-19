import {
  DestroyRef,
  Injectable,
  PLATFORM_ID,
  effect,
  inject,
  signal,
  untracked
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SupabaseService } from './supabase.service';
import { PolicyService, PolicyRule } from './policy.service';
import { FavoritesService } from './favorites.service';
import { MonitorService } from './monitor.service';
import type { ReportSnapshot } from './monitor.service';
import { StorageService } from './storage.service';
import { NotesService } from './notes.service';
import { CommunityGotchasService, CommunityNote } from './community-gotchas.service';
import { CompareHistoryService, CompareHistoryEntry } from './compare-history.service';
import type { StoredSearch } from '../models/npm-package.model';
import type { PackageNote } from './notes.service';

/**
 * Stats from the first PULL on a fresh sign-in. Used to show the user
 * a contextual "what just happened" toast: were they restored from cloud,
 * was their local data uploaded, or were two sets merged?
 */
export interface MergeReport {
  /** Local items count BEFORE the merge. */
  localBefore: number;
  /** Cloud items count BEFORE the merge. */
  cloudBefore: number;
  /** Items count AFTER the merge (= what's now both local and cloud). */
  merged: number;
  /** Per-collection breakdown for richer messaging. */
  byCollection: {
    favorites: number;
    history: number;
    notes: number;
    gotchas: number;
    policies: number;
    snapshots: number;
    compares: number;
  };
}

/**
 * Two-way sync of small user-state collections to Supabase.
 *
 * Why this exists:
 *   Local-only state (policies, favorites) is fine until the user opens the
 *   app on a second device — then they get an empty list and rebuild it. With
 *   Supabase already wired in for auth, mirroring these collections per-user
 *   is mostly plumbing.
 *
 * Strategy:
 *   - On a `null → user` transition we PULL rows from Supabase, merge them
 *     with local state, and write the merged set back into the live signals.
 *     The merge is union-by-id-or-name (last-write-wins on conflicts) so two
 *     devices that diverged before sync was on don't lose data.
 *   - On every signal change while signed in we PUSH the full collection to
 *     Supabase using a debounced upsert. Debouncing avoids one round-trip per
 *     keystroke during bulk imports.
 *   - On `user → null` transitions (sign-out) we leave local state alone —
 *     it's the user's working copy until they sign back in.
 *
 * Tables expected (created via Supabase migration outside this code):
 *   public.user_policies (
 *     user_id uuid references auth.users(id) on delete cascade,
 *     rules   jsonb not null default '[]'::jsonb,
 *     updated_at timestamptz default now(),
 *     primary key (user_id)
 *   )
 *   public.user_favorites (
 *     user_id uuid references auth.users(id) on delete cascade,
 *     names   jsonb not null default '[]'::jsonb,
 *     updated_at timestamptz default now(),
 *     primary key (user_id)
 *   )
 *
 * RLS policy on both tables: `(auth.uid() = user_id)` for select/insert/update.
 *
 * SSR-safe: bails out cleanly when `window` isn't around.
 */
@Injectable({ providedIn: 'root' })
export class SupabaseSyncService {
  private readonly supabase = inject(SupabaseService);
  private readonly policy = inject(PolicyService);
  private readonly favorites = inject(FavoritesService);
  private readonly monitor = inject(MonitorService);
  private readonly storage = inject(StorageService);
  private readonly notes = inject(NotesService);
  private readonly gotchas = inject(CommunityGotchasService);
  private readonly compares = inject(CompareHistoryService);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly destroyRef = inject(DestroyRef);

  /** Most recent sync timestamp (or null if we never sync'd). */
  readonly lastSyncedAt = signal<string | null>(null);
  /** Last sync error message (debugging aid). */
  readonly lastError = signal<string | null>(null);
  /**
   * Per-collection counts captured during the most recent first-pull on
   * a fresh sign-in. The auth-callback page subscribes to this signal to
   * show a contextual "Restored 47 items from your other devices" toast.
   * Cleared after the toast is shown.
   */
  readonly mergeReport = signal<MergeReport | null>(null);

  private pushPolicyTimer: ReturnType<typeof setTimeout> | null = null;
  private pushFavTimer: ReturnType<typeof setTimeout> | null = null;
  private pushSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private pushHistoryTimer: ReturnType<typeof setTimeout> | null = null;
  private pushNotesTimer: ReturnType<typeof setTimeout> | null = null;
  private pushGotchasTimer: ReturnType<typeof setTimeout> | null = null;
  private pushComparesTimer: ReturnType<typeof setTimeout> | null = null;
  private suspendPush = false; // set during PULL → set so we don't echo
  private lastUserId: string | null = null;

  constructor() {
    if (!isPlatformBrowser(this.platformId)) return;

    // Watch for auth transitions and trigger a PULL when we become signed in.
    //
    // Three transitions to handle:
    //   - null → user A: first sign-in this session. Just pull A's data.
    //   - user A → user B: account-switch. We MUST wipe local first; otherwise
    //     A's data sitting in memory + localStorage gets pushed to B's cloud
    //     account when the push effects re-fire under the new user.id.
    //   - user → null: sign-out. Handled in navbar.onSignOut (which calls
    //     wipeLocalWorkspace() explicitly).
    effect(() => {
      const user = this.supabase.user();
      const prevId = this.lastUserId;
      const nextId = user?.id ?? null;
      if (nextId === prevId) return;
      this.lastUserId = nextId;
      if (!nextId) return; // user → null: sign-out path, navbar handles it.
      const isAccountSwitch = prevId !== null && prevId !== nextId;
      // Run pull outside the reactive context — pull mutates signals.
      untracked(() => {
        void (async () => {
          if (isAccountSwitch) {
            // Wipe before pull so account A's data doesn't bleed into B's
            // cloud as soon as the push effects fire under the new user id.
            await this.wipeLocalWorkspace();
          }
          await this.pullAll(nextId);
        })();
      });
    });

    // PUSH effects: run whenever the signed-in user has policies / favs change.
    effect(() => {
      const user = this.supabase.user();
      const rules = this.policy.rules();
      if (!user) return;
      if (this.suspendPush) return;
      this.schedulePush('policies', () => this.pushPolicies(user.id, rules));
    });

    effect(() => {
      const user = this.supabase.user();
      const names = this.favorites.names();
      if (!user) return;
      if (this.suspendPush) return;
      this.schedulePush('favorites', () => this.pushFavorites(user.id, names));
    });

    // Snapshot sync (feature #87) — debounce push of the full map.
    effect(() => {
      const user = this.supabase.user();
      const snaps = this.monitor.snapshots();
      if (!user) return;
      if (this.suspendPush) return;
      this.schedulePush('snapshots', () =>
        this.pushSnapshots(user.id, snaps)
      );
    });

    // History sync — search history on storage.history.
    effect(() => {
      const user = this.supabase.user();
      const items = this.storage.history();
      if (!user) return;
      if (this.suspendPush) return;
      this.schedulePush('history', () => this.pushHistory(user.id, items));
    });

    // Notes sync — per-package notes on notes.cache.
    effect(() => {
      const user = this.supabase.user();
      const map = this.notes.all();
      if (!user) return;
      if (this.suspendPush) return;
      this.schedulePush('notes', () => this.pushNotes(user.id, map));
    });

    // Community gotchas sync — the user's contributed notes.
    effect(() => {
      const user = this.supabase.user();
      const list = this.gotchas.userNotes();
      if (!user) return;
      if (this.suspendPush) return;
      this.schedulePush('gotchas', () => this.pushGotchas(user.id, list));
    });

    // Compare history sync — list of two-package comparisons the user
    // has viewed. Mirrors the same push/pull/wipe pattern as the other
    // collections so signed-in users get cross-device history.
    effect(() => {
      const user = this.supabase.user();
      const list = this.compares.entries();
      if (!user) return;
      if (this.suspendPush) return;
      this.schedulePush('compares', () => this.pushCompares(user.id, list));
    });

    this.destroyRef.onDestroy(() => this.cancelTimers());
  }

  // ---------- PULL ----------

  private async pullAll(userId: string): Promise<void> {
    this.suspendPush = true;
    let cloudBefore = 0;
    try {
      // Strict separation: each pull *replaces* the local view with cloud
      // contents. Anonymous data is intentionally dropped from view on
      // sign-in. The "merge" semantics from the previous design are gone.
      const [pol, fav, snaps, hist, notes, gotchas, compares] = await Promise.all([
        this.pullPolicies(userId),
        this.pullFavorites(userId),
        this.pullSnapshots(userId),
        this.pullHistory(userId),
        this.pullNotes(userId),
        this.pullGotchas(userId),
        this.pullCompares(userId)
      ]);
      cloudBefore = pol + fav + snaps + hist + notes + gotchas + compares;
      this.lastSyncedAt.set(new Date().toISOString());
      this.lastError.set(null);

      const after = {
        favorites: this.favorites.names().length,
        history: this.storage.history().length,
        notes: Object.keys(this.notes.all()).length,
        gotchas: this.gotchas.userNotes().length,
        policies: this.policy.rules().length,
        snapshots: Object.keys(this.monitor.snapshots()).length,
        compares: this.compares.entries().length
      };
      // localBefore is always 0 under strict separation — the auth-callback
      // toast uses this to pick the "Restored N items" vs "first sign-in"
      // copy. We keep the field for back-compat with the toast logic.
      this.mergeReport.set({
        localBefore: 0,
        cloudBefore,
        merged: cloudBefore,
        byCollection: after
      });
    } catch (e) {
      this.lastError.set((e as Error)?.message ?? 'Sync pull failed');
    } finally {
      // Allow the next tick of the effect to settle before re-enabling pushes.
      queueMicrotask(() => (this.suspendPush = false));
    }
  }

  /** Force a manual sync (for the "Sync now" button). */
  async syncNow(): Promise<void> {
    const user = this.supabase.user();
    if (!user) return;
    await this.pullAll(user.id);
  }

  /** Clear the merge report — call after the welcome toast has been shown. */
  consumeMergeReport(): void {
    this.mergeReport.set(null);
  }

  /**
   * Wipe every collection that's synced — favorites, history, notes, policies,
   * snapshots — from local storage AND the live in-memory signals. The cloud
   * copy is left intact so signing back in restores everything.
   *
   * This is the "you signed out, signed-in data should go away on this
   * device" behavior. The strict separation rule is:
   *
   *   - Anonymous user → data in localStorage / IndexedDB
   *   - Signed-in user → data in Supabase
   *   - Sign-out      → device's view of the signed-in data is wiped
   *
   * Anonymous users (never signed in) keep their localStorage untouched.
   * Only call this *after* the auth session has been revoked, so the push
   * effects don't fire on the empty-state and overwrite the cloud copy.
   */
  async wipeLocalWorkspace(): Promise<void> {
    // Suspend pushes while we tear everything down so the empty-state
    // doesn't roundtrip back to the cloud and clobber the user's data
    // there. (`auth.signOut()` should already have nulled the session,
    // but we belt-and-brace it here.)
    this.suspendPush = true;
    try {
      this.policy.clearAll();
      this.favorites.clear();
      this.monitor.replaceSnapshots({});
      this.storage.clearAll();
      await this.notes.replaceAll({});
      this.gotchas.clearUserNotes();
      await this.compares.clear();
      this.lastSyncedAt.set(null);
      this.lastError.set(null);
      this.mergeReport.set(null);
    } finally {
      // Re-enable on the next tick so any echo writes have settled.
      queueMicrotask(() => (this.suspendPush = false));
    }
  }

  private async pullSnapshots(userId: string): Promise<number> {
    const { data, error } = await this.supabase.client
      .from('user_snapshots')
      .select('project_label, captured_at, payload')
      .eq('user_id', userId)
      .order('captured_at', { ascending: false })
      .limit(200);
    if (error) throw error;

    // Strict separation: build the map from cloud only. We do NOT merge in
    // local snapshots — anonymous data is its own separate world.
    const map: Record<string, ReportSnapshot> = {};
    if (data) {
      const seen = new Set<string>();
      for (const row of data) {
        const projectLabel = (row as Record<string, unknown>)['project_label'] as string;
        const key = projectLabel.trim().toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const payload = (row as Record<string, unknown>)['payload'] as ReportSnapshot;
        if (payload && typeof payload === 'object') map[key] = payload;
      }
    }
    this.monitor.replaceSnapshots(map);
    return data?.length ?? 0;
  }

  /**
   * Pull search history. Cloud and local are merged by `name` — entries
   * present in both keep the *newest* timestamp. Capped at 25 (matches
   * the StorageService HISTORY_MAX).
   */
  private async pullHistory(userId: string): Promise<number> {
    const { data, error } = await this.supabase.client
      .from('user_history')
      .select('items')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    const remote = (data?.items ?? []) as StoredSearch[];
    // Strict separation: cloud replaces local. No merge with anonymous history.
    const next = [...remote]
      .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
      .slice(0, 25);
    this.storage.replaceHistory(next);
    return remote.length;
  }

  private async pushHistory(userId: string, items: StoredSearch[]): Promise<void> {
    const { error } = await this.supabase.client.from('user_history').upsert(
      {
        user_id: userId,
        items,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'user_id' }
    );
    if (error) throw error;
  }

  /**
   * Pull per-package notes. Cloud and local merge by package name —
   * if both sides have a note for the same package, the one with the
   * newer `updatedAt` wins.
   */
  private async pullNotes(userId: string): Promise<number> {
    const { data, error } = await this.supabase.client
      .from('user_notes')
      .select('notes')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    const remote = (data?.notes ?? {}) as Record<string, PackageNote>;
    // Strict separation: cloud replaces local. No merge with anonymous notes.
    await this.notes.replaceAll(remote);
    return Object.keys(remote).length;
  }

  private async pushNotes(
    userId: string,
    map: Record<string, PackageNote>
  ): Promise<void> {
    const { error } = await this.supabase.client.from('user_notes').upsert(
      {
        user_id: userId,
        notes: map,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'user_id' }
    );
    if (error) throw error;
  }

  private async pushSnapshots(
    userId: string,
    snaps: Record<string, ReportSnapshot>
  ): Promise<void> {
    const rows = Object.entries(snaps).map(([_key, snap]) => ({
      user_id: userId,
      project_label: snap.label ?? 'Untitled',
      captured_at: snap.capturedAt,
      health_score: snap.healthScore,
      payload: snap as unknown as Record<string, unknown>
    }));
    if (rows.length === 0) return;
    const { error } = await this.supabase.client
      .from('user_snapshots')
      .upsert(rows, { onConflict: 'user_id,project_label,captured_at' });
    if (error) throw error;
  }

  private async pullPolicies(userId: string): Promise<number> {
    const { data, error } = await this.supabase.client
      .from('user_policies')
      .select('rules')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;

    // Strict separation: cloud replaces local. Anonymous policy rules are
    // dropped on sign-in — they were anonymous-only, not "yours-and-now-mine".
    const remote = (data?.rules ?? []) as PolicyRule[];
    this.policy.replaceAll(remote);
    return remote.length;
  }

  private async pullFavorites(userId: string): Promise<number> {
    const { data, error } = await this.supabase.client
      .from('user_favorites')
      .select('names')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;

    // Strict separation: cloud replaces local. Anonymous favorites are not
    // promoted to the signed-in account.
    const remote = (data?.names ?? []) as string[];
    this.favorites.names.set([...remote]);
    return remote.length;
  }

  // ---------- PUSH ----------

  private schedulePush(
    kind:
      | 'policies'
      | 'favorites'
      | 'snapshots'
      | 'history'
      | 'notes'
      | 'gotchas'
      | 'compares',
    fn: () => Promise<void>
  ): void {
    type TimerKey =
      | 'pushPolicyTimer'
      | 'pushFavTimer'
      | 'pushSnapshotTimer'
      | 'pushHistoryTimer'
      | 'pushNotesTimer'
      | 'pushGotchasTimer'
      | 'pushComparesTimer';
    const slot: TimerKey =
      kind === 'policies'
        ? 'pushPolicyTimer'
        : kind === 'favorites'
          ? 'pushFavTimer'
          : kind === 'snapshots'
            ? 'pushSnapshotTimer'
            : kind === 'history'
              ? 'pushHistoryTimer'
              : kind === 'notes'
                ? 'pushNotesTimer'
                : kind === 'gotchas'
                  ? 'pushGotchasTimer'
                  : 'pushComparesTimer';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const self = this as any;
    if (self[slot]) clearTimeout(self[slot]);
    self[slot] = setTimeout(async () => {
      try {
        await fn();
        this.lastSyncedAt.set(new Date().toISOString());
        this.lastError.set(null);
      } catch (e) {
        this.lastError.set((e as Error)?.message ?? `Push ${kind} failed`);
      }
    }, 600);
  }

  private async pushPolicies(userId: string, rules: PolicyRule[]): Promise<void> {
    const { error } = await this.supabase.client.from('user_policies').upsert(
      {
        user_id: userId,
        rules,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'user_id' }
    );
    if (error) throw error;
  }

  private async pushFavorites(userId: string, names: string[]): Promise<void> {
    const { error } = await this.supabase.client.from('user_favorites').upsert(
      {
        user_id: userId,
        names,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'user_id' }
    );
    if (error) throw error;
  }

  // ---------- helpers ----------

  private cancelTimers(): void {
    if (this.pushPolicyTimer) clearTimeout(this.pushPolicyTimer);
    if (this.pushFavTimer) clearTimeout(this.pushFavTimer);
    if (this.pushSnapshotTimer) clearTimeout(this.pushSnapshotTimer);
    if (this.pushHistoryTimer) clearTimeout(this.pushHistoryTimer);
    if (this.pushNotesTimer) clearTimeout(this.pushNotesTimer);
    if (this.pushGotchasTimer) clearTimeout(this.pushGotchasTimer);
    if (this.pushComparesTimer) clearTimeout(this.pushComparesTimer);
  }

  // ---------- Compare history ----------

  /**
   * Pull the user's compare history list. Cloud replaces local under
   * strict separation — anonymous comparisons are NOT promoted to the
   * signed-in account. Cap at 50 to match the local-only cap and
   * defend against a corrupted cloud row that somehow exceeded it.
   *
   * Expected table:
   *   public.user_compares (
   *     user_id uuid references auth.users(id) on delete cascade,
   *     entries jsonb not null default '[]'::jsonb,
   *     updated_at timestamptz default now(),
   *     primary key (user_id)
   *   )
   *
   * RLS: `(auth.uid() = user_id)` on select/insert/update.
   */
  private async pullCompares(userId: string): Promise<number> {
    const { data, error } = await this.supabase.client
      .from('user_compares')
      .select('entries')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    const remote = (data?.entries ?? []) as CompareHistoryEntry[];
    await this.compares.replaceAll(remote);
    return remote.length;
  }

  private async pushCompares(
    userId: string,
    entries: CompareHistoryEntry[]
  ): Promise<void> {
    const { error } = await this.supabase.client.from('user_compares').upsert(
      {
        user_id: userId,
        entries,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'user_id' }
    );
    if (error) throw error;
  }

  // ---------- Community gotchas ----------

  /**
   * Pull the user's contributed gotchas. Cloud is the source of truth on
   * sign-in — we don't merge anonymous notes, matching the strict-separation
   * rule used elsewhere in this service. The sync service tells the
   * gotchas store NOT to persist to localStorage during the pull, so a
   * subsequent sign-out leaves no signed-in residue on the device.
   */
  private async pullGotchas(userId: string): Promise<number> {
    const { data, error } = await this.supabase.client
      .from('user_gotchas')
      .select('notes')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    const remote = (data?.notes ?? []) as CommunityNote[];
    this.gotchas.replaceUserNotes(remote, /* persistLocal */ false);
    return remote.length;
  }

  private async pushGotchas(userId: string, list: CommunityNote[]): Promise<void> {
    const { error } = await this.supabase.client.from('user_gotchas').upsert(
      {
        user_id: userId,
        notes: list,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'user_id' }
    );
    if (error) throw error;
  }
}

/**
 * Union-merge two lists keyed by id, preferring the remote copy on conflict
 * (so a sign-in on a second device picks up cloud state). Same-id matches are
 * de-duplicated; otherwise both lists' entries survive.
 */
function mergeById<T>(local: T[], remote: T[], idOf: (t: T) => string): T[] {
  const remoteMap = new Map<string, T>();
  for (const r of remote) remoteMap.set(idOf(r), r);
  const merged: T[] = [];
  const seen = new Set<string>();
  for (const r of remote) {
    const id = idOf(r);
    if (seen.has(id)) continue;
    merged.push(r);
    seen.add(id);
  }
  for (const l of local) {
    const id = idOf(l);
    if (seen.has(id)) continue;
    merged.push(l);
    seen.add(id);
  }
  return merged;
}
