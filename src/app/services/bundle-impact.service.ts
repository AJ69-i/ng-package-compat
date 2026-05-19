import { Injectable, inject } from '@angular/core';
import { Observable, forkJoin, of } from 'rxjs';
import { map } from 'rxjs/operators';
import { BundleDelta } from '../models/npm-package.model';
import { BundlephobiaService } from './bundlephobia.service';

/**
 * Computes a bundle-size delta between a package's current version and its
 * recommended (target) version, using BundlePhobia's public API.
 *
 * Returns `null` for any pair we can't resolve — the UI treats null as
 * "unknown" (no badge shown), never as "no change".
 */
@Injectable({ providedIn: 'root' })
export class BundleImpactService {
  private readonly bp = inject(BundlephobiaService);

  delta(
    name: string,
    currentVersion: string | null,
    recommendedVersion: string | null
  ): Observable<BundleDelta | null> {
    if (!recommendedVersion) return of(null);
    const current$ = currentVersion
      ? this.bp.size(name, currentVersion)
      : of(null);
    const recommended$ = this.bp.size(name, recommendedVersion);
    return forkJoin([current$, recommended$]).pipe(
      map(([cur, rec]) => {
        if (!rec) return null;
        const currentGzip = cur?.gzip ?? null;
        const recommendedGzip = rec.gzip;
        if (currentGzip == null) {
          return {
            currentGzip: null,
            recommendedGzip,
            deltaBytes: null,
            deltaPercent: null
          };
        }
        const deltaBytes = recommendedGzip - currentGzip;
        const deltaPercent = currentGzip > 0 ? (deltaBytes / currentGzip) * 100 : null;
        return {
          currentGzip,
          recommendedGzip,
          deltaBytes,
          deltaPercent
        };
      })
    );
  }
}
