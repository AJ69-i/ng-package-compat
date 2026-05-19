import { Injectable } from '@angular/core';

/**
 * Terminal-version knowledge for abandoned Angular-ecosystem libraries.
 *
 * Some packages were never formally deprecated on npm, but their
 * maintainers went silent years ago. Teams on a budget still run them in
 * production because no alternative offers a free, drop-in migration.
 *
 * For those packages, we record the exact last version that still works
 * against each Angular major. Users get a pinned install line they can
 * paste into their package.json and know they are buying themselves
 * another 12-24 months while they plan the proper migration.
 */
export interface DeadPin {
  /** Last npm version that still compiles / runs against this Angular major. */
  version: string;
  /** A short note — typically explains why this is the last working version. */
  note: string;
}

export type DeadPinTable = Record<number, DeadPin>;

@Injectable({ providedIn: 'root' })
export class DeadButWorkingService {
  /**
   * Keyed first by package name, then by Angular major.
   */
  private readonly table: Record<string, DeadPinTable> = {
    '@agm/core': {
      14: { version: '1.1.0', note: 'Last @agm/core release compatible with Angular Ivy + 14.' },
      15: { version: '1.1.0', note: 'Builds with ngcc disabled; disable strictMetadataEmit if needed.' },
      16: { version: '1.1.0', note: 'Needs explicit allowedCommonJsDependencies in angular.json.' },
      17: { version: '1.1.0', note: 'Runs if you opt out of the new application builder.' },
      18: { version: '1.1.0', note: 'Still loads but will not compile under standalone-first bootstrap.' }
    },
    '@angular/flex-layout': {
      14: { version: '14.0.0-beta.41', note: 'Final official release before deprecation.' },
      15: { version: '15.0.0-beta.42', note: 'Unofficial beta; use if migration budget is zero this quarter.' },
      16: { version: '15.0.0-beta.42', note: 'Compiles with peerDependency override; no new features will arrive.' },
      17: { version: '15.0.0-beta.42', note: 'Works with npm overrides; standalone components still render correctly.' }
    },
    'ngx-moment': {
      14: { version: '6.0.2', note: 'Last release with Angular 14 peer range.' },
      15: { version: '6.0.2', note: 'Compiles with peer-override; moment itself is in maintenance mode.' },
      16: { version: '6.0.2', note: 'Works but emits deprecation warnings.' }
    },
    'angular-calendar': {
      14: { version: '0.30.1', note: 'Last release before the maintainer went quiet.' },
      15: { version: '0.30.1', note: 'Installs via overrides; keep CommonJS warnings suppressed.' },
      16: { version: '0.30.1', note: 'Compiles; requires manually bumping peer of date-fns.' }
    },
    'ngx-quill': {
      14: { version: '21.0.0', note: 'Pre-standalone refactor; needs NgModule wrappers.' },
      15: { version: '22.3.0', note: 'Last 22.x; still uses NgModules.' },
      16: { version: '22.3.0', note: 'Compiles; suppress deprecation warnings about quill v1.' }
    },
    'ng-recaptcha': {
      14: { version: '11.0.0', note: 'Last version pre-standalone refactor.' },
      15: { version: '12.0.2', note: 'Compatible with Angular 15 IVY.' },
      16: { version: '13.2.1', note: 'Peer updated to Angular 16; later versions require 17.' }
    },
    'ngx-infinite-scroll': {
      14: { version: '14.0.1', note: 'Angular 14 peer; no new features since 2022.' },
      15: { version: '15.0.0', note: 'Unofficial jump to 15; scroll APIs unchanged.' },
      16: { version: '16.0.0', note: 'Community bump to Angular 16 peer; no code changes.' }
    },
    'angular2-datatable': {
      14: { version: '0.6.0', note: 'Final release; project is archived — migrate to @angular/cdk/table.' },
      15: { version: '0.6.0', note: 'Not officially supported; compiles with npm overrides.' }
    },
    'ng2-file-upload': {
      14: { version: '4.0.0', note: 'Last release under the valor-software org.' },
      15: { version: '4.0.0', note: 'Install via peer override; consider @angular/cdk file-drop primitives.' },
      16: { version: '4.0.0', note: 'Works; suppress peer-dependency warnings.' }
    }
  };

  /**
   * Return the last-known-working pin for a given package + Angular major.
   * Returns null if no pin is known.
   */
  lastWorkingFor(pkgName: string, ngMajor: number): DeadPin | null {
    const byMajor = this.table[pkgName];
    if (!byMajor) return null;
    if (byMajor[ngMajor]) return byMajor[ngMajor];

    // Fallback: return the highest major <= ngMajor (best-effort).
    const candidates = Object.keys(byMajor)
      .map(Number)
      .filter((m) => m <= ngMajor)
      .sort((a, b) => b - a);
    return candidates.length ? byMajor[candidates[0]] : null;
  }

  /**
   * Does this package have at least one dead-pin recorded?
   */
  has(pkgName: string): boolean {
    return !!this.table[pkgName];
  }

  /**
   * Return the raw table — used by the knowledge-base / about page.
   */
  all(): Record<string, DeadPinTable> {
    return this.table;
  }

  /**
   * Count of packages currently in the knowledge base.
   */
  get size(): number {
    return Object.keys(this.table).length;
  }
}
