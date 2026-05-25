import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';

export interface Crumb {
  label: string;
  link?: string | any[];
  /**
   * Optional query-params to append to the routerLink. Critical for
   * crumbs that point back at the Search page — clicking the package
   * name needs to land on `/?q=<pkg>` so the search-page effect
   * re-hydrates the package, not on bare `/` (which renders the
   * empty welcome state and loses the user's context).
   */
  queryParams?: Record<string, string | number | null>;
}

@Component({
  selector: 'app-breadcrumbs',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, RouterLink],
  template: `
    <nav class="breadcrumbs" aria-label="Breadcrumb">
      <ol>
        @for (c of crumbs(); track c.label; let last = $last) {
          <li [class.current]="last">
            @if (!last && c.link) {
              <a [routerLink]="c.link" [queryParams]="c.queryParams ?? null">{{ c.label }}</a>
              <span class="sep" aria-hidden="true">›</span>
            } @else {
              <span>{{ c.label }}</span>
            }
          </li>
        }
      </ol>
    </nav>
  `,
  styles: [`
    .breadcrumbs { padding: 0.75rem 0; font-size: 0.85rem; color: var(--fg-dim); }
    .breadcrumbs ol { list-style: none; display: flex; flex-wrap: wrap; gap: 0.25rem; padding: 0; margin: 0; }
    .breadcrumbs a { color: var(--accent); text-decoration: none; }
    .breadcrumbs a:hover { text-decoration: underline; }
    .breadcrumbs .sep { margin: 0 0.4rem; color: var(--fg-dim); }
    .breadcrumbs .current span { color: var(--fg); font-weight: 600; }
  `]
})
export class BreadcrumbsComponent {
  readonly crumbs = input<Crumb[]>([]);
}
