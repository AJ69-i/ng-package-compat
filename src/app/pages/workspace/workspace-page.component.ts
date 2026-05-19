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
import { MonitorDigestComponent } from '../../components/monitor-digest/monitor-digest.component';
import { PolicyConfigComponent } from '../../components/policy-config/policy-config.component';
import { DeleteAccountDialogComponent } from '../../components/delete-account-dialog/delete-account-dialog.component';
import { SupabaseService } from '../../services/supabase.service';
import { FirebaseService } from '../../services/firebase.service';
import { BackendRouterService } from '../../services/backend-router.service';
import {
  AuthProvider,
  AuthService,
  PROVIDER_META
} from '../../services/auth.service';
import { ProjectScannerService, ScannedProject } from '../../services/project-scanner.service';
import { ProviderTokenStore } from '../../services/provider-token-store.service';
import { ProjectHandoffService } from '../../services/project-handoff.service';
import { ToastService } from '../../services/toast.service';

/**
 * The "Vercel/Netlify" model: the LinkedIn-signed-in user lands here with a
 * dedicated workspace tied to their LinkedIn identity. From here they can
 * connect any of the four code hosts, and projects across all of them
 * aggregate into one list under their LinkedIn identity.
 *
 * Connection flow uses Supabase's `linkIdentity()` API. Provider tokens for
 * linked identities aren't always returned to the client (Supabase config-
 * dependent); when missing, we fall back to a "paste a Personal Access Token"
 * UI that lets the workspace keep working.
 */
