import { DOCUMENT, Injectable, PLATFORM_ID, inject } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { isPlatformBrowser } from '@angular/common';
import { LocaleService } from '../i18n/locale.service';

export interface SeoConfig {
  /** Page-specific title — gets templated with the site name. */
  title?: string;
  /** Long-form description. Drops in to `<meta name="description">`, OG, Twitter. */
  description?: string;
  /** Comma-joined into `<meta name="keywords">`. Empty array clears it. */
  keywords?: string[];
  /**
   * Path or absolute URL. Default: current location pathname (so it's safe
   * to call this on every navigation).
   */
  canonical?: string;
  /** Path or absolute URL. Default: site OG card. */
  image?: string;
  /** Alt text for the OG / Twitter image. */
  imageAlt?: string;
  /** Open Graph type. Default: 'website'. */
  type?: 'website' | 'article' | 'profile';
  /** Override `<meta name="robots">`. Default: 'index,follow' (or 'noindex,nofollow' if noindex). */
  robots?: string;
  /** Convenience: short-circuits to robots='noindex,nofollow'. */
  noindex?: boolean;
  /**
   * Optional breadcrumb trail for the page (top → leaf). When provided we
   * also emit a BreadcrumbList JSON-LD block so search engines can render
   * the trail in SERPs.
   */
  breadcrumbs?: ReadonlyArray<{ name: string; path?: string }>;
}

const SITE_NAME = 'ng-package-compat';
const SITE_ORIGIN = 'https://ng-package-compat.app';
const DEFAULT_IMAGE = '/assets/og-card.png';
const DEFAULT_IMAGE_ALT = 'ng-package-compat — Angular compatibility checker';
const DEFAULT_DESCRIPTION =
  'Free open-source tool to check npm packages against any Angular version. ' +
  'Find compatible releases, analyze peer dependencies, and generate a one-command ' +
  '`ng update` for your whole project.';
const DEFAULT_KEYWORDS = [
  'angular', 'npm', 'package compatibility', 'ng update',
  'angular upgrade', 'peer dependency', 'semver', 'typescript'
];

/** Map our short locale codes to full BCP-47 / OG locale strings. */
const OG_LOCALE: Record<string, string> = {
  en: 'en_US',
  ar: 'ar_AR',
  fr: 'fr_FR',
  es: 'es_ES'
};

/**
 * Centralized SEO + structured-data manager.
 *
 * Apply per-route metadata via `set()` on every NavigationEnd. Site-wide
 * structured data (Organization, WebSite) lives in dedicated JSON-LD
 * blocks added once at boot via `setStructuredData()`. Page-specific
 * structured data (BreadcrumbList) is regenerated on each `set()` call
 * — older blocks for the same id are replaced in place.
 *
 * SSR-safe: tags are written via Angular's `Meta` / `Title` services and
 * we only touch `<link rel="canonical">` via the injected `DOCUMENT`,
 * which works under both server and browser platforms.
 */
@Injectable({ providedIn: 'root' })
export class SeoService {
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly doc = inject(DOCUMENT);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly locale = inject(LocaleService);

