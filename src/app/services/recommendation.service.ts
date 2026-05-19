import { Injectable } from '@angular/core';
import { Recommendation, VersionCompatibility } from '../models/npm-package.model';

/**
 * Computes "the best version to install" for a given Angular major.
 * Strategy: among rows that satisfy the target major AND are not deprecated,
 *  - `stable`  → highest non-prerelease
 *  - `latest`  → highest overall (falls back to prerelease if no stable)
 */
@Injectable({ providedIn: 'root' })
export class RecommendationService {
  forMajor(rows: VersionCompatibility[], angularMajor: number): Recommendation {
    const matches = rows
      .filter((r) => r.supportedAngularMajors.includes(angularMajor))
      .filter((r) => !r.isDeprecated);

    // Rows are already sorted descending by semver in the service pipeline,
    // but we defensively sort again by publishedAt desc when semver is equal.
    const all = [...matches].sort((a, b) => {
      const d = (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0);
      return d;
    });

    const stable = all.find((r) => !r.isPrerelease) ?? null;
    const latest = all[0] ?? null;

    return { angularMajor, stable, latest, all };
  }

  /** Given a range of Angular majors, produce one recommendation per major. */
  forRange(rows: VersionCompatibility[], majors: number[]): Recommendation[] {
    return majors.map((m) => this.forMajor(rows, m));
  }
}