@Component({
  selector: 'app-workspace-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, TranslocoModule, ProjectListComponent, MonitorDigestComponent, PolicyConfigComponent, DeleteAccountDialogComponent],
  template: `
    <section class="head">
      <div>
        <h1>{{ 'workspaceHub.heading' | transloco }}</h1>
        <p>{{ 'workspaceHub.subtitle' | transloco: { name: displayName() } }}</p>
      </div>
      <div class="header-actions">
        <button type="button" class="ghost" (click)="signOut()">
          {{ 'auth.signOut' | transloco }}
        </button>
      </div>
    </section>

    <section class="connections">
      <h2>{{ 'workspaceHub.connections.title' | transloco }}</h2>
      <p class="muted">{{ 'workspaceHub.connections.lede' | transloco }}</p>

      <div class="cards">
        @for (p of linkable; track p) {
          <article
            class="card"
            [class.linked]="isLinked(p)"
            [class.has-token]="hasToken(p)"
            [class.is-experimental]="isExperimental(p)"
          >
            <header>
              <span class="logo" [attr.data-provider]="p" aria-hidden="true">{{ glyph(p) }}</span>
              <div>
                <strong>
                  {{ label(p) }}
                  <!-- Mirrors the badge on the sign-in page. Renders only
                       for providers flagged experimental in PROVIDER_META;
                       single source of truth means flipping that flag
                       updates every UI surface. -->
                  @if (isExperimental(p)) {
                    <span
                      class="card-experimental"
                      [title]="'providerExperimental.tooltip' | transloco: { name: label(p) }"
                    >
                      {{ 'providerExperimental.label' | transloco }}
                    </span>
                  }
                </strong>
                <small>
                  @if (isLinked(p)) {
                    {{ 'workspaceHub.connections.linked' | transloco }}
                    @if (!hasToken(p)) {
                      · <span class="warn">{{ 'workspaceHub.connections.needPat' | transloco }}</span>
                    }
                  } @else {
                    {{ 'workspaceHub.connections.notLinked' | transloco }}
                  }
                </small>
              </div>
            </header>
            <div class="card-actions">
              @if (!isLinked(p)) {
                <button type="button" class="primary" (click)="link(p)">
                  {{ 'workspaceHub.connections.connect' | transloco }}
                </button>
              } @else {
                @if (!hasToken(p)) {
                  <details class="pat">
                    <summary>{{ 'workspaceHub.connections.addPat' | transloco }}</summary>
                    <input
                      type="password"
                      placeholder="ghp_xxx / glpat-xxx / ..."
                      [ngModel]="patInputs()[p] ?? ''"
                      (ngModelChange)="setPatInput(p, $event)"
                    />
                    <button type="button" class="primary" (click)="savePat(p)">
                      {{ 'workspaceHub.connections.savePat' | transloco }}
                    </button>
                  </details>
                }
                @if (isPrimary(p)) {
                  <small class="muted primary-note">
                    Primary identity — sign out to remove.
                  </small>
                  @if (!hasToken(p)) {
                    <button type="button" class="ghost" (click)="reAuth(p)">
                      Re-authenticate to refresh token
                    </button>
                  }
                } @else {
                  <button type="button" class="ghost danger" (click)="unlink(p)">
                    {{ 'workspaceHub.connections.unlink' | transloco }}
                  </button>
                }
              }
            </div>
          </article>
        }
      </div>
    </section>

    <!-- Continuous monitoring digest (feature #74). Renders nothing if no
         project has ever been captured, so it's safe to leave above the fold. -->
    <app-monitor-digest />

    <!-- Policy/rule engine (feature #73) — same component the upgrade page uses;
         rules are global so configuring here applies everywhere. -->
    <app-policy-config />

    @if (anyTokenAvailable()) {
      <section class="projects">
        <app-project-list (refresh)="rescan()" (analyze)="onAnalyze($event)" />
      </section>
    } @else {
      <section class="empty">
        <h3>{{ 'workspaceHub.empty.title' | transloco }}</h3>
        <p>{{ 'workspaceHub.empty.body' | transloco }}</p>
      </section>
    }

    <!-- Danger zone. Lives at the bottom intentionally — destructive
         actions go where users have to scroll past everything else to
         reach them. The amber/red palette + dashed border signals
         "different category of action" without screaming. Account
         deletion lives behind a typed-confirmation modal, so the
         button itself can sit visibly without being dangerous. -->
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
  `,
  styles: [`
    :host { display: block; max-width: var(--content-max-width, min(94vw, 1320px)); margin: 0 auto; padding: 1.5rem 1rem; }
    .head { display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
    .head h1 { margin: 0 0 0.2rem; font-size: 1.5rem; }
    .head p { margin: 0; color: var(--fg-dim, #64748b); }
    .header-actions { display: flex; gap: 0.5rem; }
    .connections { margin-bottom: 1.5rem; }
    .connections h2 { margin: 0 0 0.2rem; font-size: 1rem; }
    .muted { color: var(--fg-dim, #64748b); font-size: 0.85rem; margin: 0 0 0.85rem; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 0.75rem; }
    .card {
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 12px;
      padding: 0.85rem 1rem;
      background: var(--surface-1, #fff);
      display: flex; flex-direction: column; gap: 0.6rem;
    }
    .card.linked { border-color: color-mix(in srgb, #22c55e 30%, var(--border, #e5e7eb)); }
    .card.has-token { background: color-mix(in srgb, #22c55e 4%, var(--surface-1, #fff)); }
    .card header { display: flex; gap: 0.6rem; align-items: center; }
    .logo {
      width: 36px; height: 36px; border-radius: 8px;
      display: grid; place-items: center;
      color: #fff; font-weight: 700; font-size: 0.85rem;
    }
    .logo[data-provider="github"] { background: #24292f; }
    .logo[data-provider="gitlab"] { background: #fc6d26; }
    .logo[data-provider="bitbucket"] { background: #2684ff; }
    .logo[data-provider="azure"] { background: #0078d4; }
    .card strong { font-size: 0.95rem; display: block; }
    .card small { color: var(--fg-dim, #64748b); font-size: 0.78rem; }
    .card .warn { color: #b45309; font-weight: 600; }
    .card-actions { display: flex; gap: 0.4rem; flex-wrap: wrap; }
    .pat {
      flex: 1 1 100%;
      border: 1px dashed var(--border, #e5e7eb);
      border-radius: 8px;
      padding: 0.4rem 0.6rem;
      font-size: 0.8rem;
    }
    .pat summary { cursor: pointer; }
    .pat input {
      width: 100%; margin-top: 0.4rem;
      padding: 0.35rem 0.5rem;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 6px;
      font: inherit;
      font-size: 0.8rem;
    }
    .pat .primary { margin-top: 0.4rem; }
    button { font: inherit; cursor: pointer; }
    button.primary {
      padding: 0.4rem 0.9rem; border-radius: 6px; border: none;
      background: var(--accent, #2563eb); color: #fff; font-weight: 600; font-size: 0.82rem;
    }
    button.ghost {
      padding: 0.4rem 0.9rem; border-radius: 6px;
      background: transparent; border: 1px solid var(--border, #e5e7eb);
      font-size: 0.82rem;
    }
    button.ghost.danger { color: #dc2626; border-color: color-mix(in srgb, #dc2626 30%, var(--border, #e5e7eb)); }
    .empty {
      text-align: center; padding: 2rem 1rem;
      border: 1px dashed var(--border, #e5e7eb);
      border-radius: 12px;
      color: var(--fg-dim, #64748b);
    }
    .empty h3 { color: var(--fg, #0f172a); margin: 0 0 0.4rem; font-size: 1rem; }

    /* Danger zone — visually separated from normal sections with a
       red-tinted dashed border + larger top margin. Sits at the bottom
       of the page intentionally; destructive actions live where users
       have to scroll past everything else to reach them. */
    .danger-zone {
      margin-top: 3rem;
      padding: 1.25rem;
      border: 1px dashed color-mix(in srgb, #ef4444 35%, var(--border, #e5e7eb));
      border-radius: 12px;
      background: color-mix(in srgb, #ef4444 4%, transparent);
    }
    .danger-head {
      margin-bottom: 0.85rem;
    }
    .danger-head h2 {
      margin: 0 0 0.15rem;
      font-size: 1rem;
      color: color-mix(in srgb, #ef4444 65%, var(--fg, #0f172a));
    }

    /* Experimental marker on connection cards. Same vocabulary as the
       sign-in page and the AI settings dialog: amber pill + amber edge.
       cursor:help on the pill signals the tooltip is the place to look. */
    .card.is-experimental { border-left: 3px solid color-mix(in srgb, var(--warn, #f59e0b) 50%, var(--border, #e5e7eb)); }
    .card-experimental {
      font-size: 0.6rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      font-weight: 700;
      padding: 1px 6px;
      margin-inline-start: 0.4rem;
      border-radius: var(--radius-pill, 999px);
      background: color-mix(in srgb, var(--warn, #f59e0b) 16%, transparent);
      color: color-mix(in srgb, var(--warn, #f59e0b) 70%, var(--fg, #0f172a));
      border: 1px solid color-mix(in srgb, var(--warn, #f59e0b) 40%, var(--border, #e5e7eb));
      cursor: help;
      display: inline-block;
      vertical-align: middle;
    }
  `]
})
export class WorkspacePageComponent {
  private readonly supabase = inject(SupabaseService);
  private readonly auth = inject(AuthService);
  private readonly scanner = inject(ProjectScannerService);
  private readonly tokens = inject(ProviderTokenStore);
  private readonly handoff = inject(ProjectHandoffService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);

