import { Injectable } from '@angular/core';
import {
  Alternative,
  BreakingChange,
  DeprecationInfo,
  UiFrameworkAlert
} from '../models/npm-package.model';

/**
 * Curated knowledge base of:
 *  - deprecated Angular-ecosystem packages + modern alternatives
 *  - well-known library breaking changes per major
 *  - UI-framework-specific alerts
 *  - license metadata overrides (when npm metadata is misleading)
 *  - standalone-readiness heuristics
 *
 * Keep this data focused and opinionated — it's the "expert consultant" layer
 * that sits on top of the raw npm registry data.
 */
@Injectable({ providedIn: 'root' })
export class KnowledgeBaseService {
  private readonly deprecations: Record<string, DeprecationInfo> = {
    '@angular/flex-layout': {
      npmDeprecated: true,
      reason:
        'Flex-Layout is deprecated and unmaintained. The Angular team recommends moving to CSS Grid, Tailwind CSS, or native Flexbox.',
      alternatives: [
        { name: 'tailwindcss', rationale: 'Utility-first CSS with responsive variants — most popular replacement.' },
        { name: 'Native CSS Grid / Flexbox', rationale: 'Zero-dep, first-class browser support.' }
      ]
    },
    '@angular/http': {
      npmDeprecated: true,
      reason: 'Removed from Angular in v8. Use the modern HttpClient API.',
      alternatives: [{ name: '@angular/common/http', rationale: 'Built-in modern HTTP client with interceptor support.' }]
    },
    'protractor': {
      npmDeprecated: true,
      reason: 'Protractor is end-of-life (Angular dropped it in v12). Choose a modern E2E runner.',
      alternatives: [
        { name: 'cypress', rationale: 'Ergonomic, interactive browser-based test runner with time travel.' },
        { name: '@playwright/test', rationale: 'Cross-browser, parallel, and supports component testing.' }
      ]
    },
    'tslint': {
      npmDeprecated: true,
      reason: 'Deprecated in 2019. Replaced by ESLint.',
      alternatives: [{ name: '@angular-eslint/schematics', rationale: 'Official Angular ESLint integration with schematics.' }]
    },
    'codelyzer': {
      npmDeprecated: true,
      reason: 'Bundled with TSLint — deprecated along with TSLint.',
      alternatives: [{ name: '@angular-eslint/eslint-plugin', rationale: 'Modern Angular-aware linter rules.' }]
    },
    '@nguniversal/express-engine': {
      npmDeprecated: true,
      reason: 'Merged into @angular/ssr in Angular 17.',
      alternatives: [{ name: '@angular/ssr', rationale: 'Official SSR package, maintained by the Angular team.' }]
    },
    '@nrwl/angular': {
      npmDeprecated: false,
      reason: 'Rebranded to @nx/angular in Nx 16.',
      alternatives: [{ name: '@nx/angular', rationale: 'Current package name; identical functionality.' }]
    },
    '@nrwl/nx-cloud': {
      npmDeprecated: false,
      reason: 'Rebranded to nx-cloud in Nx 17.',
      alternatives: [{ name: 'nx-cloud', rationale: 'Current package name.' }]
    },
    'moment': {
      npmDeprecated: true,
      reason: 'Moment is in maintenance mode; the team recommends a modern, tree-shakeable alternative.',
      alternatives: [
        { name: 'date-fns', rationale: 'Tree-shakeable, functional, TypeScript-native.' },
        { name: 'dayjs', rationale: 'Tiny (2 KB), Moment-compatible API.' },
        { name: 'luxon', rationale: 'Timezone support built-in, immutable API.' }
      ]
    },
    'request': {
      npmDeprecated: true,
      reason: 'Archived in 2020. Do not use in new code.',
      alternatives: [
        { name: 'undici', rationale: 'Modern Node fetch implementation.' },
        { name: 'axios', rationale: 'Promise-based HTTP with interceptors.' }
      ]
    },
    'karma': {
      npmDeprecated: false,
      reason: 'Angular is migrating to Web Test Runner / Vitest. Karma still works in v21 but is considered legacy.',
      alternatives: [
        { name: '@web/test-runner', rationale: 'Official replacement recommended by the Angular team.' },
        { name: 'jest-preset-angular', rationale: 'Popular Jest setup for Angular apps.' }
      ]
    }
  };

