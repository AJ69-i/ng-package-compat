import { Injectable, inject } from '@angular/core';
import { Observable, forkJoin, of } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import * as semver from 'semver';
import {
  CompatMode,
  CompatibilityReport,
  ConfigAnalysis,
  LockfileReport,
  MfeAnalysis,
  NpmRegistryResponse,
  ParsedDep,
  ParsedPackageJson,
  PeerConflict,
  ReportEntry,
  UploadedProject,
  VersionCompatibility
} from '../models/npm-package.model';
import { CompatibilityService } from './compatibility.service';
import { NpmRegistryService } from './npm-registry.service';
import { PackageJsonParserService } from './package-json-parser.service';
import { PackageManagerService } from './package-manager.service';
import { KnowledgeBaseService } from './knowledge-base.service';
import { PeerConflictService } from './peer-conflict.service';
import { BundleImpactService } from './bundle-impact.service';
import { LicenseRiskService } from './license-risk.service';
import { HealthScoreService } from './health-score.service';
import { TimeEstimateService } from './time-estimate.service';
import { NxDetectionService } from './nx-detection.service';
import { RollbackService } from './rollback.service';
import { ConfigAnalyzerService } from './config-analyzer.service';
import { LockfileAnalyzerService } from './lockfile-analyzer.service';
import { MfeAnalyzerService } from './mfe-analyzer.service';
import { SourceScannerService } from './source-scanner.service';

/**
 * Known `ng update` aware package prefixes / exact names.
 */
const NG_UPDATE_AWARE = new Set<string>([
  '@angular/core',
  '@angular/cli',
  '@angular/material',
  '@angular/cdk',
  '@angular/flex-layout',
  '@angular/google-maps',
  '@angular/youtube-player',
  '@angular/pwa',
  '@angular/ssr',
  '@nguniversal/express-engine',
  '@ngrx/store',
  '@ngrx/effects',
  '@ngrx/component-store',
  '@ngrx/router-store',
  '@ngrx/data',
  '@ngrx/entity',
  '@ngrx/signals',
  '@ionic/angular',
  '@ionic/angular-toolkit',
  '@nrwl/angular',
  '@nx/angular',
  'nx',
  '@angular-eslint/schematics',
  '@angular/localize',
  '@angular/service-worker',
  '@angular/fire',
  'ng-packagr'
]);

function isNgUpdateAware(name: string): boolean {
  if (NG_UPDATE_AWARE.has(name)) return true;
  if (name.startsWith('@angular/')) return true;
  return false;
}

@Injectable({ providedIn: 'root' })
export class CompatibilityReportService {
  private readonly registry = inject(NpmRegistryService);
  private readonly compat = inject(CompatibilityService);
  private readonly parser = inject(PackageJsonParserService);
  private readonly pm = inject(PackageManagerService);
  private readonly kb = inject(KnowledgeBaseService);
  private readonly peerConflicts = inject(PeerConflictService);
  private readonly bundleImpact = inject(BundleImpactService);
  private readonly licenseRisk = inject(LicenseRiskService);
  private readonly health = inject(HealthScoreService);
  private readonly estimator = inject(TimeEstimateService);
  private readonly nxDetect = inject(NxDetectionService);
  private readonly rollback = inject(RollbackService);
  private readonly configAnalyzer = inject(ConfigAnalyzerService);
  private readonly lockfileAnalyzer = inject(LockfileAnalyzerService);
  private readonly mfeAnalyzer = inject(MfeAnalyzerService);
  private readonly sourceScanner = inject(SourceScannerService);

  /** Back-compat entry point (used by legacy callers). */
  buildReport(
    parsed: ParsedPackageJson,
    targetAngularMajor: number
  ): Observable<CompatibilityReport> {
    return this.buildFullReport({ packageJson: parsed }, targetAngularMajor);
  }

