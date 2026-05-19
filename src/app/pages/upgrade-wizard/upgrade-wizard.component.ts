import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslocoModule } from '@jsverse/transloco';
import { Router, RouterLink } from '@angular/router';
import {
  PackageDropZoneComponent,
  UploadedFile
} from '../../components/package-drop-zone/package-drop-zone.component';
import { PrPreviewComponent } from '../../components/pr-preview/pr-preview.component';
import { BundleDeltaSummaryComponent } from '../../components/bundle-delta-summary/bundle-delta-summary.component';
import { PackageJsonParserService } from '../../services/package-json-parser.service';
import { CompatibilityReportService } from '../../services/compatibility-report.service';
import { PolicyService, PolicyEvaluation } from '../../services/policy.service';
import { ToastService } from '../../services/toast.service';
import {
  CompatibilityReport,
  ParsedPackageJson
} from '../../models/npm-package.model';

type WizardStep = 'upload' | 'blockers' | 'bumps' | 'pr';

const STEPS: WizardStep[] = ['upload', 'blockers', 'bumps', 'pr'];

/**
 * Guided 4-step upgrade flow.
 *
 * The dense `/upgrade` page is great for power users but overwhelming for
 * first-timers. This wizard takes the same underlying services and walks the
 * user through one decision at a time:
 *
 *   1. Upload — drop the package.json (or paste it).
 *   2. Blockers — review policy violations + breaking changes before going further.
 *   3. Bumps — review the recommended version bumps + bundle-size impact.
 *   4. PR — generate the patch / open the PR on GitHub.
 *
 * Each step gates progress on the next so users can't accidentally skip a
 * blocker. A "Switch to dense view" link is always available for anyone who
 * prefers the original page.
 */
