import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { catchError, of, switchMap } from 'rxjs';
import { NpmRegistryService } from '../../services/npm-registry.service';
import { VersionDiffService } from '../../services/version-diff.service';
import { CompatibilityService } from '../../services/compatibility.service';
import { VersionDiffComponent } from '../../components/version-diff/version-diff.component';
import { BreadcrumbsComponent, Crumb } from '../../components/breadcrumbs/breadcrumbs.component';
import { NpmRegistryResponse, VersionCompatibility, VersionDiff } from '../../models/npm-package.model';

@Component({
  selector: 'app-diff-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, VersionDiffComponent, BreadcrumbsComponent],
  template: `
    <app-breadcrumbs [crumbs]="crumbs()" />

    <section class="head">
      <h1>Compare two versions of <code>{{ pkgName() }}</code></h1>
      <p class="muted">Choose two releases to see how their dependencies, peer dependencies, and deprecation status changed.</p>

      <form class="row" (submit)="$event.preventDefault(); apply()">
        <label class="lbl">
          From
          <select [ngModel]="from()" (ngModelChange)="from.set($event)" name="from" [disabled]="!versionList().length">
            <option value="">—</option>
            @for (v of versionList(); track v) { <option [ngValue]="v">{{ v }}</option> }
          </select>
        </label>
        <label class="lbl">
          To
          <select [ngModel]="to()" (ngModelChange)="to.set($event)" name="to" [disabled]="!versionList().length">
            <option value="">—</option>
            @for (v of versionList(); track v) { <option [ngValue]="v">{{ v }}</option> }
          </select>
        </label>
        <button type="submit" class="primary" [disabled]="!from() || !to()">Diff</button>
      </form>
    </section>

    @if (loading()) { <p class="muted">Loading…</p> }
    @if (error()) { <p class="error">{{ error() }}</p> }

    @if (diff(); as d) {
      <app-version-diff [diff]="d" />
    } @else if (pkg() && !loading()) {
      <p class="muted">Pick two versions to view a diff.</p>
    }
  `,
  styles: [`
    .head h1 { font-size: clamp(1.3rem, 2vw + 0.8rem, 1.6rem); color: var(--fg); }
    .head code { background: var(--surface-1); border: 1px solid var(--border); padding: 2px 8px; border-radius: 6px; font-size: 0.85em; }
    .muted { color: var(--fg-dim); font-style: italic; }
    .error { color: #fca5a5; }
    .row { display: flex; gap: 0.6rem; flex-wrap: wrap; margin-top: 1rem; align-items: end; }
    .lbl { display: flex; flex-direction: column; color: var(--fg-dim); font-size: 0.85rem; gap: 0.3rem; }
    select {
      padding: 0.6rem 0.75rem; border-radius: 8px; border: 1px solid var(--border);
      background: var(--surface-1); color: var(--fg); min-height: 40px;
    }
    .primary {
      padding: 0.6rem 1.25rem; border-radius: 10px; border: none; cursor: pointer;
      background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; font-weight: 600; min-height: 40px;
    }
    .primary:disabled { opacity: 0.6; }
  `]
})
export class DiffPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly registry = inject(NpmRegistryService);
  private readonly diffSvc = inject(VersionDiffService);
  private readonly compat = inject(CompatibilityService);

  readonly pkgName = signal('');
  readonly from = signal('');
  readonly to = signal('');
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly pkg = signal<NpmRegistryResponse | null>(null);

  readonly rows = computed<VersionCompatibility[]>(() => {
    const p = this.pkg();
    return p ? this.compat.buildVersionRows(p, 'peer-dep') : [];
  });

  readonly versionList = computed(() => this.rows().map((r) => r.version));

  readonly diff = computed<VersionDiff | null>(() => {
    const p = this.pkg();
    const f = this.from();
    const t = this.to();
    if (!p || !f || !t) return null;
    return this.diffSvc.diff(p, f, t);
  });

  readonly crumbs = computed<Crumb[]>(() => [
    { label: 'Search', link: '/' },
    // Package-name crumb carries `?q=<pkg>` so the search page
    // re-hydrates that package instead of landing on the empty
    // welcome state. Same pattern as /dependencies.
    {
      label: this.pkgName() || '—',
      link: '/',
      queryParams: this.pkgName() ? { q: this.pkgName() } : undefined
    },
    { label: 'Diff' }
  ]);

  constructor() {
    this.route.paramMap
      .pipe(
        switchMap((p) => {
          const name = p.get('pkg');
          this.pkgName.set(name ?? '');
          if (!name) return of(null);
          this.loading.set(true);
          this.error.set(null);
          return this.registry.fetchPackage(name).pipe(
            catchError((e) => {
              this.error.set(e?.status === 404 ? 'Package not found.' : 'Failed to fetch.');
              return of(null);
            })
          );
        })
      )
      .subscribe((res) => {
        this.pkg.set(res);
        this.loading.set(false);
        // Pre-fill from latest two
        const rows = this.rows();
        if (rows.length >= 2) {
          if (!this.to()) this.to.set(rows[0].version);
          if (!this.from()) this.from.set(rows[1].version);
        }
      });

    this.route.queryParamMap.subscribe((q) => {
      const f = q.get('from');
      const t = q.get('to');
      if (f) this.from.set(f);
      if (t) this.to.set(t);
    });
  }

  apply(): void {
    this.router.navigate([], {
      queryParams: { from: this.from(), to: this.to() },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }
}
