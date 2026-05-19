import { Injectable } from '@angular/core';

/**
 * A knowledge base of npm packages that have been moved, renamed, scoped,
 * forked under new ownership, or fully transferred to another maintainer.
 *
 * Why this exists: a huge part of "why doesn't this install cleanly on
 * Angular 17+?" is that the package's new home is under a different name,
 * and the old name is either deprecated-on-npm or published a stub pointing
 * to the new location. Surfacing this explicitly — with the reason — saves
 * teams hours of manual archaeology.
 */
export interface PackageRelocation {
  /** Old / deprecated name the user searched for. */
  from: string;
  /** Canonical new package name to use going forward. */
  to: string;
  /** Short, human-readable explanation of what happened. */
  reason: string;
  /** Date (YYYY-MM) when the relocation was announced, if known. */
  movedAt?: string;
  /** Optional link to the announcement / migration guide. */
  link?: string;
  /** Kind of relocation — for UI categorisation. */
  kind:
    | 'scoped'          // e.g. foo → @scope/foo
    | 'renamed'         // e.g. angular-social-login → @abacritt/angularx-social-login
    | 'forked'          // abandoned, community fork took over
    | 'transferred'     // same name, new maintainer
    | 'split';          // one package became several
}

@Injectable({ providedIn: 'root' })
export class PackageRelocationService {
  private readonly table: Record<string, PackageRelocation> = {
    'angular-social-login': {
      from: 'angular-social-login',
      to: '@abacritt/angularx-social-login',
      kind: 'renamed',
      reason:
        'Original maintainer stopped publishing. Community continuation is published under @abacritt/angularx-social-login with full Angular 15+ support.',
      movedAt: '2022-09',
      link: 'https://github.com/abacritt/angularx-social-login'
    },
    'angular2-jwt': {
      from: 'angular2-jwt',
      to: '@auth0/angular-jwt',
      kind: 'renamed',
      reason:
        'Renamed to @auth0/angular-jwt when ownership moved under the Auth0 org. Original package is frozen.',
      movedAt: '2018-08',
      link: 'https://github.com/auth0/angular2-jwt'
    },
    'ng2-translate': {
      from: 'ng2-translate',
      to: '@ngx-translate/core',
      kind: 'renamed',
      reason:
        'Deprecated in 2017 in favour of @ngx-translate/core (the official ngx-translate successor).',
      movedAt: '2017-01',
      link: 'https://github.com/ngx-translate/core'
    },
    '@angular/http': {
      from: '@angular/http',
      to: '@angular/common/http',
      kind: 'split',
      reason:
        'The legacy @angular/http module was removed in Angular 8. All HTTP functionality is now under @angular/common/http.',
      movedAt: '2019-05',
      link: 'https://angular.dev/guide/http'
    },
    'ngx-bootstrap-modal': {
      from: 'ngx-bootstrap-modal',
      to: 'ngx-bootstrap',
      kind: 'transferred',
      reason:
        'Original standalone modal package was folded into ngx-bootstrap as the modal sub-module. Use ngx-bootstrap/modal.',
      link: 'https://valor-software.com/ngx-bootstrap/'
    },
    'ngrx-store': {
      from: 'ngrx-store',
      to: '@ngrx/store',
      kind: 'scoped',
      reason:
        'Moved under the official @ngrx scope. The unscoped package has not been published since 2016.',
      movedAt: '2016-12',
      link: 'https://ngrx.io'
    },
    'flex-layout': {
      from: 'flex-layout',
      to: '@angular/flex-layout',
      kind: 'scoped',
      reason:
        'Published under the @angular scope. (Note: @angular/flex-layout itself is now deprecated — see the Upgrade tab for modern alternatives.)'
    },
    'tslint': {
      from: 'tslint',
      to: 'eslint + @angular-eslint/schematics',
      kind: 'forked',
      reason:
        'TSLint was deprecated in 2019. The Angular toolchain moved to ESLint via @angular-eslint/schematics.',
      movedAt: '2019-12',
      link: 'https://github.com/angular-eslint/angular-eslint'
    },
    'codelyzer': {
      from: 'codelyzer',
      to: '@angular-eslint/eslint-plugin',
      kind: 'forked',
      reason:
        'Codelyzer was the linting engine for TSLint. The Angular-specific lint rules now live in @angular-eslint/eslint-plugin.',
      link: 'https://github.com/angular-eslint/angular-eslint'
    },
    'protractor': {
      from: 'protractor',
      to: 'cypress or @playwright/test',
      kind: 'forked',
      reason:
        'Protractor is end-of-life (Angular dropped it in v12). There is no direct successor — the community standardised on Cypress or Playwright.',
      movedAt: '2021-08',
      link: 'https://blog.angular.io/the-state-of-end-to-end-testing-with-angular-d175f751cb9c'
    },
    '@nrwl/nx': {
      from: '@nrwl/nx',
      to: 'nx',
      kind: 'renamed',
      reason:
        'Nx 16 rebranded from the @nrwl scope to the unscoped "nx" package. Peripheral packages moved to the @nx scope.',
      movedAt: '2023-05',
      link: 'https://nx.dev'
    },
    '@nrwl/angular': {
      from: '@nrwl/angular',
      to: '@nx/angular',
      kind: 'scoped',
      reason:
        'Nx 16 moved the Angular plugin from @nrwl/angular to @nx/angular. Old package is a stub that redirects.',
      movedAt: '2023-05',
      link: 'https://nx.dev'
    },
    'karma': {
      from: 'karma',
      to: '@web/test-runner or jest or vitest',
      kind: 'forked',
      reason:
        'Karma was deprecated by its maintainers. Angular recommends migrating to Jest, Vitest, or @web/test-runner.',
      movedAt: '2023-04',
      link: 'https://github.com/karma-runner/karma'
    },
    'ng2-charts': {
      from: 'ng2-charts',
      to: 'ng2-charts',
      kind: 'transferred',
      reason:
        'Package name unchanged, but ownership transferred to Valor Software. Make sure you are on v4+ for modern Angular support.',
      link: 'https://valor-software.com/ng2-charts/'
    }
  };

  /**
   * Return a relocation entry for the given package name, or null if the
   * package is not known to have moved.
   */
  for(pkgName: string): PackageRelocation | null {
    return this.table[pkgName] ?? null;
  }

  /**
   * Return all relocations, sorted by move date (newest first, unknown last).
   * Useful for the About / knowledge page.
   */
  all(): PackageRelocation[] {
    return Object.values(this.table).sort((a, b) => {
      if (!a.movedAt && !b.movedAt) return 0;
      if (!a.movedAt) return 1;
      if (!b.movedAt) return -1;
      return b.movedAt.localeCompare(a.movedAt);
    });
  }

  /**
   * Size of the knowledge base — used in the About page.
   */
  get size(): number {
    return Object.keys(this.table).length;
  }
}