  readonly linkable: AuthProvider[] = ['github', 'gitlab', 'bitbucket', 'azure'];

  // Accept either Supabase OR Firebase as the active identity, via the
  // unified backend router. Without this fix a Gmail-signed-in user lands
  // here with `supabase.user() === null` and sees the "no one is signed in"
  // empty state.
  private readonly firebase = inject(FirebaseService);
  private readonly backend = inject(BackendRouterService);

  readonly displayName = computed(() =>
    this.backend.displayName() ?? 'there'
  );

  readonly anyTokenAvailable = computed(() => this.tokens.bindings().length > 0);
  readonly patInputs = signal<Partial<Record<AuthProvider, string>>>({});

  /** Have we already kicked off the auto-scan once for this session? */
  private autoScanned = false;

  constructor() {
    effect(() => {
      if (!this.supabase.ready()) return;
      // Either backend's session counts as signed-in.
      if (!this.backend.isSignedIn()) {
        this.router.navigateByUrl('/sign-in');
        return;
      }
      // Auto-scan ONCE when tokens become available — without the guard the
      // effect re-fires every time `tokens.bindings()` updates and pegs the
      // CPU after a successful sign-in.
      const bindings = this.tokens.bindings();
      if (
        !this.autoScanned &&
        bindings.length &&
        !this.scanner.projects().length &&
        this.scanner.status()?.stage !== 'fetching'
      ) {
        this.autoScanned = true;
        this.rescan();
      }
    });
  }

  isLinked(p: AuthProvider): boolean {
    if (this.backend.identitySource() === 'firebase') {
      // Firebase doesn't support GitLab/BitBucket natively.
      const fb = this.toFirebase(p);
      return fb ? this.firebase.hasIdentity(fb) : false;
    }
    return this.supabase.hasIdentity(p);
  }

  /**
   * Supabase forbids unlinking the user's *primary* identity (the one they
   * originally signed in with) and Firebase silently no-ops the same call.
   * Either way, hide the Disconnect button for the primary identity — they
   * need to sign out to remove it.
   */
  isPrimary(p: AuthProvider): boolean {
    if (this.backend.identitySource() === 'firebase') {
      const fb = this.toFirebase(p);
      return fb !== null && this.firebase.primaryProvider() === fb;
    }
    return this.supabase.primaryProvider() === p;
  }

  /**
   * Map a Supabase-style AuthProvider to the matching FirebaseProvider id.
   * GitLab and BitBucket aren't first-class Firebase providers, so they
   * map to null and the workspace UI disables the button for them.
   */
  private toFirebase(p: AuthProvider): 'github' | 'microsoft' | null {
    if (p === 'github') return 'github';
    if (p === 'azure') return 'microsoft';
    return null;
  }

