import { Injectable } from '@angular/core';
import * as semver from 'semver';
import { MfeAnalysis, ParsedPackageJson } from '../models/npm-package.model';

/**
 * Cross-references multiple `package.json` files (one per micro-frontend app)
 * and checks whether the shared-runtime libraries (Angular core, RxJS, Zone.js,
 * shared state / router / material) are pinned to exactly the same version
 * across every host.
 *
 * Module Federation will silently load duplicate copies of a library if the
 * versions don't match — this service makes that risk visible.
 */
@Injectable({ providedIn: 'root' })
export class MfeAnalyzerService {
  /**
   * Libraries that MUST be shared as singletons in a federated setup. If two
   * apps declare different versions of these, the browser will load both
   * copies and the app will break in subtle ways.
   */
  private readonly sharedLibs = [
    '@angular/core',
    '@angular/common',
    '@angular/router',
    '@angular/forms',
    '@angular/platform-browser',
    '@angular/animations',
    '@angular/material',
    '@angular/cdk',
    '@ngrx/store',
    '@ngrx/effects',
    '@ngrx/signals',
    'rxjs',
    'zone.js',
    'tslib',
    '@angular-architects/module-federation',
    '@angular-architects/native-federation'
  ];

  analyze(apps: ParsedPackageJson[]): MfeAnalysis {
    const appNames = apps.map((a, i) => a.name || `app-${i + 1}`);
    const sharedDeps: MfeAnalysis['sharedDeps'] = [];

    for (const lib of this.sharedLibs) {
      const versions: Record<string, string> = {};
      for (const [i, app] of apps.entries()) {
        const dep = app.deps.find((d) => d.name === lib);
        if (dep?.range) {
          versions[appNames[i]] = dep.range;
        }
      }
      // Only surface if at least two apps declare it.
      const appsUsing = Object.keys(versions);
      if (appsUsing.length < 2) continue;

      const consistent = this.allEqual(appsUsing.map((a) => versions[a]));
      sharedDeps.push({ name: lib, versions, consistent });
    }

    return { apps: appNames, sharedDeps };
  }

  private allEqual(ranges: string[]): boolean {
    if (ranges.length < 2) return true;
    const first = this.normalize(ranges[0]);
    return ranges.every((r) => this.normalize(r) === first);
  }

  /**
   * Normalize a range to its minimum concrete version so `^16.2.0` and
   * `~16.2.0` are treated as the same minimum (but `^16.2.0` vs `^17.0.0`
   * will diverge).
   */
  private normalize(range: string): string {
    const min = semver.minVersion(range);
    return min ? min.version : range.trim();
  }
}
