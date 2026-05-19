import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { TranslocoModule } from '@jsverse/transloco';
import { ThemeService } from '../../services/theme.service';
import { PackageManagerService } from '../../services/package-manager.service';
import { PackageManager } from '../../models/npm-package.model';
import { LocaleService } from '../../i18n/locale.service';
import { ShortcutsService } from '../../services/shortcuts.service';
import { SupabaseService } from '../../services/supabase.service';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';
import { ProviderTokenStore } from '../../services/provider-token-store.service';
import { ProjectScannerService } from '../../services/project-scanner.service';
import { SupabaseSyncService } from '../../services/supabase-sync.service';

@Component({
  selector: 'app-navbar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, RouterLink, RouterLinkActive, TranslocoModule],
  template: `
    <nav class="navbar" aria-label="Primary">
      <a routerLink="/" class="brand" aria-label="Home">
        <span class="accent">ng</span>-package-compat
      </a>

      <button
        type="button"
        class="hamburger"
        (click)="mobileOpen.update(v => !v)"
        [attr.aria-expanded]="mobileOpen()"
        aria-controls="primary-nav"
        [attr.aria-label]="'nav.toggle' | transloco"
      >
        <span></span><span></span><span></span>
      </button>

      <ul id="primary-nav" class="links" role="list" [class.open]="mobileOpen()">
        <li>
          <a routerLink="/" routerLinkActive="active"
             #rlaSearch="routerLinkActive"
             [routerLinkActiveOptions]="{exact: true}"
             [attr.aria-current]="rlaSearch.isActive ? 'page' : null"
             (click)="mobileOpen.set(false)">{{ 'nav.search' | transloco }}</a>
        </li>
        <li>
          <a routerLink="/compare" routerLinkActive="active"
             #rlaCompare="routerLinkActive"
             [attr.aria-current]="rlaCompare.isActive ? 'page' : null"
             (click)="mobileOpen.set(false)">{{ 'nav.compare' | transloco }}</a>
        </li>
        <li>
          <a routerLink="/upgrade" routerLinkActive="active"
             #rlaUpgrade="routerLinkActive"
             [attr.aria-current]="rlaUpgrade.isActive ? 'page' : null"
             (click)="mobileOpen.set(false)">{{ 'nav.upgrade' | transloco }}</a>
        </li>
        <li>
          <a routerLink="/history" routerLinkActive="active"
             #rlaHistory="routerLinkActive"
             [attr.aria-current]="rlaHistory.isActive ? 'page' : null"
             (click)="mobileOpen.set(false)">{{ 'nav.history' | transloco }}</a>
        </li>
        <li>
          <a routerLink="/about" routerLinkActive="active"
             #rlaAbout="routerLinkActive"
             [attr.aria-current]="rlaAbout.isActive ? 'page' : null"
             (click)="mobileOpen.set(false)">{{ 'nav.about' | transloco }}</a>
        </li>
      </ul>

      <div class="spacer"></div>

      <label class="lang" [title]="'nav.language' | transloco">
        <span class="sr-only">{{ 'nav.language' | transloco }}</span>
        <select
          [value]="locale.active()"
          (change)="onLangChange($event)"
          [attr.aria-label]="'nav.language' | transloco"
        >
          @for (l of locale.supported; track l.code) {
            <option [value]="l.code">{{ l.label }}</option>
          }
        </select>
      </label>

      <label class="pm" [title]="'nav.packageManager' | transloco">
        <span class="sr-only">{{ 'nav.packageManager' | transloco }}</span>
        <select [value]="pmSvc.pm()" (change)="onPmChange($event)" [attr.aria-label]="'nav.packageManager' | transloco">
          <option value="npm">npm</option>
          <option value="yarn">yarn</option>
          <option value="pnpm">pnpm</option>
          <option value="bun">bun</option>
        </select>
      </label>

      <button
        type="button"
        class="shortcuts-chip"
        data-tour="shortcuts"
        (click)="shortcuts.openHelp()"
        [attr.aria-label]="'shortcuts.title' | transloco"
        [title]="'shortcuts.title' | transloco"
      >?</button>

      @if (isSignedIn()) {
        <a
          routerLink="/projects"
          class="auth-chip"
          [title]="signedInTitle()"
          [attr.aria-label]="signedInTitle()"
        >
          <span class="avatar" aria-hidden="true">{{ initial() }}</span>
          <span class="auth-label">{{ 'nav.projects' | transloco }}</span>
        </a>
        <button
          type="button"
          class="signout-chip"
          (click)="onSignOut()"
          [attr.aria-label]="'auth.signOut' | transloco"
          [title]="'auth.signOut' | transloco"
        >⏻</button>
      } @else {
        <a
          routerLink="/sign-in"
          class="auth-chip primary"
          [attr.aria-label]="'nav.signIn' | transloco"
          [title]="'nav.signIn' | transloco"
        >
          <span class="auth-label">{{ 'nav.signIn' | transloco }}</span>
        </a>
      }

      <button
        type="button"
        class="theme-toggle"
        (click)="theme.toggle()"
        [attr.aria-label]="theme.effective() === 'dark' ? ('nav.lightMode' | transloco) : ('nav.darkMode' | transloco)"
        [title]="theme.effective() === 'dark' ? ('nav.lightMode' | transloco) : ('nav.darkMode' | transloco)"
      >
        {{ theme.effective() === 'dark' ? '☀' : '☾' }}
      </button>
    </nav>
  `,
  styles: [`
    :host { display: block; }
    .navbar {
      display: flex; align-items: center; gap: 0.75rem;
      padding: 0.75rem 1.25rem;
      background: color-mix(in srgb, var(--surface-1) 92%, transparent);
      border-bottom: 1px solid var(--border);
      position: sticky; top: 0; z-index: 50;
      backdrop-filter: blur(10px);
      animation: navbar-slide-in 250ms ease-out both;
    }
    @keyframes navbar-slide-in {
      from { transform: translateY(-8px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
    .brand {
      font-weight: 700; font-size: 1.05rem; text-decoration: none;
      color: var(--fg);
      transition: transform 180ms ease;
    }
    .brand:hover { transform: translateY(-1px); }
    .brand .accent {
      background: linear-gradient(135deg, #6366f1, #ec4899);
      -webkit-background-clip: text; background-clip: text; color: transparent;
    }
    .spacer { flex: 1 1 auto; }
    .links {
      display: flex; gap: 0.15rem; list-style: none; padding: 0; margin: 0 0 0 0.5rem;
    }
    .links a {
      display: inline-block;
      padding: 0.5rem 0.85rem; border-radius: 10px; text-decoration: none;
      color: var(--fg-dim); font-size: 0.9rem;
      transition: background 180ms ease, color 180ms ease, transform 180ms ease;
      min-height: 36px; line-height: 1.2;
    }
    .links a:hover, .links a:focus-visible { background: var(--surface-2); color: var(--fg); outline: none; transform: translateY(-1px); }
    .links a.active { background: var(--accent-bg); color: var(--accent); }
    .theme-toggle, .pm select, .lang select, .shortcuts-chip {
      background: var(--surface-2); border: 1px solid var(--border);
      color: var(--fg); border-radius: 10px; padding: 0.4rem 0.7rem;
      font-size: 0.9rem; cursor: pointer; min-height: 36px;
      transition: border-color 180ms ease, background 180ms ease, transform 180ms ease;
    }
    .theme-toggle:hover, .pm select:hover, .lang select:hover, .shortcuts-chip:hover { border-color: var(--accent); transform: translateY(-1px); }
    .shortcuts-chip {
      min-width: 36px; font-weight: 700; font-size: 1rem;
      display: inline-flex; align-items: center; justify-content: center;
      color: var(--fg-dim);
    }
    .shortcuts-chip:hover { color: var(--accent); }

    .auth-chip {
      display: inline-flex; align-items: center; gap: 0.4rem;
      padding: 0.4rem 0.8rem; border-radius: 10px;
      background: var(--surface-2); border: 1px solid var(--border);
      color: var(--fg); text-decoration: none; font-size: 0.88rem;
      min-height: 36px; line-height: 1.2;
      transition: border-color 180ms ease, background 180ms ease, transform 180ms ease;
    }
    .auth-chip:hover, .auth-chip:focus-visible {
      border-color: var(--accent); transform: translateY(-1px); outline: none;
    }
    .auth-chip.primary {
      background: var(--accent-gradient, var(--accent, #2563eb));
      color: #fff; border-color: transparent;
      font-weight: 600;
      box-shadow: var(--shadow-1);
    }
    .auth-chip.primary:hover {
      filter: brightness(1.06);
      box-shadow: var(--shadow-glow);
    }
    .auth-chip .avatar {
      display: inline-flex; align-items: center; justify-content: center;
      width: 22px; height: 22px; border-radius: 999px;
      background: linear-gradient(135deg, #6366f1, #ec4899);
      color: #fff; font-size: 0.7rem; font-weight: 700;
    }
    .signout-chip {
      background: var(--surface-2); border: 1px solid var(--border);
      color: var(--fg-dim); border-radius: 10px;
      padding: 0; min-width: 36px; min-height: 36px;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 1rem; cursor: pointer;
      transition: border-color 180ms ease, color 180ms ease, transform 180ms ease;
    }
    .signout-chip:hover { color: #b91c1c; border-color: #b91c1c; transform: translateY(-1px); }

    .pm, .lang { display: flex; align-items: center; gap: 0.25rem; }
    .sr-only {
      position: absolute; width: 1px; height: 1px; padding: 0;
      margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0;
    }
    .hamburger {
      display: none; background: transparent; border: none;
      padding: 0.4rem; cursor: pointer; gap: 4px;
      flex-direction: column; align-items: center; justify-content: center;
      width: 40px; height: 40px;
    }
    .hamburger span {
      display: block; width: 22px; height: 2px; background: var(--fg);
      transition: transform 200ms ease, opacity 200ms ease;
    }

    /* RTL adjustments */
    :host-context(html[dir='rtl']) .links { margin: 0 0.5rem 0 0; }

    @media (max-width: 780px) {
      .navbar { flex-wrap: wrap; row-gap: 0.5rem; }
      .hamburger { display: inline-flex; margin-left: auto; order: 2; }
      .auth-chip .auth-label { display: none; }
      .auth-chip { padding: 0.4rem 0.6rem; }
      .links {
        display: none; flex-direction: column; width: 100%;
        order: 99; background: var(--surface-1); border-top: 1px solid var(--border);
        padding: 0.5rem 0; margin: 0.5rem -1.25rem -0.75rem;
      }
      .links.open { display: flex; animation: links-drop 200ms ease both; }
      @keyframes links-drop {
        from { transform: translateY(-6px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
      .links a {
        padding: 0.75rem 1.25rem; border-radius: 0; font-size: 1rem;
      }
      .spacer { display: none; }
      .pm, .lang, .theme-toggle { order: 1; }
    }
  `]
})
export class NavbarComponent {
  readonly theme = inject(ThemeService);
  readonly pmSvc = inject(PackageManagerService);
  readonly locale = inject(LocaleService);
  readonly shortcuts = inject(ShortcutsService);
  private readonly supabase = inject(SupabaseService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly tokens = inject(ProviderTokenStore);
  private readonly scanner = inject(ProjectScannerService);
  private readonly sync = inject(SupabaseSyncService);
  private readonly router = inject(Router);
  readonly mobileOpen = signal(false);

  /** Bound directly so the template can `@if` on it. */
  readonly isSignedIn = this.supabase.isSignedIn;

  /** Single-letter avatar (first char of name/email, or `?`). */
  readonly initial = computed<string>(() => {
    const u = this.supabase.user();
    if (!u) return '?';
    const name =
      ((u.user_metadata as Record<string, unknown>)?.['full_name'] as string | undefined) ??
      ((u.user_metadata as Record<string, unknown>)?.['name'] as string | undefined) ??
      u.email ??
      '';
    const ch = name.trim().charAt(0).toUpperCase();
    return ch || '?';
  });

  /** Title text for the signed-in chip — shows the email if known. */
  readonly signedInTitle = computed<string>(() => {
    const u = this.supabase.user();
    return u?.email ? `Signed in as ${u.email}` : 'Signed in';
  });

  onPmChange(e: Event): void {
    const value = (e.target as HTMLSelectElement).value as PackageManager;
    this.pmSvc.set(value);
  }

  onLangChange(e: Event): void {
    const code = (e.target as HTMLSelectElement).value;
    this.locale.set(code);
  }

  async onSignOut(): Promise<void> {
    // Order matters here. The projects-page (and other auth-aware pages)
    // each register a signal effect that auto-redirects to /sign-in the
    // moment they see no tokens / no session. If we revoke the session
    // *first*, that effect fires while the projects component is still
    // mounted and bounces the user to /sign-in — defeating our own
    // navigateByUrl('/') call.
    //
    // The fix: navigate to home FIRST so the projects component is torn
    // down (and its effect with it). Then we can safely revoke the session
    // and wipe local state with no risk of a redirect race.
    try {
      await this.router.navigateByUrl('/');
      await this.auth.signOut();
      this.tokens.clearAll();
      this.scanner.clear();
      // Wipe the synced-data view from this device. The cloud copy stays
      // intact in Supabase — signing back in restores everything. Anonymous
      // users (who never signed in) never call this path, so their local
      // data is unaffected.
      await this.sync.wipeLocalWorkspace();
      this.toast.success('Signed out.');
    } catch (e) {
      this.toast.error((e as Error)?.message ?? 'Sign-out failed.');
    }
  }
}
