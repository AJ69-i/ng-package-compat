import { TestBed } from '@angular/core/testing';
import { RecommendationService } from './recommendation.service';
import { VersionCompatibility } from '../models/npm-package.model';

/**
 * Helper: build a `VersionCompatibility` from a few fields a test cares about,
 * defaulting the rest to safe values. Keeps tests readable without re-stating
 * the whole 14-field shape every time.
 */
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

describe('RecommendationService', () => {
  let svc: RecommendationService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    svc = TestBed.inject(RecommendationService);
  });

  it('returns null for both fields when no row supports the target major', () => {
    const rows = [
      row({ version: '1.0.0', supportedAngularMajors: [16] }),
      row({ version: '2.0.0', supportedAngularMajors: [17] })
    ];
    const rec = svc.forMajor(rows, 21);
    expect(rec.angularMajor).toBe(21);
    expect(rec.stable).toBeNull();
    expect(rec.latest).toBeNull();
    expect(rec.all.length).toBe(0);
  });

  it('excludes deprecated rows from recommendations', () => {
    const rows = [
      row({ version: '2.0.0', supportedAngularMajors: [17], isDeprecated: true }),
      row({ version: '1.5.0', supportedAngularMajors: [17], publishedAt: new Date('2024-01-01') })
    ];
    const rec = svc.forMajor(rows, 17);
    expect(rec.all.length).toBe(1);
    expect(rec.latest?.version).toBe('1.5.0');
  });

  it('picks the most recent non-prerelease as `stable`', () => {
    const rows = [
      row({ version: '3.0.0-beta.1', supportedAngularMajors: [17], isPrerelease: true, publishedAt: new Date('2024-06-01') }),
      row({ version: '2.0.0',        supportedAngularMajors: [17], publishedAt: new Date('2024-03-01') }),
      row({ version: '1.0.0',        supportedAngularMajors: [17], publishedAt: new Date('2023-01-01') })
    ];
    const rec = svc.forMajor(rows, 17);
    expect(rec.stable?.version).toBe('2.0.0');
    expect(rec.latest?.version).toBe('3.0.0-beta.1');
  });

  it('falls back to the prerelease for `latest` when no stable match exists', () => {
    const rows = [
      row({ version: '4.0.0-rc.1', supportedAngularMajors: [21], isPrerelease: true, publishedAt: new Date('2024-09-01') })
    ];
    const rec = svc.forMajor(rows, 21);
    expect(rec.stable).toBeNull();
    expect(rec.latest?.version).toBe('4.0.0-rc.1');
  });

  it('sorts the candidate `all` list by publish date descending', () => {
    const rows = [
      row({ version: '1.0.0', supportedAngularMajors: [17], publishedAt: new Date('2023-01-01') }),
      row({ version: '3.0.0', supportedAngularMajors: [17], publishedAt: new Date('2024-09-01') }),
      row({ version: '2.0.0', supportedAngularMajors: [17], publishedAt: new Date('2024-03-01') })
    ];
    const rec = svc.forMajor(rows, 17);
    expect(rec.all.map((r) => r.version)).toEqual(['3.0.0', '2.0.0', '1.0.0']);
  });

  it('forRange returns one Recommendation per major in the requested order', () => {
    const rows = [
      row({ version: '1.0.0', supportedAngularMajors: [16] }),
      row({ version: '2.0.0', supportedAngularMajors: [17] })
    ];
    const out = svc.forRange(rows, [16, 17, 18]);
    expect(out.length).toBe(3);
    expect(out[0].angularMajor).toBe(16);
    expect(out[0].latest?.version).toBe('1.0.0');
    expect(out[1].angularMajor).toBe(17);
    expect(out[1].latest?.version).toBe('2.0.0');
    expect(out[2].angularMajor).toBe(18);
    expect(out[2].latest).toBeNull();
  });
});
