import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  PLATFORM_ID,
  computed,
  effect,
  inject,
  signal
} from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';

import { NpmRegistryService } from '../../services/npm-registry.service';
import { CompatibilityService } from '../../services/compatibility.service';
import { NpmDownloadsService } from '../../services/npm-downloads.service';
import { AdvisoriesService } from '../../services/advisories.service';
import { StorageService } from '../../services/storage.service';
import { ExportService } from '../../services/export.service';
import { FiltersService } from '../../services/filters.service';
import { PackageManagerService } from '../../services/package-manager.service';
import { RecommendationService } from '../../services/recommendation.service';
import { PackageRelocationService, PackageRelocation } from '../../services/package-relocation.service';
import { ReleaseDateService } from '../../services/release-date.service';
import { MaintainerVitalityService, MaintainerVitality } from '../../services/maintainer-vitality.service';
import { PackageTrustService, ProvenanceSignal, InstallScriptSignal } from '../../services/package-trust.service';
import { ScorecardService, ScorecardResult } from '../../services/scorecard.service';
import { TyposquatService, TyposquatSuggestion } from '../../services/typosquat.service';

import {
  Advisory,
  DetectionStrategy,
  NpmRegistryResponse,
  VersionCompatibility
} from '../../models/npm-package.model';

import { PackageMetaComponent } from '../../components/package-meta/package-meta.component';
import { VersionsTableComponent } from '../../components/versions-table/versions-table.component';
import { FiltersBarComponent } from '../../components/filters-bar/filters-bar.component';
import { RecommendationCardComponent } from '../../components/recommendation-card/recommendation-card.component';
import { TimelineComponent } from '../../components/timeline/timeline.component';
import { SkeletonComponent } from '../../components/skeleton/skeleton.component';
import { ErrorBoundaryComponent } from '../../components/error-boundary/error-boundary.component';
import { AutocompleteInputComponent } from '../../components/autocomplete-input/autocomplete-input.component';

interface StrategyOption { id: DetectionStrategy; label: string; hint: string; }

const STRATEGY_OPTIONS: StrategyOption[] = [
  { id: 'peer', label: 'peerDependencies', hint: 'Strict — peerDependencies["@angular/core"] only.' },
  { id: 'peer-dep', label: 'peer + dependencies', hint: 'Also fall back to regular dependencies on @angular/*.' },
  { id: 'heuristic', label: 'Heuristic', hint: 'Also devDependencies + @angular/* name matching.' }
];

@Component({
  selector: 'app-search-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    TranslocoModule,
    PackageMetaComponent,
    VersionsTableComponent,
    FiltersBarComponent,
    RecommendationCardComponent,
    TimelineComponent,
    SkeletonComponent,
    ErrorBoundaryComponent,
    AutocompleteInputComponent
  ],
  templateUrl: './search-page.component.html',
  styleUrls: ['./search-page.component.scss']
})
export class SearchPageComponent {
  private readonly registry = inject(NpmRegistryService);
  private readonly compat = inject(CompatibilityService);
  private readonly downloads = inject(NpmDownloadsService);
  private readonly advisories = inject(AdvisoriesService);
  private readonly exporter = inject(ExportService);
  private readonly storage = inject(StorageService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly transloco = inject(TranslocoService);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  readonly filtersSvc = inject(FiltersService);
  readonly pm = inject(PackageManagerService);
  readonly recoSvc = inject(RecommendationService);
  readonly relocationSvc = inject(PackageRelocationService);
  readonly releaseDates = inject(ReleaseDateService);
  private readonly vitalitySvc = inject(MaintainerVitalityService);
  private readonly trustSvc = inject(PackageTrustService);
  private readonly scorecardSvc = inject(ScorecardService);
  private readonly typosquatSvc = inject(TyposquatService);

  readonly strategyOptions = STRATEGY_OPTIONS;

  readonly query = signal<string>('');
  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);
  readonly pkg = signal<NpmRegistryResponse | null>(null);
  readonly rows = signal<VersionCompatibility[]>([]);
  readonly recoMajor = signal<number | null>(null);
  readonly copiedVersion = signal<string | null>(null);
  readonly strategy = signal<DetectionStrategy>('peer');
  readonly downloadsSeries = signal<Array<{ week: string; downloads: number }> | null>(null);
  readonly advisoriesList = signal<Advisory[] | null>(null);
  readonly relocation = signal<PackageRelocation | null>(null);
  readonly vitality = signal<MaintainerVitality | null>(null);
  readonly scorecard = signal<ScorecardResult | null>(null);

  private lastQuery = '';

