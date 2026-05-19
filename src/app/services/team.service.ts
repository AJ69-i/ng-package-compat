import { Injectable, computed, inject, signal } from '@angular/core';
import { SupabaseService } from './supabase.service';

/**
 * Team workspace + RBAC (feature #89).
 *
 * Lightweight wrapper around the `teams` and `team_members` tables. The
 * heavy lifting is in Postgres RLS — this service just keeps the user's
 * current memberships in a signal so guards and the UI can react.
 *
 * Concepts:
 *   - A user can belong to many teams.
 *   - On each team they have role `'admin'` or `'member'`.
 *   - The "current team" is the user's selection — defaults to the first
 *     admin team, then the first member team. Stored in localStorage.
 */
export type TeamRole = 'admin' | 'member';

export interface Team {
  id: string;
  name: string;
  slug: string;
}

export interface Membership {
  team: Team;
  role: TeamRole;
}

const ACTIVE_KEY = 'ngpc.activeTeam.v1';

@Injectable({ providedIn: 'root' })
export class TeamService {
  private readonly supabase = inject(SupabaseService);

  readonly memberships = signal<Membership[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly activeTeamId = signal<string | null>(this.loadActive());

  readonly active = computed<Membership | null>(() => {
    const id = this.activeTeamId();
    if (!id) return null;
    return this.memberships().find((m) => m.team.id === id) ?? null;
  });

  readonly isAdminOfActive = computed(() => this.active()?.role === 'admin');

  async refresh(): Promise<void> {
    const user = this.supabase.user();
    if (!user) {
      this.memberships.set([]);
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    try {
      const { data, error } = await this.supabase.client
        .from('team_members')
        .select('role, team:teams ( id, name, slug )')
        .eq('user_id', user.id);
      if (error) throw error;
      const out: Membership[] = (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        const t = r['team'] as Record<string, unknown> | null;
        return {
          team: {
            id: (t?.['id'] as string) ?? '',
            name: (t?.['name'] as string) ?? '',
            slug: (t?.['slug'] as string) ?? ''
          },
          role: (r['role'] as TeamRole) ?? 'member'
        };
      });
      this.memberships.set(out);
      // Auto-pick a default team if we don't have one yet.
      if (!this.activeTeamId() && out.length > 0) {
        const adminFirst = out.find((m) => m.role === 'admin') ?? out[0];
        this.setActive(adminFirst.team.id);
      }
    } catch (e) {
      this.error.set((e as Error)?.message ?? 'Failed to load teams');
    } finally {
      this.loading.set(false);
    }
  }

  setActive(teamId: string | null): void {
    this.activeTeamId.set(teamId);
    if (typeof localStorage === 'undefined') return;
    try {
      if (teamId) localStorage.setItem(ACTIVE_KEY, teamId);
      else localStorage.removeItem(ACTIVE_KEY);
    } catch {
      /* ignore */
    }
  }

  /** Boolean check: does the current user have role `role` on team `teamId`? */
  hasRole(teamId: string, role: TeamRole): boolean {
    return this.memberships().some(
      (m) => m.team.id === teamId && (role === 'member' || m.role === role)
    );
  }

  /**
   * Create a new team and immediately make the current user its first admin.
   * RLS won't allow the second insert if `created_by` doesn't match auth.uid,
   * so we let the failure surface as a normal error.
   */
  async createTeam(name: string, slug: string): Promise<Team | null> {
    const user = this.supabase.user();
    if (!user) return null;
    const { data, error } = await this.supabase.client
      .from('teams')
      .insert({ name, slug, created_by: user.id })
      .select('id, name, slug')
      .single();
    if (error) {
      this.error.set(error.message);
      return null;
    }
    const team = data as Team;
    const { error: memErr } = await this.supabase.client
      .from('team_members')
      .insert({ team_id: team.id, user_id: user.id, role: 'admin' });
    if (memErr) {
      this.error.set(memErr.message);
      return null;
    }
    await this.refresh();
    this.setActive(team.id);
    return team;
  }

  private loadActive(): string | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      return localStorage.getItem(ACTIVE_KEY);
    } catch {
      return null;
    }
  }
}
