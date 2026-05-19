import {
  ChangeDetectionStrategy,
  Component,
  ViewChild,
  computed,
  effect,
  inject,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslocoModule } from '@jsverse/transloco';
import { ProjectListComponent } from '../../components/project-list/project-list.component';
import { DeleteAccountDialogComponent } from '../../components/delete-account-dialog/delete-account-dialog.component';
import {
  ProjectScannerService,
  ScannedProject
} from '../../services/project-scanner.service';
import { ProviderTokenStore } from '../../services/provider-token-store.service';
import { SupabaseService } from '../../services/supabase.service';
import { AuthService } from '../../services/auth.service';
import { ProjectHandoffService } from '../../services/project-handoff.service';
import { ToastService } from '../../services/toast.service';
import { BitbucketWorkspacesService } from '../../services/bitbucket-workspaces.service';

/**
 * "Direct provider" landing page — what GitHub / GitLab / BitBucket / Azure
 * users see immediately after signing in. We auto-trigger a scan as soon as
 * the page mounts (token + provider are already available), then render the
 * normalized project list.
 *
 * "Analyze" hands the parsed package.json off to /upgrade via the in-memory
 * handoff service.
 */
@Component({
  selector: 'app-projects-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, TranslocoModule, ProjectListComponent, DeleteAccountDialogComponent],
  template: `
    <section class="head">
      <div>
        <h1>{{ 'projects.heading' | transloco }}</h1>
        <p>
          {{ 'projects.subtitle' | transloco: { provider: providerLabel() } }}
        </p>
        @if (sessionExpiresInLabel(); as label) {
          <p class="session-expires" [title]="'Re-authenticate before this expires'">
            ⏱ {{ label }}
          </p>
        }
      </div>
      <!-- Sign out lives in the global navbar (top right). -->
    </section>

    @if (!hasToken()) {
      <article class="warn">
        <strong>{{ 'projects.noToken.title' | transloco }}</strong>
        <p>{{ 'projects.noToken.body' | transloco }}</p>
        <button type="button" class="primary" (click)="reSignIn()">
          {{ 'projects.noToken.cta' | transloco }}
        </button>
      </article>
    } @else {
      <!-- Bitbucket workspace setup panel. Bitbucket Cloud's CHANGE-2770
           deprecation removed the cross-workspace listing endpoints, so
           we need at least one workspace slug to call the surviving
           workspace-scoped repositories endpoint. This panel only
           appears for users signed in with Bitbucket. -->
      @if (hasBitbucketToken()) {
        <article class="bb-panel" [class.bb-panel-empty]="!bitbucketWorkspaces().length">
          <header>
            <strong>{{ 'projects.bitbucket.title' | transloco }}</strong>
            <p>{{ 'projects.bitbucket.body' | transloco }}</p>
          </header>

          @if (bitbucketWorkspaces().length) {
            <ul class="bb-list" [attr.aria-label]="'projects.bitbucket.listLabel' | transloco">
              @for (ws of bitbucketWorkspaces(); track ws) {
                <li>
                  <code class="bb-slug">{{ ws }}</code>
                  <button
                    type="button"
                    class="bb-remove"
                    (click)="removeBbWorkspace(ws)"
                    [attr.aria-label]="'projects.bitbucket.remove' | transloco: { workspace: ws }"
                  >
                    &times;
                  </button>
                </li>
              }
            </ul>
          }

          <form class="bb-add" (submit)="addBbWorkspace($event)" novalidate>
            <label class="bb-input-row">
              <span class="visually-hidden">
                {{ 'projects.bitbucket.inputLabel' | transloco }}
              </span>
              <input
                type="text"
                [(ngModel)]="bbInputValue"
                name="bbWorkspace"
                placeholder="aj769-workspace"
                autocomplete="off"
                autocapitalize="none"
                autocorrect="off"
                spellcheck="false"
                pattern="^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]?$"
              />
            </label>
            <button type="submit" class="primary" [disabled]="!bbInputValue.trim()">
              {{ 'projects.bitbucket.add' | transloco }}
            </button>
          </form>

          <p class="bb-hint">
            {{ 'projects.bitbucket.hint' | transloco }}
          </p>
        </article>
      }

      <app-project-list
        (refresh)="rescan()"
        (analyze)="onAnalyze($event)"
      />
    }

    <!-- Danger zone (account deletion). Mirrored from workspace-page
         intentionally — direct-provider sign-in users (GitHub/GitLab/
         BitBucket/Azure) land here, not on /workspace, so without this
         section they'd have no in-app path to GDPR data deletion.
         Same component, same RPC, same modal — discovery surface only. -->
    @if (isSignedIn()) {
      <section class="danger-zone" [attr.aria-label]="'deleteAccount.section' | transloco">
        <header class="danger-head">
          <h2>{{ 'deleteAccount.section' | transloco }}</h2>
          <p class="muted">{{ 'deleteAccount.sectionLede' | transloco }}</p>
        </header>
        <button
          type="button"
          class="ghost danger"
          (click)="openDeleteDialog()"
          data-testid="deleteAccount.open"
        >
          {{ 'deleteAccount.openButton' | transloco }}
        </button>
      </section>
      <app-delete-account-dialog #deleteDialog />
    }
  `,
  styles: [`
    :host { display: block; max-width: var(--content-max-width, min(94vw, 1320px)); margin: 0 auto; padding: 1.5rem 1rem; }
    .head {
      display: flex; justify-content: space-between; align-items: flex-start;
      gap: 1rem; flex-wrap: wrap; margin-bottom: 1.25rem;
    }
    .head h1 { margin: 0 0 0.2rem; font-size: 1.5rem; }
    .head p { margin: 0; color: var(--fg-dim, #64748b); }
    .session-expires {
      font-size: 0.8rem;
      color: var(--fg-dim, #94a3b8);
      margin-top: 0.4rem !important;
      font-variant-numeric: tabular-nums;
    }
    .header-actions { display: flex; gap: 0.5rem; }
    button { font: inherit; cursor: pointer; }
    button.ghost {
      padding: 0.45rem 0.9rem; border-radius: 8px;
      background: transparent; border: 1px solid var(--border, #e5e7eb);
      font-size: 0.85rem;
    }
    button.primary {
      padding: 0.5rem 1rem; border-radius: 8px;
      background: var(--accent, #2563eb); color: #fff; border: none;
      font-size: 0.85rem; font-weight: 600;
    }
    .warn {
      border: 1px solid color-mix(in srgb, #f59e0b 35%, var(--border, #e5e7eb));
      background: color-mix(in srgb, #f59e0b 6%, var(--surface-1, #fff));
      padding: 1rem 1.2rem; border-radius: 12px;
      display: grid; gap: 0.5rem; max-width: 540px;
    }
    .warn strong { font-size: 0.95rem; }
    .warn p { margin: 0; color: var(--fg-dim, #475569); font-size: 0.9rem; }

    /* === Bitbucket workspace setup panel === */
    .bb-panel {
      margin-bottom: 1.25rem;
      padding: 1rem 1.25rem;
      border: 1px solid var(--border-subtle, var(--border, #e5e7eb));
      border-radius: var(--radius-lg, 14px);
      background: var(--surface-2, #fff);
      display: grid;
      gap: 0.85rem;
    }
    .bb-panel.bb-panel-empty {
      /* Subtle accent when there are no workspaces yet — draws the eye
         for the first-time setup case without screaming about it. */
      border-color: color-mix(in srgb, var(--accent) 30%, var(--border));
      background: var(--accent-gradient-soft, var(--surface-2));
    }
    .bb-panel header { display: grid; gap: 0.2rem; }
    .bb-panel header strong { font-size: 0.95rem; color: var(--fg); }
    .bb-panel header p {
      margin: 0;
      color: var(--fg-dim, #475569);
      font-size: 0.85rem;
      line-height: 1.5;
    }
    .bb-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
    }
    .bb-list li {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.3rem 0.45rem 0.3rem 0.65rem;
      border-radius: var(--radius-pill, 999px);
      background: var(--surface-1);
      border: 1px solid var(--border);
      font-size: 0.85rem;
    }
    .bb-slug {
      font-family: var(--code-font, ui-monospace, Menlo, Consolas, monospace);
      font-size: 0.85rem;
      color: var(--fg);
    }
    .bb-remove {
      width: 22px; height: 22px;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: 50%;
      background: transparent;
      border: none;
      cursor: pointer;
      color: var(--fg-dim);
      font-size: 1.1rem;
      line-height: 1;
      transition: background-color 120ms ease, color 120ms ease;
    }
    .bb-remove:hover {
      background: color-mix(in srgb, var(--bad, #ef4444) 12%, transparent);
      color: var(--bad, #ef4444);
    }
    .bb-add {
      display: flex;
      gap: 0.5rem;
      align-items: stretch;
      flex-wrap: wrap;
    }
    .bb-input-row {
      flex: 1 1 240px;
      min-width: 240px;
      display: block;
    }
    .bb-input-row input {
      width: 100%;
      box-sizing: border-box;
      padding: 0.55rem 0.7rem;
      border: 1px solid var(--border);
      border-radius: var(--radius-md, 10px);
      font: inherit;
      font-size: 0.9rem;
      color: var(--fg);
      background: var(--surface-1);
      min-height: 38px;
    }
    .bb-input-row input:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-ring);
    }
    .bb-add button.primary {
      padding: 0 1.1rem;
      min-height: 38px;
    }
    .bb-add button.primary[disabled] {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .bb-hint {
      margin: 0;
      font-size: 0.78rem;
      color: var(--fg-dim, #64748b);
    }
    .visually-hidden {
      position: absolute;
      width: 1px; height: 1px;
      padding: 0; margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    /* Danger zone — mirrored from workspace-page so both signed-in
       landing pages have the same destructive-action affordance. Same
       visual vocabulary: red-tinted dashed border + sits at the
       bottom of the page so users have to scroll past everything else
       to reach it. Account deletion lives behind a typed-DELETE modal,
       so the button itself can sit visibly without being dangerous. */
    .danger-zone {
      margin-top: 3rem;
      padding: 1.25rem;
      border: 1px dashed color-mix(in srgb, #ef4444 35%, var(--border, #e5e7eb));
      border-radius: 12px;
      background: color-mix(in srgb, #ef4444 4%, transparent);
    }
    .danger-head { margin-bottom: 0.85rem; }
    .danger-head h2 {
      margin: 0 0 0.15rem;
      font-size: 1rem;
      color: color-mix(in srgb, #ef4444 65%, var(--fg, #0f172a));
    }
    .danger-head .muted { color: var(--fg-dim, #64748b); font-size: 0.85rem; }
    .ghost.danger {
      padding: 0.55rem 1rem;
      background: color-mix(in srgb, #ef4444 10%, transparent);
      color: #fca5a5;
      border: 1px solid color-mix(in srgb, #ef4444 35%, transparent);
      border-radius: 8px;
      font-size: 0.9rem; font-weight: 500;
      cursor: pointer;
      transition: background 140ms ease, border-color 140ms ease;
    }
    .ghost.danger:hover {
      background: color-mix(in srgb, #ef4444 18%, transparent);
      border-color: color-mix(in srgb, #ef4444 55%, transparent);
    }
  `]
})
export class ProjectsPageComponent {
  private readonly scanner = inject(ProjectScannerService);
  private readonly tokens = inject(ProviderTokenStore);
  private readonly supabase = inject(SupabaseService);
  private readonly auth = inject(AuthService);
  private readonly handoff = inject(ProjectHandoffService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly bbWorkspaceStore = inject(BitbucketWorkspacesService);

  readonly providerLabel = signal('your code host');
  readonly hasToken = signal(false);

  /** True when a Supabase session exists — gates the Danger Zone. */
  readonly isSignedIn = computed(() => this.supabase.isSignedIn());

  /**
   * Reference to the account-deletion modal. Lives on this page (and
   * the workspace page) so signed-in users via *any* sign-in flow can
   * find the GDPR data-deletion path; without it, direct-provider
   * users would never see /workspace and have no in-app deletion path.
   */
  @ViewChild('deleteDialog')
  private deleteDialog?: DeleteAccountDialogComponent;

  openDeleteDialog(): void {
    this.deleteDialog?.open();
  }
  /**
   * True when the user has a Bitbucket OAuth token captured. Drives the
   * Bitbucket workspace setup panel — only shown for Bitbucket users
   * because that's the only provider that needs an explicit slug.
   */
  readonly hasBitbucketToken = computed(() => this.tokens.has('bitbucket'));
  /** Configured workspace slugs — surfaced to the template. */
  readonly bitbucketWorkspaces = this.bbWorkspaceStore.workspaces;

  /**
   * Two-way bound to the workspace input. Plain property (not a signal)
   * because ngModel works directly with property mutation; signals would
   * require the [(ngModel)]="x()" / (ngModelChange) two-line dance and
   * we don't need reactivity here.
   */
  bbInputValue = '';

  /** One-shot guard so the effect doesn't auto-scan on every signal change. */
  private autoScanned = false;

  /** Re-render the "expires in" hint every minute. */
  private readonly nowTick = signal(Date.now());

  /**
   * Human-readable countdown until the OAuth token in the store expires.
   * Returns null if no expiring token is in play (e.g. only PATs, or empty).
   */
  readonly sessionExpiresInLabel = computed<string | null>(() => {
    const expiresAt = this.tokens.earliestOauthExpiry();
    if (!expiresAt) return null;
    const remaining = expiresAt - this.nowTick();
    if (remaining <= 0) return 'Session expired — please re-authenticate';
    const hours = Math.floor(remaining / (60 * 60 * 1000));
    const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
    if (hours >= 1) return `Session expires in ${hours}h ${minutes}m`;
    if (minutes >= 1) return `Session expires in ${minutes}m`;
    return 'Session expires in less than a minute';
  });

  constructor() {
    // Tick the "expires in" clock every minute so the label refreshes.
    if (typeof window !== 'undefined') {
      const id = window.setInterval(() => this.nowTick.set(Date.now()), 60_000);
      window.addEventListener(
        'beforeunload',
        () => window.clearInterval(id),
        { once: true }
      );
    }

    effect(() => {
      if (!this.supabase.ready()) return;
      const tokens = this.tokens.bindings();
      this.hasToken.set(tokens.length > 0);
      if (tokens.length) {
        this.providerLabel.set(tokens.map((t) => t.provider).join(', '));
        if (
          !this.autoScanned &&
          !this.scanner.projects().length &&
          this.scanner.status()?.stage !== 'fetching'
        ) {
          this.autoScanned = true;
          this.rescan();
        }
      } else {
        // Bounce to sign-in if we have no session at all.
        if (!this.supabase.isSignedIn()) {
          this.router.navigateByUrl('/sign-in');
        }
      }
    });
  }

  rescan(): void {
    const bindings = this.tokens.bindings();
    if (!bindings.length) return;
    this.scanner.scan(bindings).subscribe({
      error: (e) => this.toast.error(e?.message ?? 'Scan failed.')
    });
  }

  onAnalyze(p: ScannedProject): void {
    if (!p.parsed) return;
    // Pass the full repo descriptor (provider, default branch, etc.) so the
    // PR-preview component on /upgrade can use it as the active repo without
    // asking the user to pick again.
    this.handoff.set(p.parsed, p.repo.fullName, p.repo);
    this.router.navigateByUrl('/upgrade');
  }

  async signOut(): Promise<void> {
    await this.auth.signOut();
    this.tokens.clearAll();
    this.scanner.clear();
    // Bitbucket workspace slugs are user-configured per-account info; the
    // next user to sign in shouldn't inherit them. Wipe alongside tokens.
    this.bbWorkspaceStore.clear();
    this.router.navigateByUrl('/sign-in');
  }

  /**
   * Add a Bitbucket workspace slug to the discovery list. After a
   * successful add we re-trigger a scan so the user sees their repos
   * appear immediately — no need to click Re-scan separately.
   */
  addBbWorkspace(ev: Event): void {
    ev.preventDefault();
    const value = this.bbInputValue;
    const added = this.bbWorkspaceStore.add(value);
    this.bbInputValue = '';
    if (added) {
      this.toast.success(`Added Bitbucket workspace "${value.trim()}".`);
      this.rescan();
    }
  }

  removeBbWorkspace(slug: string): void {
    this.bbWorkspaceStore.remove(slug);
    this.toast.info?.(`Removed Bitbucket workspace "${slug}".`);
    // Re-scan so the project list reflects the change immediately.
    this.rescan();
  }

  async reSignIn(): Promise<void> {
    const provider = this.supabase.primaryProvider();
    if (!provider || provider === 'linkedin_oidc') {
      this.router.navigateByUrl('/sign-in');
      return;
    }
    try {
      await this.auth.signInWith(provider as 'github' | 'gitlab' | 'bitbucket' | 'azure');
    } catch (e) {
      this.toast.error(e instanceof Error ? e.message : 'Re-authentication failed.');
    }
  }
}
