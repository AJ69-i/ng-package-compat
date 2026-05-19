import { TestBed } from '@angular/core/testing';
import { PackageJsonParserService } from './package-json-parser.service';

describe('PackageJsonParserService', () => {
  let svc: PackageJsonParserService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    svc = TestBed.inject(PackageJsonParserService);
  });

  describe('parseJson', () => {
    it('throws on empty input with a clear message', () => {
      expect(() => svc.parseJson('')).toThrowError(/empty/i);
      expect(() => svc.parseJson('   ')).toThrowError(/empty/i);
    });

    it('throws on malformed JSON', () => {
      expect(() => svc.parseJson('{ not: json }')).toThrowError(/Not valid JSON/);
    });

    it('throws on a JSON array (must be an object)', () => {
      expect(() => svc.parseJson('[]')).toThrowError(/JSON object/);
    });

    it('extracts dependencies, devDependencies, and peerDependencies', () => {
      const raw = JSON.stringify({
        name: 'demo',
        version: '1.0.0',
        dependencies: { 'rxjs': '^7.8.0' },
        devDependencies: { 'typescript': '^5.5.0' },
        peerDependencies: { '@angular/core': '^17.0.0' }
      });
      const parsed = svc.parseJson(raw);
      expect(parsed.name).toBe('demo');
      expect(parsed.version).toBe('1.0.0');
      expect(parsed.deps.length).toBe(3);
      const sections = parsed.deps.map((d) => d.section).sort();
      expect(sections).toEqual(['dependencies', 'devDependencies', 'peerDependencies']);
    });

    it('detects the Angular major from @angular/core', () => {
      const raw = JSON.stringify({
        dependencies: { '@angular/core': '^17.2.0' }
      });
      expect(svc.parseJson(raw).angularMajor).toBe(17);
    });

    it('returns null angularMajor when @angular/core is absent', () => {
      const raw = JSON.stringify({ dependencies: { 'rxjs': '^7.0.0' } });
      expect(svc.parseJson(raw).angularMajor).toBeNull();
    });

    it('warns about and skips non-registry ranges (git/file/link/workspace)', () => {
      const raw = JSON.stringify({
        dependencies: {
          'good': '^1.0.0',
          'fork': 'git+https://github.com/u/r.git',
          'local': 'file:../mylib',
          'mono': 'workspace:*'
        }
      });
      const parsed = svc.parseJson(raw);
      expect(parsed.deps.map((d) => d.name)).toEqual(['good']);
      expect(parsed.warnings.length).toBe(3);
    });

    it('warns and skips entries whose range is not a string', () => {
      const raw = JSON.stringify({
        dependencies: { 'broken': 17, 'good': '^1.0.0' }
      });
      const parsed = svc.parseJson(raw);
      expect(parsed.deps.map((d) => d.name)).toEqual(['good']);
      expect(parsed.warnings[0]).toContain('broken');
    });

    it('dedupes a name across sections, preferring dependencies over devDependencies', () => {
      const raw = JSON.stringify({
        dependencies: { 'shared': '^2.0.0' },
        devDependencies: { 'shared': '^1.0.0' }
      });
      const parsed = svc.parseJson(raw);
      const shared = parsed.deps.find((d) => d.name === 'shared')!;
      expect(shared.section).toBe('dependencies');
      expect(shared.range).toBe('^2.0.0');
    });
  });

  describe('parseList', () => {
    it('handles bare names', () => {
      const parsed = svc.parseList('rxjs\nngx-toastr');
      expect(parsed.deps.map((d) => d.name).sort()).toEqual(['ngx-toastr', 'rxjs']);
      expect(parsed.deps[0].range).toBeNull();
    });

    it('handles `name@range` syntax — including scoped packages', () => {
      const parsed = svc.parseList('rxjs@^7.0.0\n@angular/core@^17.0.0');
      const ng = parsed.deps.find((d) => d.name === '@angular/core')!;
      const rx = parsed.deps.find((d) => d.name === 'rxjs')!;
      expect(ng.range).toBe('^17.0.0');
      expect(rx.range).toBe('^7.0.0');
    });

    it('handles package.json-style "name": "range" entries', () => {
      const parsed = svc.parseList('"rxjs": "^7.8.0"');
      expect(parsed.deps[0]).toEqual({ name: 'rxjs', range: '^7.8.0', section: 'dependencies' });
    });

    it('ignores blank lines, comments (# and //), and surrounding punctuation', () => {
      const parsed = svc.parseList('# comment\n// another\n\n  rxjs,\n');
      expect(parsed.deps.map((d) => d.name)).toEqual(['rxjs']);
    });

    it('records a warning for unparseable lines', () => {
      const parsed = svc.parseList('this is not a package!');
      expect(parsed.deps.length).toBe(0);
      expect(parsed.warnings.length).toBe(1);
    });

    it('detects the Angular major from a list-form @angular/core entry', () => {
      const parsed = svc.parseList('@angular/core@^18.0.0');
      expect(parsed.angularMajor).toBe(18);
    });
  });

  describe('resolveInstalledVersion', () => {
    it('returns the minimum version of a caret range', () => {
      expect(svc.resolveInstalledVersion('^17.2.0')).toBe('17.2.0');
    });

    it('coerces partial versions like `17`', () => {
      expect(svc.resolveInstalledVersion('17')).toBe('17.0.0');
    });

    it('returns null for null / empty ranges', () => {
      expect(svc.resolveInstalledVersion(null)).toBeNull();
      expect(svc.resolveInstalledVersion('')).toBeNull();
    });

    it('returns null for completely unparseable ranges', () => {
      expect(svc.resolveInstalledVersion('not-a-range')).toBeNull();
    });
  });
});