  constructor() {
    // Rebuild rows when strategy changes
    effect(() => {
      const strat = this.strategy();
      const p = this.pkg();
      if (p) this.rows.set(this.compat.buildVersionRows(p, strat));
    });

    // Default reco major = latest available when rows arrive
    effect(() => {
      const majors = this.availableMajors();
      if (this.recoMajor() === null && majors.length) this.recoMajor.set(majors[0]);
    });

    // Sync URL <- state
    effect(() => {
      const name = this.pkg()?.name;
      const strat = this.strategy();
      const reco = this.recoMajor();
      if (name) {
        this.router.navigate([], {
          queryParams: { q: name, strategy: strat, reco },
          queryParamsHandling: 'merge',
          replaceUrl: true
        });
      }
    });

    // Hydrate from URL
    this.route.queryParamMap.subscribe((params) => {
      const name = params.get('q') ?? params.get('package');
      const strat = (params.get('strategy') || 'peer') as DetectionStrategy;
      const reco = params.get('reco');
      if (['peer', 'peer-dep', 'heuristic'].includes(strat)) this.strategy.set(strat);
      if (reco && /^\d+$/.test(reco)) this.recoMajor.set(Number(reco));
      if (name && name !== this.lastQuery) {
        this.query.set(name);
        this.search();
      }
    });
  }

  @HostListener('window:keydown', ['$event'])
  onGlobalKey(ev: KeyboardEvent): void {
    if (!this.isBrowser) return;
    if ((ev.metaKey || ev.ctrlKey) && ev.key === '/') {
      ev.preventDefault();
      const el = document.getElementById('package-input') as HTMLInputElement | null;
      el?.focus();
      el?.select();
    }
  }

  readonly availableMajors = computed(() => this.compat.collectAngularMajorsInUse(this.rows()));

  readonly filteredRows = computed<VersionCompatibility[]>(() => this.filtersSvc.apply(this.rows()));

  readonly recommendation = computed(() => {
    const m = this.recoMajor();
    if (m == null) return null;
    return this.recoSvc.forMajor(this.rows(), m);
  });

  readonly latestVersion = computed<string | null>(() => this.pkg()?.['dist-tags']?.['latest'] ?? null);

  readonly lastPublish = computed<string | null>(() => {
    const p = this.pkg();
    if (!p) return null;
    const v = this.latestVersion();
    const iso = v ? p.time?.[v] : p.time?.['modified'];
    if (!iso) return null;
    return this.relative(new Date(iso));
  });

  readonly authorName = computed<string | null>(() => {
    const a = this.pkg()?.author;
    if (!a) return null;
    return typeof a === 'string' ? a : a.name ?? null;
  });

  readonly maintainerCount = computed<number>(() => this.pkg()?.maintainers?.length ?? 0);

  /**
   * Synchronous trust signals derived from the packument. These re-
   * compute automatically when `pkg` changes — no manual fetch
   * needed, since the data is already in the packument we fetched.
   */
  readonly provenance = computed<ProvenanceSignal>(() => this.trustSvc.provenance(this.pkg()));
  readonly installScripts = computed<InstallScriptSignal>(() => this.trustSvc.installScripts(this.pkg()));
  readonly supportsNgAdd = computed<boolean>(() => this.trustSvc.supportsNgAdd(this.pkg()));

  /**
   * Typosquat check runs against the query string (the user's typed
   * intent), not against the resolved package name — the package
   * might BE the typosquat. We compute it eagerly off lastQuery so
   * even a failed lookup ("npm 404'd") still surfaces the "Did you
   * mean ___?" pivot, which is exactly when the suggestion is most
   * useful.
   */
  readonly typosquat = computed<TyposquatSuggestion | null>(() => this.typosquatSvc.suggest(this.lastQuerySignal()));

  /**
   * Mirror of `lastQuery` as a signal so the typosquat computed has
   * something to track. (`lastQuery` is a plain class field for
   * historical reasons.)
   */
  private readonly lastQuerySignal = signal('');

