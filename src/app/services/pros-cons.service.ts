import { Injectable } from '@angular/core';

/**
 * One row in a side-by-side comparison.
 *
 * When we tell a team "stop using X, use Y", they immediately ask:
 * "OK, but what are the trade-offs?". This service encodes those
 * answers as structured data so the UI can render a consistent,
 * scannable comparison table.
 */
export interface ProsConsEntry {
  /** Alternative package / tool name. */
  name: string;
  /** Short verdict/recommendation summary. */
  verdict: string;
  /** Bulleted pros — keep short, scannable. */
  pros: string[];
  /** Bulleted cons / caveats. */
  cons: string[];
  /** Optional external link to the project. */
  link?: string;
}

/**
 * Curated pros/cons for common "replace deprecated X with modern Y" swaps
 * in the Angular ecosystem.
 */
@Injectable({ providedIn: 'root' })
export class ProsConsService {
  private readonly table: Record<string, ProsConsEntry[]> = {
    '@angular/flex-layout': [
      {
        name: 'tailwindcss',
        verdict: 'Recommended for most new Angular apps.',
        pros: [
          'Utility-first classes compose cleanly with Angular templates',
          'Zero runtime JS — compiled to static CSS',
          'Massive community, great documentation, strong Angular tooling',
          'Dark-mode, RTL and responsive variants built in'
        ],
          cons: [
          'Bigger initial learning curve for teams coming from SCSS/BEM',
          'Requires a build-time step and a tailwind.config.js',
          'HTML can become verbose without component extraction'
        ],
        link: 'https://tailwindcss.com'
      },
      {
        name: 'Native CSS Grid + Flexbox',
        verdict: 'Good for small projects or design systems.',
        pros: [
          'No third-party dependency whatsoever',
          'First-class browser support, including evergreen mobile browsers',
          'Best long-term bet — browser primitives do not get deprecated'
        ],
        cons: [
          'You lose the responsive-breakpoint DSL fxLayout.xs / fxLayout.gt-md',
          'Requires reaching for CSS variables / container queries for breakpoints',
          'More manual work for complex responsive dashboards'
        ]
      }
    ],
    'protractor': [
      {
        name: 'cypress',
        verdict: 'Best DX, easiest to adopt for existing Angular teams.',
        pros: [
          'Interactive time-travel runner makes debugging trivial',
          'Excellent documentation and video walkthroughs',
          'Native screenshots, video recording, retries',
          'Cypress Cloud integrates with every major CI'
        ],
        cons: [
          'Single-browser per run (though multi-browser support is improving)',
          'Different execution model than traditional Selenium — needs some rewriting',
          'Cypress Cloud is paid for serious parallelisation'
        ],
        link: 'https://www.cypress.io'
      },
      {
        name: '@playwright/test',
        verdict: 'Best for cross-browser matrices and parallel execution.',
        pros: [
          'Runs Chromium, Firefox and WebKit in one suite',
          'Excellent auto-waiting, network interception, and trace viewer',
          'Parallelism is first-class; no paid tier to unlock',
          'Component testing support for Angular (beta)'
        ],
        cons: [
          'Less mature Angular-specific community than Cypress',
          'Slightly steeper API surface',
          'Trace viewer runs best with Playwright-hosted report server'
        ],
        link: 'https://playwright.dev'
      }
    ],
    'tslint': [
      {
        name: '@angular-eslint/schematics',
        verdict: 'Drop-in replacement — run once, get an ESLint setup.',
        pros: [
          'Official Angular tooling, receives regular updates',
          'Rich ecosystem (rxjs rules, import-sorting, etc.)',
          'Converts existing tslint.json automatically',
          'Aligns the Angular project with the broader JS/TS ecosystem'
        ],
        cons: [
          'Initial migration needs a clean commit to avoid massive diffs',
          'Some bespoke TSLint rules do not have ESLint equivalents',
          'Performance on very large monorepos requires configuration tuning'
        ],
        link: 'https://github.com/angular-eslint/angular-eslint'
      }
    ],
    'karma': [
      {
        name: 'jest',
        verdict: 'Mature, fast, great Angular preset via jest-preset-angular.',
        pros: [
          'Parallel test execution out of the box',
          'Rich matchers, snapshot testing, great mocking primitives',
          'Large community, battle-tested on React + Angular codebases'
        ],
        cons: [
          'Not a real browser — some DOM / Zone.js edge cases differ',
          'jest-preset-angular has to keep pace with Angular releases',
          'Test files that rely on real rendering need migration'
        ],
        link: 'https://jestjs.io'
      },
      {
        name: '@web/test-runner',
        verdict: 'Run tests in real browsers (Playwright) with ESM support.',
        pros: [
          'Executes in a real browser — highest fidelity to production',
          'ESM-native, great for zoneless Angular',
          'Pluggable runner (Playwright / Puppeteer / Selenium)'
        ],
        cons: [
          'Younger ecosystem, fewer Angular-specific recipes',
          'Requires more custom setup than Jest',
          'Coverage tooling is less polished'
        ],
        link: 'https://modern-web.dev/docs/test-runner/overview/'
      },
      {
        name: 'vitest',
        verdict: 'Fastest option for Vite-based workspaces.',
        pros: [
          'Vite-speed cold starts; incremental reruns are near-instant',
          'Jest-compatible API — easy migration from Jest',
          'Works great with AnalogJS / Vite-based Angular setups'
        ],
        cons: [
          'Node-based by default (jsdom) — needs extra config for browsers',
          'Angular preset still maturing',
          'Not an official Angular blessed path yet'
        ],
        link: 'https://vitest.dev'
      }
    ],
    '@angular/http': [
      {
        name: '@angular/common/http',
        verdict: 'Required — this is the only supported path.',
        pros: [
          'Modern, tree-shakable HttpClient with interceptor support',
          'Typed responses, request caching, testability',
          'Built into every supported Angular version'
        ],
        cons: [
          'Breaking API change from the legacy @angular/http Http class',
          'Requires a one-time refactor to swap .get<T>() and .post<T>()'
        ],
        link: 'https://angular.dev/guide/http'
      }
    ],
    'ngx-bootstrap': [
      {
        name: 'ng-bootstrap',
        verdict: 'Consider for new projects on Bootstrap 5 / Angular 17+.',
        pros: [
          'Actively maintained with newer Angular major support',
          'Strictly Bootstrap 5 native, no jQuery dependency',
          'Smaller bundle footprint for individual components'
        ],
        cons: [
          'Different API — migration from ngx-bootstrap is non-trivial',
          'Smaller component set than ngx-bootstrap historically'
        ],
        link: 'https://ng-bootstrap.github.io'
      }
    ],
    'moment': [
      {
        name: 'date-fns',
        verdict: 'Preferred for tree-shakable, immutable date utilities.',
        pros: [
          'Tree-shakes to near-zero in production builds',
          'Immutable by default — no in-place mutation bugs',
          'Excellent TypeScript types'
        ],
        cons: [
          'Functional API is a mindset shift from moment chains',
          'Timezone handling requires date-fns-tz separately'
        ],
        link: 'https://date-fns.org'
      },
      {
        name: 'luxon',
        verdict: 'Best for heavy timezone / locale use cases.',
        pros: [
          'Built on top of Intl.DateTimeFormat — strong timezone + locale support',
          'Immutable, chainable, modern API',
          'Authored by the same team that maintained moment'
        ],
        cons: [
          'Larger than date-fns for simple use cases',
          'Some locale bundles still need explicit loading'
        ],
        link: 'https://moment.github.io/luxon/'
      }
    ]
  };

  /**
   * Return the structured pros/cons comparison for the given package name.
   */
  for(pkgName: string): ProsConsEntry[] {
    return this.table[pkgName] ?? [];
  }

  /**
   * Number of packages currently covered by the pros/cons knowledge base.
   */
  get size(): number {
    return Object.keys(this.table).length;
  }
}
