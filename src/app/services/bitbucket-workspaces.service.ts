import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

/**
 * Stores the Bitbucket workspace slugs the user has configured for repo
 * discovery. Required because Atlassian's CHANGE-2770 retired the cross-
 * workspace listing endpoints (`/2.0/workspaces`, `/2.0/repositories?role=member`,
 * `/2.0/user/permissions/repositories`). The only endpoint that still works
 * after that change is `/2.0/repositories/{workspace}` — workspace-scoped —
 * which means we need the workspace slug to call it.
 *
 * Two-pronged storage:
 *   - In-memory signal — drives the UI directly (input + "Add" button on
 *     the projects page, listing the configured workspaces with remove
 *     buttons).
 *   - localStorage — survives page reloads. Per-browser, no cloud sync;
 *     Bitbucket workspaces are an account-shape detail we don't want
 *     leaking into Supabase tables.
 *
 * Slugs are normalized to lowercase + trimmed before storage. Duplicates
 * are silently ignored.
 */
@Injectable({ providedIn: 'root' })
export class BitbucketWorkspacesService {
  private static readonly STORAGE_KEY = 'ngpc.bitbucket-workspaces.v1';
  private readonly platformId = inject(PLATFORM_ID);

  readonly workspaces = signal<string[]>(this.load());

  /**
   * Add a workspace slug. Trims, lowercases, and deduplicates against the
   * existing list. Returns `true` if the slug was actually added (i.e. it
   * wasn't already in the list); `false` if it was a no-op.
   */
  add(rawSlug: string): boolean {
    const slug = this.normalize(rawSlug);
    if (!slug) return false;
    const current = this.workspaces();
    if (current.includes(slug)) return false;
    const next = [...current, slug];
    this.workspaces.set(next);
    this.persist(next);
    return true;
  }

  remove(slug: string): void {
    const next = this.workspaces().filter((w) => w !== this.normalize(slug));
    this.workspaces.set(next);
    this.persist(next);
  }

  /**
   * Wipe all configured workspaces. Called on sign-out so the next user
   * doesn't inherit the previous user's Bitbucket setup.
   */
  clear(): void {
    this.workspaces.set([]);
    if (!isPlatformBrowser(this.platformId)) return;
    try {
      localStorage.removeItem(BitbucketWorkspacesService.STORAGE_KEY);
    } catch {
      /* storage blocked — non-fatal */
    }
  }

  private normalize(raw: string): string {
    // Bitbucket workspace slugs are lowercase, alphanumeric + hyphens.
    // We trim and lowercase but don't strip other characters — let the
    // user discover bad slugs via a 404 from the API rather than silently
    // mangling their input.
    return (raw || '').trim().toLowerCase();
  }

  private load(): string[] {
    if (!isPlatformBrowser(this.platformId)) return [];
    try {
      const raw = localStorage.getItem(BitbucketWorkspacesService.STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((s): s is string => typeof s === 'string' && s.length > 0);
    } catch {
      return [];
    }
  }

  private persist(workspaces: string[]): void {
    if (!isPlatformBrowser(this.platformId)) return;
    try {
      localStorage.setItem(
        BitbucketWorkspacesService.STORAGE_KEY,
        JSON.stringify(workspaces)
      );
    } catch {
      /* storage full / blocked — non-fatal */
    }
  }
}