  /**
   * Orchestrates every analyzer to produce a single "complete-solution"
   * compatibility report.
   */
  buildFullReport(
    project: UploadedProject,
    targetAngularMajor: number
  ): Observable<CompatibilityReport> {
    const parsed = project.packageJson;
    const external = parsed.deps.filter((d) => !d.name.startsWith('@angular/'));
    if (!external.length) {
      return of(this.emptyReport(project, targetAngularMajor));
    }

    const mode: CompatMode =
      parsed.angularMajor === targetAngularMajor ? 'same-version' : 'upgrade';

    const perEntry$ = external.map((dep) =>
      this.buildEntry(dep, parsed.angularMajor, targetAngularMajor, mode)
    );

    return forkJoin(perEntry$).pipe(
      switchMap((entries) =>
        this.enrichWithBundles(entries).pipe(
          map((enriched) => this.assemble(enriched, project, targetAngularMajor, mode))
        )
      )
    );
  }

  private buildEntry(
    dep: ParsedDep,
    currentNg: number | null,
    targetNg: number,
    mode: CompatMode
  ): Observable<ReportEntry> {
    return this.registry.fetchPackage(dep.name).pipe(
      map((pkg) => this.evaluate(dep, pkg, currentNg, targetNg, mode)),
      catchError((err) =>
        of<ReportEntry>({
          name: dep.name,
          currentRange: dep.range,
          currentVersion: this.parser.resolveInstalledVersion(dep.range),
          currentSupportsTarget: false,
          currentSupportsCurrent: false,
          recommendedForTarget: null,
          recommendedForCurrent: null,
          status: 'unknown',
          note:
            err?.status === 404
              ? 'Package not found on the npm registry.'
              : 'Failed to fetch package info.',
          installSpec: null,
          ngUpdateAware: isNgUpdateAware(dep.name),
          unresolved: true,
          deprecation: this.kb.getDeprecation(dep.name),
          breakingChanges: this.sourceScanner.annotate(
            dep.name,
            this.kb.getBreakingChanges(dep.name, currentNg, targetNg)
          ),
          bundleDelta: null,
          licenseRisk: null,
          uiFrameworkAlert: this.kb.getUiFrameworkAlert(dep.name),
          supportsStandalone: this.kb.supportsStandalone(dep.name, targetNg)
        })
      )
    );
  }

  private evaluate(
    dep: ParsedDep,
    pkg: NpmRegistryResponse,
    currentNg: number | null,
    targetNg: number,
    mode: CompatMode
  ): ReportEntry {
    const rows = this.compat.buildVersionRows(pkg, 'peer-dep');
    const currentVersion = this.parser.resolveInstalledVersion(dep.range);
    const currentRow = currentVersion ? this.matchRow(rows, currentVersion) : null;

    const currentSupportsTarget = this.supports(currentRow, targetNg);
    const currentSupportsCurrent =
      currentNg == null ? true : this.supports(currentRow, currentNg);

    const recommendedForTarget = this.newestStable(rows, targetNg);
    const recommendedForCurrent =
      currentNg == null ? null : this.newestStable(rows, currentNg);

    const status = this.rollUpStatus({
      mode,
      currentRow,
      currentSupportsTarget,
      currentSupportsCurrent,
      currentVersion,
      recommendedForTarget,
      recommendedForCurrent
    });

    const targetVersion = recommendedForTarget?.version ?? null;
    const suggestVersion = mode === 'same-version'
      ? recommendedForCurrent?.version ?? targetVersion
      : targetVersion;

    // Knowledge-base enrichment
    const deprecation = this.kb.getDeprecation(dep.name);
    const breakingChanges = this.sourceScanner.annotate(
      dep.name,
      this.kb.getBreakingChanges(dep.name, currentNg, targetNg)
    );
    const uiFrameworkAlert = this.kb.getUiFrameworkAlert(dep.name);
    const supportsStandalone = this.kb.supportsStandalone(dep.name, targetNg);
    const licenseRisk = this.licenseRisk.assess(currentRow, recommendedForTarget);

    // A copyleft license change must override the status to "conflict".
    let effectiveStatus = status;
    if (licenseRisk?.risk === 'blocker') {
      effectiveStatus = 'conflict';
    }

    const installSpec =
      effectiveStatus === 'safe' || !suggestVersion ? null : `${dep.name}@${suggestVersion}`;

    const note = this.describe({
      mode,
      status: effectiveStatus,
      currentVersion,
      currentRange: dep.range,
      currentSupportsTarget,
      recommendedVersion: suggestVersion,
      targetNg,
      currentNg,
      deprecated: !!deprecation,
      licenseBlocker: licenseRisk?.risk === 'blocker'
    });

    return {
      name: dep.name,
      currentRange: dep.range,
      currentVersion,
      currentSupportsTarget,
      currentSupportsCurrent,
      recommendedForTarget,
      recommendedForCurrent,
      status: effectiveStatus,
      note,
      installSpec,
      ngUpdateAware: isNgUpdateAware(dep.name),
      unresolved: false,
      deprecation,
      breakingChanges,
      bundleDelta: null, // filled in by enrichWithBundles
      licenseRisk,
      uiFrameworkAlert,
      supportsStandalone
    };
  }

