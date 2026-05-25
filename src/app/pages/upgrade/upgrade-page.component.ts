import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs/operators';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import { CompatibilityReportService } from '../../services/compatibility-report.service';
import { ToastService } from '../../services/toast.service';
import { SupabaseService } from '../../services/supabase.service';
import { PackageJsonParserService } from '../../services/package-json-parser.service';
import { KNOWN_ANGULAR_MAJORS } from '../../services/compatibility.service';
import { MarkdownExportService } from '../../services/markdown-export.service';
import { CiGeneratorService, CiProvider } from '../../services/ci-generator.service';
import { AiCopilotService, AiProvider } from '../../services/ai-copilot.service';
import { CommunityGotchasService, CommunityNote } from '../../services/community-gotchas.service';
import { ProsConsService, ProsConsEntry } from '../../services/pros-cons.service';
import { DeadButWorkingService } from '../../services/dead-but-working.service';
import { ReleaseDateService, ReleaseTimeline } from '../../services/release-date.service';
import {
  CompatibilityReport,
  CompatStatus,
  ParsedPackageJson,
  ReportEntry,
  UploadedProject,
  BreakingChange
} from '../../models/npm-package.model';
import {
  PackageDropZoneComponent,
  UploadedFile
} from '../../components/package-drop-zone/package-drop-zone.component';
import {
  StickySummaryBarComponent,
  SummaryCounts,
  SummaryFilter
} from '../../components/sticky-summary-bar/sticky-summary-bar.component';
import { NotesPopoverComponent } from '../../components/notes-popover/notes-popover.component';
import { NotesService } from '../../services/notes.service';
import { HealthCelebrationComponent } from '../../components/health-celebration/health-celebration.component';
import { SourceDropZoneComponent } from '../../components/source-drop-zone/source-drop-zone.component';
import { SourceScannerService, ScannedFile } from '../../services/source-scanner.service';
import { CodemodPreviewComponent } from '../../components/codemod-preview/codemod-preview.component';
import { WorkspaceDriftComponent } from '../../components/workspace-drift/workspace-drift.component';
import { InstallVerifierService, ResolutionReport } from '../../services/install-verifier.service';
import { RegistryConfigComponent } from '../../components/registry-config/registry-config.component';
import { ProjectHandoffService } from '../../services/project-handoff.service';
import { PolicyConfigComponent } from '../../components/policy-config/policy-config.component';
import {
  PolicyEvaluation,
  PolicyService,
  PolicyViolation
} from '../../services/policy.service';
import { MonitorService } from '../../services/monitor.service';
import { PrPreviewComponent } from '../../components/pr-preview/pr-preview.component';
import { BundleDeltaSummaryComponent } from '../../components/bundle-delta-summary/bundle-delta-summary.component';
import { RouterLink } from '@angular/router';

/**
 * The Upgrade / Optimize page — a complete Angular-migration dashboard.
 *
 * Surfaces every enterprise feature:
 *   Health score, time estimate, deprecation warnings + alternatives,
 *   breaking-changes checklist, bundle-size delta, peer-dep conflicts,
 *   Nx detection, rollback command, config-file analysis, lockfile X-ray,
 *   micro-frontend cross-check, UI-framework alerts, license risks,
 *   standalone readiness, CI/CD pipeline generator, AI copilot hand-off,
 *   Markdown export, and post-update verification command.
 */