  /**
   * Apply the provided SEO config. Any field you omit falls back to the site
   * default, so it's safe to call this on every route navigation. Always
   * pair with a canonical so we never leak `?utm_*` params into search.
   */
  set(config: SeoConfig): void {
    const fullTitle = config.title ? `${config.title} | ${SITE_NAME}` : SITE_NAME;
    const description = config.description ?? DEFAULT_DESCRIPTION;
    const keywordsList = config.keywords ?? DEFAULT_KEYWORDS;
    const keywords = keywordsList.join(', ');
    const canonical = this.resolveUrl(config.canonical);
    const image = this.resolveUrl(config.image ?? DEFAULT_IMAGE);
    const imageAlt = config.imageAlt ?? DEFAULT_IMAGE_ALT;
    const type = config.type ?? 'website';
    const robots = config.noindex
      ? 'noindex,nofollow,max-snippet:-1,max-image-preview:large,max-video-preview:-1'
      : (config.robots ?? 'index,follow,max-snippet:-1,max-image-preview:large,max-video-preview:-1');
    const ogLocale = OG_LOCALE[this.locale.active()] ?? 'en_US';

    this.title.setTitle(fullTitle);

    this.upsert('name', 'description', description);
    if (keywords) this.upsert('name', 'keywords', keywords);
    else this.meta.removeTag('name="keywords"');
    this.upsert('name', 'robots', robots);
    this.upsert('name', 'googlebot', robots);
    this.upsert('name', 'author', SITE_NAME);

    // Open Graph
    this.upsert('property', 'og:site_name', SITE_NAME);
    this.upsert('property', 'og:title', fullTitle);
    this.upsert('property', 'og:description', description);
    this.upsert('property', 'og:type', type);
    this.upsert('property', 'og:url', canonical);
    this.upsert('property', 'og:image', image);
    this.upsert('property', 'og:image:alt', imageAlt);
    this.upsert('property', 'og:image:width', '1200');
    this.upsert('property', 'og:image:height', '630');
    this.upsert('property', 'og:locale', ogLocale);

    // Alternate locales (so OG scrapers know there are other languages)
    this.replaceAlternateLocales(ogLocale);

    // Twitter cards
    this.upsert('name', 'twitter:card', 'summary_large_image');
    this.upsert('name', 'twitter:title', fullTitle);
    this.upsert('name', 'twitter:description', description);
    this.upsert('name', 'twitter:image', image);
    this.upsert('name', 'twitter:image:alt', imageAlt);

    this.setCanonical(canonical);
    this.setLanguageAlternates(canonical);

    // Page-scoped structured data: regenerate breadcrumbs every navigation.
    if (config.breadcrumbs && config.breadcrumbs.length > 0) {
      this.setStructuredData('breadcrumbs', this.breadcrumbList(config.breadcrumbs));
    } else {
      this.clearStructuredData('breadcrumbs');
    }
  }

  /** Add / replace a JSON-LD block under `<head>`. */
  setStructuredData(id: string, data: unknown): void {
    if (!this.doc?.head) return;
    const scriptId = `ld-${id}`;
    let el = this.doc.getElementById(scriptId) as HTMLScriptElement | null;
    if (!el) {
      el = this.doc.createElement('script') as HTMLScriptElement;
      el.id = scriptId;
      el.type = 'application/ld+json';
      this.doc.head.appendChild(el);
    }
    el.textContent = JSON.stringify(data);
  }

  /** Remove a JSON-LD block set earlier. */
  clearStructuredData(id: string): void {
    const el = this.doc?.getElementById(`ld-${id}`);
    if (el?.parentNode) el.parentNode.removeChild(el);
  }

  /** Site-wide WebApplication block — call once on bootstrap. */
  webApplication(): Record<string, unknown> {
    return {
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      '@id': `${SITE_ORIGIN}/#app`,
      name: SITE_NAME,
      url: SITE_ORIGIN,
      description: DEFAULT_DESCRIPTION,
      applicationCategory: 'DeveloperApplication',
      applicationSubCategory: 'Angular tooling',
      operatingSystem: 'Any',
      browserRequirements: 'Requires JavaScript',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      featureList: [
        'Package search with Angular peer-dep detection',
        'Side-by-side package comparison',
        'Version diff',
        'Bundle size analysis',
        'Security advisories',
        'Upgrade assistant with one-command `ng update`',
        'Guided upgrade wizard',
        'Workspace / monorepo analysis',
        'Codemod registry + preview',
        'Continuous monitoring + digests'
      ],
      potentialAction: {
        '@type': 'SearchAction',
        target: `${SITE_ORIGIN}/?q={search_term_string}`,
        'query-input': 'required name=search_term_string'
      }
    };
  }

  /** WebSite block enabling sitelinks search box. */
  website(): Record<string, unknown> {
    return {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      '@id': `${SITE_ORIGIN}/#website`,
      url: SITE_ORIGIN,
      name: SITE_NAME,
      description: DEFAULT_DESCRIPTION,
      inLanguage: ['en', 'ar', 'fr', 'es'],
      potentialAction: {
        '@type': 'SearchAction',
        target: { '@type': 'EntryPoint', urlTemplate: `${SITE_ORIGIN}/?q={search_term_string}` },
        'query-input': 'required name=search_term_string'
      }
    };
  }

