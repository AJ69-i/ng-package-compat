import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  PLATFORM_ID,
  ViewChild,
  inject
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { ActivatedRoute, NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs/operators';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import { NavbarComponent } from './components/navbar/navbar.component';
import { CommandPaletteComponent } from './components/command-palette/command-palette.component';
import { InstallPromptComponent } from './components/install-prompt/install-prompt.component';
import { ToastHostComponent } from './components/toast-host/toast-host.component';
import { ShortcutsHelpComponent } from './components/shortcuts-help/shortcuts-help.component';
import { ThemeCustomizerComponent } from './components/theme-customizer/theme-customizer.component';
import { OnboardingTourComponent } from './components/onboarding-tour/onboarding-tour.component';
import { SeoService } from './services/seo.service';
import { LocaleService } from './i18n/locale.service';
import { PreferencesService } from './services/preferences.service';
import { OnboardingService } from './services/onboarding.service';
import { SupabaseSyncService } from './services/supabase-sync.service';
import { AnnouncerService } from './services/announcer.service';

@Component({
  selector: 'app-root',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterOutlet, RouterLink,
    NavbarComponent,
    CommandPaletteComponent,
    InstallPromptComponent,
    ToastHostComponent,
    ShortcutsHelpComponent,
    ThemeCustomizerComponent,
    OnboardingTourComponent,
    TranslocoModule
  ],
  template: `
    <a class="skip" href="#main">{{ 'app.skipToContent' | transloco }}</a>

    <app-navbar />

    <main #mainEl class="shell" id="main" tabindex="-1" role="main">
      <router-outlet />
    </main>

    <!--
      Overlay components below this line are decoupled from initial paint.
      They each ship as their own chunk and hydrate during browser-idle
      time, so a first-time visitor doesn't pay for ~1300 lines of
      modal/dialog code before they can read the page.
    -->
    @defer (on idle) {
      <app-command-palette />
    }

    @defer (on idle) {
      <app-install-prompt />
    }

    @defer (on idle) {
      <app-toast-host />
    }

    @defer (on idle) {
      <app-shortcuts-help />
    }

    @defer (on idle) {
      <app-theme-customizer data-tour="preferences" />
    }

    @defer (on idle) {
      <app-onboarding-tour />
    }

    <footer class="footer" role="contentinfo" [attr.aria-label]="'app.footer.label' | transloco">
      <nav class="links" aria-label="External resources">
        <a routerLink="/about">{{ 'app.footer.about' | transloco }}</a>
        <span aria-hidden="true">·</span>
        <a routerLink="/privacy">{{ 'app.footer.privacy' | transloco }}</a>
        <span aria-hidden="true">·</span>
        <!-- Footer "data sources" links. The two npm endpoints we
             use (registry.npmjs.org for packuments and api.npmjs.org
             for download counts) are JSON APIs that render as raw
             {…} blobs in a browser — useless to a human clicking
             through a credits list. Pointing the labels at the
             user-facing equivalents instead: the main npm site for
             "npm", and the public downloads stats page on npmjs.com
             for "downloads" (the human view of the same data the
             api.npmjs.org endpoint serves machine-readably). -->
        <a href="https://www.npmjs.com" target="_blank" rel="noopener noreferrer">npm</a>
        <span aria-hidden="true">·</span>
        <a href="https://npm-stat.com" target="_blank" rel="noopener noreferrer">downloads</a>
        <span aria-hidden="true">·</span>
        <a href="https://osv.dev" target="_blank" rel="noopener noreferrer">OSV.dev</a>
        <span aria-hidden="true">·</span>
        <a href="https://bundlephobia.com" target="_blank" rel="noopener noreferrer">Bundlephobia</a>
      </nav>
      <small class="built">
        {{ 'app.footer.built' | transloco }}
        {{ 'app.footer.palette' | transloco: { mod: 'Cmd/Ctrl', k: 'K' } }}
      </small>
      <small class="rights">{{ 'app.footer.rights' | transloco }}</small>
      <small class="independence">{{ 'app.footer.independence' | transloco }}</small>
    </footer>
  `,
  styles: [`
    .skip {
      position: absolute;
      top: -200px;
      inset-inline-start: 8px;
      background: var(--accent); color: #fff; padding: 0.5rem 0.75rem;
      border-radius: 0 0 8px 0; z-index: 200;
      transition: top 140ms var(--ease);
      font-weight: 600;
    }
    .skip:focus { top: 8px; outline: 2px solid #fff; outline-offset: 2px; }
    .shell {
      max-width: var(--content-max-width, min(94vw, 1320px)); margin: 0 auto;
      padding: clamp(1rem, 2.5vw, 2rem) clamp(0.75rem, 3vw, 1.5rem) 3rem;
    }
    /* When focused programmatically after route change, no visual outline —
       only screen-reader users care about the focus. Keyboard-driven Tab
       still gets the universal focus-visible ring from styles.scss. */
    .shell:focus { outline: none; }
    .footer {
      margin-top: 3rem; padding: 1.25rem;
      text-align: center;
      color: var(--fg-dim); border-top: 1px solid var(--border);
      display: flex; flex-direction: column; gap: 0.4rem; align-items: center;
    }
    .footer .links {
      display: flex; gap: 0.5rem; flex-wrap: wrap; justify-content: center;
      font-size: 0.85rem;
    }
    .footer a { color: var(--accent); text-decoration: none; }
    .footer a:hover, .footer a:focus-visible { text-decoration: underline; outline: none; }
    .footer kbd {
      background: var(--surface-1); border: 1px solid var(--border);
      border-radius: 4px; padding: 1px 5px; font-size: 0.72rem; color: var(--fg);
    }
    .footer .built { font-size: 0.82rem; }
    .footer .rights {
      font-weight: 600; color: var(--fg);
      font-size: 0.8rem; margin-top: 0.2rem;
    }
    .footer .independence {
      font-size: 0.72rem; color: var(--fg-dim);
      font-style: italic; max-width: 62ch; line-height: 1.45;
      padding: 0 0.75rem;
    }
  `]
})
export class AppComponent implements AfterViewInit {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly seo = inject(SeoService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly transloco = inject(TranslocoService);
  private readonly announcer = inject(AnnouncerService);
  // Eagerly construct so html[lang] and html[dir] are applied on boot.
  private readonly locale = inject(LocaleService);
  // Eager instantiation: the service's effect() applies accent / font-scale /
  // reduced-motion / high-contrast / color-blind-safe classes on boot.
  private readonly prefs = inject(PreferencesService);
  private readonly onboarding = inject(OnboardingService);
  // Boot the Supabase sync service so its auth-state effect runs as soon as
  // the app is alive. Pure side-effect construction; no methods to call.
  private readonly _sync = inject(SupabaseSyncService);

  @ViewChild('mainEl', { static: true }) private mainEl!: ElementRef<HTMLElement>;

  /** True once Angular has finished the very first route render. */
  private isFirstNavigation = true;

  constructor() {
    // First-run tour (no-op for returning users).
    this.onboarding.maybeAutoStart();

    // Site-wide structured data — these don't change between routes.
    // Page-scoped blocks (BreadcrumbList) are rebuilt by SeoService.set().
    this.seo.setStructuredData('app', this.seo.webApplication());
    this.seo.setStructuredData('website', this.seo.website());
    this.seo.setStructuredData('organization', this.seo.organization());

    // Update per-route SEO + manage focus on every NavigationEnd.
    this.router.events
      .pipe(
        filter((e): e is NavigationEnd => e instanceof NavigationEnd),
        map(() => ({
          data: this.collectRouteData(),
          urlPath: this.router.url.split('?')[0],
          fullUrl: this.router.url
        })),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe(({ data, urlPath }) => {
        const label = (data['label'] as string | undefined) ?? '';
        const seoTitle = (data['seoTitle'] as string | undefined) ?? label;

        this.seo.set({
          title: seoTitle,
          description: data['seoDescription'] as string | undefined,
          keywords: data['seoKeywords'] as string[] | undefined,
          canonical: urlPath,
          noindex: !!data['seoNoIndex'],
          breadcrumbs: this.buildBreadcrumbs(label, urlPath)
        });

        // Skip focus + announce on the very first navigation — the page just
        // loaded, focus is at the top of the document, and announcing here
        // would conflict with the user's own screen-reader load message.
        if (this.isFirstNavigation) {
          this.isFirstNavigation = false;
          return;
        }

        this.handleRouteChange(label || seoTitle);
      });
  }

  ngAfterViewInit(): void {
    // Nothing to do — the @ViewChild grabs the <main> on first render and
    // we focus it on subsequent navigations only.
  }

  /**
   * After every non-initial navigation: announce the new page name to
   * screen readers and move keyboard focus to the <main> element so Tab
   * starts from the page content (not the navbar). Doesn't show a visible
   * focus ring; that only appears for keyboard-driven focus.
   */
  private handleRouteChange(label: string): void {
    if (!isPlatformBrowser(this.platformId)) return;

    // Announce route change in the user's active language.
    const announceTpl = this.transloco.translate('app.announce.routeChanged', { name: label });
    const fallback = label ? `Navigated to ${label}` : 'Page changed';
    this.announcer.say(announceTpl && announceTpl !== 'app.announce.routeChanged' ? announceTpl : fallback);

    // Defer focus to the next microtask so the new view's children have
    // mounted and any auto-focus on the new page wins over ours.
    queueMicrotask(() => {
      try {
        this.mainEl?.nativeElement?.focus({ preventScroll: false });
      } catch {
        /* ignore — non-focusable hosts (jsdom under tests) */
      }
    });
  }

  private collectRouteData(): Record<string, unknown> {
    let r = this.route.snapshot;
    while (r.firstChild) r = r.firstChild;
    const merged: Record<string, unknown> = {};
    for (const part of r.pathFromRoot) Object.assign(merged, part.data ?? {});
    return merged;
  }

  /**
   * Compose a Home → Page trail from the current URL. Deep routes
   * (`/dependencies/foo/1.2.3`) get an extra segment for context. The
   * BreadcrumbList JSON-LD this becomes is what enables breadcrumb
   * rendering in Google search results.
   */
  private buildBreadcrumbs(
    label: string,
    path: string
  ): ReadonlyArray<{ name: string; path?: string }> {
    if (!path || path === '/') {
      return [{ name: 'Home', path: '/' }];
    }
    const segments = path.split('/').filter(Boolean);
    const trail: { name: string; path?: string }[] = [{ name: 'Home', path: '/' }];
    if (segments.length > 0 && label) {
      trail.push({ name: label, path: `/${segments[0]}` });
    }
    if (segments.length > 1) {
      trail.push({ name: decodeURIComponent(segments.slice(1).join(' / ')) });
    }
    return trail;
  }
}