  /**
   * Library-level breaking changes to flag when the user bumps across a major.
   * Keyed by package name; each entry lists the changes and which "since" major
   * introduced them.
   */
  private readonly breakingChanges: Record<string, BreakingChange[]> = {
    'rxjs': [
      {
        title: '`toPromise()` removed',
        detail:
          'Replace `observable.toPromise()` with `lastValueFrom(observable)` (or `firstValueFrom`).',
        since: '8.0.0',
        link: 'https://rxjs.dev/deprecations/to-promise',
        severity: 'critical',
        symbols: ['toPromise']
      },
      {
        title: 'Pipeable operators only',
        detail:
          'Chainable `.map().filter()` was removed — always use `.pipe(map(), filter())`.',
        since: '7.0.0',
        severity: 'warning',
        symbols: ['Observable', 'Subject', 'BehaviorSubject', 'ReplaySubject']
      }
    ],
    '@angular/core': [
      {
        title: 'NgModules optional (standalone default)',
        detail:
          'Angular 19+ defaults new components to standalone. Migrate using `ng generate @angular/core:standalone`.',
        since: '19.0.0',
        link: 'https://angular.dev/reference/migrations/standalone',
        severity: 'info',
        symbols: ['NgModule']
      },
      {
        title: 'Zoneless change detection',
        detail:
          'Add `provideZonelessChangeDetection()` to unlock signal-driven rendering and remove Zone.js.',
        since: '20.0.0',
        severity: 'info'
      },
      {
        title: 'Control flow migration',
        detail:
          '`*ngIf`, `*ngFor`, `*ngSwitch` replaced by `@if`, `@for`, `@switch`. Run `ng generate @angular/core:control-flow`.',
        since: '17.0.0',
        severity: 'info',
        symbols: ['*ngIf', '*ngFor', '*ngSwitch']
      }
    ],
    '@angular/common': [
      {
        title: 'Http interceptors are functional',
        detail:
          'Class-based `HttpInterceptor` is superseded by functional `HttpInterceptorFn`. Register via `withInterceptors([...])`.',
        since: '15.0.0',
        severity: 'warning',
        symbols: ['HttpInterceptor']
      }
    ],
    '@angular/router': [
      {
        title: 'Functional route guards',
        detail:
          '`CanActivate` class guards are deprecated. Use `CanActivateFn` factory functions via `provideRouter(routes)`.',
        since: '15.0.0',
        severity: 'warning',
        symbols: ['CanActivate', 'CanDeactivate', 'CanLoad', 'Resolve']
      }
    ],
    '@angular/forms': [
      {
        title: 'Typed reactive forms',
        detail:
          'FormControl / FormGroup accept a generic type parameter. Migrate via `ng update @angular/core`.',
        since: '14.0.0',
        severity: 'info',
        symbols: ['FormControl', 'FormGroup', 'FormArray', 'FormBuilder']
      }
    ],
    '@ngrx/store': [
      {
        title: 'Typed action creators required',
        detail:
          'Legacy class-based actions removed; use `createAction` / `createReducer`.',
        since: '15.0.0',
        severity: 'warning',
        symbols: ['Action', 'ActionReducer']
      },
      {
        title: 'Signals Store API',
        detail:
          'New `@ngrx/signals` package offers a simpler, signal-based store. Consider adopting for greenfield features.',
        since: '17.0.0',
        severity: 'info'
      }
    ],
    '@angular/material': [
      {
        title: 'Legacy MDC components removed',
        detail:
          '`mat-legacy-*` components were removed in v17. Use the MDC-based replacements and re-theme.',
        since: '17.0.0',
        link: 'https://material.angular.io/guide/mdc-migration',
        severity: 'critical',
        symbols: ['<mat-*>', 'MatLegacyButtonModule', 'MatLegacyCardModule']
      }
    ],
    'primeng': [
      {
        title: 'Theming overhaul (v16)',
        detail:
          'PrimeNG moved to a design-token based theming in v16. Review your SCSS.',
        since: '16.0.0',
        link: 'https://primeng.org/guides/upgrade',
        severity: 'warning',
        symbols: ['<p-*>']
      }
    ],
    'ng-bootstrap': [
      {
        title: 'Requires Bootstrap 5',
        detail:
          'ng-bootstrap v14+ requires Bootstrap 5; Bootstrap 4 class names changed (e.g. `ml-*` → `ms-*`).',
        since: '14.0.0',
        severity: 'warning',
        symbols: ['NgbModule', 'NgbModal', 'NgbActiveModal']
      }
    ],
    'typescript': [
      {
        title: 'Stricter type narrowing',
        detail:
          'TS 5.x narrows unknown and any more aggressively; review any `// @ts-ignore` comments.',
        since: '5.0.0',
        severity: 'info'
      }
    ],
    '@ionic/angular': [
      {
        title: 'IonicModule removed in favor of standalone components',
        detail:
          'v7+ ships standalone components. Drop the global `IonicModule` import and import `IonButton`, `IonContent`, etc. per-component.',
        since: '7.0.0',
        link: 'https://ionicframework.com/docs/angular/build-options',
        severity: 'warning',
        symbols: ['IonicModule']
      }
    ]
  };