  private enrichWithBundles(entries: ReportEntry[]): Observable<ReportEntry[]> {
    // Only fetch for entries we'd actually recommend bumping — keeps network chatter low.
    const interesting = entries.filter(
      (e) => e.status !== 'safe' && e.currentVersion && e.recommendedForTarget?.version
    );
    if (!interesting.length) return of(entries);

    const deltas$ = interesting.map((e) =>
      this.bundleImpact
        .delta(e.name, e.currentVersion, e.recommendedForTarget!.version)
        .pipe(map((delta) => ({ name: e.name, delta })))
    );

    return forkJoin(deltas$).pipe(
      map((results) => {
        const byName = new Map(results.map((r) => [r.name, r.delta]));
        return entries.map((e) =>
          byName.has(e.name) ? { ...e, bundleDelta: byName.get(e.name) ?? null } : e
        );
      })
    );
  }

  private supports(row: VersionCompatibility | null, ngMajor: number): boolean {
    if (!row) return false;
    if (row.supportsAny) return true;
    return row.supportedAngularMajors.includes(ngMajor);
  }

  private matchRow(
    rows: VersionCompatibility[],
    version: string
  ): VersionCompatibility | null {
    const direct = rows.find((r) => r.version === version);
    if (direct) return direct;
    const parsed = semver.parse(version);
    if (!parsed) return null;
    const sameMajor = rows.filter((r) => {
      const p = semver.parse(r.version);
      return p && p.major === parsed.major;
    });
    return sameMajor[0] ?? null;
  }

  private newestStable(
    rows: VersionCompatibility[],
    ngMajor: number
  ): VersionCompatibility | null {
    return (
      rows.find(
        (r) =>
          !r.isDeprecated &&
          !r.isPrerelease &&
          (r.supportsAny || r.supportedAngularMajors.includes(ngMajor))
      ) ?? null
    );
  }

  private rollUpStatus(args: {
    mode: CompatMode;
    currentRow: VersionCompatibility | null;
    currentSupportsTarget: boolean;
    currentSupportsCurrent: boolean;
    currentVersion: string | null;
    recommendedForTarget: VersionCompatibility | null;
    recommendedForCurrent: VersionCompatibility | null;
  }): ReportEntry['status'] {
    const {
      mode,
      currentRow,
      currentSupportsTarget,
      currentVersion,
      recommendedForTarget,
      recommendedForCurrent
    } = args;

    if (!currentRow && !recommendedForTarget && !recommendedForCurrent) {
      return 'unknown';
    }

    if (mode === 'same-version') {
      const reco = recommendedForCurrent ?? recommendedForTarget;
      if (!currentVersion || !reco) return currentSupportsTarget ? 'safe' : 'conflict';
      if (semver.lt(currentVersion, reco.version)) return 'warning';
      return 'safe';
    }

    if (!currentSupportsTarget) {
      return recommendedForTarget ? 'conflict' : 'unknown';
    }
    if (
      currentVersion &&
      recommendedForTarget &&
      semver.lt(currentVersion, recommendedForTarget.version)
    ) {
      return 'warning';
    }
    return 'safe';
  }

