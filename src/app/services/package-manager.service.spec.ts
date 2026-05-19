import { TestBed } from '@angular/core/testing';
import { PackageManagerService } from './package-manager.service';

describe('PackageManagerService', () => {
  let svc: PackageManagerService;

  beforeEach(() => {
    // Each test starts from a clean localStorage so we don't inherit a saved pm.
    try { localStorage.removeItem('ngpc.pm'); } catch { /* ignore */ }
    TestBed.configureTestingModule({});
    svc = TestBed.inject(PackageManagerService);
  });

  describe('default + persistence', () => {
    it('defaults to npm when no preference is saved', () => {
      expect(svc.pm()).toBe('npm');
    });

    it('persists the chosen pm to localStorage', () => {
      svc.set('pnpm');
      expect(svc.pm()).toBe('pnpm');
      expect(localStorage.getItem('ngpc.pm')).toBe('pnpm');
    });

    it('hydrates a previously-saved pm on a fresh service instance', () => {
      localStorage.setItem('ngpc.pm', 'yarn');
      // Force a fresh injector + service so the constructor reads storage anew.
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({});
      const fresh = TestBed.inject(PackageManagerService);
      expect(fresh.pm()).toBe('yarn');
    });

    it('ignores garbage values in localStorage and falls back to npm', () => {
      localStorage.setItem('ngpc.pm', 'cargo');
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({});
      const fresh = TestBed.inject(PackageManagerService);
      expect(fresh.pm()).toBe('npm');
    });
  });

  describe('installCommand', () => {
    const cases: Array<['npm' | 'yarn' | 'pnpm' | 'bun', string]> = [
      ['npm',  'npm install rxjs@7.8.0'],
      ['yarn', 'yarn add rxjs@7.8.0'],
      ['pnpm', 'pnpm add rxjs@7.8.0'],
      ['bun',  'bun add rxjs@7.8.0']
    ];
    for (const [pm, expected] of cases) {
      it(`emits the right install command for ${pm}`, () => {
        svc.set(pm);
        expect(svc.installCommand('rxjs', '7.8.0')).toBe(expected);
      });
    }

    it('omits the @version when no version is provided', () => {
      svc.set('npm');
      expect(svc.installCommand('rxjs')).toBe('npm install rxjs');
    });
  });

  describe('ngAddCommand', () => {
    const cases: Array<['npm' | 'yarn' | 'pnpm' | 'bun', string]> = [
      ['npm',  'npx @angular/cli@latest add @angular/material@17.0.0'],
      ['yarn', 'yarn dlx @angular/cli@latest add @angular/material@17.0.0'],
      ['pnpm', 'pnpm dlx @angular/cli@latest add @angular/material@17.0.0'],
      ['bun',  'bunx --bun @angular/cli@latest add @angular/material@17.0.0']
    ];
    for (const [pm, expected] of cases) {
      it(`emits the right ng add command for ${pm}`, () => {
        svc.set(pm);
        expect(svc.ngAddCommand('@angular/material', '17.0.0')).toBe(expected);
      });
    }
  });
});