  /** Organization block (publisher metadata for rich results). */
  organization(): Record<string, unknown> {
    return {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      '@id': `${SITE_ORIGIN}/#organization`,
      name: SITE_NAME,
      url: SITE_ORIGIN,
      logo: { '@type': 'ImageObject', url: `${SITE_ORIGIN}/assets/icons/icon-512.png`, width: 512, height: 512 },
      sameAs: ['https://github.com/ng-package-compat']
    };
  }

  /** Build a BreadcrumbList block from a top→leaf trail. */
  breadcrumbList(trail: ReadonlyArray<{ name: string; path?: string }>): Record<string, unknown> {
    return {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: trail.map((b, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: b.name,
        ...(b.path ? { item: this.resolveUrl(b.path) } : {})
      }))
    };
  }

  private upsert(attr: 'name' | 'property', key: string, content: string): void {
    const selector = `${attr}="${key}"`;
    if (this.meta.getTag(selector)) {
      this.meta.updateTag({ [attr]: key, content } as Record<string, string>, selector);
    } else {
      this.meta.addTag({ [attr]: key, content } as Record<string, string>);
    }
  }

  /** Replace any existing og:locale:alternate tags so they reflect the active locale. */
  private replaceAlternateLocales(activeOgLocale: string): void {
    const existing = this.meta.getTags('property="og:locale:alternate"');
    for (const tag of existing) this.meta.removeTagElement(tag);
    for (const code of Object.keys(OG_LOCALE)) {
      const og = OG_LOCALE[code];
      if (og && og !== activeOgLocale) {
        this.meta.addTag({ property: 'og:locale:alternate', content: og });
      }
    }
  }

  /**
   * Emit `<link rel="alternate" hreflang="…">` for every supported locale
   * plus an `x-default` pointing at the canonical URL. Helps search engines
   * route users to the right language.
   */
  private setLanguageAlternates(canonical: string): void {
    if (!this.doc?.head) return;
    // Remove any existing alternates we previously emitted.
    const existing = this.doc.head.querySelectorAll('link[rel="alternate"][data-seo="lang"]');
    existing.forEach((node) => node.parentNode?.removeChild(node));

    // Strip any existing query string; we always want the bare canonical.
    const path = canonical.replace(SITE_ORIGIN, '') || '/';

    for (const code of Object.keys(OG_LOCALE)) {
      const link = this.doc.createElement('link');
      link.setAttribute('rel', 'alternate');
      link.setAttribute('hreflang', code);
      link.setAttribute('href', `${SITE_ORIGIN}${path}?lang=${code}`);
      link.setAttribute('data-seo', 'lang');
      this.doc.head.appendChild(link);
    }
    const xDefault = this.doc.createElement('link');
    xDefault.setAttribute('rel', 'alternate');
    xDefault.setAttribute('hreflang', 'x-default');
    xDefault.setAttribute('href', `${SITE_ORIGIN}${path}`);
    xDefault.setAttribute('data-seo', 'lang');
    this.doc.head.appendChild(xDefault);
  }

  private setCanonical(url: string): void {
    if (!this.doc?.head) return;
    let link = this.doc.head.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
    if (!link) {
      link = this.doc.createElement('link');
      link.setAttribute('rel', 'canonical');
      this.doc.head.appendChild(link);
    }
    link.setAttribute('href', url);
  }

  private resolveUrl(pathOrUrl: string | undefined): string {
    if (!pathOrUrl) return this.currentUrl();
    if (/^https?:/i.test(pathOrUrl)) return pathOrUrl;
    const path = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
    return `${SITE_ORIGIN}${path}`;
  }

  private currentUrl(): string {
    if (this.isBrowser && typeof location !== 'undefined') {
      return `${SITE_ORIGIN}${location.pathname}`;
    }
    return SITE_ORIGIN;
  }
}
