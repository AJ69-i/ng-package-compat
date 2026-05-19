import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Router } from '@angular/router';
import { SupabaseService } from './supabase.service';
import { AuthService } from './auth.service';
import { SupabaseSyncService } from './supabase-sync.service';
import { ToastService } from './toast.service';

/**
 * Account deletion service.
 *
 * # The deletion contract
 *
 * Deleting an account is irreversible and must do three things in order:
 *
 *   1. **Server-side wipe** — call the Postgres RPC `delete_user_account()`
 *      which removes the `auth.users` row. All `public.user_*` tables
 *      have `on delete cascade` foreign keys, so every collection
 *      (favorites, history, notes, snapshots, compares, etc.) is
 *      removed atomically as part of that single SQL statement.
 *
 *   2. **Local-side wipe** — every IndexedDB / localStorage cache on
 *      this device is cleared via `SupabaseSyncService.wipeLocalWorkspace()`.
 *      Without this, signed-out state would still hold the user's data
 *      in memory + storage until the next page reload, and a casual
 *      observer (another OS user, a leaked device) could read it.
 *
 *   3. **Auth session destruction** — `auth.signOut()` clears the
 *      Supabase session and tokens so the now-deleted user can't
 *      accidentally re-authenticate from the stale JWT.
 *
 * Order matters: server first (so even if the local wipe partially
 * fails, the account is gone), then local, then sign-out. If the
 * server delete fails (network, RLS misconfiguration), we surface
 * the error and stop — the user's data and auth row remain intact.
 *
 * # SSR safety
 *
 * Every method is a no-op during prerender. Anonymous users (no
 * session) get an early no-op too — there's nothing to delete.
 */
@Injectable({ providedIn: 'root' })
export class AccountDeletionService {
  private readonly supabase = inject(SupabaseService);
  private readonly auth = inject(AuthService);
  private readonly sync = inject(SupabaseSyncService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /**
   * Permanently delete the signed-in user's account.
   *
   * Returns `true` on success. On failure, surfaces a toast with the
   * underlying error and returns `false` — caller (the modal) should
   * keep the modal open so the user can retry.
   */
  async deleteAccount(): Promise<boolean> {
    if (!this.isBrowser) return false;
    const user = this.supabase.user();
    if (!user) {
      // Nothing to delete — pretend success so the caller closes the modal.
      return true;
    }

    try {
      // 1. Server wipe via RPC. The Postgres function deletes auth.users
      //    (cascading to every user_* table) and returns void on success.
      const { error } = await this.supabase.client.rpc('delete_user_account');
      if (error) {
        // The most common failure here is the RPC not existing yet —
        // either the migration hasn't been applied to this Supabase
        // project, or the function is mis-named. Surface a useful
        // message rather than the raw Postgres error.
        const friendly = /function .* does not exist/i.test(error.message)
          ? 'Account deletion isn\'t available on this server. Please contact support — the migration hasn\'t been applied yet.'
          : error.message;
        this.toast.error(friendly);
        return false;
      }

      // 2. Local wipe. Same routine sign-out uses, but called explicitly
      //    here because after the server deletes the row, the session
      //    is still alive on this device until we tear it down.
      await this.sync.wipeLocalWorkspace();

      // 3. Auth session destruction. Note: signOut() would normally
      //    fail loudly if the user row is already gone server-side,
      //    but supabase-js treats that case as a successful local
      //    sign-out (it's idempotent on the local session token).
      await this.auth.signOut();

      // 4. Route home. The redirect must happen AFTER signOut so the
      //    router-level auth guards see the cleared session and don't
      //    bounce the user back to /workspace.
      await this.router.navigateByUrl('/');

      this.toast.success('Your account has been deleted. Goodbye!');
      return true;
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Account deletion failed.';
      this.toast.error(msg);
      return false;
    }
  }
}