  search(): void {
    const name = this.query().trim();
    if (!name) {
      this.error.set(this.transloco.translate('search.packageNameLabel'));
      return;
    }
    this.lastQuery = name;
    // Mirror lastQuery into a signal so the typosquat computed
    // re-evaluates whenever a new search fires (the original
    // `lastQuery` is a plain field; reading from a signal makes the
    // reactive graph notice the change).
    this.lastQuerySignal.set(name);
    this.loading.set(true);
    this.error.set(null);
    this.pkg.set(null);
    this.rows.set([]);
    this.downloadsSeries.set(null);
    this.advisoriesList.set(null);
    this.vitality.set(null);
    this.scorecard.set(null);
    this.recoMajor.set(null);
    this.filtersSvc.reset();

    // Relocation knowledge base — show a banner if this package was moved.
    const reloc = this.relocationSvc.for(name);
    this.relocation.set(reloc);

    this.registry.fetchPackage(name).subscribe({
      next: (res) => {
        this.pkg.set(res);
        this.storage.recordSearch(res.name);
        this.releaseDates.hydrate(res.name, res);
        this.loading.set(false);
        // Vitality is fetched on its own track — it goes to GitHub
        // (not npm) and there's no point in blocking the main
        // package render on a third-party API that's rate-limited to
        // 60 req/hr. We deliberately swallow errors here so a
        // 403 (rate limit) or 404 (no GitHub repo) leaves the meta
        // panel intact rather than turning the whole header red.
        this.vitalitySvc.forRepoUrl(res.repository?.url).pipe(
          catchError(() => of(null))
        ).subscribe((v) => this.vitality.set(v));
        // Scorecard is its own track for the same reason as Vitality:
        // OpenSSF's API can be slow / down / 404 for un-reported repos,
        // and none of that should block the main package render.
        // Returns null silently when the repo has no public scorecard.
        this.scorecardSvc.forRepoUrl(res.repository?.url).pipe(
          catchError(() => of(null))
        ).subscribe((s) => this.scorecard.set(s));
        forkJoin({
          dl: this.downloads.weeklyTrend(res.name).pipe(catchError(() => of(null))),
          adv: this.advisories.forPackage(res.name).pipe(catchError(() => of(null)))
        }).subscribe(({ dl, adv }) => {
          this.downloadsSeries.set(dl);
          this.advisoriesList.set(adv);
        });
      },
      error: (err: any) => {
        const status = err?.status;
        this.error.set(
          status === 404
            ? this.transloco.translate('common.notFound')
            : this.transloco.translate('common.failedToFetch') + (status ? ` (HTTP ${status})` : '')
        );
        this.loading.set(false);
      }
    });
  }

  /** Jump search to the relocated name shown in the banner. */
  searchNewName(relocation: PackageRelocation): void {
    this.query.set(relocation.to);
    this.search();
  }

  retry(): void { if (this.lastQuery) this.search(); }

  onSubmit(ev: Event): void { ev.preventDefault(); this.search(); }

  /** User clicked / Enter-confirmed a suggestion in the autocomplete dropdown. */
  onPicked(name: string): void {
    this.query.set(name);
    this.search();
  }

  /** User pressed Enter without a selected suggestion. */
  onAutocompleteSubmit(raw: string): void {
    this.query.set(raw);
    this.search();
  }

  installCommand(version: string): string {
    const name = this.pkg()?.name ?? this.query().trim();
    // Defer to PackageManagerService.recommendedInstall which dispatches
    // to ng add when the package ships a schematic, otherwise falls back
    // to the user's chosen pm install command. The `supportsNgAdd`
    // computed reads from the same packument the rest of the page
    // already has, so this is a free upgrade — no extra fetches.
    return this.pm.recommendedInstall(name, version, this.supportsNgAdd());
  }

  async handleCopy(versionOrCmd: string): Promise<void> {
    if (!this.isBrowser) return;
    const cmd = versionOrCmd.includes(' ') ? versionOrCmd : this.installCommand(versionOrCmd);
    const version = versionOrCmd.includes(' ') ? versionOrCmd : versionOrCmd;
    try {
      await navigator.clipboard.writeText(cmd);
      this.copiedVersion.set(version);
      setTimeout(() => {
        if (this.copiedVersion() === version) this.copiedVersion.set(null);
      }, 1500);
    } catch {
      window.prompt('Copy the install command:', cmd);
    }
  }

  setStrategy(s: DetectionStrategy): void { this.strategy.set(s); }

  /**
   * Bound to the typosquat banner CTA inside PackageMetaComponent.
   * Accepts the suggested name and re-runs the search — same flow
   * as if the user had typed it themselves. Passed as a function
   * input rather than wired through (suggested) output because the
   * banner lives one component deep and a function input is the
   * leanest cross-component callback for OnPush components.
   */
  acceptTyposquatSuggestion = (suggestion: string): void => {
    this.query.set(suggestion);
    this.search();
  };

  exportJson(): void {
    const pkg = this.pkg();
    if (!pkg) return;
    this.exporter.download(
      `${this.fileBase(pkg.name)}.json`,
      this.exporter.toJson(this.filteredRows()),
      'application/json'
    );
  }

  exportCsv(): void {
    const pkg = this.pkg();
    if (!pkg) return;
    this.exporter.download(
      `${this.fileBase(pkg.name)}.csv`,
      this.exporter.toCsv(this.filteredRows()),
      'text/csv'
    );
  }

  private fileBase(name: string): string {
    return name.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  }

  private relative(date: Date): string {
    const secs = Math.max(1, Math.floor((Date.now() - date.getTime()) / 1000));
    const units: Array<[number, string]> = [
      [60, 'second'], [60, 'minute'], [24, 'hour'], [30, 'day'],
      [12, 'month'], [Number.POSITIVE_INFINITY, 'year']
    ];
    let value = secs;
    for (const [div, name] of units) {
      if (value < div) {
        const rounded = Math.floor(value);
        return `${rounded} ${name}${rounded === 1 ? '' : 's'} ago`;
      }
      value /= div;
    }
    return date.toDateString();
  }
}