@Component({
  selector: 'app-upgrade-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, PackageDropZoneComponent, TranslocoModule, StickySummaryBarComponent, NotesPopoverComponent, HealthCelebrationComponent, SourceDropZoneComponent, CodemodPreviewComponent, WorkspaceDriftComponent, RegistryConfigComponent, PolicyConfigComponent, PrPreviewComponent, BundleDeltaSummaryComponent, RouterLink],
  template: `
    <section class="head">
      <h1>{{ 'upgrade.title' | transloco }}</h1>
      <p>{{ 'upgrade.subtitle' | transloco }}</p>
      <a routerLink="/upgrade/wizard" class="wizard-link">
        🪄 {{ 'wizard.title' | transloco }} →
      </a>
    </section>

    <section class="io">
      <app-package-drop-zone
        (files)="onFiles($event)"
        (sample)="loadSample()"
      />

      <details class="paste">
        <summary>{{ 'upgrade.orPaste' | transloco }}</summary>
        <textarea
          rows="6"
          spellcheck="false"
          [ngModel]="listInput()"
          (ngModelChange)="listInput.set($event)"
          placeholder="ngx-toastr&#10;&#64;angular/material&#10;ngrx/store"
        ></textarea>
        <div class="row">
          <button type="button" class="ghost" (click)="applyList()">{{ 'upgrade.analyzeList' | transloco }}</button>
        </div>
      </details>

      <!-- Source-aware scan (feature #68): drop .ts/.html files to filter
           breaking changes to only ones your code actually touches.
           Most users don't touch these advanced setup widgets on first
           visit, so they load during idle time instead of competing with
           initial paint. Each gets its own deferred chunk. -->
      @defer (on idle) {
        <app-source-drop-zone (scan)="onSourceScan($event)" />
      } @placeholder { <div class="defer-spacer" aria-hidden="true"></div> }

      @defer (on idle) {
        <!-- Private registry config (feature #72): @scope -> URL bindings + auth. -->
        <app-registry-config />
      } @placeholder { <div class="defer-spacer" aria-hidden="true"></div> }

      @defer (on idle) {
        <!-- Policy/rule engine (feature #73): block/warn rules across packages,
             licenses, deprecations, scopes. Violations surface inline below. -->
        <app-policy-config />
      } @placeholder { <div class="defer-spacer" aria-hidden="true"></div> }
    </section>

    @if (parsed(); as p) {
      <section class="setup" [attr.aria-label]="'upgrade.banner.reportSettings' | transloco">
        <div class="pill-row">
          <span class="chip">
            <strong>{{ p.deps.length }}</strong> {{ 'upgrade.chip.dependencies' | transloco }}
          </span>
          @if (p.angularMajor !== null) {
            <span class="chip">
              {{ 'upgrade.chip.detectedAngular' | transloco }} <strong>{{ p.angularMajor }}</strong>
            </span>
          } @else {
            <span class="chip warn">{{ 'upgrade.chip.noAngularCore' | transloco }}</span>
          }
          @if (projectKind() === 'nx') { <span class="chip nx">{{ 'upgrade.chip.nxWorkspace' | transloco }}</span> }
          @if (projectKind() === 'mfe') { <span class="chip mfe">{{ 'upgrade.chip.mfeHost' | transloco }}</span> }
          @if (extraApps().length) { <span class="chip mfe">{{ 'upgrade.chip.mfeApps' | transloco: { count: extraApps().length + 1 } }}</span> }
          @if (uploads().angularJsonRaw) { <span class="chip ok">{{ 'upgrade.chip.angularJson' | transloco }}</span> }
          @if (uploads().tsconfigRaw) { <span class="chip ok">{{ 'upgrade.chip.tsconfig' | transloco }}</span> }
          @if (uploads().browserslistRaw) { <span class="chip ok">{{ 'upgrade.chip.browserslist' | transloco }}</span> }
          @if (uploads().lockfileName) { <span class="chip ok">{{ uploads().lockfileName }}</span> }
          @if (p.name) { <span class="chip subtle">{{ p.name }}{{ p.version ? '@' + p.version : '' }}</span> }
        </div>

        <div class="controls">
          <label class="lbl">
            {{ 'upgrade.target' | transloco }}:
            <select
              [ngModel]="target()"
              (ngModelChange)="target.set(+$event)"
              name="target"
              [attr.aria-label]="'upgrade.target' | transloco"
            >
              @for (m of majors; track m) { <option [ngValue]="m">Angular {{ m }}</option> }
            </select>
          </label>

          <fieldset class="mode" role="radiogroup" [attr.aria-label]="'upgrade.mode.analysisMode' | transloco">
            <label [class.on]="mode() === 'same-version'">
              <input type="radio" name="mode" [checked]="mode() === 'same-version'" (change)="setMode('same-version')" />
              {{ 'upgrade.mode.optimize' | transloco }}
            </label>
            <label [class.on]="mode() === 'upgrade'">
              <input type="radio" name="mode" [checked]="mode() === 'upgrade'" (change)="setMode('upgrade')" />
              {{ 'upgrade.mode.upgrade' | transloco }}
            </label>
          </fieldset>

          <button type="button" class="primary" (click)="run()" [disabled]="running() || !p.deps.length">
            {{ running() ? ('upgrade.running' | transloco) : ('upgrade.analyze' | transloco) }}
          </button>
        </div>

        @if (p.warnings.length) {
          <ul class="warnings" [attr.aria-label]="'upgrade.banner.parseWarnings' | transloco">
            @for (w of p.warnings; track w) { <li>{{ w }}</li> }
          </ul>
        }
      </section>

      <!-- Workspace / monorepo drift analysis (feature #70). Hydrate when
           the user scrolls down past the setup section. -->
      @defer (on viewport; prefetch on idle) {
        <app-workspace-drift
          [primary]="p"
          [extras]="extraApps()"
        />
      } @placeholder { <div class="defer-spacer" aria-hidden="true"></div> }
    }

    @if (report(); as r) {
      <!-- Sticky Summary Bar — noise-cancellation filter pills (Feature #26) -->
      <app-sticky-summary-bar
        [counts]="summaryCounts()"
        [active]="severityFilter()"
        [shown]="visibleEntries().length"
        (filterChange)="setSeverityFilter($event)"
      />

      <!-- Health score banner (feature #15) -->
      <section class="health" [attr.data-grade]="r.health.grade">
        <div class="score-ring" [attr.data-grade]="r.health.grade" aria-hidden="true">
          <span class="n">{{ r.health.score }}</span>
          <span class="g">{{ r.health.grade }}</span>
        </div>
        <div class="h-body">
          <h2>
            @if (r.mode === 'upgrade') {
              {{ 'upgrade.banner.upgradeFromTo' | transloco: { from: (r.currentAngularMajor ?? '?'), to: r.targetAngularMajor } }}
            } @else {
              {{ 'upgrade.banner.optimizationOn' | transloco: { ng: r.targetAngularMajor } }}
            }
          </h2>
          <p class="h-summary">{{ 'upgrade.banner.health' | transloco: { score: r.health.score, label: gradeLabel(r.health.grade), summary: r.estimate.summary } }}</p>
          <ul class="factors">
            @for (b of r.health.breakdown; track b.label) {
              <li>
                <span class="f-label">{{ b.label }}</span>
                <span class="f-bar"><span class="f-fill" [style.width.%]="b.value"></span></span>
                <span class="f-val">{{ b.value }}%</span>
                @if (b.note) { <span class="f-note">{{ b.note }}</span> }
              </li>
            }
          </ul>
        </div>
      </section>

      <!-- Confetti + toast fires when health score hits 100 (feature #49) -->
      <app-health-celebration [score]="r.health.score" />

      <!-- Policy violations banner (feature #73) — shows blockers/warnings
           that fired against the user's enabled rules. -->
      @if (policyEval(); as pe) {
        @if (pe.violations.length) {
          <section class="policy-banner" [class.has-blockers]="pe.hasBlockers">
            <header>
              <strong>
                @if (pe.hasBlockers) {
                  {{ 'policy.banner.blocked' | transloco: { count: pe.blockerCount } }}
                } @else {
                  {{ 'policy.banner.warning' | transloco: { count: pe.warningCount } }}
                }
              </strong>
              <small>{{ 'policy.banner.lede' | transloco }}</small>
            </header>
            <ul>
              @for (v of pe.violations; track v.ruleId + ':' + v.package) {
                <li [class.block]="v.severity === 'block'" [class.warn]="v.severity === 'warn'">
                  <code>{{ v.package }}</code>
                  <span>{{ v.message }}</span>
                  <em>{{ v.ruleLabel }}</em>
                </li>
              }
            </ul>
          </section>
        }
      }

      <!-- Bundle-size delta viewer (feature #77): aggregate bundle impact
           across every recommendation in the report. Hydrate when the user
           scrolls past the health banner. -->
      @defer (on viewport; prefetch on idle) {
        <app-bundle-delta-summary [report]="r" />
      } @placeholder { <div class="defer-spacer" aria-hidden="true"></div> }

      <!-- Automated PR/MR generation (feature #75): preview the patch + open
           it directly on GitHub or GitLab when a token is available. Lazy
           because most users want to review the report before generating
           a PR. PrPreviewComponent dispatches by the active repo provider. -->
      @defer (on viewport; prefetch on idle) {
        <app-pr-preview
          [report]="r"
          [parsed]="parsed()"
          [initialRepo]="handoffSource()"
          [activeRepo]="activeRepo()"
        />
      } @placeholder { <div class="defer-spacer" aria-hidden="true"></div> }

      <section class="report">
        <div class="filter-row">
          <input
            type="search"
            class="name-filter"
            [placeholder]="'upgrade.searchPlaceholder' | transloco"
            [attr.aria-label]="'upgrade.searchPlaceholder' | transloco"
            [value]="nameFilter()"
            (input)="setNameFilter($any($event.target).value)"
          />
          @if (nameFilter().length > 0) {
            <button
              type="button"
              class="clear-filter"
              (click)="setNameFilter('')"
              [attr.aria-label]="'common.clear' | transloco"
            >×</button>
            <span class="filter-count">
              {{ visibleEntries().length }} / {{ r.entries.length }}
            </span>
          }
        </div>
        <header class="report-head">
          <div class="counts">
            <span class="pill safe">{{ r.safeCount }} {{ 'upgrade.counts.safeLower' | transloco }}</span>
            <span class="pill warning">{{ r.warningCount }} {{ 'upgrade.counts.warningLower' | transloco }}</span>
            <span class="pill conflict">{{ r.conflictCount }} {{ 'upgrade.counts.breakingLower' | transloco }}</span>
            <span class="pill unknown">{{ r.unknownCount }} {{ 'upgrade.counts.unknownLower' | transloco }}</span>
            @if (r.deprecatedCount > 0) { <span class="pill depr">{{ r.deprecatedCount }} {{ 'upgrade.counts.deprecatedLower' | transloco }}</span> }
            @if (r.uiAlertCount > 0) { <span class="pill ui">{{ r.uiAlertCount }} {{ 'upgrade.counts.uiAlertLower' | transloco }}</span> }
            @if (r.licenseBlockerCount > 0) { <span class="pill lic">{{ r.licenseBlockerCount }} {{ 'upgrade.counts.licenseBlockLower' | transloco }}</span> }
            @if (r.peerConflicts.length > 0) { <span class="pill peer">{{ r.peerConflicts.length }} {{ 'upgrade.counts.peerConflictLower' | transloco }}</span> }
          </div>
          <div class="actions">
            <button type="button" class="ghost" (click)="copyMarkdown(r)" [title]="'upgrade.actions.copyMarkdownTitle' | transloco">{{ 'upgrade.actions.copyMarkdown' | transloco }}</button>
            <div class="split">
              <button type="button" class="ghost" (click)="copyCi(r, 'github')">{{ 'upgrade.actions.githubActions' | transloco }}</button>
              <button type="button" class="ghost" (click)="copyCi(r, 'gitlab')">{{ 'upgrade.actions.gitlabCi' | transloco }}</button>
            </div>
          </div>
        </header>

        <!-- Command cards -->
        @if (r.nxMigrateCommand) {
          <article class="cmd">
            <div class="cmd-head">
              <h3>{{ 'upgrade.cmd.nxMigrateTitle' | transloco }}</h3>
              <p>{{ 'upgrade.cmd.nxMigrateHint' | transloco }}</p>
            </div>
            <pre class="cmd-body"><code>{{ r.nxMigrateCommand }}</code></pre>
            <button type="button" class="copy" (click)="copy(r.nxMigrateCommand!)">{{ 'upgrade.cmd.nxMigrateCopy' | transloco }}</button>
          </article>
        } @else if (r.ngUpdateCommand) {
          <article class="cmd">
            <div class="cmd-head">
              <h3>{{ 'upgrade.cmd.oneShotTitle' | transloco }}</h3>
              <p>{{ 'upgrade.cmd.oneShotHint' | transloco }}</p>
            </div>
            <pre class="cmd-body"><code>{{ r.ngUpdateCommand }}</code></pre>
            <button type="button" class="copy" (click)="copy(r.ngUpdateCommand)">{{ 'upgrade.cmd.oneShotCopy' | transloco }}</button>
          </article>
        }

        @if (r.installCommand) {
          <article class="cmd">
            <div class="cmd-head">
              <h3>{{ 'upgrade.cmd.installTitle' | transloco }}</h3>
              <p>{{ 'upgrade.cmd.installHint' | transloco }}</p>
            </div>
            <pre class="cmd-body"><code>{{ r.installCommand }}</code></pre>
            <div class="cmd-actions">
              <button type="button" class="copy" (click)="copy(r.installCommand)">{{ 'upgrade.cmd.installCopy' | transloco }}</button>
              <!-- Install-time verifier (feature #71) -->
              <button type="button" class="copy" (click)="verifyInstall(r)">{{ 'upgrade.cmd.verify' | transloco }}</button>
            </div>
            @if (verifyResult(); as vr) {
              <div class="verify" [class.ok]="vr.ok" [class.bad]="!vr.ok">
                @if (vr.ok) {
                  <strong>✓ {{ 'upgrade.cmd.verifyOk' | transloco: { n: vr.walked } }}</strong>
                } @else {
                  <strong>✗ {{ 'upgrade.cmd.verifyBad' | transloco: { n: vr.conflicts.length } }}</strong>
                  <ul>
                    @for (c of vr.conflicts; track c.source + c.target) {
                      <li><code>{{ c.source }}</code> ↔ <code>{{ c.target }}@{{ c.actual }}</code> — {{ c.hint }}</li>
                    }
                  </ul>
                }
              </div>
            }
          </article>
        }

        <!-- Rollback + verify (features #6 + #11) -->
        <div class="safety">
          @if (r.rollbackCommand) {
            <article class="cmd roll">
              <div class="cmd-head">
                <h3>{{ 'upgrade.cmd.rollbackTitle' | transloco }}</h3>
                <p>{{ 'upgrade.cmd.rollbackHint' | transloco }}</p>
              </div>
              <pre class="cmd-body"><code>{{ r.rollbackCommand }}</code></pre>
              <button type="button" class="copy" (click)="copy(r.rollbackCommand)">{{ 'upgrade.cmd.rollbackCopy' | transloco }}</button>
            </article>
          }
          @if (r.verifyCommand) {
            <article class="cmd verify">
              <div class="cmd-head">
                <h3>{{ 'upgrade.cmd.verifyTitle' | transloco }}</h3>
                <p>{{ 'upgrade.cmd.verifyHint' | transloco }}</p>
              </div>
              <pre class="cmd-body"><code>{{ r.verifyCommand }}</code></pre>
              <button type="button" class="copy" (click)="copy(r.verifyCommand)">{{ 'upgrade.cmd.verifyCopy' | transloco }}</button>
            </article>
          }
        </div>

        <!-- Peer conflicts (feature #4) -->
        @if (r.peerConflicts.length) {
          <article class="panel peer">
            <h3>{{ 'upgrade.peer.title' | transloco }}</h3>
            <ul>
              @for (c of r.peerConflicts; track c.source + c.target) {
                <li>
                  <code>{{ c.source }}</code> {{ 'upgrade.peer.expects' | transloco }}
                  <code>{{ c.target }}@{{ c.expected }}</code> {{ 'upgrade.peer.butResolves' | transloco }}
                  <code>{{ c.actual }}</code>.
                  <p class="hint">{{ c.hint }}</p>
                </li>
              }
            </ul>
          </article>
        }

        <!-- Config analysis (feature #8 + #16) -->
        @if (r.config) {
          <article class="panel cfg">
            <h3>{{ 'upgrade.cfg.title' | transloco }}</h3>
            @if (r.config.angularJson?.length) {
              <h4>angular.json</h4>
              <ul>
                @for (c of r.config.angularJson; track $index) {
                  <li [attr.data-level]="c.level"><span class="lvl">{{ c.level }}</span> {{ c.message }}</li>
                }
              </ul>
            }
            @if (r.config.tsconfig?.length) {
              <h4>tsconfig.json</h4>
              <ul>
                @for (c of r.config.tsconfig; track $index) {
                  <li [attr.data-level]="c.level"><span class="lvl">{{ c.level }}</span> {{ c.message }}</li>
                }
              </ul>
            }
            @if (r.config.browserslist?.length) {
              <h4>.browserslistrc</h4>
              <ul>
                @for (c of r.config.browserslist; track $index) {
                  <li [attr.data-level]="c.level"><span class="lvl">{{ c.level }}</span> {{ c.message }}</li>
                }
              </ul>
            }
          </article>
        }

        <!-- Lockfile X-ray (feature #12) -->
        @if (r.lockfile) {
          <article class="panel lock">
            <h3>{{ 'upgrade.lock.title' | transloco: { kind: r.lockfile.kind } }}</h3>
            <p class="sub">{{ 'upgrade.lock.scanned' | transloco: { total: r.lockfile.total } }}</p>
            @if (r.lockfile.transitiveRisks.length) {
              <ul>
                @for (risk of r.lockfile.transitiveRisks; track risk.name + risk.version) {
                  <li>
                    <code>{{ risk.name }}{{ risk.version ? '@' + risk.version : '' }}</code>
                    — {{ risk.reason }}
                  </li>
                }
              </ul>
            } @else {
              <p class="sub">{{ 'upgrade.lock.none' | transloco }}</p>
            }
          </article>
        }

        <!-- Micro-frontend cross-check (feature #13) -->
        @if (r.mfe) {
          <article class="panel mfe">
            <h3>{{ 'upgrade.mfeSection.title' | transloco }}</h3>
            <p class="sub">{{ 'upgrade.mfeSection.apps' | transloco: { names: r.mfe.apps.join(', ') } }}</p>
            <table class="grid sm">
              <thead>
                <tr><th>{{ 'upgrade.mfeSection.sharedLib' | transloco }}</th><th>{{ 'upgrade.mfeSection.status' | transloco }}</th><th>{{ 'upgrade.mfeSection.versions' | transloco }}</th></tr>
              </thead>
              <tbody>
                @for (d of r.mfe.sharedDeps; track d.name) {
                  <tr>
                    <td><code>{{ d.name }}</code></td>
                    <td>
                      <span class="pill" [ngClass]="d.consistent ? 'safe' : 'conflict'">
                        {{ (d.consistent ? 'upgrade.mfeSection.consistent' : 'upgrade.mfeSection.mismatch') | transloco }}
                      </span>
                    </td>
                    <td>
                      <ul class="inline">
                        @for (kv of toPairs(d.versions); track kv[0]) {
                          <li><strong>{{ kv[0] }}</strong>: <code>{{ kv[1] }}</code></li>
                        }
                      </ul>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </article>
        }

        <!-- Main per-dep table. scroll-table-tall (800px / 80vh) instead
             of the default 600px because this is THE main result table
             on the page — users expect to see more rows at once than
             on supporting tables, and uploads with 50+ deps need the
             extra real estate. -->
        <div class="table-wrap scroll-table scroll-table-tall">
          <table class="grid">
            <caption class="sr-only">{{ 'upgrade.table.caption' | transloco }}</caption>
            <thead>
              <tr>
                <th scope="col">{{ 'upgrade.table.package' | transloco }}</th>
                <th scope="col">{{ 'upgrade.table.status' | transloco }}</th>
                <th scope="col">{{ 'upgrade.table.current' | transloco }}</th>
                <th scope="col">{{ 'upgrade.table.recommended' | transloco }}</th>
                <th scope="col">{{ 'upgrade.table.bundle' | transloco }}</th>
                <th scope="col">{{ 'upgrade.table.license' | transloco }}</th>
                <th scope="col">{{ 'upgrade.table.action' | transloco }}</th>
                <th scope="col">{{ 'upgrade.table.notes' | transloco }}</th>
              </tr>
            </thead>
            <tbody>
              @for (e of visibleEntries(); track e.name) {
                <tr [attr.data-status]="e.status">
                  <td [attr.data-label]="'upgrade.table.package' | transloco">
                    <code>{{ e.name }}</code>
                    @if (e.ngUpdateAware) { <span class="tag">{{ 'upgrade.table.ngUpdate' | transloco }}</span> }
                    @if (e.supportsStandalone) { <span class="tag standalone" [title]="'upgrade.table.standaloneTitle' | transloco">{{ 'upgrade.table.standalone' | transloco }}</span> }
                    @if (e.deprecation) { <span class="tag depr">{{ 'upgrade.table.deprecated' | transloco }}</span> }
                    @if (e.uiFrameworkAlert) { <span class="tag ui">{{ 'upgrade.table.ui' | transloco }}</span> }
                  </td>
                  <td [attr.data-label]="'upgrade.table.status' | transloco">
                    <span class="pill" [ngClass]="e.status">{{ label(e.status) }}</span>
                  </td>
                  <td [attr.data-label]="'upgrade.table.current' | transloco">
                    {{ e.currentVersion ?? '—' }}
                    @if (e.currentRange) { <span class="sub"> ({{ e.currentRange }})</span> }
                  </td>
                  <td [attr.data-label]="'upgrade.table.recommended' | transloco">
                    {{ recommendedFor(e, r.mode) ?? '—' }}
                  </td>
                  <td [attr.data-label]="'upgrade.table.bundle' | transloco">
                    @if (e.bundleDelta?.deltaBytes != null && e.bundleDelta?.deltaBytes !== 0) {
                      <span class="bundle" [class.up]="(e.bundleDelta?.deltaBytes ?? 0) > 0" [class.down]="(e.bundleDelta?.deltaBytes ?? 0) < 0">
                        {{ formatBundle(e.bundleDelta!.deltaBytes!) }}
                        @if (e.bundleDelta?.deltaPercent != null) {
                          <span class="sub">({{ formatPct(e.bundleDelta!.deltaPercent!) }})</span>
                        }
                      </span>
                    } @else { <span class="sub">—</span> }
                  </td>
                  <td [attr.data-label]="'upgrade.table.license' | transloco">
                    @if (e.licenseRisk) {
                      <span class="pill" [ngClass]="licenseClass(e.licenseRisk.risk)">
                        {{ e.licenseRisk.recommendedLicense ?? e.licenseRisk.currentLicense ?? '—' }}
                      </span>
                    } @else { <span class="sub">—</span> }
                  </td>
                  <td [attr.data-label]="'upgrade.table.action' | transloco">
                    @if (e.installSpec) {
                      <code class="spec">{{ e.installSpec }}</code>
                      <button type="button" class="copy sm" (click)="copy(e.installSpec!)">{{ 'upgrade.table.copy' | transloco }}</button>
                    } @else { — }
                  </td>
                  <td [attr.data-label]="'upgrade.table.notes' | transloco" class="note">
                    <div class="note-head">
                      <span class="note-text">{{ e.note }}</span>
                      <button
                        type="button"
                        class="note-btn"
                        [class.has-note]="notes.isFlagged(e.name) || notes.noteFor(e.name)"
                        (click)="toggleNotes(e.name)"
                        [attr.aria-label]="'notes.title' | transloco"
                        [attr.aria-expanded]="notesOpenFor() === e.name"
                        [title]="'notes.title' | transloco"
                      >
                        @if (notes.isFlagged(e.name)) { 📌 } @else if (notes.noteFor(e.name)) { 📝 } @else { 🗒 }
                      </button>
                    </div>
                    @if (notesOpenFor() === e.name) {
                      <app-notes-popover
                        [packageName]="e.name"
                        (close)="notesOpenFor.set(null)"
                      />
                    }

                    <!-- Codemod previews (feature #69) — only when we scanned src files -->
                    @if (sourceScanner.lastFiles().length) {
                      <app-codemod-preview [pkg]="e.name" />
                    }

                    <!-- Breaking changes (feature #2) -->
                    @if (e.breakingChanges?.length) {
                      <details class="bc">
                        <summary>{{ 'upgrade.table.breakingCount' | transloco: { n: e.breakingChanges!.length } }}</summary>
                        <ul>
                          @for (bc of e.breakingChanges!; track bc.title) {
                            <li [attr.data-sev]="bc.severity" [class.cited]="bc.citations?.length">
                              <strong>{{ bc.title }}</strong>
                              @if (bc.since) { <span class="sub">· {{ 'upgrade.table.since' | transloco }} {{ bc.since }}</span> }
                              @if (bc.citations?.length) {
                                <span class="cite-badge" [attr.title]="'upgrade.table.inYourCode' | transloco">
                                  {{ 'upgrade.table.citedCount' | transloco: { n: bc.citations!.length } }}
                                </span>
                              }
                              <p>{{ bc.detail }}</p>
                              @if (bc.citations?.length) {
                                <ul class="cites">
                                  @for (c of bc.citations!; track c.file + ':' + c.line) {
                                    <li>
                                      <code>{{ c.file }}:{{ c.line }}</code>
                                      <span class="muted">{{ c.snippet }}</span>
                                    </li>
                                  }
                                </ul>
                              }
                              <div class="bc-actions">
                                @if (bc.link) { <a [href]="bc.link" target="_blank" rel="noopener">{{ 'upgrade.table.docsLink' | transloco }}</a> }
                                <button type="button" class="link" (click)="askAi('claude', e.name, bc, r.targetAngularMajor)">{{ 'upgrade.table.askClaude' | transloco }}</button>
                                <button type="button" class="link" (click)="askAi('chatgpt', e.name, bc, r.targetAngularMajor)">{{ 'upgrade.table.askChatGPT' | transloco }}</button>
                                <button type="button" class="link" (click)="askAi('gemini', e.name, bc, r.targetAngularMajor)">{{ 'upgrade.table.askGemini' | transloco }}</button>
                              </div>
                            </li>
                          }
                        </ul>
                      </details>
                    }

                    <!-- Deprecation alternatives (feature #1) -->
                    @if (e.deprecation?.alternatives?.length) {
                      <details class="bc depr">
                        <summary>{{ 'upgrade.table.alternatives' | transloco: { n: e.deprecation!.alternatives!.length } }}</summary>
                        <p>{{ e.deprecation!.reason }}</p>
                        <ul>
                          @for (a of e.deprecation!.alternatives!; track a.name) {
                            <li><code>{{ a.name }}</code> — {{ a.rationale }}</li>
                          }
                        </ul>

                        <!-- Pros & Cons (new feature) -->
                        @if (prosConsFor(e.name); as comparison) {
                          @if (comparison.length) {
                            <div class="proscons">
                              <h5>{{ 'upgrade.prosCons.title' | transloco }}</h5>
                              <table class="grid sm">
                                <thead><tr>
                                  <th>{{ 'upgrade.prosCons.option' | transloco }}</th>
                                  <th>{{ 'upgrade.prosCons.pros' | transloco }}</th>
                                  <th>{{ 'upgrade.prosCons.cons' | transloco }}</th>
                                  <th>{{ 'upgrade.prosCons.verdict' | transloco }}</th>
                                </tr></thead>
                                <tbody>
                                  @for (pc of comparison; track pc.name) {
                                    <tr>
                                      <td><code>{{ pc.name }}</code></td>
                                      <td><ul class="plain">@for (p of pc.pros; track p) { <li>✔ {{ p }}</li> }</ul></td>
                                      <td><ul class="plain">@for (c of pc.cons; track c) { <li>✘ {{ c }}</li> }</ul></td>
                                      <td class="sub">{{ pc.verdict }}</td>
                                    </tr>
                                  }
                                </tbody>
                              </table>
                            </div>
                          }
                        }

                        <!-- Dead-but-working pin (new feature) -->
                        @if (deadPinFor(e.name, r.targetAngularMajor); as dead) {
                          <div class="dead-pin">
                            <h5>{{ 'upgrade.deadButWorking.title' | transloco }}</h5>
                            <p class="sub">{{ 'upgrade.deadButWorking.hint' | transloco }}</p>
                            <p><strong>{{ 'upgrade.deadButWorking.lastWorking' | transloco: { ng: r.targetAngularMajor } }}:</strong> <code>{{ e.name }}@{{ dead.version }}</code></p>
                            <button type="button" class="copy sm" (click)="copy(e.name + '@' + dead.version)">{{ 'upgrade.deadButWorking.useExact' | transloco }}</button>
                            <p class="sub warn">{{ 'upgrade.deadButWorking.caveat' | transloco }}</p>
                          </div>
                        }
                      </details>
                    }

                    <!-- Release timeline (new feature) -->
                    @if (timelineFor(e.name); as t) {
                      @if (t) {
                        <details class="bc timeline">
                          <summary>{{ 'upgrade.timeline.title' | transloco }}</summary>
                          @if (t.currentAgo) { <p>{{ 'upgrade.timeline.currentReleased' | transloco: { ago: t.currentAgo } }}</p> }
                          @if (t.latestAgo) { <p>{{ 'upgrade.timeline.latestReleased' | transloco: { ago: t.latestAgo } }}</p> }
                          <p class="sub" [class.warn]="t.stale">{{ (t.stale ? 'upgrade.timeline.stale' : 'upgrade.timeline.fresh') | transloco }}</p>
                        </details>
                      }
                    }

                    <!-- UI framework alert (feature #10) -->
                    @if (e.uiFrameworkAlert) {
                      <details class="bc ui">
                        <summary>{{ 'upgrade.table.uiAlert' | transloco: { framework: e.uiFrameworkAlert.framework } }}</summary>
                        <strong>{{ e.uiFrameworkAlert.title }}</strong>
                        <p>{{ e.uiFrameworkAlert.detail }}</p>
                        @if (e.uiFrameworkAlert.link) {
                          <a [href]="e.uiFrameworkAlert.link" target="_blank" rel="noopener">{{ 'upgrade.table.migrationGuide' | transloco }}</a>
                        }
                      </details>
                    }

                    <!-- License risk (feature #20) -->
                    @if (e.licenseRisk?.risk && e.licenseRisk?.risk !== 'safe') {
                      <details class="bc" [attr.data-sev]="e.licenseRisk!.risk === 'blocker' ? 'critical' : 'warning'">
                        <summary>{{ 'upgrade.table.licenseLabel' | transloco: { risk: e.licenseRisk!.risk } }}</summary>
                        <p>{{ e.licenseRisk!.note }}</p>
                      </details>
                    }

                    <!-- Community gotchas (feature #14) -->
                    @if (gotchasFor(e.name, r.targetAngularMajor).length) {
                      <details class="bc community">
                        <summary>{{ 'upgrade.table.communityNotes' | transloco: { n: gotchasFor(e.name, r.targetAngularMajor).length } }}</summary>
                        @for (n of gotchasFor(e.name, r.targetAngularMajor); track n.id) {
                          <blockquote>
                            <p>{{ n.body }}</p>
                            <cite>— {{ n.author || ('upgrade.table.anonymous' | transloco) }} · ▲ {{ n.upvotes ?? 0 }}
                              <button type="button" class="link" (click)="upvote(n.id)">{{ 'upgrade.table.upvote' | transloco }}</button>
                            </cite>
                          </blockquote>
                        }
                      </details>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>

        @if (r.conflictCount > 0) {
          <aside class="callout conflict">
            <strong>{{ 'upgrade.breakingCallout.strong' | transloco }}</strong>
            {{ 'upgrade.breakingCallout.body' | transloco: { ng: r.targetAngularMajor } }}
          </aside>
        }

        <!-- Add community note -->
        <section class="add-note">
          <h3>{{ 'upgrade.addNote.title' | transloco }}</h3>
          <p class="sub">
            {{ 'upgrade.addNote.intro' | transloco }}
            @if (supabase.isSignedIn()) {
              <span class="storage-pill storage-cloud">
                {{ 'upgrade.addNote.storageSignedIn' | transloco }}
              </span>
            } @else {
              <span class="storage-pill storage-local">
                {{ 'upgrade.addNote.storageAnon' | transloco }}
              </span>
            }
          </p>
          <div class="row">
            <input
              type="text"
              [ngModel]="noteName()"
              (ngModelChange)="noteName.set($event)"
              [placeholder]="'upgrade.addNote.pkgPlaceholder' | transloco"
              [attr.aria-invalid]="noteValidation().reasons.includes('pkg')"
            />
            <input
              type="number"
              [ngModel]="noteNg()"
              (ngModelChange)="noteNg.set(+$event)"
              [min]="12" [max]="50"
              [placeholder]="'upgrade.addNote.ngPlaceholder' | transloco"
            />
            <input
              type="text"
              [ngModel]="noteAuthor()"
              (ngModelChange)="noteAuthor.set($event)"
              [placeholder]="'upgrade.addNote.authorPlaceholder' | transloco"
            />
          </div>
          <textarea
            rows="3"
            [ngModel]="noteBody()"
            (ngModelChange)="noteBody.set($event)"
            [placeholder]="'upgrade.addNote.bodyPlaceholder' | transloco"
            [attr.aria-invalid]="noteValidation().reasons.includes('body-short')"
          ></textarea>

          <!-- Live, contextual feedback below the form. The counter turns
               green when the body crosses the min-length threshold so the
               user can see exactly when the button will unlock. -->
          <div class="note-feedback">
            @if (noteValidation().reasons.includes('pkg')) {
              <small class="hint hint-bad">
                {{ 'upgrade.addNote.hintLabels.needPkg' | transloco }}
              </small>
            }
            @if (noteValidation().reasons.includes('body-short')) {
              <small class="hint hint-bad">
                {{ 'upgrade.addNote.hintLabels.needBody' | transloco: {
                  min: noteValidation().bodyMin,
                  have: noteValidation().bodyLen
                } }}
              </small>
            } @else if (noteBody()) {
              <small class="hint hint-ok">
                {{ 'upgrade.addNote.hintLabels.bodyOk' | transloco: {
                  count: noteValidation().bodyLen
                } }}
              </small>
            }
          </div>

          <div class="row">
            <!-- Wrapper catches clicks even when the inner button is
                 disabled — gives users feedback explaining what's missing. -->
            <span
              class="submit-wrap"
              (click)="noteSubmitIntent()"
              [class.is-blocked]="!canSubmitNote()"
            >
              <button
                type="button"
                class="primary"
                (click)="submitNote(); $event.stopPropagation()"
                [disabled]="!canSubmitNote()"
              >
                {{ 'upgrade.addNote.submit' | transloco }}
              </button>
            </span>
          </div>
        </section>

        <!--
          Option B: tiny inline "Your contributions" disclosure.
          Renders for ANY user (anon or signed-in) that has contributed at
          least one note — the deletion-friction problem applies equally to
          both. The internal pill tells users where their data is being
          stored so the storage policy stays transparent.
          Closed by default — its primary job is to give users a way to
          find + remove their old contributions without forcing them to
          re-navigate to the exact package@major combination.
        -->
        @if (community.userNotes().length > 0) {
          <details class="my-contributions">
            <summary>
              <span class="contrib-icon" aria-hidden="true">📝</span>
              <span class="contrib-summary-text">
                {{ 'upgrade.myContributions.title' | transloco: {
                  count: community.userNotes().length
                } }}
              </span>
              @if (supabase.isSignedIn()) {
                <span class="storage-pill storage-cloud">
                  {{ 'upgrade.addNote.storageSignedIn' | transloco }}
                </span>
              } @else {
                <span class="storage-pill storage-local">
                  {{ 'upgrade.addNote.storageAnon' | transloco }}
                </span>
              }
            </summary>
            <ul class="contrib-list">
              @for (n of community.userNotes(); track n.id) {
                <li class="contrib-item">
                  <div class="contrib-meta">
                    <code class="contrib-pkg">{{ n.pkg }}</code>
                    <span class="contrib-ng">Angular {{ n.ng }}</span>
                    @if (n.upvotes && n.upvotes > 0) {
                      <span class="contrib-upvotes" [attr.aria-label]="
                        'upgrade.myContributions.upvotes' | transloco: { count: n.upvotes }
                      ">▲ {{ n.upvotes }}</span>
                    }
                  </div>
                  <p class="contrib-body">{{ n.body }}</p>
                  <div class="contrib-foot">
                    <time [attr.datetime]="n.createdAt">{{ relativeTime(n.createdAt) }}</time>
                    <button
                      type="button"
                      class="contrib-remove"
                      (click)="removeContribution(n.id)"
                      [attr.aria-label]="'upgrade.myContributions.remove' | transloco"
                    >
                      {{ 'upgrade.myContributions.remove' | transloco }}
                    </button>
                  </div>
                </li>
              }
            </ul>
          </details>
        }
      </section>
    } @else if (running()) {
      <section class="skel" aria-label="Loading">
        <div class="bar"></div>
        <div class="bar w60"></div>
        <div class="bar w80"></div>
      </section>
    }
  `,
  styles: [`
    :host { display: block; }
    /* Reserve a small slot for @defer placeholders so layout doesn't jump
       when the chunk arrives. The deferred component fills the slot. */
    .defer-spacer { min-height: 1px; }
    .head h1 { font-size: clamp(1.35rem, 2vw + 0.8rem, 2rem); color: var(--fg); margin: 0 0 0.35rem; }
    .head p { color: var(--fg-dim); margin: 0; max-width: 72ch; }
    .head .wizard-link {
      display: inline-block; margin-top: 0.45rem;
      font-size: 0.88rem; color: var(--accent, #2563eb); text-decoration: none;
      padding: 0.3rem 0.65rem; border-radius: 8px;
      background: var(--accent-bg, #eff6ff); border: 1px solid var(--accent-bg, #eff6ff);
      transition: background 180ms ease, transform 180ms ease;
    }
    .head .wizard-link:hover { transform: translateY(-1px); }
    .filter-row {
      display: flex; align-items: center; gap: 0.5rem;
      margin: 0.4rem 0 0.6rem;
    }
    .name-filter {
      flex: 1 1 auto; max-width: 320px;
      padding: 0.45rem 0.7rem; border-radius: 8px;
      border: 1px solid var(--border); background: var(--surface-2); color: var(--fg);
      font: inherit; font-size: 0.88rem;
    }
    .name-filter:focus { outline: 2px solid var(--accent, #2563eb); outline-offset: 1px; }
    .clear-filter {
      width: 28px; height: 28px; border-radius: 50%;
      border: 1px solid var(--border); background: var(--surface-2); color: var(--fg-dim);
      cursor: pointer; line-height: 1; font-size: 1rem;
    }
    .clear-filter:hover { color: var(--accent, #2563eb); border-color: var(--accent, #2563eb); }
    .filter-count { font-size: 0.82rem; color: var(--fg-dim); }
    code { background: var(--surface-1); padding: 1px 6px; border-radius: 4px; border: 1px solid var(--border); font-size: 0.85rem; }

    .io { display: grid; gap: 1rem; margin-top: 1.25rem; }
    .paste summary { cursor: pointer; color: var(--fg-dim); font-size: 0.9rem; padding: 0.5rem 0; user-select: none; }
    .paste summary:hover { color: var(--accent); }
    .paste textarea {
      width: 100%; padding: 0.7rem 0.85rem; border-radius: 10px;
      border: 1px solid var(--border); background: var(--surface-1);
      color: var(--fg); font-family: ui-monospace, Menlo, Consolas, monospace;
      font-size: 0.85rem; min-height: 140px; resize: vertical;
    }
    .paste .row { margin-top: 0.5rem; display: flex; gap: 0.5rem; }
    .ghost {
      padding: 0.55rem 0.9rem; border-radius: 8px; border: 1px solid var(--border);
      background: var(--surface-2); color: var(--fg); cursor: pointer; font-size: 0.88rem;
    }
    .ghost:hover { border-color: var(--accent); color: var(--accent); }

    .setup {
      margin-top: 1.25rem; padding: 1rem 1.1rem; border: 1px solid var(--border);
      border-radius: 14px; background: var(--surface-2);
      display: flex; flex-direction: column; gap: 0.8rem;
    }
    .pill-row { display: flex; flex-wrap: wrap; gap: 0.4rem; }
    .chip {
      padding: 3px 10px; border-radius: 999px; background: var(--surface-1);
      border: 1px solid var(--border); font-size: 0.78rem; color: var(--fg-dim);
    }
    .chip.subtle { color: var(--fg-dim); }
    .chip.warn { background: color-mix(in srgb, #f59e0b 12%, transparent); border-color: color-mix(in srgb, #f59e0b 35%, transparent); color: #fcd34d; }
    .chip.ok { background: color-mix(in srgb, #22c55e 10%, transparent); border-color: color-mix(in srgb, #22c55e 35%, transparent); color: #86efac; }
    .chip.nx, .chip.mfe { background: color-mix(in srgb, #8b5cf6 12%, transparent); border-color: color-mix(in srgb, #8b5cf6 35%, transparent); color: #c4b5fd; }

    .controls { display: flex; flex-wrap: wrap; gap: 0.65rem; align-items: center; }
    .lbl { display: flex; align-items: center; gap: 0.5rem; color: var(--fg-dim); font-size: 0.85rem; }
    select {
      padding: 0.45rem 0.7rem; border-radius: 8px; border: 1px solid var(--border);
      background: var(--surface-1); color: var(--fg); font-size: 0.9rem; min-height: 36px;
    }
    .mode { border: 1px solid var(--border); border-radius: 10px; padding: 3px; display: inline-flex; gap: 2px; background: var(--surface-1); }
    .mode label {
      padding: 0.4rem 0.75rem; border-radius: 7px; cursor: pointer;
      font-size: 0.82rem; color: var(--fg-dim); display: inline-flex; align-items: center; gap: 0.3rem;
    }
    .mode label.on { background: var(--accent); color: #fff; }
    .mode input { display: none; }

    .primary {
      padding: 0.6rem 1.1rem; border-radius: 10px; border: none; cursor: pointer;
      background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; font-weight: 600;
      min-height: 40px; font-size: 0.92rem;
    }
    .primary:disabled { opacity: 0.55; cursor: not-allowed; }

    .warnings {
      margin: 0; padding: 0.5rem 0.75rem 0.5rem 1.3rem; color: #fcd34d; font-size: 0.82rem;
      background: color-mix(in srgb, #f59e0b 8%, transparent);
      border: 1px solid color-mix(in srgb, #f59e0b 30%, transparent);
      border-radius: 10px;
    }

    /* Health banner */
    .health {
      margin-top: 1.5rem; display: flex; gap: 1.25rem; padding: 1.25rem;
      border: 1px solid var(--border); border-radius: 16px; background: var(--surface-2);
      align-items: center;
    }
    .health[data-grade="A"] { background: color-mix(in srgb, #22c55e 8%, var(--surface-2)); border-color: color-mix(in srgb, #22c55e 40%, transparent); }
    .health[data-grade="B"] { background: color-mix(in srgb, #84cc16 8%, var(--surface-2)); border-color: color-mix(in srgb, #84cc16 40%, transparent); }
    .health[data-grade="C"] { background: color-mix(in srgb, #f59e0b 8%, var(--surface-2)); border-color: color-mix(in srgb, #f59e0b 40%, transparent); }
    .health[data-grade="D"] { background: color-mix(in srgb, #f97316 8%, var(--surface-2)); border-color: color-mix(in srgb, #f97316 40%, transparent); }
    .health[data-grade="F"] { background: color-mix(in srgb, #ef4444 10%, var(--surface-2)); border-color: color-mix(in srgb, #ef4444 45%, transparent); }
    .score-ring {
      flex: 0 0 auto; width: 96px; height: 96px; border-radius: 50%;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      background: var(--surface-1); border: 4px solid var(--accent); color: var(--fg);
    }
    .score-ring .n { font-size: 1.6rem; font-weight: 700; }
    .score-ring .g { font-size: 0.82rem; color: var(--fg-dim); letter-spacing: 0.05em; }
    .score-ring[data-grade="A"] { border-color: #22c55e; }
    .score-ring[data-grade="B"] { border-color: #84cc16; }
    .score-ring[data-grade="C"] { border-color: #f59e0b; }
    .score-ring[data-grade="D"] { border-color: #f97316; }
    .score-ring[data-grade="F"] { border-color: #ef4444; }
    .h-body { flex: 1 1 auto; min-width: 0; }
    .h-body h2 { margin: 0 0 0.2rem; font-size: 1.1rem; color: var(--fg); }
    .h-summary { margin: 0 0 0.55rem; color: var(--fg-dim); font-size: 0.88rem; }
    .factors { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.3rem; }
    .factors li { display: grid; grid-template-columns: 160px 1fr 48px; gap: 0.6rem; align-items: center; font-size: 0.8rem; color: var(--fg-dim); }
    .f-label { color: var(--fg); }
    .f-bar { height: 6px; border-radius: 3px; background: var(--surface-1); overflow: hidden; border: 1px solid var(--border); }
    .f-fill { display: block; height: 100%; background: linear-gradient(90deg, #22c55e, #6366f1); }
    .f-val { text-align: right; font-variant-numeric: tabular-nums; color: var(--fg); }
    .f-note { grid-column: 1 / -1; color: var(--fg-dim); font-size: 0.74rem; padding-left: 0; }

    .report { margin-top: 1.5rem; display: grid; gap: 1rem; }
    .report-head { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; justify-content: space-between; }
    .counts { display: flex; flex-wrap: wrap; gap: 0.35rem; }
    .actions { display: flex; gap: 0.4rem; flex-wrap: wrap; }
    .split { display: inline-flex; gap: 0.25rem; }

    .pill {
      padding: 3px 10px; border-radius: 999px; font-size: 0.76rem; font-weight: 600;
      border: 1px solid transparent; display: inline-block; white-space: nowrap;
    }
    .pill.safe     { background: color-mix(in srgb, #22c55e 14%, transparent); color: #86efac; border-color: color-mix(in srgb, #22c55e 35%, transparent); }
    .pill.warning  { background: color-mix(in srgb, #f59e0b 14%, transparent); color: #fcd34d; border-color: color-mix(in srgb, #f59e0b 35%, transparent); }
    .pill.conflict { background: color-mix(in srgb, #ef4444 14%, transparent); color: #fca5a5; border-color: color-mix(in srgb, #ef4444 35%, transparent); }
    .pill.unknown  { background: color-mix(in srgb, #64748b 18%, transparent); color: #cbd5e1; border-color: color-mix(in srgb, #64748b 40%, transparent); }
    .pill.depr     { background: color-mix(in srgb, #ec4899 14%, transparent); color: #f9a8d4; border-color: color-mix(in srgb, #ec4899 40%, transparent); }
    .pill.ui       { background: color-mix(in srgb, #8b5cf6 14%, transparent); color: #c4b5fd; border-color: color-mix(in srgb, #8b5cf6 40%, transparent); }
    .pill.lic      { background: color-mix(in srgb, #b91c1c 20%, transparent); color: #fecaca; border-color: color-mix(in srgb, #b91c1c 40%, transparent); }
    .pill.peer     { background: color-mix(in srgb, #14b8a6 14%, transparent); color: #5eead4; border-color: color-mix(in srgb, #14b8a6 40%, transparent); }

    .cmd {
      border: 1px solid var(--border); border-radius: 14px; background: var(--surface-2);
      padding: 1rem 1.1rem; display: grid; gap: 0.6rem;
    }
    .cmd.roll { border-color: color-mix(in srgb, #f59e0b 40%, transparent); background: color-mix(in srgb, #f59e0b 5%, var(--surface-2)); }
    .cmd.verify { border-color: color-mix(in srgb, #22c55e 40%, transparent); background: color-mix(in srgb, #22c55e 5%, var(--surface-2)); }
    .cmd-head h3 { margin: 0; font-size: 0.98rem; color: var(--fg); }
    .cmd-head p { margin: 0; color: var(--fg-dim); font-size: 0.82rem; }
    .cmd-body {
      margin: 0; padding: 0.75rem 0.9rem; border-radius: 10px;
      background: var(--surface-1); border: 1px solid var(--border);
      overflow-x: auto; font-size: 0.85rem; color: var(--fg); white-space: pre;
    }
    .copy {
      justify-self: start; padding: 0.5rem 0.9rem; border-radius: 8px;
      background: var(--accent); color: #fff; border: none; cursor: pointer;
      font-size: 0.82rem; font-weight: 600; min-height: 34px;
    }
    .copy:hover { filter: brightness(1.08); }
    .copy.sm { min-height: 26px; padding: 2px 8px; font-size: 0.72rem; margin-left: 0.3rem; }

    /* Install verifier (feature #71) */
    .cmd-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
    .verify {
      margin-top: 0.4rem; padding: 0.6rem 0.8rem; border-radius: 8px;
      font-size: 0.82rem; border: 1px solid var(--border); background: var(--surface-1);
    }
    .verify.ok { border-color: color-mix(in srgb, #22c55e 40%, transparent); background: color-mix(in srgb, #22c55e 8%, var(--surface-1)); color: #15803d; }
    .verify.bad { border-color: color-mix(in srgb, #ef4444 40%, transparent); background: color-mix(in srgb, #ef4444 8%, var(--surface-1)); color: #b91c1c; }
    .verify ul { margin: 0.4rem 0 0; padding-left: 1.1rem; display: grid; gap: 0.25rem; }
    .verify code { background: var(--surface-2); padding: 0.05rem 0.3rem; border-radius: 4px; }

    /* Policy violations banner (feature #73) */
    .policy-banner {
      margin: 0.85rem 0; padding: 0.9rem 1rem; border-radius: 12px;
      border: 1px solid color-mix(in srgb, #f59e0b 40%, var(--border));
      background: color-mix(in srgb, #f59e0b 5%, var(--surface-1));
    }
    .policy-banner.has-blockers {
      border-color: color-mix(in srgb, #dc2626 40%, var(--border));
      background: color-mix(in srgb, #dc2626 5%, var(--surface-1));
    }
    .policy-banner header { display: flex; flex-direction: column; gap: 0.15rem; margin-bottom: 0.6rem; }
    .policy-banner header strong { font-size: 0.95rem; color: var(--fg); }
    .policy-banner header small { color: var(--fg-dim); font-size: 0.82rem; }
    .policy-banner ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.4rem; }
    .policy-banner li {
      display: grid; grid-template-columns: minmax(120px, auto) 1fr auto; gap: 0.5rem; align-items: baseline;
      padding: 0.4rem 0.6rem; border-radius: 6px;
      background: color-mix(in srgb, var(--surface-2) 60%, transparent);
      font-size: 0.85rem;
    }
    .policy-banner li.block { border-left: 3px solid #dc2626; }
    .policy-banner li.warn { border-left: 3px solid #f59e0b; }
    .policy-banner li code { font: 0.82rem ui-monospace, Menlo, Consolas, monospace; color: var(--fg); }
    .policy-banner li em { font-style: normal; color: var(--fg-dim); font-size: 0.78rem; text-align: right; }

    .safety { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }

    /* Panels */
    .panel {
      border: 1px solid var(--border); border-radius: 14px; background: var(--surface-2);
      padding: 1rem 1.1rem; display: grid; gap: 0.55rem;
    }
    .panel h3 { margin: 0; font-size: 0.98rem; color: var(--fg); }
    .panel h4 { margin: 0.5rem 0 0.1rem; font-size: 0.84rem; color: var(--fg-dim); text-transform: uppercase; letter-spacing: 0.04em; }
    .panel ul { margin: 0; padding: 0 0 0 1.1rem; color: var(--fg-dim); font-size: 0.86rem; display: grid; gap: 0.3rem; }
    .panel ul li[data-level="critical"] .lvl { color: #fca5a5; }
    .panel ul li[data-level="warning"] .lvl { color: #fcd34d; }
    .panel ul li[data-level="info"] .lvl { color: #93c5fd; }
    .panel .lvl { font-weight: 700; margin-right: 0.35rem; text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.05em; }
    .panel.peer .hint { margin: 0.1rem 0 0; color: var(--fg-dim); font-size: 0.8rem; }

    .grid.sm { font-size: 0.82rem; }
    .grid.sm ul.inline { display: flex; flex-wrap: wrap; gap: 0.35rem 0.8rem; list-style: none; padding: 0; margin: 0; }

    .table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-2); }
    .grid { width: 100%; border-collapse: collapse; min-width: 980px; }
    .grid th, .grid td { padding: 0.7rem 0.9rem; border-bottom: 1px solid var(--border); text-align: left; font-size: 0.88rem; vertical-align: top; }
    .grid th { background: var(--surface-1); color: var(--fg-dim); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; }
    .grid tr[data-status="conflict"] td:first-child { border-left: 3px solid #ef4444; }
    .grid tr[data-status="warning"]  td:first-child { border-left: 3px solid #f59e0b; }
    .grid tr[data-status="unknown"]  td:first-child { border-left: 3px solid #64748b; }
    .grid tr[data-status="safe"]     td:first-child { border-left: 3px solid #22c55e; }

    .tag {
      margin-left: 0.35rem; padding: 1px 6px; border-radius: 4px;
      background: color-mix(in srgb, var(--accent) 14%, transparent);
      color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
      font-size: 0.68rem; font-weight: 600;
    }
    .tag.standalone { background: color-mix(in srgb, #22c55e 14%, transparent); color: #86efac; border-color: color-mix(in srgb, #22c55e 35%, transparent); }
    .tag.depr { background: color-mix(in srgb, #ec4899 14%, transparent); color: #f9a8d4; border-color: color-mix(in srgb, #ec4899 40%, transparent); }
    .tag.ui { background: color-mix(in srgb, #8b5cf6 14%, transparent); color: #c4b5fd; border-color: color-mix(in srgb, #8b5cf6 40%, transparent); }

    .sub { color: var(--fg-dim); font-size: 0.8rem; }
    .spec { font-size: 0.82rem; }
    .note { color: var(--fg-dim); font-size: 0.83rem; max-width: 48ch; }

    .bundle { font-variant-numeric: tabular-nums; font-weight: 600; }
    .bundle.up { color: #fca5a5; }
    .bundle.down { color: #86efac; }

    details.bc { margin-top: 0.4rem; border: 1px solid var(--border); border-radius: 8px; padding: 0.25rem 0.55rem; background: var(--surface-1); }
    details.bc summary { cursor: pointer; font-size: 0.8rem; color: var(--fg); }
    details.bc summary:hover { color: var(--accent); }
    details.bc[open] { background: color-mix(in srgb, var(--accent) 4%, var(--surface-1)); }
    details.bc ul { margin: 0.35rem 0 0; padding-left: 1rem; }
    details.bc p { margin: 0.2rem 0; }
    details.bc a { color: var(--accent); }
    details.bc.depr { border-color: color-mix(in srgb, #ec4899 30%, transparent); }
    details.bc.ui { border-color: color-mix(in srgb, #8b5cf6 30%, transparent); }
    details.bc.community { border-color: color-mix(in srgb, #14b8a6 30%, transparent); }
    details.bc blockquote { margin: 0.4rem 0; border-left: 2px solid var(--accent); padding: 0 0 0 0.55rem; color: var(--fg-dim); font-style: italic; }
    details.bc cite { font-style: normal; color: var(--fg-dim); font-size: 0.74rem; display: block; margin-top: 0.2rem; }
    details.bc li[data-sev="critical"] strong { color: #fca5a5; }
    details.bc li[data-sev="warning"] strong { color: #fcd34d; }
    .bc-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.25rem; }
    .link {
      background: none; border: none; color: var(--accent); font: inherit;
      cursor: pointer; padding: 0; text-decoration: underline; text-underline-offset: 2px; font-size: 0.78rem;
    }

    .callout {
      border: 1px solid var(--border); border-radius: 12px; padding: 0.8rem 1rem;
      background: var(--surface-2); color: var(--fg-dim); font-size: 0.9rem;
    }
    .callout.conflict {
      border-color: color-mix(in srgb, #ef4444 40%, transparent);
      background: color-mix(in srgb, #ef4444 6%, var(--surface-2));
      color: #fecaca;
    }

    .add-note {
      border: 1px solid var(--border); border-radius: var(--radius-lg, 14px); background: var(--surface-2);
      padding: 1rem 1.1rem; display: grid; gap: 0.6rem;
    }
    .add-note h3 { margin: 0; font-size: 1rem; color: var(--fg); font-weight: 600; }
    .add-note .sub {
      margin: 0; color: var(--fg-dim);
      display: flex; flex-wrap: wrap; align-items: center; gap: 0.45rem;
      line-height: 1.5;
    }
    .add-note input, .add-note textarea {
      padding: 0.55rem 0.7rem; border-radius: var(--radius-md, 8px);
      border: 1px solid var(--border);
      background: var(--surface-1); color: var(--fg);
      font-size: 0.88rem; font-family: inherit;
      transition: border-color 160ms var(--ease, ease), box-shadow 160ms var(--ease, ease);
    }
    .add-note input:focus, .add-note textarea:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-ring);
    }
    .add-note input[aria-invalid='true'],
    .add-note textarea[aria-invalid='true'] {
      border-color: color-mix(in srgb, var(--bad, #ef4444) 60%, var(--border));
    }
    .add-note textarea { min-height: 72px; resize: vertical; }
    .add-note .row { display: flex; gap: 0.4rem; flex-wrap: wrap; }
    .add-note .row input { flex: 1 1 140px; min-width: 120px; }

    /* Storage policy pill — tells the user where their note will end up. */
    .storage-pill {
      display: inline-flex; align-items: center; gap: 0.3rem;
      padding: 0.12rem 0.55rem;
      border-radius: var(--radius-pill, 999px);
      font-size: 0.72rem;
      font-weight: 600;
      letter-spacing: 0.02em;
      border: 1px solid var(--border);
      white-space: nowrap;
    }
    .storage-cloud {
      color: var(--accent);
      background: var(--accent-bg);
      border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
    }
    .storage-local {
      color: var(--fg-dim);
      background: var(--surface-1);
    }

    /* Live validation feedback below the form. */
    .note-feedback {
      display: flex; gap: 0.65rem; flex-wrap: wrap; min-height: 1.1rem;
    }
    .note-feedback .hint { font-size: 0.78rem; line-height: 1.4; }
    .note-feedback .hint-bad { color: var(--bad, #ef4444); }
    .note-feedback .hint-ok  { color: var(--ok,  #16a34a); }

    /* Submit button wrapper — catches clicks even when the inner button is
       disabled, so we can fire a translated toast explaining what's missing. */
    .submit-wrap {
      display: inline-block;
      cursor: pointer;
    }
    .submit-wrap.is-blocked button.primary {
      pointer-events: none; /* let the wrapper handle the click */
    }

    /* "Your contributions" disclosure — Option B inline view. Sits flush
       under the Add-note section, sharing the same card surface so it
       reads as one unit rather than a separate panel. */
    .my-contributions {
      margin-top: 0.6rem;
      border: 1px solid var(--border);
      border-radius: var(--radius-lg, 14px);
      background: var(--surface-2);
      padding: 0;
      overflow: hidden;
    }
    .my-contributions > summary {
      display: flex; align-items: center; gap: 0.5rem;
      padding: 0.75rem 1rem;
      cursor: pointer;
      list-style: none;
      font-weight: 600;
      font-size: 0.9rem;
      color: var(--fg);
      transition: background-color 160ms var(--ease, ease);
    }
    .my-contributions > summary::-webkit-details-marker { display: none; }
    .my-contributions > summary::before {
      content: '▸';
      font-size: 0.75em;
      color: var(--fg-dim);
      transition: transform 160ms var(--ease, ease);
    }
    .my-contributions[open] > summary::before { transform: rotate(90deg); }
    .my-contributions > summary:hover { background: var(--surface-1); }
    .contrib-icon { font-size: 1rem; }
    /* Push the storage pill to the far right of the summary row so users
       see at a glance where these notes live. */
    .contrib-summary-text { flex: 1 1 auto; min-width: 0; }

    .contrib-list {
      list-style: none;
      padding: 0;
      margin: 0;
      border-top: 1px solid var(--border-subtle, var(--border));
    }
    .contrib-item {
      padding: 0.75rem 1rem;
      display: flex; flex-direction: column; gap: 0.4rem;
      border-bottom: 1px solid var(--border-subtle, var(--border));
    }
    .contrib-item:last-child { border-bottom: none; }
    .contrib-meta {
      display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
      font-size: 0.78rem;
    }
    .contrib-pkg {
      font-family: var(--code-font, ui-monospace, monospace);
      background: var(--surface-1);
      border: 1px solid var(--border-subtle, var(--border));
      padding: 0.1rem 0.5rem;
      border-radius: var(--radius-sm, 6px);
      font-size: 0.78rem;
      color: var(--fg);
    }
    .contrib-ng {
      color: var(--fg-dim);
      letter-spacing: 0.02em;
    }
    .contrib-upvotes {
      color: var(--ok, #22c55e);
      font-variant-numeric: var(--num);
      font-weight: 600;
    }
    .contrib-body {
      margin: 0;
      font-size: 0.88rem;
      color: var(--fg);
      line-height: 1.55;
      /* Truncate runaway notes — full text is still in the JSON. */
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .contrib-foot {
      display: flex; align-items: center; justify-content: space-between;
      gap: 0.5rem;
      font-size: 0.74rem;
      color: var(--fg-dim);
    }
    .contrib-remove {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg-dim);
      padding: 0.25rem 0.65rem;
      border-radius: var(--radius-sm, 6px);
      font-size: 0.74rem;
      cursor: pointer;
      transition: border-color 160ms var(--ease, ease), color 160ms var(--ease, ease), background-color 160ms var(--ease, ease);
    }
    .contrib-remove:hover {
      border-color: var(--bad, #ef4444);
      color: var(--bad, #ef4444);
      background: color-mix(in srgb, var(--bad, #ef4444) 8%, transparent);
    }
    .contrib-remove:focus-visible {
      outline: 2px solid var(--bad, #ef4444);
      outline-offset: 2px;
    }

    .skel { margin-top: 1.5rem; display: grid; gap: 0.5rem; }
    .bar { height: 18px; border-radius: 8px; background: linear-gradient(90deg, var(--surface-1), var(--surface-2), var(--surface-1)); background-size: 200% 100%; animation: shimmer 1.2s linear infinite; }
    .bar.w60 { width: 60%; } .bar.w80 { width: 80%; }
    @keyframes shimmer { to { background-position: -200% 0; } }

    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }

    @media (max-width: 820px) {
      .health { flex-direction: column; align-items: flex-start; }
      .factors li { grid-template-columns: 1fr 60px; }
      .factors .f-bar { grid-column: 1 / -1; }
    }
    @media (max-width: 720px) {
      .controls { flex-direction: column; align-items: stretch; }
      .primary { width: 100%; }
      .grid { min-width: 0; display: block; }
      .grid thead { display: none; }
      .grid tbody, .grid tr, .grid td { display: block; width: 100%; }
      .grid tr { border: 1px solid var(--border); border-radius: 10px; margin: 0.5rem; padding: 0.5rem; background: var(--surface-1); }
      .grid tr[data-status="conflict"] { border-left: 3px solid #ef4444; }
      .grid tr[data-status="warning"]  { border-left: 3px solid #f59e0b; }
      .grid tr[data-status="unknown"]  { border-left: 3px solid #64748b; }
      .grid tr[data-status="safe"]     { border-left: 3px solid #22c55e; }
      .grid td { border: none; padding: 0.3rem 0; display: flex; justify-content: space-between; gap: 0.75rem; }
      .grid td::before { content: attr(data-label); color: var(--fg-dim); font-weight: 600; font-size: 0.72rem; text-transform: uppercase; }
      .note { max-width: none; text-align: right; }
    }
  `]
})
export class UpgradePageComponent {
  private readonly parser = inject(PackageJsonParserService);
  private readonly reportSvc = inject(CompatibilityReportService);
  private readonly markdown = inject(MarkdownExportService);
  private readonly ciGen = inject(CiGeneratorService);
  private readonly ai = inject(AiCopilotService);
  protected readonly community = inject(CommunityGotchasService);
  private readonly prosCons = inject(ProsConsService);
  private readonly deadPins = inject(DeadButWorkingService);
  private readonly releaseDates = inject(ReleaseDateService);
  private readonly transloco = inject(TranslocoService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  protected readonly notes = inject(NotesService);
  protected readonly sourceScanner = inject(SourceScannerService);
  private readonly verifier = inject(InstallVerifierService);
  private readonly handoff = inject(ProjectHandoffService);
  private readonly policy = inject(PolicyService);
  private readonly monitor = inject(MonitorService);
  private readonly toast = inject(ToastService);
  protected readonly supabase = inject(SupabaseService);

  /**
   * Feature #73: live policy evaluation against the current report.
   * `null` until a report is built, then re-runs whenever rules or report change.
   */
  readonly policyEval = computed<PolicyEvaluation | null>(() => {
    const r = this.report();
    // Touch rules() so this recomputes when a rule is toggled / added.
    this.policy.rules();
    if (!r) return null;
    return this.policy.evaluateReport(r);
  });

  /** Convenience: violations bucketed by package, for inline row chips. */
  readonly violationsByPackage = computed<Record<string, PolicyViolation[]>>(
    () => this.policyEval()?.byPackage ?? {}
  );

  /** Feature #71: holds the last install-verifier result; null until the user clicks "Verify". */
  readonly verifyResult = signal<ResolutionReport | null>(null);

  /** Source-of-record label when the package.json came from a connected provider. */
  readonly handoffSource = signal<string | null>(null);

  /**
   * The full repo descriptor when the user reached /upgrade by clicking
   * "Analyze" on /projects. Carries provider + default branch so the
   * PR-preview component doesn't have to re-ask. Null when the user
   * dropped a package.json file directly.
   */
  readonly activeRepo = signal<import('../../services/provider-repo.service').NormalizedRepo | null>(null);

  constructor() {
    // Pick up a handoff from /workspace or /projects if present.
    const incoming = this.handoff.consume();
    if (incoming) {
      this.parsed.set(incoming.parsed);
      this.handoffSource.set(incoming.sourceLabel);
      this.activeRepo.set(incoming.repo);
      this.seedTargetFrom(incoming.parsed);
    }
  }

  /** Which package row currently has its notes popover open, if any. */
  readonly notesOpenFor = signal<string | null>(null);

  /** Toggle the notes popover for a specific package row. */
  toggleNotes(name: string): void {
    this.notesOpenFor.set(this.notesOpenFor() === name ? null : name);
  }

  readonly majors = [...KNOWN_ANGULAR_MAJORS].slice(-10);

  readonly parsed = signal<ParsedPackageJson | null>(null);
  readonly extraApps = signal<ParsedPackageJson[]>([]);
  readonly uploads = signal<Omit<UploadedProject, 'packageJson' | 'extraPackageJsons'>>({});
  readonly target = signal<number>(this.majors[this.majors.length - 1]);
  readonly mode = signal<'same-version' | 'upgrade'>('upgrade');
  readonly running = signal(false);
  readonly report = signal<CompatibilityReport | null>(null);
  readonly listInput = signal('');

  // Community-note form
  readonly noteName = signal('');
  readonly noteNg = signal<number>(this.majors[this.majors.length - 1]);
  readonly noteBody = signal('');
  readonly noteAuthor = signal('');

  /** Minimum useful note length. Anything shorter is rarely actionable. */
  static readonly NOTE_MIN_BODY = 8;

  /**
   * Rich validation state — exposes the *individual* reasons the form is
   * incomplete so the template can render contextual hints instead of a
   * generic disabled button. The toast on a click-while-disabled also
   * uses this to tell the user exactly what to fix.
   */
  readonly noteValidation = computed(() => {
    const name = this.noteName().trim();
    const body = this.noteBody().trim();
    const reasons: Array<'pkg' | 'body-short'> = [];
    if (!name) reasons.push('pkg');
    if (body.length < UpgradePageComponent.NOTE_MIN_BODY) reasons.push('body-short');
    return {
      ok: reasons.length === 0,
      reasons,
      bodyLen: body.length,
      bodyMin: UpgradePageComponent.NOTE_MIN_BODY
    };
  });

  /** Backwards-compatible alias for the old API. */
  readonly canSubmitNote = computed(() => this.noteValidation().ok);

  readonly projectKind = computed(() => this.report()?.projectKind ?? null);

  /** Sticky-summary-bar filter — which severity bucket to show. */
  readonly severityFilter = signal<SummaryFilter>('all');

  /** Counts used by <app-sticky-summary-bar>, computed live from the report. */
  readonly summaryCounts = computed<SummaryCounts>(() => {
    const r = this.report();
    if (!r) return { critical: 0, warning: 0, healthy: 0, total: 0 };
    let critical = 0, warning = 0, healthy = 0;
    for (const e of r.entries) {
      if (e.status === 'conflict' || !!e.deprecation) critical++;
      else if (e.status === 'warning') warning++;
      else healthy++;
    }
    return { critical, warning, healthy, total: r.entries.length };
  });

  /** Search-as-you-type filter on package name (feature #95). */
  readonly nameFilter = signal<string>('');

  /** Entries after applying the sticky-summary-bar filter + search filter. */
  readonly visibleEntries = computed<ReportEntry[]>(() => {
    const r = this.report();
    const f = this.severityFilter();
    const q = this.nameFilter().trim().toLowerCase();
    if (!r) return [];
    let out = r.entries;
    if (f !== 'all') {
      out = out.filter((e) => {
        const isCritical = e.status === 'conflict' || !!e.deprecation;
        const isWarning = !isCritical && e.status === 'warning';
        const isHealthy = !isCritical && !isWarning;
        if (f === 'critical') return isCritical;
        if (f === 'warning') return isWarning;
        if (f === 'healthy') return isHealthy;
        return true;
      });
    }
    if (q.length > 0) {
      out = out.filter((e) => e.name.toLowerCase().includes(q));
    }
    return out;
  });

  setSeverityFilter(f: SummaryFilter): void { this.severityFilter.set(f); }
  setNameFilter(q: string): void { this.nameFilter.set(q); }

  /** React to ?target=X&mode=upgrade in the URL for sharable reports. */
  readonly _params = toSignal(
    this.route.queryParamMap.pipe(
      map((pm) => {
        const t = Number(pm.get('target'));
        if (!Number.isNaN(t) && t > 0 && this.majors.includes(t)) {
          this.target.set(t);
        }
        const m = pm.get('mode');
        if (m === 'same-version' || m === 'upgrade') this.mode.set(m);
        return true;
      })
    ),
    { initialValue: false }
  );

  onFiles(files: UploadedFile[]): void {
    // Reset extras + config payloads on a fresh drop.
    const extras: ParsedPackageJson[] = [];
    const uploads: Omit<UploadedProject, 'packageJson' | 'extraPackageJsons'> = {};
    let primary: ParsedPackageJson | null = null;

    for (const f of files) {
      switch (f.kind) {
        case 'package-json': {
          try {
            const parsed = this.parser.parseJson(f.content);
            if (!primary) primary = parsed;
            else extras.push(parsed);
          } catch (err: any) {
            if (!primary) {
              primary = {
                deps: [],
                angularMajor: null,
                warnings: [err?.message ?? 'Could not parse package.json.']
              };
            }
          }
          break;
        }
        case 'angular-json': uploads.angularJsonRaw = f.content; break;
        case 'tsconfig': uploads.tsconfigRaw = f.content; break;
        case 'browserslist': uploads.browserslistRaw = f.content; break;
        case 'lockfile':
          uploads.lockfileRaw = f.content;
          uploads.lockfileName = f.name;
          break;
        case 'unknown':
          // Attempt to parse pasted JSON as a package.json if nothing else matched.
          if (!primary) {
            try {
              const parsed = this.parser.parseJson(f.content);
              primary = parsed;
            } catch {
              /* swallow */
            }
          }
          break;
      }
    }

    if (primary) {
      this.parsed.set(primary);
      this.seedTargetFrom(primary);
    }
    this.extraApps.set(extras);
    this.uploads.set(uploads);
    this.report.set(null);
  }

  /**
   * Feature #68: when the user drops .ts/.html files, run the scanner. The
   * annotated scan lives on the service; the next compatibility report pulls
   * from it automatically via `SourceScannerService.annotate()`.
   */
  onSourceScan(files: ScannedFile[]): void {
    if (!files.length) {
      this.sourceScanner.clear();
    } else {
      this.sourceScanner.scan(files);
    }
    // Re-run the report if we already have one so citations/filtering take effect.
    if (this.parsed() && this.report()) {
      this.report.set(null);
      // A subsequent `analyze()` call recomputes; leave it to the user to
      // press Analyze, so we don't silently burn their network budget.
    }
  }

  /**
   * Feature #71: "pre-flight" the recommended install plan. Collects concrete
   * (name, version) specs from each report entry that has a `recommendedForTarget`,
   * walks the npm registry for peer-dep conflicts, and surfaces any install-time
   * failures in the UI *before* the user runs `npm install`.
   */
  verifyInstall(r: CompatibilityReport): void {
    const specs = r.entries
      .filter((e) => !!e.recommendedForTarget?.version)
      .map((e) => ({ name: e.name, version: e.recommendedForTarget!.version }));
    if (!specs.length) {
      this.verifyResult.set({ nodes: [], conflicts: [], ok: true, walked: 0 });
      return;
    }
    this.verifier.verify(specs).subscribe((res) => this.verifyResult.set(res));
  }

  applyList(): void {
    const raw = this.listInput();
    if (!raw.trim()) return;
    const parsed = this.parser.parseList(raw);
    this.parsed.set(parsed);
    this.extraApps.set([]);
    this.uploads.set({});
    this.seedTargetFrom(parsed);
    this.report.set(null);
  }

  loadSample(): void {
    const sample = {
      name: 'my-angular-app',
      version: '0.0.1',
      dependencies: {
        '@angular/core': '^16.2.0',
        '@angular/common': '^16.2.0',
        '@angular/router': '^16.2.0',
        '@angular/material': '^16.2.0',
        '@angular/flex-layout': '^15.0.0-beta.42',
        'ngx-toastr': '^17.0.0',
        'primeng': '^15.4.0',
        'rxjs': '~7.8.0',
        'tslib': '^2.3.0'
      },
      devDependencies: {
        '@angular/cli': '^16.2.0',
        'typescript': '~5.1.0',
        'protractor': '~7.0.0'
      }
    };
    const parsed = this.parser.parseJson(JSON.stringify(sample, null, 2));
    this.parsed.set(parsed);
    this.extraApps.set([]);
    this.uploads.set({});
    this.seedTargetFrom(parsed);
    this.report.set(null);
  }

  setMode(m: 'same-version' | 'upgrade'): void {
    this.mode.set(m);
    this.report.set(null);
  }

  run(): void {
    const parsed = this.parsed();
    if (!parsed || !parsed.deps.length) return;

    const targetNg =
      this.mode() === 'same-version' && parsed.angularMajor !== null
        ? parsed.angularMajor
        : this.target();

    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { target: targetNg, mode: this.mode() },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });

