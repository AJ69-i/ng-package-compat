import { CompatibilityService, KNOWN_ANGULAR_MAJORS } from './compatibility.service';
import { NpmRegistryResponse } from '../models/npm-package.model';

describe('CompatibilityService', () => {
  let svc: CompatibilityService;

  beforeEach(() => {
    svc = new CompatibilityService();
  });

  describe('majorsSatisfiedByRange', () => {
    const cases: Array<[string, number[]]> = [
      ['^17.0.0', [17]],
      ['~17.1.0', [17]],
      ['>=16.0.0 <18.0.0', [16, 17]],
      ['16.x', [16]],
      ['16 || 17 || 18', [16, 17, 18]],
      ['16.0.0 - 17.0.0', [16, 17]],
      ['*', [...KNOWN_ANGULAR_MAJORS]],
      ['>=15', KNOWN_ANGULAR_MAJORS.filter((m) => m >= 15)],
      ['<18', KNOWN_ANGULAR_MAJORS.filter((m) => m < 18)],
      ['^14.0.0 || ^15.0.0', [14, 15]],
      ['not-a-real-range', []],
      ['', []]
    ];

    cases.forEach(([range, expected]) => {
      it(`returns ${JSON.stringify(expected)} for "${range}"`, () => {
        expect(svc.majorsSatisfiedByRange(range)).toEqual(expected);
      });
    });
  });

  describe('buildVersionRows — strategies', () => {
    const pkg: NpmRegistryResponse = {
      name: 'example',
      'dist-tags': { latest: '3.0.0' },
      time: { '1.0.0': '2023-01-01', '2.0.0': '2023-06-01', '3.0.0': '2024-01-01' },
      versions: {
        '1.0.0': { name: 'example', version: '1.0.0', peerDependencies: { '@angular/core': '^14.0.0' } },
        '2.0.0': { name: 'example', version: '2.0.0', dependencies: { '@angular/core': '^16.0.0' } },
        '3.0.0': { name: 'example', version: '3.0.0', devDependencies: { '@angular/core': '^17.0.0' } }
      }
    };

    it('peer strategy: only "peer" source produces majors', () => {
      const rows = svc.buildVersionRows(pkg, 'peer');
      expect(rows.find((r) => r.version === '1.0.0')!.supportedAngularMajors).toEqual([14]);
      expect(rows.find((r) => r.version === '2.0.0')!.supportedAngularMajors).toEqual([]);
      expect(rows.find((r) => r.version === '3.0.0')!.supportedAngularMajors).toEqual([]);
      expect(rows.find((r) => r.version === '2.0.0')!.detectionSource).toBe('none');
    });

    it('peer-dep strategy: falls back to dependencies', () => {
      const rows = svc.buildVersionRows(pkg, 'peer-dep');
      expect(rows.find((r) => r.version === '2.0.0')!.supportedAngularMajors).toEqual([16]);
      expect(rows.find((r) => r.version === '2.0.0')!.detectionSource).toBe('dependency');
      expect(rows.find((r) => r.version === '3.0.0')!.supportedAngularMajors).toEqual([]);
    });

    it('heuristic strategy: also uses devDependencies', () => {
      const rows = svc.buildVersionRows(pkg, 'heuristic');
      expect(rows.find((r) => r.version === '3.0.0')!.supportedAngularMajors).toEqual([17]);
      expect(rows.find((r) => r.version === '3.0.0')!.detectionSource).toBe('devDependency');
    });

    it('heuristic: @angular/* packages match by their own major', () => {
      const angPkg: NpmRegistryResponse = {
        name: '@angular/material',
        'dist-tags': { latest: '16.2.0' },
        time: { '16.2.0': '2024-01-01' },
        versions: { '16.2.0': { name: '@angular/material', version: '16.2.0' } }
      };
      const rows = svc.buildVersionRows(angPkg, 'heuristic');
      expect(rows[0].supportedAngularMajors).toEqual([16]);
      expect(rows[0].detectionSource).toBe('angular-package-name');
    });

    it('flags the latest tag and deprecated versions correctly', () => {
      const pkg2: NpmRegistryResponse = {
        name: 'x',
        'dist-tags': { latest: '2.0.0' },
        time: { '1.0.0': '2023-01-01', '2.0.0': '2024-01-01' },
        versions: {
          '1.0.0': { name: 'x', version: '1.0.0', deprecated: 'no longer maintained' },
          '2.0.0': { name: 'x', version: '2.0.0' }
        }
      };
      const rows = svc.buildVersionRows(pkg2, 'peer');
      const v1 = rows.find((r) => r.version === '1.0.0')!;
      const v2 = rows.find((r) => r.version === '2.0.0')!;
      expect(v1.isDeprecated).toBe(true);
      expect(v1.deprecationMessage).toBe('no longer maintained');
      expect(v2.isLatest).toBe(true);
    });
  });

  describe('compareSemverDesc', () => {
    it('sorts descending semver', () => {
      const v = ['1.0.0', '2.1.0', '1.2.0', '2.0.0-beta.1', '2.0.0'];
      expect(v.sort((a, b) => svc.compareSemverDesc(a, b))).toEqual([
        '2.1.0',
        '2.0.0',
        '2.0.0-beta.1',
        '1.2.0',
        '1.0.0'
      ]);
    });
  });
});
