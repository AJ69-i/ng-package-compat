import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { catchError, map, Observable, of } from 'rxjs';
import { Advisory } from '../models/npm-package.model';

interface OsvQueryResponse {
  vulns?: Array<{
    id: string;
    summary?: string;
    details?: string;
    published?: string;
    severity?: Array<{ type: string; score: string }>;
    affected?: Array<{
      package?: { ecosystem?: string; name?: string };
      ranges?: Array<{
        type: string;
        events: Array<{ introduced?: string; fixed?: string; last_affected?: string }>;
      }>;
    }>;
    references?: Array<{ type: string; url: string }>;
  }>;
}

@Injectable({ providedIn: 'root' })
export class AdvisoriesService {
  private readonly http = inject(HttpClient);
  private readonly endpoint = 'https://api.osv.dev/v1/query';

  /**
   * Query OSV.dev for known advisories on an npm package.
   * OSV is CORS-friendly and unauthenticated.
   */
  forPackage(packageName: string): Observable<Advisory[]> {
    return this.http
      .post<OsvQueryResponse>(this.endpoint, {
        package: { ecosystem: 'npm', name: packageName }
      })
      .pipe(
        map((res) => this.normalize(res)),
        catchError(() => of([] as Advisory[]))
      );
  }

  private normalize(res: OsvQueryResponse): Advisory[] {
    const vulns = res.vulns ?? [];
    return vulns.map((v) => {
      const ranges: string[] = [];
      for (const a of v.affected ?? []) {
        if (a.package?.ecosystem !== 'npm') continue;
        for (const r of a.ranges ?? []) {
          const intro = r.events.find((e) => e.introduced)?.introduced;
          const fixed = r.events.find((e) => e.fixed)?.fixed;
          const lastAff = r.events.find((e) => e.last_affected)?.last_affected;
          if (intro && fixed) ranges.push(`>=${intro} <${fixed}`);
          else if (intro && lastAff) ranges.push(`>=${intro} <=${lastAff}`);
          else if (intro) ranges.push(`>=${intro}`);
        }
      }
      return {
        id: v.id,
        summary: v.summary ?? v.details?.split('\n')[0] ?? v.id,
        severity: v.severity?.[0]?.score,
        affectedRanges: ranges.join(', ') || '*',
        references: (v.references ?? []).map((r) => r.url),
        publishedAt: v.published ? new Date(v.published) : undefined
      };
    });
  }
}