@Component({
  selector: 'app-upgrade-wizard',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    TranslocoModule,
    RouterLink,
    PackageDropZoneComponent,
    PrPreviewComponent,
    BundleDeltaSummaryComponent
  ],
  template: `
    <main class="wizard" role="main" aria-labelledby="wizard-title">
      <header class="head">
        <h1 id="wizard-title">{{ 'wizard.title' | transloco }}</h1>
        <p class="muted">{{ 'wizard.lede' | transloco }}</p>
        <a routerLink="/upgrade" class="dense-link">
          {{ 'wizard.denseLink' | transloco }} →
        </a>
      </header>

      <ol class="steps" aria-label="Upgrade progress" role="list">
        @for (s of stepDefs; track s.id; let i = $index) {
          <li
            [class.active]="currentIndex() === i"
            [class.done]="currentIndex() > i"
            [attr.aria-current]="currentIndex() === i ? 'step' : null"
          >
            <span class="num">{{ i + 1 }}</span>
            <span class="label">{{ s.label | transloco }}</span>
          </li>
        }
      </ol>

      @switch (current()) {
        @case ('upload') {
          <section class="step">
            <h2>{{ 'wizard.upload.title' | transloco }}</h2>
            <p class="muted">{{ 'wizard.upload.lede' | transloco }}</p>

            <label class="target">
              <span>{{ 'wizard.target' | transloco }}</span>
              <select [(ngModel)]="targetMajor" name="target">
                @for (n of targetOptions; track n) {
                  <option [value]="n">Angular {{ n }}</option>
                }
              </select>
            </label>

            <app-package-drop-zone (files)="onFiles($event)" (sample)="loadSample()" />

            <div class="bottom-row">
              <span class="step-status">
                @if (parsed(); as p) {
                  ✔ {{ p.deps.length }} {{ 'wizard.upload.depsFound' | transloco }}
                } @else {
                  {{ 'wizard.upload.waiting' | transloco }}
                }
              </span>
              <button
                type="button"
                class="primary"
                (click)="goTo('blockers')"
                [disabled]="!parsed() || running()"
              >
                @if (running()) {
                  {{ 'wizard.analyzing' | transloco }}
                } @else {
                  {{ 'wizard.next' | transloco }} →
                }
              </button>
            </div>
          </section>
        }

        @case ('blockers') {
          <section class="step">
            <h2>{{ 'wizard.blockers.title' | transloco }}</h2>
            <p class="muted">{{ 'wizard.blockers.lede' | transloco }}</p>

            @if (report(); as r) {
              <div class="grid">
                <div
                  class="card"
                  [class.bad]="hasBlockingViolations()"
                  [class.good]="!hasBlockingViolations()"
                >
                  <h3>{{ 'wizard.blockers.policy' | transloco }}</h3>
                  @if (policyEval(); as pe) {
                    @if (pe.hasBlockers) {
                      <p>
                        {{ 'wizard.blockers.policyBad' | transloco: { count: pe.blockerCount } }}
                      </p>
                      <ul>
                        @for (v of pe.violations.slice(0, 5); track v.ruleId + v.package) {
                          <li>
                            <code>{{ v.package }}</code> —
                            {{ v.message }}
                          </li>
                        }
                      </ul>
                    } @else {
                      <p>
                        ✔ {{ 'wizard.blockers.policyGood' | transloco }}
                        @if (pe.warningCount > 0) {
                          <span class="warn">
                            ({{ pe.warningCount }} {{ 'wizard.blockers.warns' | transloco }})
                          </span>
                        }
                      </p>
                    }
                  }
                </div>

                <div
                  class="card"
                  [class.bad]="r.conflictCount > 0"
                  [class.good]="r.conflictCount === 0"
                >
                  <h3>{{ 'wizard.blockers.breaking' | transloco }}</h3>
                  @if (r.conflictCount > 0) {
                    <p>
                      {{ 'wizard.blockers.breakingBad' | transloco: { count: r.conflictCount } }}
                    </p>
                    <ul>
                      @for (e of breakingPackages(); track e.name) {
                        <li>
                          <code>{{ e.name }}</code> — {{ e.note }}
                        </li>
                      }
                    </ul>
                  } @else {
                    <p>✔ {{ 'wizard.blockers.breakingGood' | transloco }}</p>
                  }
                </div>

                <div
                  class="card"
                  [class.warn]="r.deprecatedCount > 0"
                  [class.good]="r.deprecatedCount === 0"
                >
                  <h3>{{ 'wizard.blockers.deprecated' | transloco }}</h3>
                  <p>
                    @if (r.deprecatedCount > 0) {
                      {{ 'wizard.blockers.deprecatedNote' | transloco: { count: r.deprecatedCount } }}
                    } @else {
                      ✔ {{ 'wizard.blockers.deprecatedGood' | transloco }}
                    }
                  </p>
                </div>
              </div>
            } @else if (running()) {
              <p>{{ 'wizard.analyzing' | transloco }}</p>
            }

            <div class="bottom-row">
              <button type="button" class="ghost" (click)="goTo('upload')">
                ← {{ 'wizard.back' | transloco }}
              </button>
              <button
                type="button"
                class="primary"
                (click)="goTo('bumps')"
                [disabled]="!report() || hasBlockingViolations()"
                [title]="hasBlockingViolations() ? ('wizard.blockers.cantContinue' | transloco) : ''"
              >
                {{ 'wizard.next' | transloco }} →
              </button>
            </div>
          </section>
        }

        @case ('bumps') {
          <section class="step">
            <h2>{{ 'wizard.bumps.title' | transloco }}</h2>
            <p class="muted">{{ 'wizard.bumps.lede' | transloco }}</p>

            @if (report(); as r) {
              <!-- Same chunk as the upgrade page's deferred bundle viewer; the
                   bundler dedupes so loading is free if the user came from
                   /upgrade. -->
              @defer (on viewport; prefetch on idle) {
                <app-bundle-delta-summary [report]="r" />
              } @placeholder { <div class="defer-spacer" aria-hidden="true"></div> }

              <div class="bumps-table-wrap">
                <table class="bumps">
                  <thead>
                    <tr>
                      <th>{{ 'wizard.bumps.package' | transloco }}</th>
                      <th>{{ 'wizard.bumps.from' | transloco }}</th>
                      <th>{{ 'wizard.bumps.to' | transloco }}</th>
                      <th>{{ 'wizard.bumps.status' | transloco }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (e of bumpRows(); track e.name) {
                      <tr [attr.data-status]="e.status">
                        <td><code>{{ e.name }}</code></td>
                        <td>{{ e.currentVersion ?? '—' }}</td>
                        <td>{{ e.recommendedVersion ?? '—' }}</td>
                        <td>{{ e.status }}</td>
                      </tr>
                    } @empty {
                      <tr>
                        <td colspan="4" class="muted">
                          {{ 'wizard.bumps.empty' | transloco }}
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }

            <div class="bottom-row">
              <button type="button" class="ghost" (click)="goTo('blockers')">
                ← {{ 'wizard.back' | transloco }}
              </button>
              <button type="button" class="primary" (click)="goTo('pr')">
                {{ 'wizard.next' | transloco }} →
              </button>
            </div>
          </section>
        }

        @case ('pr') {
          <section class="step">
            <h2>{{ 'wizard.pr.title' | transloco }}</h2>
            <p class="muted">{{ 'wizard.pr.lede' | transloco }}</p>

            @if (report(); as r) {
              @defer (on viewport; prefetch on idle) {
                <app-pr-preview
                  [report]="r"
                  [parsed]="parsed()"
                  [rawPackageJson]="rawPackageJson()"
                />
              } @placeholder { <div class="defer-spacer" aria-hidden="true"></div> }
            }

            <div class="bottom-row">
              <button type="button" class="ghost" (click)="goTo('bumps')">
                ← {{ 'wizard.back' | transloco }}
              </button>
              <button type="button" class="ghost" (click)="reset()">
                {{ 'wizard.startOver' | transloco }}
              </button>
            </div>
          </section>
        }
      }
    </main>
  `,
  styles: [`
    :host { display: block; }
    .defer-spacer { min-height: 1px; }
    .wizard {
      max-width: 960px; margin: 0 auto; padding: 1.5rem 1.25rem 4rem;
    }
    .head h1 { margin: 0 0 0.3rem; font-size: 1.5rem; }
    .head .muted { margin: 0 0 0.4rem; color: var(--fg-dim); }
    .head .dense-link {
      display: inline-block; margin-top: 0.3rem;
      font-size: 0.85rem; color: var(--accent); text-decoration: none;
    }
    .head .dense-link:hover { text-decoration: underline; }

    .steps {
      display: flex; gap: 0.5rem; list-style: none; padding: 0;
      margin: 1.25rem 0 1.5rem;
    }
    .steps li {
      flex: 1 1 0; display: flex; align-items: center; gap: 0.5rem;
      padding: 0.55rem 0.7rem; border-radius: 10px;
      border: 1px solid var(--border);
      background: var(--surface-1); color: var(--fg-dim);
      font-size: 0.85rem;
    }
    .steps li.active {
      background: var(--accent-bg, #eff6ff);
      color: var(--accent, #2563eb);
      border-color: var(--accent, #2563eb);
      font-weight: 600;
    }
    .steps li.done {
      background: #ecfdf5; color: #15803d; border-color: #15803d;
    }
    .steps li .num {
      display: inline-flex; width: 22px; height: 22px;
      border-radius: 999px; align-items: center; justify-content: center;
      background: currentColor; color: var(--surface-1);
      font-size: 0.78rem; font-weight: 700;
    }

    .step {
      border: 1px solid var(--border); border-radius: 14px;
      background: var(--surface-1);
      padding: 1.1rem 1.25rem; box-shadow: 0 1px 0 rgba(0,0,0,0.02);
    }
    .step h2 { margin: 0 0 0.3rem; font-size: 1.15rem; }
    .step .muted { margin: 0 0 0.85rem; color: var(--fg-dim); font-size: 0.9rem; }

    .target {
      display: flex; align-items: center; gap: 0.55rem;
      margin: 0.6rem 0 1rem; font-size: 0.9rem;
    }
    .target select {
      padding: 0.35rem 0.6rem; border-radius: 8px;
      border: 1px solid var(--border); background: var(--surface-2); color: var(--fg);
    }

    .grid {
      display: grid; gap: 0.75rem; margin: 1rem 0 1.25rem;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    }
    .card {
      padding: 0.85rem 1rem; border-radius: 12px;
      border: 1px solid var(--border); background: var(--surface-2);
    }
    .card h3 { margin: 0 0 0.4rem; font-size: 0.95rem; }
    .card p { margin: 0 0 0.4rem; font-size: 0.88rem; }
    .card ul { margin: 0; padding-left: 1.1rem; font-size: 0.83rem; }
    /* Status cards — theme-aware tint via color-mix() over the current
       --surface-2, so the same component reads as a soft pastel on light
       mode and a deeper tinted surface on dark mode. Hardcoded pastels
       like #fef2f2 used to leak through and clash with the white --fg
       in dark mode (unreadable body text). The semantic --bad / --ok /
       --warn tokens carry the actual hue so re-skinning the brand only
       requires touching styles.scss. */
    .card.bad {
      border-color: color-mix(in srgb, var(--bad, #ef4444) 35%, var(--border));
      background:   color-mix(in srgb, var(--bad, #ef4444) 8%, var(--surface-2));
    }
    .card.bad h3 { color: var(--bad, #ef4444); }
    .card.good {
      border-color: color-mix(in srgb, var(--ok, #22c55e) 35%, var(--border));
      background:   color-mix(in srgb, var(--ok, #22c55e) 8%, var(--surface-2));
    }
    .card.good h3 { color: var(--ok, #22c55e); }
    .card.warn {
      border-color: color-mix(in srgb, var(--warn, #f59e0b) 35%, var(--border));
      background:   color-mix(in srgb, var(--warn, #f59e0b) 8%, var(--surface-2));
    }
    .card.warn h3 { color: var(--warn, #f59e0b); }
    .card .warn { color: var(--warn, #f59e0b); font-size: 0.8rem; }

    .bumps-table-wrap { overflow-x: auto; margin: 0.5rem 0 1rem; }
    table.bumps {
      width: 100%; border-collapse: collapse; font-size: 0.88rem;
    }
    table.bumps th, table.bumps td {
      text-align: left; padding: 0.45rem 0.6rem;
      border-bottom: 1px solid var(--border);
    }
    table.bumps th { color: var(--fg-dim); font-weight: 600; }
    /* Theme-aware status colors — the dark hex values (#b91c1c, #b45309)
       were tuned for white backgrounds and fail contrast on dark surfaces.
       The semantic tokens carry brighter hues that pass on either theme. */
    table.bumps tr[data-status="conflict"] td { color: var(--bad, #ef4444); }
    table.bumps tr[data-status="warning"] td { color: var(--warn, #f59e0b); }
    table.bumps tr[data-status="deprecated"] td { color: color-mix(in srgb, var(--accent) 70%, var(--fg-dim)); }
    table.bumps tr[data-status="safe"] td { color: var(--fg); }

    .bottom-row {
      display: flex; align-items: center; justify-content: space-between;
      gap: 0.5rem; margin-top: 1rem;
    }
    .step-status { font-size: 0.85rem; color: var(--fg-dim); }
    button { font: inherit; cursor: pointer; }
    button.primary {
      padding: 0.55rem 1.05rem; border-radius: 8px; border: none;
      background: var(--accent, #2563eb); color: #fff; font-weight: 600;
    }
    button.primary[disabled] { opacity: 0.55; cursor: not-allowed; }
    button.ghost {
      padding: 0.5rem 0.95rem; border-radius: 8px;
      background: transparent; border: 1px solid var(--border);
      color: var(--fg);
    }
    button.ghost:hover { border-color: var(--accent, #2563eb); color: var(--accent, #2563eb); }
  `]
})
export class UpgradeWizardComponent {
  private readonly parser = inject(PackageJsonParserService);
  private readonly reportSvc = inject(CompatibilityReportService);
  private readonly policySvc = inject(PolicyService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  /** Step labels — kept here so the template can iterate. */
  readonly stepDefs: { id: WizardStep; label: string }[] = [
    { id: 'upload', label: 'wizard.steps.upload' },
    { id: 'blockers', label: 'wizard.steps.blockers' },
    { id: 'bumps', label: 'wizard.steps.bumps' },
    { id: 'pr', label: 'wizard.steps.pr' }
  ];

  readonly current = signal<WizardStep>('upload');
  readonly currentIndex = computed(() =>
    STEPS.indexOf(this.current())
  );

  /** Plausible target majors — Angular has been releasing yearly. */
  readonly targetOptions = [16, 17, 18, 19, 20, 21, 22];
  targetMajor = 21;

  readonly running = signal(false);
  readonly parsed = signal<ParsedPackageJson | null>(null);
  readonly rawPackageJson = signal<string | null>(null);
  readonly report = signal<CompatibilityReport | null>(null);

  readonly policyEval = computed<PolicyEvaluation | null>(() => {
    // Touch rules() so the eval re-runs when rules change.
    void this.policySvc.rules();
    const r = this.report();
    return r ? this.policySvc.evaluateReport(r) : null;
  });

  readonly hasBlockingViolations = computed(
    () => !!this.policyEval()?.hasBlockers
  );

  readonly breakingPackages = computed(() => {
    const r = this.report();
    if (!r) return [];
    return r.entries
      .filter((e) => e.status === 'conflict')
      .slice(0, 5)
      .map((e) => ({ name: e.name, note: e.note || '—' }));
  });

  readonly bumpRows = computed(() => {
    const r = this.report();
    if (!r) return [];
    return r.entries
      .map((e) => ({
        name: e.name,
        currentVersion: e.currentVersion,
        recommendedVersion: e.recommendedForTarget?.version ?? null,
        status: e.status
      }))
      .filter(
        (e) =>
          e.recommendedVersion && e.recommendedVersion !== e.currentVersion
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  onFiles(files: UploadedFile[]): void {
    const pj = files.find((f) => f.kind === 'package-json');
    if (!pj) {
      this.toast.error('No package.json found in the dropped files.');
      return;
    }
    try {
      const parsed = this.parser.parseJson(pj.content);
      this.parsed.set(parsed);
      this.rawPackageJson.set(pj.content);
      if (parsed.angularMajor && this.targetMajor < parsed.angularMajor) {
        // Default target to next major if the user didn't pick one yet.
        this.targetMajor = parsed.angularMajor + 1;
      }
      this.toast.success(`Loaded ${parsed.deps.length} dependencies.`);
    } catch (e) {
      this.toast.error((e as Error)?.message ?? 'Failed to parse package.json.');
    }
  }

  loadSample(): void {
    // Drop-zone signals "use a built-in sample" — we provide a quickstart.
    const sample = JSON.stringify(
      {
        name: 'sample-app',
        version: '0.0.1',
        dependencies: {
          '@angular/core': '^16.2.0',
          '@angular/common': '^16.2.0',
          rxjs: '~7.8.0',
          'ngx-toastr': '^17.0.0'
        }
      },
      null,
      2
    );
    this.onFiles([{ kind: 'package-json', name: 'package-json', content: sample }]);
  }

  goTo(step: WizardStep): void {
    if (step === 'blockers' && !this.report() && this.parsed()) {
      // Lazy-trigger the analysis on transition.
      this.runAnalysis(() => this.current.set('blockers'));
      return;
    }
    if (step === 'bumps' && this.hasBlockingViolations()) {
      this.toast.error('Resolve policy blockers before continuing.');
      return;
    }
    this.current.set(step);
  }

  private runAnalysis(after: () => void): void {
    const parsed = this.parsed();
    if (!parsed) return;
    this.running.set(true);
    this.reportSvc.buildReport(parsed, this.targetMajor).subscribe({
      next: (r) => {
        this.report.set(r);
        this.running.set(false);
        after();
      },
      error: (err) => {
        this.running.set(false);
        this.toast.error(err?.message ?? 'Analysis failed.');
      }
    });
  }

  reset(): void {
    this.parsed.set(null);
    this.rawPackageJson.set(null);
    this.report.set(null);
    this.current.set('upload');
  }
}
