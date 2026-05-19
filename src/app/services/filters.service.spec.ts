import { TestBed } from '@angular/core/testing';
import { FiltersService } from './filters.service';
import { CompatibilityService } from './compatibility.service';
import { VersionCompatibility } from '../models/npm-package.model';

/** Build a `VersionCompatibility` with sane defaults — only set what each test cares about. */
function row(o: Partial<VersionCompatibility> & { version: string }): VersionCompatibility {
  return {
    version: o.version,
    publishedAt: o.publishedAt ?? null,
    isLatest: o.isLatest ?? false,
    isDeprecated: o.isDeprecated ?? false,
    angularPeerRange: o.angularPeerRange ?? null,
    supportedAngularMajors: o.supportedAngularMajors ?? [],
    supportsAny: o.supportsAny ?? false,
    detectionSource: o.detectionSource ?? 'peer',
    isPrerelease: o.isPrerelease ?? false,
    hasTypes: o.hasTypes ?? false,
    license: o.license ?? null,
    unpackedSize: o.unpackedSize ?? null,
    peerDependencies: o.peerDependencies ?? {},
    dependencies: o.dependencies ?? {},
    nodeEngine: o.nodeEngine ?? null
  };
}

describe('FiltersService', () => {
  let svc: FiltersService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [FiltersService, CompatibilityService] });
    svc = TestBed.inject(FiltersService);
    svc.reset();
  });

  it('passes everything through when no filters are active', () => {
    const rows = [row({ version: '1.0.0' }), row({ version: '2.0.0' })];
    expect(svc.apply(rows).length).toBe(2);
    expect(svc.hasActiveFilters()).toBeFalse();
  });

  it('hides deprecated rows when hideDeprecated is on', () => {
    const rows = [
      row({ version: '1.0.0', isDeprecated: true }),
      row({ version: '2.0.0' })
    ];
    svc.patch({ hideDeprecated: true });
    expect(svc.apply(rows).map((r) => r.version)).toEqual(['2.0.0']);
    expect(svc.hasActiveFilters()).toBeTrue();
  });

  it('hides prerelease rows when hidePrerelease is on', () => {
    const rows = [
      row({ version: '2.0.0-rc.1', isPrerelease: true }),
      row({ version: '1.0.0' })
    ];
    svc.patch({ hidePrerelease: true });
    expect(svc.apply(rows).map((r) => r.version)).toEqual(['1.0.0']);
  });

  it('filters by Angular major when onlyAngularMajor is set', () => {
    const rows = [
      row({ version: '1.0.0', supportedAngularMajors: [16] }),
      row({ version: '2.0.0', supportedAngularMajors: [17] }),
      row({ version: '3.0.0', supportedAngularMajors: [16, 17] })
    ];
    svc.patch({ onlyAngularMajor: 17 });
    expect(svc.apply(rows).map((r) => r.version).sort()).toEqual(['2.0.0', '3.0.0']);
  });

  it('filters by published-date range', () => {
    const rows = [
      row({ version: '1.0.0', publishedAt: new Date('2023-01-01') }),
      row({ version: '2.0.0', publishedAt: new Date('2024-06-01') }),
      row({ version: '3.0.0', publishedAt: new Date('2025-01-01') })
    ];
    svc.patch({
      minPublishDate: '2024-01-01',
      maxPublishDate: '2024-12-31'
    });
    expect(svc.apply(rows).map((r) => r.version)).toEqual(['2.0.0']);
  });

  it('searches by version substring (case-insensitive)', () => {
    const rows = [
      row({ version: '1.0.0' }),
      row({ version: '2.0.0-RC.1' }),
      row({ version: '2.1.0' })
    ];
    svc.patch({ search: 'rc' });
    expect(svc.apply(rows).map((r) => r.version)).toEqual(['2.0.0-RC.1']);
  });

  it('reset() clears every active filter', () => {
    svc.patch({ hideDeprecated: true, hidePrerelease: true, search: 'beta' });
    expect(svc.hasActiveFilters()).toBeTrue();
    svc.reset();
    expect(svc.hasActiveFilters()).toBeFalse();
  });

  it('sorts by date descending by default', () => {
    const rows = [
      row({ version: '1.0.0', publishedAt: new Date('2023-01-01') }),
      row({ version: '3.0.0', publishedAt: new Date('2025-01-01') }),
      row({ version: '2.0.0', publishedAt: new Date('2024-06-01') })
    ];
    svc.sortKey.set('date');
    svc.sortDir.set('desc');
    expect(svc.apply(rows).map((r) => r.version)).toEqual(['3.0.0', '2.0.0', '1.0.0']);
  });

  it('sorts ascending when sortDir is asc', () => {
    const rows = [
      row({ version: '1.0.0', publishedAt: new Date('2023-01-01') }),
      row({ version: '3.0.0', publishedAt: new Date('2025-01-01') })
    ];
    svc.sortKey.set('date');
    svc.sortDir.set('asc');
    expect(svc.apply(rows).map((r) => r.version)).toEqual(['1.0.0', '3.0.0']);
  });
});
