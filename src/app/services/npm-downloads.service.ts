import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { map, Observable } from 'rxjs';
import { NpmDownloadsRange } from '../models/npm-package.model';

@Injectable({ providedIn: 'root' })
export class NpmDownloadsService {
  private readonly http = inject(HttpClient);
  private readonly base = 'https://api.npmjs.org/downloads';

  /**
   * Aggregate weekly downloads for the last 8 weeks.
   * Returns (weekStartISO, downloads) tuples newest last.
   */
  weeklyTrend(packageName: string, weeks = 8): Observable<Array<{ week: string; downloads: number }>> {
    const end = new Date();
    const start = new Date();
    start.setUTCDate(end.getUTCDate() - weeks * 7 + 1);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const range = `${fmt(start)}:${fmt(end)}`;
    const encoded = packageName.startsWith('@')
      ? '@' + encodeURIComponent(packageName.slice(1))
      : encodeURIComponent(packageName);

    return this.http
      .get<NpmDownloadsRange>(`${this.base}/range/${range}/${encoded}`)
      .pipe(
        map((res) => {
          const days = res.downloads ?? [];
          const out: Array<{ week: string; downloads: number }> = [];
          for (let i = 0; i < days.length; i += 7) {
            const chunk = days.slice(i, i + 7);
            if (!chunk.length) continue;
            out.push({
              week: chunk[0].day,
              downloads: chunk.reduce((acc, d) => acc + (d.downloads ?? 0), 0)
            });
          }
          return out;
        })
      );
  }
}
