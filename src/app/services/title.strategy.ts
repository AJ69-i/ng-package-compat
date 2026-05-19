import { Injectable, inject } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';

const SITE_NAME = 'ng-package-compat';
const SUFFIX_SEPARATOR = ' | ';

/**
 * Single source of truth for the document title.
 *
 * Resolution order, deepest route data wins:
 *   1. `data.seoTitle`           — preferred, kept short for crawlers
 *   2. `routeConfig.title`       — fallback for routes that didn't set seoTitle
 *   3. site name on its own      — for the root with no metadata
 *
 * Always appends ` | ng-package-compat` unless the route title already ends
 * with the site name (avoids `ng-package-compat | ng-package-compat`).
 *
 * SeoService also calls `setTitle()` later in the same tick when it processes
 * NavigationEnd. That's intentional: SeoService is the canonical writer for
 * SSR/crawler-visible markup; this strategy is what runs *first*, ensuring
 * the browser tab and pre-paint title are correct.
 */
@Injectable({ providedIn: 'root' })
export class AppTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);

  override updateTitle(snapshot: RouterStateSnapshot): void {
    const data = this.collectRouteData(snapshot);
    const seoTitle = (data['seoTitle'] as string | undefined) ?? this.buildDefaultTitle(snapshot);

    if (!seoTitle) {
      this.title.setTitle(SITE_NAME);
      return;
    }

    const lower = seoTitle.toLowerCase();
    const alreadySuffixed = lower.includes(SITE_NAME.toLowerCase());
    this.title.setTitle(alreadySuffixed ? seoTitle : `${seoTitle}${SUFFIX_SEPARATOR}${SITE_NAME}`);
  }

  /**
   * Walk the activated route tree and merge `data` from root → leaf so deep
   * routes override their parents. Mirrors what the SeoService does.
   */
  private collectRouteData(snapshot: RouterStateSnapshot): Record<string, unknown> {
    let r = snapshot.root;
    while (r.firstChild) r = r.firstChild;
    const merged: Record<string, unknown> = {};
    for (const part of r.pathFromRoot) Object.assign(merged, part.data ?? {});
    return merged;
  }

  /** Last resort: use the built-in `getResolvedTitleForRoute()` on the leaf. */
  private buildDefaultTitle(snapshot: RouterStateSnapshot): string | undefined {
    let r = snapshot.root;
    while (r.firstChild) r = r.firstChild;
    return this.getResolvedTitleForRoute(r);
  }
}
