import { Injectable, inject, signal } from '@angular/core';
import { SupabaseService } from './supabase.service';
import { PolicyService, PolicyRule } from './policy.service';

/**
 * Org-level policy templates (feature #88).
 *
 * A "template" is a named bundle of policy rules an admin publishes for
 * their team — for example, the platform team might publish a "no GPL,
 * no abandoned packages, pin Angular" template that every project should
 * import. Templates are also flag-able as public, in which case anyone can
 * import them (useful for community-curated templates).
 *
 * This service is read-mostly: the dense UI is admin-only and lives in a
 * separate component. Most users just see a list and an "import" button.
 */
export interface PolicyTemplate {
  id: string;
  teamId: string | null;
  name: string;
  description: string | null;
  rules: PolicyRule[];
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
}

@Injectable({ providedIn: 'root' })
export class PolicyTemplatesService {
  private readonly supabase = inject(SupabaseService);
  private readonly policy = inject(PolicyService);

  readonly templates = signal<PolicyTemplate[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  /** Re-fetch from Supabase. Returns the fresh list (also stored in `templates`). */
  async refresh(): Promise<PolicyTemplate[]> {
    if (!this.supabase.isSignedIn()) {
      // Public templates are still readable when unauthenticated.
      return this.fetch();
    }
    return this.fetch();
  }

  private async fetch(): Promise<PolicyTemplate[]> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const { data, error } = await this.supabase.client
        .from('org_policy_templates')
        .select('id, team_id, name, description, rules, is_public, created_at, updated_at')
        .order('updated_at', { ascending: false });
      if (error) throw error;
      const out = (data ?? []).map((row) => this.fromRow(row as Record<string, unknown>));
      this.templates.set(out);
      return out;
    } catch (e) {
      this.error.set((e as Error)?.message ?? 'Failed to load templates');
      return [];
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Create a new template owned by `teamId`. Server-side RLS enforces that
   * the caller is an admin on that team.
   */
  async create(template: Omit<PolicyTemplate, 'id' | 'createdAt' | 'updatedAt'>): Promise<PolicyTemplate | null> {
    if (!this.supabase.isSignedIn()) return null;
    const user = this.supabase.user();
    if (!user) return null;
    const { data, error } = await this.supabase.client
      .from('org_policy_templates')
      .insert({
        team_id: template.teamId,
        name: template.name,
        description: template.description,
        rules: template.rules,
        is_public: template.isPublic,
        created_by: user.id
      })
      .select('id, team_id, name, description, rules, is_public, created_at, updated_at')
      .single();
    if (error) {
      this.error.set(error.message);
      return null;
    }
    const created = this.fromRow(data as Record<string, unknown>);
    this.templates.update((list) => [created, ...list]);
    return created;
  }

  /**
   * Apply a template to the user's *local* policy set. We append rules with
   * fresh ids so they don't collide with existing rules. The user can still
   * remove individual rules afterwards.
   */
  apply(template: PolicyTemplate): number {
    const existing = this.policy.rules();
    const fresh = template.rules.map((r) => ({
      ...r,
      id: this.regenId()
    }));
    this.policy.replaceAll([...existing, ...fresh]);
    return fresh.length;
  }

  private regenId(): string {
    return 'tpl_' + Math.random().toString(36).slice(2, 10);
  }

  private fromRow(row: Record<string, unknown>): PolicyTemplate {
    return {
      id: row['id'] as string,
      teamId: (row['team_id'] as string | null) ?? null,
      name: row['name'] as string,
      description: (row['description'] as string | null) ?? null,
      rules: (row['rules'] as PolicyRule[]) ?? [],
      isPublic: !!row['is_public'],
      createdAt: row['created_at'] as string,
      updatedAt: row['updated_at'] as string
    };
  }
}