  /** Whether this provider can be linked from the active backend at all. */
  canLink(p: AuthProvider): boolean {
    if (this.backend.identitySource() === 'firebase') {
      return this.toFirebase(p) !== null;
    }
    return p !== 'linkedin_oidc';
  }

  hasToken(p: AuthProvider): boolean {
    return this.tokens.has(p);
  }

  label(p: AuthProvider): string {
    return PROVIDER_META[p].label;
  }

  /** See PROVIDER_META.experimental for what this flag means and how to flip it. */
  isExperimental(p: AuthProvider): boolean {
    return PROVIDER_META[p].experimental;
  }

  /** Reference to the confirmation modal in the Danger Zone. */
  @ViewChild('deleteDialog')
  private deleteDialog?: DeleteAccountDialogComponent;

  /** Open the typed-confirmation modal for account deletion. */
  openDeleteDialog(): void {
    this.deleteDialog?.open();
  }

  glyph(p: AuthProvider): string {
    switch (p) {
      case 'github': return 'GH';
      case 'gitlab': return 'GL';
      case 'bitbucket': return 'BB';
      case 'azure': return 'AZ';
      default: return '??';
    }
  }

  async link(p: AuthProvider): Promise<void> {
    // Route the link call through whichever identity hub the user signed in
    // through. Without this, a Firebase-signed-in user clicking "Connect"
    // hits Supabase's linkIdentity API with no Bearer token and gets a 401.
    try {
      if (this.backend.identitySource() === 'firebase') {
        const fb = this.toFirebase(p);
        if (!fb) {
          this.toast.error(
            `${PROVIDER_META[p].label} can't be linked through Firebase. ` +
              `Sign out and sign back in with LinkedIn to use this provider.`
          );
          return;
        }
        await this.firebase.linkProvider(fb);
        this.toast.success(`${PROVIDER_META[p].label} connected.`);
      } else {
        await this.auth.linkProvider(p);
      }
    } catch (e) {
      this.toast.error(
        e instanceof Error ? e.message : 'Could not start linking flow.'
      );
    }
  }

  async unlink(p: AuthProvider): Promise<void> {
    try {
      if (this.backend.identitySource() === 'firebase') {
        const fb = this.toFirebase(p);
        if (!fb) return;
        await this.firebase.unlinkProvider(fb);
      } else {
        await this.auth.unlinkProvider(p);
      }
      this.tokens.removeToken(p);
      this.toast.success(`${PROVIDER_META[p].label} disconnected.`);
    } catch (e) {
      this.toast.error(e instanceof Error ? e.message : 'Could not unlink.');
    }
  }

  setPatInput(p: AuthProvider, v: string): void {
    this.patInputs.update((m) => ({ ...m, [p]: v }));
  }

  savePat(p: AuthProvider): void {
    const v = this.patInputs()[p]?.trim();
    if (!v) return;
    this.tokens.setPersistentToken(p, v);
    this.setPatInput(p, '');
    this.toast.success(`${PROVIDER_META[p].label} token saved.`);
    this.rescan();
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
    this.handoff.set(p.parsed, p.repo.fullName);
    this.router.navigateByUrl('/upgrade');
  }

  /**
   * Re-run the OAuth flow for a provider that's already linked but whose
   * `provider_token` is missing from the current session. This is the right
   * answer for "GitHub is connected but I see no projects" — Supabase doesn't
   * persist provider tokens across reloads, so we have to ask GitHub for a
   * fresh one without changing any account state.
   */
  async reAuth(p: AuthProvider): Promise<void> {
    try {
      if (this.backend.identitySource() === 'firebase') {
        const fb = this.toFirebase(p);
        if (!fb) {
          this.toast.error(
            `${PROVIDER_META[p].label} can't be re-authenticated through Firebase.`
          );
          return;
        }
        await this.firebase.linkProvider(fb);
        this.toast.success(`${PROVIDER_META[p].label} token refreshed.`);
      } else {
        await this.auth.signInWith(p);
      }
    } catch (e) {
      this.toast.error(
        e instanceof Error ? e.message : 'Re-authentication failed.'
      );
    }
  }

  async signOut(): Promise<void> {
    // Sign out of whichever backend the user came in through (or both,
    // defensively, in case state got mixed).
    if (this.backend.identitySource() === 'firebase') {
      await this.firebase.signOut();
    } else {
      await this.auth.signOut();
    }
    this.tokens.clearAll();
    this.scanner.clear();
    this.router.navigateByUrl('/sign-in');
  }
}
