import { Injectable, computed, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import { AppwriteService } from './appwrite.service';

/**
 * Single-identity coordinator.
 *
 * History: this used to multiplex between Supabase auth and Firebase auth
 * to support the LinkedIn-workspace and Gmail-workspace identity hubs.
 * Both were dropped in favour of direct OAuth (GitHub / GitLab / BitBucket
 * / Microsoft Azure) only, all flowing through Supabase. Firebase and
 * Appwrite remain as **storage** backends — they're not part of identity.
 *
 * The router is kept as the single point components should ask "who is
 * signed in?" so that future refactors don't have to chase down every
 * call site if we ever change auth backends.
 */

export type IdentitySource = 'supabase' | 'none';

@Injectable({ providedIn: 'root' })
export class BackendRouterService {
  private readonly supabase = inject(SupabaseService);
  private readonly appwrite = inject(AppwriteService);

  readonly identitySource = computed<IdentitySource>(() =>
    this.supabase.isSignedIn() ? 'supabase' : 'none'
  );

  readonly userId = computed<string | null>(
    () => this.supabase.user()?.id ?? null
  );

  readonly displayName = computed<string | null>(() => {
    const u = this.supabase.user();
    if (!u) return null;
    const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
    return (meta['full_name'] as string | undefined) ?? u.email ?? null;
  });

  readonly avatarUrl = computed<string | null>(() => {
    const meta = (this.supabase.user()?.user_metadata ?? {}) as Record<string, unknown>;
    return (meta['avatar_url'] as string | undefined) ?? null;
  });

  readonly isSignedIn = computed(() => this.identitySource() !== 'none');

  /** Quick getter for the Appwrite client — handy for components that
   *  just need to read/write preferences without touching identity. */
  get appwriteClient(): AppwriteService {
    return this.appwrite;
  }
}
