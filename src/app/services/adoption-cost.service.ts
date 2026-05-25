import { Injectable } from '@angular/core';
import { LicenseTier } from './license.service';
import { VitalityTier } from './maintainer-vitality.service';
import {
  DeprecatedSignal,
  InstallScriptSignal
} from './package-trust.service';

/**
 * Composite "adoption cost" score for a package (Phase 3 feature #9).
 *
 * # The problem this solves
 *
 * The Search page surfaces 15+ separate chips — bundle size, install
 * scripts, license tier, vitality, deprecated, tree-shakeable, module
 * type, maturity, downloads, dependents, provenance, scorecard… each
 * is informative but the user has to mentally aggregate them into a
 * single decision: *"is this expensive to adopt?"*
 *
 * Adoption Cost compresses that mental work into one headline pill.
 * It's not authoritative — there's no objectively-correct weighting —
 * but it's a fast first-glance signal that lets users:
 *   • skip packages with high cost when they're shopping
 *   • justify the high cost with the breakdown when they want to dig
 *   • compare cost across alternatives at a glance
 *
 * # The scoring model
 *
 * We compute a 0-100 score where LOWER is BETTER (low cost = easy to
 * adopt). Each factor contributes points up to a cap; the sum is
 * capped at 100. Factors:
 *
 *   1. Bundle size (0-25 pts) — large gzip → high cost.
 *      - <10 kB: 0
 *      - 10-50 kB: linear ramp 0-10
 *      - 50-200 kB: linear ramp 10-20
 *      - >200 kB: 25 (effectively "heavy")
 *
 *   2. Install scripts (0-15 pts) — postinstall/preinstall scripts
 *      are real supply-chain risk surface. 1 script: 8, 2+: 15.
 *
 *   3. Transitive deps count (0-15 pts) — measured from Bundlephobia's
 *      dependencyCount when available. <5: 0, <15: 5, <30: 10, ≥30: 15.
 *
 *   4. Vitality (0-20 pts) — active: 0, maintained: 3, slow: 10,
 *      inactive: 15, archived: 20. Stale/dead packages are by far
 *      the most expensive form of cost (you inherit the unmaintenance).
 *
 *   5. License tier (0-15 pts) — permissive: 0, weak-copyleft: 5,
 *      strong-copyleft: 15, proprietary: 15, unknown: 8.
 *
 *   6. Deprecated (0-25 pts, separate bucket) — adds 25 outright.
 *      A deprecated package is the highest-cost possible adoption
 *      decision; it can push an otherwise-cheap package to the top
 *      cost tier on its own.
 *
 * Sum is clamped to 100. Tier mapping:
 *   - 0-24:  Low      (cheap to adopt)
 *   - 25-49: Moderate (some friction; review chips)
 *   - 50-74: High     (significant cost; consider alternatives)
 *   - 75-100: Heavy   (high-friction adoption; verify deeply)
 *
 * # Why these specific weights
 *
 * Three principles:
 *   • Deprecation outweighs everything else combined. A deprecated
 *     package should never read "Low cost" no matter how small it is.
 *   • Vitality is the second-biggest factor. Carrying a dead
 *     dependency is the most-frequent way teams end up in tech-debt.
 *   • Bundle size matters most for FE-runtime packages (Angular libs)
 *     but is moderate as an overall factor — the user might be
 *     adopting for a build script where bundle is irrelevant.
 *
 * Numbers are tuned, not derived. They reflect ~15 years of cumulative
 * "I wish I hadn't picked X" experience. We'd refine these with real
 * outcome data if we had any (we don't — Anthropic can't see real
 * adoption choices users make off-platform).
 */
export type AdoptionCostTier = 'low' | 'moderate' | 'high' | 'heavy';

/** One factor's contribution to the composite. */
export interface AdoptionCostFactor {
  /** Stable key for i18n + per-factor styling. */
  key: 'bundle' | 'installScripts' | 'transitiveDeps' | 'vitality' | 'license' | 'deprecated';
  /** Points this factor adds (0 means "didn't cost anything"). */
  points: number;
  /** Soft cap for this factor's contribution. */
  cap: number;
  /** A short, already-computed display string ("84 kB gzip", "Active", "MIT"). */
  display: string;
  /**
   * When the factor data was unavailable (null/missing input) we set
   * this true and points=0. The breakdown UI surfaces "—" instead of
   * pretending we know the answer.
   */
  unknown: boolean;
}

export interface AdoptionCost {
  /** Final 0-100 composite. */
  score: number;
  tier: AdoptionCostTier;
  /** Per-factor breakdown for the expandable detail view. */
  factors: AdoptionCostFactor[];
  /**
   * Number of factors that contributed real data (vs. unknowns). A
   * score computed from 2-of-6 factors is less trustworthy than one
   * from 6-of-6, and the UI can dim the headline accordingly.
   */
  knownFactorCount: number;
}

export interface AdoptionCostInputs {
  /** Gzipped bytes from Bundlephobia. null if unknown. */
  bundleGzipBytes: number | null;
  /** Transitive runtime dep count from Bundlephobia. null if unknown. */
  transitiveDeps: number | null;
  /** Lifecycle-script signal from PackageTrustService. */
  installScripts: InstallScriptSignal | null;
  /** Maintainer-vitality tier from MaintainerVitalityService. */
  vitalityTier: VitalityTier | null;
  /** License tier from LicenseService. */
  licenseTier: LicenseTier | null;
  /** Deprecated signal from PackageTrustService. */
  deprecated: DeprecatedSignal | null;
}

