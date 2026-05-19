import { TestBed } from '@angular/core/testing';
import { PolicyService, PolicyRule } from './policy.service';
import type { CompatibilityReport, ReportEntry } from '../models/npm-package.model';

function entry(overrides: Partial<ReportEntry>): ReportEntry {
  // Spread defaults first so overrides win without TS warning about
  // duplicate keys in the same object literal.
  const defaults: Partial<ReportEntry> = {
    name: 'pkg',
    currentRange: '^1.0.0',
    currentVersion: '1.0.0',
    currentSupportsTarget: true,
    currentSupportsCurrent: true,
    recommendedForTarget: null,
    recommendedForCurrent: null,
    status: 'safe',
    note: '',
    installSpec: null,
    ngUpdateAware: false,
    unresolved: false
  };
  return { ...defaults, ...overrides } as ReportEntry;
}

function buildReport(entries: ReportEntry[]): CompatibilityReport {
  return {
    fromAngularMajor: 16,
    targetAngularMajor: 21,
    mode: 'upgrade',
    entries,
    safeCount: 0,
    warningCount: 0,
    conflictCount: 0,
    unknownCount: 0,
    deprecatedCount: 0,
    uiAlertCount: 0,
    licenseBlockerCount: 0,
    peerConflicts: [],
    nxMigrateCommand: null,
    upgradeCommand: '',
    installCommand: '',
    rollbackCommand: '',
    verifyCommand: '',
    health: { score: 80, label: 'good', factors: [] },
    parseWarnings: [],
    breakingDetected: false,
    nxWorkspace: false,
    mfeApps: 0,
    mfeAnalysis: null,
    configAnalysis: null,
    lockfileReport: null,
    chips: {
      dependencies: 0,
      detectedAngular: '',
      angularJson: false,
      tsconfig: false,
      browserslist: false
    }
  } as unknown as CompatibilityReport;
}

describe('PolicyService', () => {
  let svc: PolicyService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    svc = TestBed.inject(PolicyService);
    svc.clearAll();
  });

  it('starts empty', () => {
    expect(svc.rules().length).toBe(0);
  });

  it('add() assigns an id and persists', () => {
    const rule = svc.add({
      kind: 'block-package',
      label: 'no lodash',
      pattern: 'lodash',
      severity: 'block',
      enabled: true
    } as Omit<PolicyRule, 'id'>);
    expect(rule.id).toBeTruthy();
    expect(svc.rules().length).toBe(1);
  });

  it('replaceAll resets the list and persists', () => {
    svc.add({ kind: 'block-package', label: 'one', pattern: 'a', severity: 'block', enabled: true } as Omit<PolicyRule, 'id'>);
    svc.replaceAll([
      { id: '1', kind: 'block-package', label: 'two', pattern: 'b', severity: 'warn', enabled: true }
    ]);
    expect(svc.rules().length).toBe(1);
    expect(svc.rules()[0].label).toBe('two');
  });

  it('evaluates block-package by glob', () => {
    svc.add({
      kind: 'block-package',
      label: 'no left-pad',
      pattern: 'left-pad',
      severity: 'block',
      enabled: true
    } as Omit<PolicyRule, 'id'>);
    const report = buildReport([entry({ name: 'left-pad' }), entry({ name: 'lodash' })]);
    const ev = svc.evaluateReport(report);
    expect(ev.hasBlockers).toBeTrue();
    expect(ev.blockerCount).toBe(1);
    expect(ev.violations[0].package).toBe('left-pad');
  });

  it('does not fire on disabled rules', () => {
    svc.add({
      kind: 'block-package',
      label: 'disabled',
      pattern: '*',
      severity: 'block',
      enabled: false
    } as Omit<PolicyRule, 'id'>);
    const ev = svc.evaluateReport(buildReport([entry({ name: 'anything' })]));
    expect(ev.violations.length).toBe(0);
  });

  it('toggles a rule', () => {
    const r = svc.add({
      kind: 'block-package',
      label: 'tog',
      pattern: '*',
      severity: 'warn',
      enabled: true
    } as Omit<PolicyRule, 'id'>);
    svc.toggle(r.id);
    expect(svc.rules()[0].enabled).toBeFalse();
  });
});
