import { Injectable, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import * as semver from 'semver';
import { CompatibilityReport, ReportEntry } from '../models/npm-package.model';

/**
 * Kinds of rules the policy engine supports. Kept narrow on purpose — these
 * cover ~95% of the "what's-allowed-in-our-monorepo" guardrails large orgs
 * actually want, without us turning into a Datalog implementation.
 */
export type PolicyKind =
  | 'block-package'
  | 'block-scope'
  | 'min-version'
  | 'max-version'
  | 'pin-version'
  | 'block-license'
  | 'block-deprecated'
  | 'require-scope';

export type PolicySeverity = 'block' | 'warn';

/**
 * A single rule. Some fields only apply to specific kinds; the engine
 * validates the right combination before evaluating.
 */
export interface PolicyRule {
  id: string;
  kind: PolicyKind;
  /** Display name — purely for UI; falls back to a generated description. */
  label: string;
  /** Package name or `@scope` (depending on kind). */
  pattern?: string;
  /** Version or range, used by min/max/pin kinds. */
  version?: string;
  /** SPDX license expression / glob (e.g. `GPL-3.0`, `GPL*`). */
  license?: string;
  /** Approved scopes for `require-scope`. */
  scopes?: string[];
  /** Optional explanation surfaced to the user when the rule fires. */
  note?: string;
  severity: PolicySeverity;
  enabled: boolean;
}

/**
 * One concrete violation — the result of evaluating a rule against a single
 * report entry (or, for `require-scope`, the project as a whole).
 */
export interface PolicyViolation {
  ruleId: string;
  ruleKind: PolicyKind;
  ruleLabel: string;
  package: string;
  message: string;
  severity: PolicySeverity;
}

/** Combined result returned by `evaluateReport`. */
export interface PolicyEvaluation {
  violations: PolicyViolation[];
  blockerCount: number;
  warningCount: number;
  /** True if any blocker fired — the upgrade should be considered halted. */
  hasBlockers: boolean;
  /** Map of package name → violations affecting it; useful for in-row chips. */
  byPackage: Record<string, PolicyViolation[]>;
}

const STORAGE_KEY = 'ngpc.policies.v1';

/** Cryptographically-weak ID generator — fine for client-side rule IDs. */
function rid(): string {
  return 'r_' + Math.random().toString(36).slice(2, 10);
}

/**
 * Policy / rule engine.
 *
 * Why a dedicated service: enterprise teams want to encode "we never accept
 * `GPL-3.0`," "no package below v3 of `rxjs`," "every direct dep must be in
 * `@acme/*`" — and have those rules surface alongside the regular compat
 * results, not as one-off greps. Keeping them server-free (localStorage only)
 * means they're per-developer drafts; an org-rollout is just JSON paste.
 *
 * SSR-safe: state is in-memory until `isPlatformBrowser` permits storage.
 */
@Injectable({ providedIn: 'root' })
export class PolicyService {
  private readonly platformId = inject(PLATFORM_ID);

  readonly rules = signal<PolicyRule[]>([]);

  readonly enabledCount = computed(
    () => this.rules().filter((r) => r.enabled).length
  );

  constructor() {
    if (isPlatformBrowser(this.platformId)) {
      this.load();
    }
  }

  // ---------- CRUD ----------

  add(rule: Omit<PolicyRule, 'id'>): PolicyRule {
    const full: PolicyRule = { ...rule, id: rid() };
    this.rules.set([...this.rules(), full]);
    this.persist();
    return full;
  }

  update(id: string, patch: Partial<PolicyRule>): void {
    this.rules.set(
      this.rules().map((r) => (r.id === id ? { ...r, ...patch, id: r.id } : r))
    );
    this.persist();
  }

  remove(id: string): void {
    this.rules.set(this.rules().filter((r) => r.id !== id));
    this.persist();
  }

  toggle(id: string): void {
    this.rules.set(
      this.rules().map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r))
    );
    this.persist();
  }

  /** Replace the entire rule set (used by SupabaseSyncService on pull). */
  replaceAll(rules: PolicyRule[]): void {
    this.rules.set(rules.map((r) => ({ ...r })));
    this.persist();
  }

  clearAll(): void {
    this.rules.set([]);
    this.persist();
  }

  /** Bulk-import a JSON blob exported from another machine / shared by an EM. */
  importJson(json: string): number {
    try {
      const parsed = JSON.parse(json);
      if (!Array.isArray(parsed)) return 0;
      const cleaned: PolicyRule[] = parsed
        .filter((r): r is PolicyRule => !!r && typeof r === 'object' && typeof r.kind === 'string')
        .map((r) => ({
          ...r,
          id: r.id || rid(),
          severity: (r.severity === 'warn' ? 'warn' : 'block') as PolicySeverity,
          enabled: r.enabled !== false
        }));
      // De-dupe by id, prefer incoming
      const existing = this.rules().filter((r) => !cleaned.some((c) => c.id === r.id));
      this.rules.set([...existing, ...cleaned]);
      this.persist();
      return cleaned.length;
    } catch {
      return 0;
    }
  }

  exportJson(): string {
    return JSON.stringify(this.rules(), null, 2);
  }

  // ---------- Evaluation ----------

  /**
   * Run every enabled rule against the report and roll up the results.
   *
   * Some rules (`require-scope`) operate at the project level; the rest are
   * per-entry. We bucket the output by package name so the UI can drop a chip
   * inline next to a row without re-running this on every render.
   */
  evaluateReport(report: CompatibilityReport): PolicyEvaluation {
    const active = this.rules().filter((r) => r.enabled);
    const violations: PolicyViolation[] = [];

    for (const rule of active) {
      if (rule.kind === 'require-scope') {
        violations.push(...this.evaluateRequireScope(rule, report));
        continue;
      }
      for (const entry of report.entries) {
        const v = this.evaluateEntry(rule, entry);
        if (v) violations.push(v);
      }
    }

    const byPackage: Record<string, PolicyViolation[]> = {};
    let blockers = 0;
    let warnings = 0;
    for (const v of violations) {
      (byPackage[v.package] ??= []).push(v);
      if (v.severity === 'block') blockers++;
      else warnings++;
    }

    return {
      violations,
      blockerCount: blockers,
      warningCount: warnings,
      hasBlockers: blockers > 0,
      byPackage
    };
  }

  /** Convenience for tests / preview: evaluate a single entry. */
  evaluateEntryAgainstAll(entry: ReportEntry): PolicyViolation[] {
    const out: PolicyViolation[] = [];
    for (const rule of this.rules().filter((r) => r.enabled)) {
      if (rule.kind === 'require-scope') continue;
      const v = this.evaluateEntry(rule, entry);
      if (v) out.push(v);
    }
    return out;
  }

  // ---------- Rule kind handlers ----------

  private evaluateEntry(rule: PolicyRule, entry: ReportEntry): PolicyViolation | null {
    switch (rule.kind) {
      case 'block-package':
        return this.matchPackageGlob(rule.pattern, entry.name)
          ? this.violation(rule, entry.name, `Package "${entry.name}" is blocked by policy.`)
          : null;

      case 'block-scope': {
        const scope = rule.pattern?.trim();
        if (!scope) return null;
        return entry.name.startsWith(scope.endsWith('/') ? scope : scope + '/')
          ? this.violation(rule, entry.name, `Scope "${scope}" is blocked by policy.`)
          : null;
      }

      case 'min-version': {
        if (!rule.pattern || !rule.version) return null;
        if (!this.matchPackageGlob(rule.pattern, entry.name)) return null;
        const candidate = entry.recommendedForTarget?.version ?? entry.currentVersion;
        if (!candidate) return null;
        const pcand = semver.coerce(candidate);
        const pmin = semver.coerce(rule.version);
        if (!pcand || !pmin) return null;
        return semver.lt(pcand, pmin)
          ? this.violation(
              rule,
              entry.name,
              `"${entry.name}" version ${candidate} is below required minimum ${rule.version}.`
            )
          : null;
      }

      case 'max-version': {
        if (!rule.pattern || !rule.version) return null;
        if (!this.matchPackageGlob(rule.pattern, entry.name)) return null;
        const candidate = entry.recommendedForTarget?.version ?? entry.currentVersion;
        if (!candidate) return null;
        const pcand = semver.coerce(candidate);
        const pmax = semver.coerce(rule.version);
        if (!pcand || !pmax) return null;
        return semver.gt(pcand, pmax)
          ? this.violation(
              rule,
              entry.name,
              `"${entry.name}" version ${candidate} exceeds maximum ${rule.version}.`
            )
          : null;
      }

      case 'pin-version': {
        if (!rule.pattern || !rule.version) return null;
        if (!this.matchPackageGlob(rule.pattern, entry.name)) return null;
        const candidate = entry.recommendedForTarget?.version ?? entry.currentVersion;
        if (!candidate) return null;
        try {
          return semver.satisfies(candidate, rule.version)
            ? null
            : this.violation(
                rule,
                entry.name,
                `"${entry.name}" must satisfy ${rule.version}; currently ${candidate}.`
              );
        } catch {
          return null;
        }
      }

      case 'block-license': {
        if (!rule.license) return null;
        // Check whichever license fields we have — prefer the one we'd actually
        // ship (recommended) over the one the user is on now (current).
        const lic =
          entry.licenseRisk?.recommendedLicense ?? entry.licenseRisk?.currentLicense ?? null;
        if (!lic) return null;
        return this.matchLicenseGlob(rule.license, lic)
          ? this.violation(
              rule,
              entry.name,
              `License "${lic}" of ${entry.name} is blocked by policy.`
            )
          : null;
      }

      case 'block-deprecated': {
        return entry.deprecation
          ? this.violation(rule, entry.name, `${entry.name} is deprecated.`)
          : null;
      }

      default:
        return null;
    }
  }

  private evaluateRequireScope(
    rule: PolicyRule,
    report: CompatibilityReport
  ): PolicyViolation[] {
    const scopes = (rule.scopes ?? [])
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.endsWith('/') ? s : s + '/'));
    if (!scopes.length) return [];
    const out: PolicyViolation[] = [];
    for (const entry of report.entries) {
      // Direct deps of `@scope/*` — we exempt unscoped names if the rule is
      // strict (no allowlist), and let the user soften via `block-package` only.
      const isScoped = entry.name.startsWith('@');
      if (!isScoped) continue;
      const ok = scopes.some((s) => entry.name.startsWith(s));
      if (!ok) {
        out.push(
          this.violation(
            rule,
            entry.name,
            `${entry.name} is outside approved scopes (${scopes.map((s) => s.replace(/\/$/, '')).join(', ')}).`
          )
        );
      }
    }
    return out;
  }

  // ---------- Helpers ----------

  /**
   * Match a name like `@acme/foo` against a glob like `@acme/*` or just
   * `lodash`. Three rules: exact, suffix `/*` for any sub-name, trailing `*`
   * for prefix-only.
   */
  private matchPackageGlob(pattern: string | undefined, name: string): boolean {
    if (!pattern) return false;
    const p = pattern.trim();
    if (!p) return false;
    if (p === name) return true;
    if (p.endsWith('/*')) {
      const prefix = p.slice(0, -2) + '/';
      return name.startsWith(prefix);
    }
    if (p.endsWith('*')) {
      return name.startsWith(p.slice(0, -1));
    }
    return false;
  }

  private matchLicenseGlob(pattern: string, spdx: string): boolean {
    const p = pattern.trim().toUpperCase();
    const s = spdx.trim().toUpperCase();
    if (p === s) return true;
    if (p.endsWith('*')) return s.startsWith(p.slice(0, -1));
    if (p.startsWith('*')) return s.endsWith(p.slice(1));
    return false;
  }

  private violation(
    rule: PolicyRule,
    pkg: string,
    msg: string
  ): PolicyViolation {
    return {
      ruleId: rule.id,
      ruleKind: rule.kind,
      ruleLabel: rule.label || this.describe(rule),
      package: pkg,
      message: rule.note ? `${msg} ${rule.note}` : msg,
      severity: rule.severity
    };
  }

  /** Generated label for a rule when the user hasn't supplied one. */
  describe(rule: PolicyRule): string {
    switch (rule.kind) {
      case 'block-package': return `Block package: ${rule.pattern}`;
      case 'block-scope': return `Block scope: ${rule.pattern}`;
      case 'min-version': return `${rule.pattern} >= ${rule.version}`;
      case 'max-version': return `${rule.pattern} <= ${rule.version}`;
      case 'pin-version': return `${rule.pattern} pinned to ${rule.version}`;
      case 'block-license': return `Block license: ${rule.license}`;
      case 'block-deprecated': return 'Block deprecated packages';
      case 'require-scope': return `Approved scopes: ${(rule.scopes ?? []).join(', ')}`;
      default: return 'Policy rule';
    }
  }

  // ---------- Persistence ----------

  private persist(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.rules()));
    } catch {
      /* localStorage full / blocked — accept the loss; rules will reset on reload. */
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const cleaned = parsed
        .filter((r): r is PolicyRule => !!r && typeof r === 'object' && typeof r.kind === 'string')
        .map((r) => ({
          ...r,
          id: r.id || rid(),
          severity: (r.severity === 'warn' ? 'warn' : 'block') as PolicySeverity,
          enabled: r.enabled !== false
        }));
      this.rules.set(cleaned);
    } catch {
      /* ignore corrupt blob */
    }
  }
}
