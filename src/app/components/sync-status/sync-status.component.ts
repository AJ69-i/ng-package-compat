import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslocoModule } from '@jsverse/transloco';
import { RouterLink } from '@angular/router';
import { SupabaseSyncService } from '../../services/supabase-sync.service';
import { SupabaseService } from '../../services/supabase.service';
import { ToastService } from '../../services/toast.service';

/**
 * "Sync" row designed to live in the existing theme customizer panel
 * (the gear icon at bottom-right). Three states:
 *
 *   - Signed out  → "Sign in to sync your workspace" + link
 *   - Signed in   → "Synced 2m ago" + a "Sync now" action
 *   - Mid-sync    → "Syncing…" with a spinner
 *
 * Built as its own component so it can be dropped anywhere — the gear panel
 * for now, but reusable on a future "Settings" page.
 */
@Component({
  selector: 'app-sync-status',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TranslocoModule, RouterLink],
  template: `
    <div class="row" role="status">
      <span class="dot" [attr.data-state]="state()" aria-hidden="true"></span>
      <div class="text">
        <strong>{{ 'sync.title' | transloco }}</strong>
        <small>{{ statusLabel() }}</small>
      </div>
      <div class="actions">
        @switch (state()) {
          @case ('signed-out') {
            <a routerLink="/sign-in" class="link">
              {{ 'sync.signIn' | transloco }}
            </a>
          }
          @case ('signed-in') {
            <button type="button" class="link" (click)="forceSync()" [disabled]="busy()">
              {{ 'sync.now' | transloco }}
            </button>
          }
          @case ('syncing') {
            <span class="link muted">{{ 'sync.syncing' | transloco }}</span>
          }
        }
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .row {
      display: flex; align-items: center; gap: 0.6rem;
      padding: 0.5rem 0.6rem;
      background: var(--surface-2, #f1f5f9);
      border-radius: 8px;
      font-size: 0.85rem;
    }
    .dot {
      width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
      background: var(--fg-dim, #94a3b8);
    }
    .dot[data-state="signed-out"] { background: var(--fg-dim, #94a3b8); }
    .dot[data-state="signed-in"]  { background: #15803d; box-shadow: 0 0 0 3px rgba(21, 128, 61, 0.18); }
    .dot[data-state="syncing"]    { background: #2563eb; animation: pulse 1.2s infinite; }
    .dot[data-state="error"]      { background: #b91c1c; }
    @keyframes pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(37, 99, 235, 0.45); }
      50%      { box-shadow: 0 0 0 6px rgba(37, 99, 235, 0); }
    }
    .text {
      display: grid; flex: 1 1 auto; line-height: 1.2;
    }
    .text strong { font-size: 0.82rem; }
    .text small { font-size: 0.75rem; color: var(--fg-dim, #64748b); }
    .actions { display: flex; gap: 0.4rem; }
    .link {
      background: none; border: none; padding: 0;
      color: var(--accent, #2563eb); font: inherit; font-size: 0.78rem;
      cursor: pointer; text-decoration: none;
    }
    .link:hover:not([disabled]) { text-decoration: underline; }
    .link[disabled] { opacity: 0.55; cursor: progress; }
    .link.muted { color: var(--fg-dim, #64748b); cursor: default; }
  `]
})
export class SyncStatusComponent {
  private readonly sync = inject(SupabaseSyncService);
  private readonly supabase = inject(SupabaseService);
  private readonly toast = inject(ToastService);

  readonly busy = signal(false);

  /** Tick the "synced X ago" relative time once a minute. */
  private readonly nowTick = signal(Date.now());

  constructor() {
    if (typeof window !== 'undefined') {
      const id = window.setInterval(() => this.nowTick.set(Date.now()), 60_000);
      window.addEventListener('beforeunload', () => window.clearInterval(id), { once: true });
    }
  }

  readonly state = computed<'signed-out' | 'signed-in' | 'syncing' | 'error'>(() => {
    if (this.busy()) return 'syncing';
    if (!this.supabase.isSignedIn()) return 'signed-out';
    if (this.sync.lastError()) return 'error';
    return 'signed-in';
  });

  readonly statusLabel = computed(() => {
    if (!this.supabase.isSignedIn()) return 'Sign in to sync across devices.';
    if (this.busy()) return 'Syncing your workspace…';
    const err = this.sync.lastError();
    if (err) return `Sync error: ${err}`;
    const lastAt = this.sync.lastSyncedAt();
    if (!lastAt) return 'Sync ready — waiting for first change.';
    return this.relative(lastAt);
  });

  async forceSync(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await this.sync.syncNow();
      this.toast.success('Synced.');
    } catch (e) {
      this.toast.error((e as Error)?.message ?? 'Sync failed.');
    } finally {
      this.busy.set(false);
    }
  }

  private relative(iso: string): string {
    const diff = this.nowTick() - new Date(iso).getTime();
    if (diff < 30_000) return 'Just synced';
    const m = Math.floor(diff / 60_000);
    if (m < 60) return `Synced ${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `Synced ${h}h ago`;
    const d = Math.floor(h / 24);
    return `Synced ${d}d ago`;
  }
}