  /**
   * UI framework alerts — triggered by bare package name detection. Returned
   * once per matching dep.
   */
  private readonly uiFrameworkAlerts: Record<string, UiFrameworkAlert> = {
    '@angular/material': {
      framework: 'Angular Material',
      title: 'Run the MDC migration',
      detail:
        'Angular Material switched to the Material Design Components base library. Run ' +
        '`ng generate @angular/material:mdc-migration` to auto-update templates and SCSS.',
      link: 'https://material.angular.io/guide/mdc-migration'
    },
    'primeng': {
      framework: 'PrimeNG',
      title: 'Review theme tokens',
      detail:
        'PrimeNG 16+ uses a CSS-variable theming system. Audit your SCSS and replace hardcoded class overrides.',
      link: 'https://primeng.org/guides/upgrade'
    },
    'ng-zorro-antd': {
      framework: 'Ng-Zorro',
      title: 'Less → CSS variables',
      detail:
        'Ng-Zorro v17+ generates CSS variables at runtime. If you relied on Less overrides, move to the new token API.',
      link: 'https://ng.ant.design/docs/customize-theme/en'
    },
    '@taiga-ui/core': {
      framework: 'Taiga UI',
      title: 'Standalone migration',
      detail:
        'Taiga UI components are standalone from v4. Drop the big `TuiRootModule` import and switch to `provideTuiRoot()`.',
      link: 'https://taiga-ui.dev/migration-guide'
    },
    '@ionic/angular': {
      framework: 'Ionic',
      title: 'Standalone components',
      detail:
        'Ionic 7+ ships standalone components. Import `IonButton`, `IonHeader`, etc. directly instead of `IonicModule`.',
      link: 'https://ionicframework.com/docs/angular/build-options'
    }
  };

  /** Packages that already support Angular's standalone API at the stated major. */
  private readonly standaloneReady: Record<string, number> = {
    '@angular/material': 15,
    '@angular/cdk': 15,
    '@ngrx/store': 15,
    '@ngrx/effects': 15,
    '@ngrx/signals': 17,
    '@ionic/angular': 7,
    'ngx-toastr': 17,
    'primeng': 17,
    'ng-zorro-antd': 17,
    '@taiga-ui/core': 3
  };

  /** Rough per-package effort multiplier (in hours) when an upgrade is required. */
  private readonly effortWeight: Record<string, number> = {
    '@angular/core': 4,
    '@angular/material': 3,
    '@angular/router': 2,
    '@ngrx/store': 2,
    'rxjs': 3,
    'primeng': 3,
    'ng-zorro-antd': 3,
    '@ionic/angular': 4,
    'typescript': 1
  };

  /** Copyleft license families that should block an auto-update. */
  private readonly copyleft = new Set<string>([
    'GPL-2.0', 'GPL-3.0', 'GPL-3.0-only', 'GPL-3.0-or-later',
    'AGPL-3.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later',
    'LGPL-2.1', 'LGPL-3.0',
    'CC-BY-NC-4.0', 'CC-BY-NC-SA-4.0',
    'SSPL-1.0', 'BUSL-1.1'
  ]);

  getDeprecation(name: string): DeprecationInfo | null {
    return this.deprecations[name] ?? null;
  }

  /**
   * Returns breaking changes applicable to an upgrade from `fromVersion` to
   * `toVersion` (inclusive of the `since` boundary).
   */
  getBreakingChanges(
    name: string,
    fromMajor: number | null,
    toMajor: number | null
  ): BreakingChange[] {
    const entries = this.breakingChanges[name];
    if (!entries) return [];
    if (toMajor == null) return entries;
    return entries.filter((bc) => {
      if (!bc.since) return true;
      const sinceMajor = Number(bc.since.split('.')[0]);
      if (Number.isNaN(sinceMajor)) return true;
      if (fromMajor != null && fromMajor >= sinceMajor) return false;
      return toMajor >= sinceMajor;
    });
  }

  getUiFrameworkAlert(name: string): UiFrameworkAlert | null {
    return this.uiFrameworkAlerts[name] ?? null;
  }

  /** Returns `true` if this package supports standalone APIs at `ngMajor` or newer. */
  supportsStandalone(name: string, ngMajor: number | null): boolean {
    const minor = this.standaloneReady[name];
    if (minor == null || ngMajor == null) return false;
    return ngMajor >= minor;
  }

  estimateEffort(name: string): number {
    return this.effortWeight[name] ?? 0.5;
  }

  isCopyleft(license: string | null | undefined): boolean {
    if (!license) return false;
    return this.copyleft.has(license.trim());
  }

  /** Returns alternatives for a package name, if any. */
  getAlternatives(name: string): Alternative[] {
    return this.deprecations[name]?.alternatives ?? [];
  }

  /** Known ng-update schematics are maintained in the report service, but we
   *  expose a helper here for the rollback/command generator. */
  isAngularScoped(name: string): boolean {
    return name.startsWith('@angular/');
  }
}