  private describe(args: {
    mode: CompatMode;
    status: ReportEntry['status'];
    currentVersion: string | null;
    currentRange: string | null;
    currentSupportsTarget: boolean;
    recommendedVersion: string | null;
    targetNg: number;
    currentNg: number | null;
    deprecated: boolean;
    licenseBlocker: boolean;
  }): string {
    const { mode, status, currentVersion, recommendedVersion, targetNg, deprecated, licenseBlocker } = args;
    if (licenseBlocker) return `License risk blocks this upgrade (see License column).`;
    if (deprecated) return `This package is deprecated — see the "Alternatives" panel for replacements.`;
    switch (status) {
      case 'safe':
        if (mode === 'same-version') {
          return `Up to date for Angular ${targetNg}.`;
        }
        return recommendedVersion && currentVersion && recommendedVersion !== currentVersion
          ? `Already compatible. A newer stable (${recommendedVersion}) exists but isn't required.`
          : `Already compatible with Angular ${targetNg}.`;
      case 'warning':
        return mode === 'same-version'
          ? `Compatible — a newer release (${recommendedVersion}) is recommended.`
          : `Compatible — consider bumping to ${recommendedVersion} for best results.`;
      case 'conflict':
        return recommendedVersion
          ? `Current version does not support Angular ${targetNg}. Upgrade to ${recommendedVersion}.`
          : `No released version of this package supports Angular ${targetNg}.`;
      case 'unknown':
      default:
        return 'Could not evaluate compatibility for this package.';
    }
  }

