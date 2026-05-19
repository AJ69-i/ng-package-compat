import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { FiltersService } from '../../services/filters.service';
import { SortDir, SortKey, VersionCompatibility } from '../../models/npm-package.model';

@Component({
  selector: 'app-filters-bar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="bar" role="toolbar" aria-label="Version filters">
      <label class="field search">
        <span>Search version</span>
        <input
          type="search"
          [ngModel]="filters.filters().search"
          (ngModelChange)="filters.patch({ search: $event })"
          placeholder="e.g. 1.2 or 17"
          aria-label="Search versions"
        />
      </label>

      <label class="field">
        <span>Angular major</span>
        <select
          [ngModel]="filters.filters().onlyAngularMajor ?? ''"
          (ngModelChange)="onMajor($event)"
          aria-label="Filter by Angular major"
        >
          <option value="">Any</option>
          @for (m of majors(); track m) {
            <option [ngValue]="m">{{ m }}</option>
          }
        </select>
      </label>

      <label class="field check">
        <input
          type="checkbox"
          [ngModel]="filters.filters().hideDeprecated"
          (ngModelChange)="filters.patch({ hideDeprecated: $event })"
        />
        Hide deprecated
      </label>
      <label class="field check">
        <input
          type="checkbox"
          [ngModel]="filters.filters().hidePrerelease"
          (ngModelChange)="filters.patch({ hidePrerelease: $event })"
        />
        Hide pre-release
      </label>

      <label class="field">
        <span>From</span>
        <input
          type="date"
          [ngModel]="filters.filters().minPublishDate"
          (ngModelChange)="filters.patch({ minPublishDate: $event || null })"
          aria-label="Published from"
        />
      </label>
      <label class="field">
        <span>To</span>
        <input
          type="date"
          [ngModel]="filters.filters().maxPublishDate"
          (ngModelChange)="filters.patch({ maxPublishDate: $event || null })"
          aria-label="Published to"
        />
      </label>

      <label class="field">
        <span>Sort</span>
        <select [ngModel]="filters.sortKey()" (ngModelChange)="onSortKey($event)">
          <option value="semver">Semver</option>
          <option value="date">Date</option>
          <option value="major">Angular major</option>
        </select>
      </label>

      <button
        type="button"
        class="sort-dir"
        (click)="toggleDir()"
        [attr.aria-label]="'Sort direction: ' + filters.sortDir()"
        [title]="'Sort direction'"
      >
        {{ filters.sortDir() === 'asc' ? '▲ asc' : '▼ desc' }}
      </button>

      @if (filters.hasActiveFilters()) {
        <button type="button" class="reset" (click)="filters.reset()">Reset</button>
      }
    </div>
  `,
  styles: [`
    .bar {
      display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0.6rem;
      padding: 0.75rem; border: 1px solid var(--border); border-radius: 12px;
      background: var(--surface-1); margin-top: 0.5rem;
    }
    .field { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.75rem; color: var(--fg-dim); }
    .field.check { flex-direction: row; align-items: center; gap: 0.35rem; color: var(--fg); font-size: 0.85rem; }
    .field input[type="search"], .field input[type="date"], .field select {
      padding: 0.4rem 0.6rem; background: var(--surface-2); color: var(--fg);
      border: 1px solid var(--border); border-radius: 8px; min-height: 36px;
      min-width: 120px; font-size: 0.85rem;
    }
    .field.search input { min-width: 180px; }
    .sort-dir, .reset {
      padding: 0.4rem 0.75rem; background: var(--surface-2);
      border: 1px solid var(--border); border-radius: 8px; color: var(--fg);
      cursor: pointer; min-height: 36px; font-size: 0.85rem;
    }
    .reset { color: var(--accent); border-color: var(--accent); }
    @media (max-width: 600px) {
      .bar { padding: 0.6rem; }
      .field.search input { min-width: 100%; }
      .field { flex: 1 1 45%; }
      .field.check { flex: 1 1 100%; }
    }
  `]
})
export class FiltersBarComponent {
  readonly filters = inject(FiltersService);
  readonly availableMajors = input<number[]>([]);
  readonly rows = input<VersionCompatibility[]>([]);

  readonly majors = computed(() => {
    const provided = this.availableMajors();
    if (provided.length) return [...provided].sort((a, b) => b - a);
    const set = new Set<number>();
    for (const r of this.rows()) for (const m of r.supportedAngularMajors) set.add(m);
    return [...set].sort((a, b) => b - a);
  });

  onMajor(value: number | string | null): void {
    const major = value === '' || value === null ? null : Number(value);
    this.filters.patch({ onlyAngularMajor: Number.isNaN(major) ? null : major });
  }

  onSortKey(value: SortKey): void {
    this.filters.sortKey.set(value);
  }

  toggleDir(): void {
    this.filters.sortDir.update((d: SortDir) => (d === 'asc' ? 'desc' : 'asc'));
  }
}
