import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { AppTitleStrategy } from './title.strategy';

/**
 * Build a minimal RouterStateSnapshot whose root walks down to a leaf with
 * the supplied `data`. Only what AppTitleStrategy actually reads is wired
 * up — `data`, `pathFromRoot`, `title` (the route config's title) and
 * `firstChild`. Everything else is undefined and never touched.
 */
function snapshot(leafData: Record<string, unknown>, leafTitle?: string): RouterStateSnapshot {
  const leaf: Partial<ActivatedRouteSnapshot> = {
    data: leafData,
    title: leafTitle,
    firstChild: null,
    pathFromRoot: []
  };
  // pathFromRoot must include the leaf itself for collectRouteData() to work.
  (leaf as { pathFromRoot: ActivatedRouteSnapshot[] }).pathFromRoot = [leaf as ActivatedRouteSnapshot];
  return {
    root: leaf as ActivatedRouteSnapshot,
    url: '/'
  } as RouterStateSnapshot;
}

describe('AppTitleStrategy', () => {
  let strategy: AppTitleStrategy;
  let title: Title;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [AppTitleStrategy, Title] });
    strategy = TestBed.inject(AppTitleStrategy);
    title = TestBed.inject(Title);
  });

  it('appends " | ng-package-compat" to a route seoTitle', () => {
    strategy.updateTitle(snapshot({ seoTitle: 'Compare packages' }));
    expect(title.getTitle()).toBe('Compare packages | ng-package-compat');
  });

  it('uses just the site name when no seoTitle / route title is present', () => {
    strategy.updateTitle(snapshot({}));
    expect(title.getTitle()).toBe('ng-package-compat');
  });

  it('falls back to the route config title when seoTitle is absent', () => {
    strategy.updateTitle(snapshot({}, 'Sign in'));
    expect(title.getTitle()).toBe('Sign in | ng-package-compat');
  });

  it('does not double-suffix when the seoTitle already mentions the site name', () => {
    strategy.updateTitle(snapshot({ seoTitle: 'About — ng-package-compat' }));
    expect(title.getTitle()).toBe('About — ng-package-compat');
    // Critical: assert no "ng-package-compat | ng-package-compat".
    expect(title.getTitle()).not.toContain('| ng-package-compat');
  });

  it('matches the site-name check case-insensitively', () => {
    strategy.updateTitle(snapshot({ seoTitle: 'NG-PACKAGE-COMPAT manual' }));
    expect(title.getTitle()).toBe('NG-PACKAGE-COMPAT manual');
  });

  it('seoTitle wins over the route config title (data is more specific)', () => {
    strategy.updateTitle(snapshot({ seoTitle: 'Override' }, 'Generic'));
    expect(title.getTitle()).toBe('Override | ng-package-compat');
  });
});
