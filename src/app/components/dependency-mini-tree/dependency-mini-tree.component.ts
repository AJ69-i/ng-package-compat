import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TranslocoModule } from '@jsverse/transloco';
import { CopyOnClickDirective } from '../../directives/copy-on-click.directive';

/**
 * Compact "Top 5 direct dependencies" preview (Phase 3 feature #7).
 *
 * # Why this exists
 *
 * The full dependency tree page (/dependencies/<pkg>/<version>) is
 * powerful but unloved — most users land on /search and never click
 * through to it. By surfacing the top few direct deps inline on the
 * search results page itself, we turn "what is this package built
 * on?" from a deep-link question into a glance.
 *
 * # What we render
 *
 * - The first 6-8 entries of `pkg.versions[latest].dependencies`.
 *   We don't sort or rank — package.json key order is meaningful
 *   (maintainers list them in importance order more often than not).
 * - Each as a compact chip: name + range.
 * - A "View full tree" link to the dedicated /dependencies route
 *   when there are more than what we show, OR when there are any
 *   dependencies at all (so even small-dep packages get the
 *   discoverability hook).
 *
 * # What we DON'T do here
 *
 * - No per-dep health fetching. That requires N npm-registry calls
 *   and the /dependencies route already does it. This component is
 *   a fast inline preview, not a mini version of that page.
 * - No transitive resolution. Direct deps only.
 *
 * The component is signal-driven and idempotent — pass a fresh
 * dependencies object, get a fresh render.
 */
@Component({
  selector: 'app-dependency-mini-tree',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, RouterLink, TranslocoModule, CopyOnClickDirective],
  template: `
    @if (entries().length > 0) {
      <section class="deps" [attr.aria-label]="'depsMiniTree.aria' | transloco">
        <header class="head">
          <span class="ico" aria-hidden="true">⤴</span>
          <h3 class="title">
            {{ 'depsMiniTree.title' | transloco: { n: count() } }}
          </h3>
          @if (count() > maxEntries()) {
            <span class="more-hint">
              {{ 'depsMiniTree.showingTop' | transloco: { shown: maxEntries(), total: count() } }}
            </span>
          }
          <span class="grow"></span>
          @if (pkgName() && versionForLink()) {
            <a
              class="full-link"
              [routerLink]="['/dependencies', pkgName(), versionForLink()]"
            >
              {{ 'depsMiniTree.viewFull' | transloco }} →
            </a>
          }
        </header>

        <div class="chips" role="list">
          @for (e of entries(); track e.name) {
            <span
              class="dep-chip"
              role="listitem"
              [appCopyOnClick]="e.name + '@' + e.range"
              copyLabel="dependency spec"
            >
              <code class="dep-name">{{ e.name }}</code>
              <code class="dep-range">{{ e.range }}</code>
            </span>
          }
        </div>

        @if (count() === 0) {
          <p class="empty muted">{{ 'depsMiniTree.none' | transloco }}</p>
        }
      </section>
    }
  `,
  styles: [`
    :host { display: block; margin-top: 1.25rem; }

    .deps {
      padding: 1rem 1.15rem;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg, 12px);
    }

    .head {
      display: flex;
      align-items: center;
      gap: 0.55rem;
      margin-bottom: 0.7rem;
    }
    .ico { font-size: 1.1rem; line-height: 1; color: var(--accent); }
    .title {
      margin: 0;
      font-size: 0.95rem;
      font-weight: 700;
      color: var(--fg);
    }
    .more-hint {
      font-size: 0.78rem;
      color: var(--fg-dim);
      font-weight: 500;
    }
    .grow { flex: 1 1 auto; }
    .full-link {
      color: var(--accent);
      text-decoration: none;
      font-size: 0.82rem;
      font-weight: 600;
    }
    .full-link:hover { text-decoration: underline; }

    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
    }

    /* Each chip is a name + range pair. Visually they read as a
       single unit — the range is dim and right-aligned inside the
       chip. Cursor:copy makes the click-to-copy affordance obvious. */
    .dep-chip {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.3rem 0.65rem;
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-md, 10px);
      font-size: 0.82rem;
      cursor: copy;
      transition: border-color 140ms ease, background-color 140ms ease;
    }
    .dep-chip:hover {
      border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
      background: color-mix(in srgb, var(--accent) 4%, var(--surface-1));
    }
    .dep-name {
      color: var(--fg);
      font-weight: 600;
      background: none;
      border: none;
      padding: 0;
    }
    .dep-range {
      color: var(--fg-dim);
      font-size: 0.78rem;
      background: none;
      border: none;
      padding: 0;
    }

    .empty { margin: 0; color: var(--fg-dim); font-size: 0.85rem; }
    .muted { color: var(--fg-dim); }
  `]
})
export class DependencyMiniTreeComponent {
  /**
   * Raw dependencies map from `pkg.versions[latest].dependencies`
   * (or any equivalent shape). Order is preserved — package.json key
   * order is meaningful so we don't sort.
   */
  readonly dependencies = input<Record<string, string> | null | undefined>(null);
  /** Used for the routerLink to /dependencies/:pkg/:version. */
  readonly pkgName = input<string | null>(null);
  /** Used for the routerLink to /dependencies/:pkg/:version. */
  readonly version = input<string | null>(null);
  /** Maximum chip count to render before showing the "viewing top N of M" line. */
  readonly maxEntries = input<number>(8);

  /** All entries flattened. Used for the count line. */
  readonly count = computed<number>(() => Object.keys(this.dependencies() ?? {}).length);

  /** Capped entries for the chip row. */
  readonly entries = computed<Array<{ name: string; range: string }>>(() => {
    const deps = this.dependencies() ?? {};
    const cap = this.maxEntries();
    return Object.entries(deps)
      .slice(0, cap)
      .map(([name, range]) => ({ name, range }));
  });

  /**
   * `version` is optional — when absent we don't render the
   * "View full tree" link (the /dependencies route requires both
   * package and version segments).
   */
  readonly versionForLink = computed<string | null>(() => this.version() || null);
}