    const project: UploadedProject = {
      packageJson: parsed,
      extraPackageJsons: this.extraApps(),
      ...this.uploads()
    };

    this.running.set(true);
    this.reportSvc.buildFullReport(project, targetNg).subscribe({
      next: (r) => {
        this.report.set(r);
        this.running.set(false);
        // Feature #74: capture a snapshot whenever a report finishes; if a
        // previous snapshot exists for the same project, this also produces
        // a digest visible on the Workspace page.
        const label = this.handoffSource() ?? this.parsed()?.name ?? 'Untitled project';
        this.monitor.capture(r, MonitorService.keyFor(label), label);
      },
      error: () => {
        this.running.set(false);
      }
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

  copyMarkdown(r: CompatibilityReport): void {
    const md = this.markdown.toMarkdown(r);
    this.copy(md);
  }

  copyCi(r: CompatibilityReport, provider: CiProvider): void {
    const yml = this.ciGen.generate(r, provider);
    this.copy(yml);
  }

  askAi(provider: AiProvider, pkg: string, bc: BreakingChange, targetNg: number): void {
    const prompt = this.ai.prompt(pkg, bc, targetNg);
    const url = this.ai.url(provider, prompt);
    if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener');
    }
  }

  gotchasFor(pkg: string, ngMajor: number): CommunityNote[] {
    return this.community.for(pkg, ngMajor);
  }

  upvote(id: string): void {
    this.community.upvote(id);
  }

  submitNote(): void {
    const v = this.noteValidation();
    if (!v.ok) {
      // The button is disabled when invalid, but a click on a disabled
      // button still triggers handlers in some setups (e.g. when clicked
      // from screen readers, or when wrapped in a clickable region). In
      // either case, surface a translated toast that names exactly what's
      // missing — much better UX than silent rejection.
      this.toast.error(this.noteValidationMessage());
      return;
    }
    this.community.add({
      pkg: this.noteName().trim(),
      ng: this.noteNg(),
      author: this.noteAuthor().trim() || undefined,
      body: this.noteBody().trim()
    });
    this.noteName.set('');
    this.noteBody.set('');
    this.toast.success(
      this.transloco.translate('upgrade.addNote.toast.saved')
    );
  }

  /**
   * Translated, user-facing description of why the form can't be submitted.
   * Built from the structured `noteValidation` reasons so future fields
   * just need a new case + translation key.
   */
  private noteValidationMessage(): string {
    const v = this.noteValidation();
    const parts: string[] = [];
    if (v.reasons.includes('pkg')) {
      parts.push(this.transloco.translate('upgrade.addNote.toast.needPkg'));
    }
    if (v.reasons.includes('body-short')) {
      parts.push(
        this.transloco.translate('upgrade.addNote.toast.needBody', {
          min: v.bodyMin,
          have: v.bodyLen
        })
      );
    }
    if (parts.length === 0) {
      return this.transloco.translate('upgrade.addNote.toast.invalid');
    }
    return parts.join(' · ');
  }

  /**
   * Click handler on the disabled-state button wrapper. When the button is
   * disabled the native click won't fire on the <button>, so the same
   * `noteValidationMessage` toast is exposed via a transparent overlay
   * that catches user intent and still gives feedback.
   */
  noteSubmitIntent(): void {
    if (this.noteValidation().ok) {
      this.submitNote();
    } else {
      this.toast.info(this.noteValidationMessage());
    }
  }

  /**
   * Remove one of the current user's contributions, with toast confirmation.
   * The signal change triggers `SupabaseSyncService` to push the new (shorter)
   * list to Supabase automatically — no extra plumbing here.
   */
  removeContribution(id: string): void {
    this.community.remove(id);
    this.toast.success(this.transloco.translate('upgrade.myContributions.removed'));
  }

  /**
   * Lightweight "5 minutes ago" formatter used in the contribution list.
   * Falls back to a localized date when the delta is > a week. We use the
   * platform Intl helpers rather than a date-fns dep — the precision is
   * fine for this list and keeps the bundle small.
   */
  relativeTime(iso: string): string {
    const created = new Date(iso).getTime();
    const now = Date.now();
    const diff = Math.max(0, now - created);
    const sec = Math.floor(diff / 1000);
    const min = Math.floor(sec / 60);
    const hr = Math.floor(min / 60);
    const day = Math.floor(hr / 24);
    if (sec < 60)  return this.transloco.translate('upgrade.myContributions.justNow');
    if (min < 60)  return this.transloco.translate('upgrade.myContributions.minutesAgo', { n: min });
    if (hr < 24)   return this.transloco.translate('upgrade.myContributions.hoursAgo', { n: hr });
    if (day < 7)   return this.transloco.translate('upgrade.myContributions.daysAgo', { n: day });
    try {
      return new Intl.DateTimeFormat(this.transloco.getActiveLang(), {
        year: 'numeric', month: 'short', day: 'numeric'
      }).format(new Date(iso));
    } catch {
      return new Date(iso).toLocaleDateString();
    }
  }

  label(s: CompatStatus): string {
    const key = s === 'safe' ? 'upgrade.labels.safe'
      : s === 'warning' ? 'upgrade.labels.warning'
      : s === 'conflict' ? 'upgrade.labels.conflict'
      : 'upgrade.labels.unknown';
    return this.transloco.translate(key);
  }

  gradeLabel(g: string): string {
    const valid = ['A', 'B', 'C', 'D', 'F'].includes(g) ? g : 'F';
    return this.transloco.translate('upgrade.grades.' + valid);
  }

  prosConsFor(pkg: string): ProsConsEntry[] {
    return this.prosCons.for(pkg);
  }

  deadPinFor(pkg: string, ngMajor: number): { version: string } | null {
    return this.deadPins.lastWorkingFor(pkg, ngMajor);
  }

  timelineFor(pkg: string): ReleaseTimeline | null {
    return this.releaseDates.timelineFor(pkg);
  }

  licenseClass(risk: 'safe' | 'review' | 'blocker'): string {
    if (risk === 'blocker') return 'lic';
    if (risk === 'review') return 'warning';
    return 'safe';
  }

  recommendedFor(entry: ReportEntry, mode: 'same-version' | 'upgrade'): string | null {
    if (mode === 'same-version') {
      return entry.recommendedForCurrent?.version ?? entry.recommendedForTarget?.version ?? null;
    }
    return entry.recommendedForTarget?.version ?? null;
  }

  formatBundle(bytes: number): string {
    const sign = bytes < 0 ? '−' : '+';
    const kb = Math.abs(bytes / 1024);
    return `${sign}${kb.toFixed(1)} KB`;
  }

  formatPct(pct: number): string {
    const sign = pct < 0 ? '−' : '+';
    return `${sign}${Math.abs(pct).toFixed(0)}%`;
  }

  toPairs(obj: Record<string, string>): Array<[string, string]> {
    return Object.entries(obj);
  }

  private seedTargetFrom(parsed: ParsedPackageJson): void {
    if (parsed.angularMajor !== null) {
      const latest = this.majors[this.majors.length - 1];
      if (parsed.angularMajor < latest) {
        this.target.set(latest);
        this.mode.set('upgrade');
      } else {
        this.target.set(parsed.angularMajor);
        this.mode.set('same-version');
      }
    }
  }
}
