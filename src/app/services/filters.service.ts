import { Injectable, computed, signal } from '@angular/core';
import { SortDir, SortKey, VersionCompatibility, VersionFilters } from '../models/npm-package.model';
import { CompatibilityService } from './compatibility.service';

const INITIAL: VersionFilters = {
  hideDeprecated: false,
  hidePrerelease: false,
  onlyAngularMajor: null,
  minPublishDate: null,
  maxPublishDate: null,
  search: ''
};

@Injectable({ providedIn: 'root' })
export class FiltersService {
  constructor(private readonly compat: CompatibilityService) {}

  readonly filters = signal<VersionFilters>({ ...INITIAL });
  readonly sortKey = signal<SortKey>('semver');
  readonly sortDir = signal<SortDir>('desc');

  readonly hasActiveFilters = computed(() => {
    const f = this.filters();
    return (
      f.hideDeprecated ||
      f.hidePrerelease ||
      f.onlyAngularMajor !== null ||
      !!f.minPublishDate ||
      !!f.maxPublishDate ||
      !!f.search
    );
  });

  reset(): void {
    this.filters.set({ ...INITIAL });
    this.sortKey.set('semver');
    this.sortDir.set('desc');
  }

  patch(partial: Partial<VersionFilters>): void {
    this.filters.update((f) => ({ ...f, ...partial }));
  }

  apply(rows: VersionCompatibility[]): VersionCompatibility[] {
    const f = this.filters();
    const search = f.search.trim().toLowerCase();
    const min = f.minPublishDate ? new Date(f.minPublishDate).getTime() : null;
    const max = f.maxPublishDate ? new Date(f.maxPublishDate).getTime() : null;

    let out = rows.filter((r) => {
      if (f.hideDeprecated && r.isDeprecated) return false;
      if (f.hidePrerelease && r.isPrerelease) return false;
      if (f.onlyAngularMajor !== null && !r.supportedAngularMajors.includes(f.onlyAngularMajor)) {
        return false;
      }
      if (min !== null && (!r.publishedAt || r.publishedAt.getTime() < min)) return false;
      if (max !== null && (!r.publishedAt || r.publishedAt.getTime() > max)) return false;
      if (search && !r.version.toLowerCase().includes(search)) return false;
      return true;
    });

    const key = this.sortKey();
    const dir = this.sortDir();
    out = [...out].sort((a, b) => {
      let cmp = 0;
      if (key === 'semver') cmp = this.compat.compareSemverAsc(a.version, b.version);
      else if (key === 'date') {
        cmp = (a.publishedAt?.getTime() ?? 0) - (b.publishedAt?.getTime() ?? 0);
      } else if (key === 'major') {
        const ma = Math.max(0, ...a.supportedAngularMajors);
        const mb = Math.max(0, ...b.supportedAngularMajors);
        cmp = ma - mb;
      }
      return dir === 'asc' ? cmp : -cmp;
    });

    return out;
  }
}