  private assemble(
    entries: ReportEntry[],
    project: UploadedProject,
    targetNg: number,
    mode: CompatMode
  ): CompatibilityReport {
    const parsed = project.packageJson;

    const counts = entries.reduce(
      (acc, e) => {
        acc[e.status]++;
        return acc;
      },
      { safe: 0, warning: 0, conflict: 0, unknown: 0 }
    );

    const toUpdate = entries.filter(
      (e) => e.installSpec && (e.status === 'warning' || e.status === 'conflict')
    );
    const ngUpdateSpecs = toUpdate
      .filter((e) => e.ngUpdateAware)
      .map((e) => e.installSpec!)
      .sort();
    const installOnly = toUpdate
      .filter((e) => !e.ngUpdateAware)
      .map((e) => e.installSpec!)
      .sort();

    if (mode === 'upgrade') {
      const forced = [`@angular/core@${targetNg}`, `@angular/cli@${targetNg}`];
      for (const spec of forced) {
        if (!ngUpdateSpecs.some((s) => s.startsWith(spec.split('@')[0] + '@'))) {
          ngUpdateSpecs.unshift(spec);
        }
      }
    }

    const ngUpdateCommand = ngUpdateSpecs.length
      ? `ng update ${ngUpdateSpecs.join(' ')}`
      : '';
    const pm = this.pm.pm();
    const installVerb =
      pm === 'yarn' ? 'yarn add' : pm === 'pnpm' ? 'pnpm add' : pm === 'bun' ? 'bun add' : 'npm install';
    const installCommand = installOnly.length
      ? `${installVerb} ${installOnly.join(' ')}`
      : '';

    // Nx / MFE project detection
    const projectKind = this.nxDetect.detect(parsed.deps);
    const nxMigrateCommand =
      projectKind === 'nx' ? this.nxDetect.nxMigrateCommand(targetNg, parsed.deps) : undefined;

    // Rollback & verify
    const rollbackCommand = this.rollback.command(parsed.deps);
    const verifyCommand = this.rollback.verifyCommand();

    // Peer conflicts across the user's own deps
    const recommendedMap: Record<string, VersionCompatibility> = {};
    const userVersions: Record<string, string | null> = {};
    for (const e of entries) {
      if (e.recommendedForTarget) recommendedMap[e.name] = e.recommendedForTarget;
      userVersions[e.name] = e.currentVersion;
    }
    const peerConflicts: PeerConflict[] = this.peerConflicts.detect(recommendedMap, userVersions);

    // Health & estimate
    const health = this.health.score(entries, peerConflicts, parsed.angularMajor, targetNg);
    const estimate = this.estimator.estimate(entries, peerConflicts.length);

    // Optional config / lockfile / MFE analyses
    const config: ConfigAnalysis = {};
    if (project.angularJsonRaw) {
      config.angularJson = this.configAnalyzer.analyzeAngularJson(project.angularJsonRaw, targetNg);
    }
    if (project.tsconfigRaw) {
      config.tsconfig = this.configAnalyzer.analyzeTsconfig(project.tsconfigRaw, targetNg);
    }
    if (project.browserslistRaw) {
      config.browserslist = this.configAnalyzer.analyzeBrowserslist(project.browserslistRaw, targetNg);
    }
    const hasConfig = !!(config.angularJson?.length || config.tsconfig?.length || config.browserslist?.length);

    let lockfile: LockfileReport | undefined;
    if (project.lockfileRaw && project.lockfileName) {
      const lock = this.lockfileAnalyzer.analyze(project.lockfileRaw, project.lockfileName);
      lockfile = {
        kind: lock.kind,
        total: lock.total,
        transitiveRisks: lock.transitiveRisks
      };
    }

    let mfe: MfeAnalysis | undefined;
    if (project.extraPackageJsons && project.extraPackageJsons.length > 0) {
      const apps = [parsed, ...project.extraPackageJsons];
      mfe = this.mfeAnalyzer.analyze(apps);
    }

    const deprecatedCount = entries.filter((e) => !!e.deprecation).length;
    const uiAlertCount = entries.filter((e) => !!e.uiFrameworkAlert).length;
    const licenseBlockerCount = entries.filter((e) => e.licenseRisk?.risk === 'blocker').length;

    return {
      mode,
      currentAngularMajor: parsed.angularMajor,
      targetAngularMajor: targetNg,
      entries: entries.sort((a, b) => this.rankStatus(a.status) - this.rankStatus(b.status)),
      safeCount: counts.safe,
      warningCount: counts.warning,
      conflictCount: counts.conflict,
      unknownCount: counts.unknown,
      ngUpdateCommand,
      installCommand,
      nxMigrateCommand,
      rollbackCommand,
      verifyCommand,
      projectKind,
      peerConflicts,
      health,
      estimate,
      config: hasConfig ? config : undefined,
      mfe,
      deprecatedCount,
      uiAlertCount,
      licenseBlockerCount,
      lockfile
    };
  }

  private rankStatus(s: ReportEntry['status']): number {
    return s === 'conflict' ? 0 : s === 'warning' ? 1 : s === 'unknown' ? 2 : 3;
  }

  private emptyReport(
    project: UploadedProject,
    targetNg: number
  ): CompatibilityReport {
    const parsed = project.packageJson;
    const mode: CompatMode =
      parsed.angularMajor === targetNg ? 'same-version' : 'upgrade';
    const health = this.health.score([], [], parsed.angularMajor, targetNg);
    const estimate = this.estimator.estimate([], 0);
    return {
      mode,
      currentAngularMajor: parsed.angularMajor,
      targetAngularMajor: targetNg,
      entries: [],
      safeCount: 0,
      warningCount: 0,
      conflictCount: 0,
      unknownCount: 0,
      ngUpdateCommand: '',
      installCommand: '',
      rollbackCommand: '',
      verifyCommand: this.rollback.verifyCommand(),
      projectKind: this.nxDetect.detect(parsed.deps),
      peerConflicts: [],
      health,
      estimate,
      deprecatedCount: 0,
      uiAlertCount: 0,
      licenseBlockerCount: 0
    };
  }
}