@Injectable({ providedIn: 'root' })
export class AdoptionCostService {
  /**
   * Pure function — every call is independent of state. Inputs come
   * from the search-page computed signals; output is a fresh
   * AdoptionCost. No caching needed; the per-factor work is cheap.
   */
  compute(inputs: AdoptionCostInputs): AdoptionCost {
    const factors: AdoptionCostFactor[] = [
      this.scoreBundle(inputs.bundleGzipBytes),
      this.scoreInstallScripts(inputs.installScripts),
      this.scoreTransitiveDeps(inputs.transitiveDeps),
      this.scoreVitality(inputs.vitalityTier),
      this.scoreLicense(inputs.licenseTier),
      this.scoreDeprecated(inputs.deprecated)
    ];

    const rawScore = factors.reduce((sum, f) => sum + f.points, 0);
    const score = Math.max(0, Math.min(100, Math.round(rawScore)));
    const tier = this.tierFor(score);
    const knownFactorCount = factors.filter((f) => !f.unknown).length;

    return { score, tier, factors, knownFactorCount };
  }

  // ---------- Per-factor scorers ----------

  private scoreBundle(gzip: number | null): AdoptionCostFactor {
    const factor: AdoptionCostFactor = {
      key: 'bundle',
      points: 0,
      cap: 25,
      display: '',
      unknown: gzip === null
    };
    if (gzip === null) {
      factor.display = '—';
      return factor;
    }
    factor.display = this.formatBytes(gzip);
    const kb = gzip / 1024;
    if (kb < 10) {
      factor.points = 0;
    } else if (kb < 50) {
      // 10 → 0 pts, 50 → 10 pts (linear)
      factor.points = ((kb - 10) / (50 - 10)) * 10;
    } else if (kb < 200) {
      // 50 → 10 pts, 200 → 20 pts (linear)
      factor.points = 10 + ((kb - 50) / (200 - 50)) * 10;
    } else {
      factor.points = 25;
    }
    factor.points = Math.round(factor.points);
    return factor;
  }

  private scoreInstallScripts(sig: InstallScriptSignal | null): AdoptionCostFactor {
    const factor: AdoptionCostFactor = {
      key: 'installScripts',
      points: 0,
      cap: 15,
      display: '',
      unknown: sig === null
    };
    if (sig === null) {
      factor.display = '—';
      return factor;
    }
    const n = sig.hooks?.length ?? 0;
    if (n === 0) {
      factor.display = 'none';
      factor.points = 0;
    } else if (n === 1) {
      factor.display = '1 script';
      factor.points = 8;
    } else {
      factor.display = `${n} scripts`;
      factor.points = 15;
    }
    return factor;
  }

  private scoreTransitiveDeps(n: number | null): AdoptionCostFactor {
    const factor: AdoptionCostFactor = {
      key: 'transitiveDeps',
      points: 0,
      cap: 15,
      display: '',
      unknown: n === null
    };
    if (n === null) {
      factor.display = '—';
      return factor;
    }
    factor.display = `${n}`;
    if (n < 5) factor.points = 0;
    else if (n < 15) factor.points = 5;
    else if (n < 30) factor.points = 10;
    else factor.points = 15;
    return factor;
  }

  private scoreVitality(tier: VitalityTier | null): AdoptionCostFactor {
    const factor: AdoptionCostFactor = {
      key: 'vitality',
      points: 0,
      cap: 20,
      display: '',
      unknown: tier === null || tier === 'unknown'
    };
    if (tier === null || tier === 'unknown') {
      factor.display = '—';
      return factor;
    }
    factor.display = tier;
    switch (tier) {
      case 'active': factor.points = 0; break;
      case 'maintained': factor.points = 3; break;
      case 'slow': factor.points = 10; break;
      case 'inactive': factor.points = 15; break;
      case 'archived': factor.points = 20; break;
    }
    return factor;
  }

  private scoreLicense(tier: LicenseTier | null): AdoptionCostFactor {
    const factor: AdoptionCostFactor = {
      key: 'license',
      points: 0,
      cap: 15,
      display: '',
      unknown: tier === null || tier === 'unknown'
    };
    if (tier === null || tier === 'unknown') {
      factor.display = '—';
      // Unknown license isn't zero-cost — without knowing what you're
      // signing up for, legal review is required. 8 pts.
      factor.points = tier === 'unknown' ? 8 : 0;
      factor.unknown = tier === null;
      return factor;
    }
    factor.display = tier;
    switch (tier) {
      case 'safe': factor.points = 0; break;        // permissive (MIT/Apache/BSD/ISC)
      case 'weak': factor.points = 5; break;        // weak copyleft (LGPL/MPL)
      case 'strong': factor.points = 15; break;     // strong copyleft (GPL/AGPL)
      case 'proprietary': factor.points = 15; break;
    }
    return factor;
  }

  private scoreDeprecated(sig: DeprecatedSignal | null): AdoptionCostFactor {
    const factor: AdoptionCostFactor = {
      key: 'deprecated',
      points: 0,
      cap: 25,
      display: '',
      unknown: sig === null
    };
    if (sig === null) {
      factor.display = '—';
      return factor;
    }
    if (sig.isDeprecated) {
      factor.display = 'yes';
      factor.points = 25;
    } else {
      factor.display = 'no';
      factor.points = 0;
    }
    return factor;
  }

  // ---------- Helpers ----------

  private tierFor(score: number): AdoptionCostTier {
    if (score < 25) return 'low';
    if (score < 50) return 'moderate';
    if (score < 75) return 'high';
    return 'heavy';
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1_000_000) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} kB`;
    return `${(bytes / 1_000_000).toFixed(2)} MB`;
  }
}
