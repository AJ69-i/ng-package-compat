import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { catchError, map, of, switchMap } from 'rxjs';
import { NpmRegistryService } from '../../services/npm-registry.service';
import { CompatibilityService } from '../../services/compatibility.service';
import { PackageManagerService } from '../../services/package-manager.service';
import { DependenciesPanelComponent } from '../../components/dependencies-panel/dependencies-panel.component';
import { BreadcrumbsComponent, Crumb } from '../../components/breadcrumbs/breadcrumbs.component';
import { NpmRegistryResponse, VersionCompatibility } from '../../models/npm-package.model';

@Component({
  selector: 'app-dependencies-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, DependenciesPanelComponent, BreadcrumbsComponent],
  template: `
    <app-breadcrumbs [crumbs]="crumbs()" />

    <section class="head">
      <h1>
        <code>{{ pkgName() }}</code>
        <span class="at">@</span>
        <code class="ver">{{ version() }}</code>
      </h1>
      @if (row(); as r) {
        <div class="chips">
          @if (r.isLatest) { <span class="chip chip-ok">latest</span> }
          @if (r.isPrerelease) { <span class="chip chip-warn">prerelease</span> }
          @if (r.isDeprecated) { <span class="chip chip-bad">deprecated</span> }
          @if (r.supportsAny) { <span class="chip">no Angular peer</span> }
          @if (r.supportedAngularMajors.length) {
            <span class="chip chip-ng">
              Angular {{ r.supportedAngularMajors.join(', ') }}
            </span>
          }
        </div>
        <div class="cmd">
          <code>{{ installCmd() }}</code>
          <button type="button" class="copy" (click)="copy(installCmd())">Copy</button>
        </div>
      }
    </section>

    @if (loading()) { <p class="muted">Loading…</p> }
    @if (error()) { <p class="error">{{ error() }}</p> }

    @if (row(); as r) {
      <app-dependencies-panel [row]="r" />

      @if (r.isDeprecated && r.deprecationMessage) {
        <section class="deprecated">
          <h3>Deprecation notice</h3>
          <p>{{ r.deprecationMessage }}</p>
        </section>
      }
    }
  `,
  styles: [`
    .head { margin: 1rem 0; }
    h1 { font-size: clamp(1.3rem, 2vw + 0.8rem, 1.6rem); color: var(--fg); display: flex; align-items: center; flex-wrap: wrap; gap: 0.3rem; }
    h1 code { background: var(--surface-1); border: 1px solid var(--border); padding: 2px 10px; border-radius: 6px; font-size: 0.85em; }
    .at { color: var(--fg-dim); }
    .chips { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.5rem; }
    .chip { padding: 2px 10px; border-radius: 999px; font-size: 0.75rem; background: var(--surface-1); border: 1px solid var(--border); color: var(--fg-dim); }
    .chip-ok { background: color-mix(in srgb, #22c55e 15%, transparent); color: #86efac; border-color: color-mix(in srgb, #22c55e 35%, transparent); }
    .chip-warn { background: color-mix(in srgb, #f59e0b 15%, transparent); color: #fcd34d; border-color: color-mix(in srgb, #f59e0b 35%, transparent); }
    .chip-bad { background: color-mix(in srgb, #ef4444 15%, transparent); color: #fca5a5; border-color: color-mix(in srgb, #ef4444 35%, transparent); }
    .chip-ng { background: color-mix(in srgb, #6366f1 15%, transparent); color: #c7d2fe; border-color: color-mix(in srgb, #6366f1 35%, transparent); }
    .cmd { margin-top: 0.7rem; display: flex; gap: 0.35rem; align-items: center; flex-wrap: wrap; }
    .cmd code { background: var(--surface-1); border: 1px solid var(--border); padding: 0.4rem 0.6rem; border-radius: 8px; font-size: 0.85rem; }
    .copy { padding: 4px 10px; background: var(--surface-1); border: 1px solid var(--border); border-radius: 6px; color: var(--accent); cursor: pointer; font-size: 0.75rem; min-height: 28px; }
    .copy:hover { border-color: var(--accent); }
    .muted { color: var(--fg-dim); font-style: italic; }
    .error { color: #fca5a5; }
    .deprecated {
      margin-top: 1rem; padding: 0.75rem 1rem;
      background: color-mix(in srgb, #ef4444 8%, transparent);
      border: 1px solid color-mix(in srgb, #ef4444 35%, transparent);
      border-radius: 10px; color: #fca5a5;
    }
    .deprecated h3 { margin: 0 0 0.3rem; }
    .deprecated p { margin: 0; font-size: 0.9rem; }
  `]
})
export class DependenciesPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly registry = inject(NpmRegistryService);
  private readonly compat = inject(CompatibilityService);
  private readonly pm = inject(PackageManagerService);

  readonly pkgName = toSignal(this.route.paramMap.pipe(map((p) => p.get('pkg') ?? '')), { initialValue: '' });
  readonly version = toSignal(this.route.paramMap.pipe(map((p) => p.get('version') ?? '')), { initialValue: '' });

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly pkg = signal<NpmRegistryResponse | null>(null);

  readonly rows = computed<VersionCompatibility[]>(() => {
    const p = this.pkg();
    return p ? this.compat.buildVersionRows(p, 'peer-dep') : [];
  });

  readonly row = computed<VersionCompatibility | null>(() => {
    const v = this.version();
    return this.rows().find((r) => r.version === v) ?? null;
  });

  readonly installCmd = computed(() => this.pm.installCommand(this.pkgName(), this.version()));

  readonly crumbs = computed<Crumb[]>(() => [
    // First crumb deliberately lands on the empty search welcome
    // state — clicking "Search" is the user's "start over" affordance.
    { label: 'Search', link: '/' },
    // Second crumb carries the package name back into the search
    // page via the ?q= query param. The search-page effect picks
    // this up and re-hydrates the full package view (chips, version
    // table, mini-tree, etc.) — without it, clicking the package
    // name drops the user on the empty welcome state and silently
    // discards the context they were in.
    {
      label: this.pkgName() || '—',
      link: '/',
      queryParams: this.pkgName() ? { q: this.pkgName() } : undefined
    },
    { label: this.version() || '—' }
  ]);

  constructor() {
    this.route.paramMap
      .pipe(
        switchMap((p) => {
          const name = p.get('pkg');
          if (!name) return of(null);
          this.loading.set(true);
          this.error.set(null);
          return this.registry.fetchPackage(name).pipe(
            catchError((e) => {
              this.error.set(e?.status === 404 ? 'Package not found.' : 'Failed to fetch package.');
              return of(null);
            })
          );
        })
      )
      .subscribe((res) => {
        this.pkg.set(res);
        this.loading.set(false);
      });
  }

  async copy(text: string): Promise<void> {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      window.prompt('Copy:', text);
    }
  }
}
