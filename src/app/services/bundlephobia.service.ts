import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { catchError, Observable, of } from 'rxjs';
import { BundleSize } from '../models/npm-package.model';

@Injectable({ providedIn: 'root' })
export class BundlephobiaService {
  private readonly http = inject(HttpClient);
  private readonly base = 'https://bundlephobia.com/api/size';

  /**
   * Returns bundle size (min + gzip) for a specific version.
   * Swallows errors (bundlephobia can return 4xx for deprecated/private pkgs)
   * and emits `null` in that case — the UI treats null as "unknown".
   */
  size(packageName: string, version: string): Observable<BundleSize | null> {
    const param = `${packageName}@${version}`;
    return this.http
      .get<BundleSize>(this.base, { params: { package: param } })
      .pipe(catchError(() => of(null as BundleSize | null)));
  }
}
