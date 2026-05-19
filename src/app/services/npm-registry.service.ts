import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, retry, timer } from 'rxjs';
import { NpmRegistryResponse } from '../models/npm-package.model';
import { RegistryConfigService } from './registry-config.service';

@Injectable({ providedIn: 'root' })
export class NpmRegistryService {
  private readonly http = inject(HttpClient);
  private readonly registryConfig = inject(RegistryConfigService);

  /**
   * Fetch full package metadata. Scoped packages are URL-encoded correctly,
   * and the request is routed through RegistryConfigService so private /
   * enterprise registries (Artifactory, Verdaccio, GitHub Packages, etc.)
   * pick up the right base URL + auth header.
   */
  fetchPackage(packageName: string): Observable<NpmRegistryResponse> {
    const url = this.registryConfig.buildUrl(packageName);
    const headers = this.registryConfig.buildHeaders(packageName);
    return this.http
      .get<NpmRegistryResponse>(url, headers ? { headers } : {})
      .pipe(
        retry({
          count: 2,
          // Do not retry 404s — that's a real "not found". And do not retry
          // 401/403s either — that's a user-supplied-token problem, retrying
          // just wastes their rate limit.
          delay: (err, attempt) => {
            if (err?.status === 404 || err?.status === 401 || err?.status === 403) throw err;
            return timer(400 * attempt);
          }
        })
      );
  }
}
