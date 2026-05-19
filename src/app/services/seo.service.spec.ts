import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { SeoService } from './seo.service';
import { LocaleService } from '../i18n/locale.service';

/**
 * SeoService depends on LocaleService for the active language → og:locale
 * mapping. We stub it here with a fixed `en` so the test suite doesn't
 * have to bootstrap Transloco for what amounts to a meta-tag check.
 */
class LocaleServiceStub {
  readonly active = signal('en').asReadonly();
  readonly dir = signal<'ltr' | 'rtl'>('ltr').asReadonly();
}

describe('SeoService', () => {
  let svc: SeoService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        SeoService,
        { provide: LocaleService, useClass: LocaleServiceStub }
      ]
    });
    svc = TestBed.inject(SeoService);
  });

  it('sets the page title with the site suffix', () => {
    svc.set({ title: 'Upgrade assistant' });
    expect(document.title).toContain('Upgrade assistant');
    expect(document.title).toContain('ng-package-compat');
  });

  it('upserts a description meta tag', () => {
    svc.set({ description: 'My page description.' });
    const tag = document.head.querySelector('meta[name="description"]')!;
    expect(tag.getAttribute('content')).toBe('My page description.');
  });

  it('adds and removes JSON-LD blocks', () => {
    svc.setStructuredData('test', { '@context': 'https://schema.org', '@type': 'Thing' });
    const before = document.getElementById('ld-test');
    expect(before).toBeTruthy();

    svc.clearStructuredData('test');
    const after = document.getElementById('ld-test');
    expect(after).toBeNull();
  });

  it('honors noindex', () => {
    svc.set({ noindex: true });
    const robots = document.head.querySelector('meta[name="robots"]')!;
    expect(robots.getAttribute('content')).toContain('noindex');
  });

  it('emits a BreadcrumbList block when breadcrumbs are provided', () => {
    svc.set({
      title: 'Diff',
      breadcrumbs: [
        { name: 'Home', path: '/' },
        { name: 'Diff', path: '/diff/foo' }
      ]
    });
    const node = document.getElementById('ld-breadcrumbs');
    expect(node).toBeTruthy();
    const data = JSON.parse(node!.textContent ?? '{}');
    expect(data['@type']).toBe('BreadcrumbList');
    expect(data['itemListElement']?.length).toBe(2);
  });

  it('clears the BreadcrumbList block when breadcrumbs are omitted', () => {
    svc.set({
      title: 'A',
      breadcrumbs: [{ name: 'Home', path: '/' }]
    });
    expect(document.getElementById('ld-breadcrumbs')).toBeTruthy();

    svc.set({ title: 'B' });
    expect(document.getElementById('ld-breadcrumbs')).toBeNull();
  });

  it('emits hreflang alternates for every supported locale plus x-default', () => {
    svc.set({ title: 'Search', canonical: '/' });
    const links = document.head.querySelectorAll('link[rel="alternate"][data-seo="lang"]');
    const hreflangs = Array.from(links).map((n) => n.getAttribute('hreflang'));
    expect(hreflangs).toContain('en');
    expect(hreflangs).toContain('ar');
    expect(hreflangs).toContain('fr');
    expect(hreflangs).toContain('es');
    expect(hreflangs).toContain('x-default');
  });
});
