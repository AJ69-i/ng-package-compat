import { Injectable } from '@angular/core';

/**
 * Compatibility tier we assign to a SPDX identifier. The mapping is
 * intentionally conservative — when a license isn't recognized we
 * return `unknown` rather than guessing, because guessing wrong is
 * how teams end up shipping copyleft code into closed-source products.
 *
 * # Tier semantics
 *
 *   - `safe`        Permissive. Free for commercial use, no obligations
 *                   beyond preserving the notice. Examples: MIT, ISC,
 *                   Apache-2.0, BSD-2-Clause, BSD-3-Clause, Unlicense,
 *                   CC0-1.0, 0BSD.
 *   - `weak`        Weak/file-level copyleft. Modifications to the
 *                   library itself must be open-sourced, but linking
 *                   from a proprietary product is fine. Examples:
 *                   LGPL-2.1, LGPL-3.0, MPL-2.0, EPL-2.0.
 *   - `strong`      Strong copyleft. If you distribute software that
 *                   incorporates this, the whole work must be GPL too
 *                   — a hard blocker for most SaaS / closed-source
 *                   shops. Examples: GPL-2.0, GPL-3.0, AGPL-3.0.
 *   - `proprietary` Non-free or commercial-only license. You probably
 *                   need to read the LICENSE text before shipping.
 *   - `unknown`     Not declared on npm, or an SPDX string we don't
 *                   recognize. Treat as "go read the LICENSE file."
 */
export type LicenseTier = 'safe' | 'weak' | 'strong' | 'proprietary' | 'unknown';

export interface LicenseClassification {
  /** The raw SPDX-ish string from npm (e.g. "MIT", "(MIT OR Apache-2.0)"). */
  raw: string | null;
  /** Normalized primary SPDX id we matched against — null if `unknown`. */
  spdx: string | null;
  /** Computed compatibility tier. */
  tier: LicenseTier;
  /**
   * i18n key suffix for the short label shown inside the chip
   * (e.g. `safe` → `packageMeta.license.tier.safe`).
   */
  labelKey: string;
  /**
   * i18n key suffix for the long description shown as a tooltip /
   * aria-label (e.g. `safe` → `packageMeta.license.desc.safe`).
   */
  descKey: string;
}

const SAFE_LICENSES = new Set([
  'MIT', 'ISC', 'BSD', 'BSD-2-CLAUSE', 'BSD-3-CLAUSE', 'BSD-3-CLAUSE-CLEAR',
  '0BSD', 'APACHE-2.0', 'APACHE 2.0', 'UNLICENSE', 'CC0-1.0', 'CC0', 'WTFPL',
  'PUBLIC DOMAIN', 'BLUEOAK-1.0.0', 'ZLIB'
]);

const WEAK_COPYLEFT = new Set([
  'LGPL-2.0', 'LGPL-2.0-ONLY', 'LGPL-2.0-OR-LATER',
  'LGPL-2.1', 'LGPL-2.1-ONLY', 'LGPL-2.1-OR-LATER',
  'LGPL-3.0', 'LGPL-3.0-ONLY', 'LGPL-3.0-OR-LATER',
  'MPL-2.0', 'MPL-1.1',
  'EPL-1.0', 'EPL-2.0',
  'CDDL-1.0', 'CDDL-1.1'
]);

const STRONG_COPYLEFT = new Set([
  'GPL-2.0', 'GPL-2.0-ONLY', 'GPL-2.0-OR-LATER',
  'GPL-3.0', 'GPL-3.0-ONLY', 'GPL-3.0-OR-LATER',
  'AGPL-1.0', 'AGPL-3.0', 'AGPL-3.0-ONLY', 'AGPL-3.0-OR-LATER',
  'OSL-3.0', 'EUPL-1.1', 'EUPL-1.2'
]);

const PROPRIETARY_HINTS = new Set([
  'UNLICENSED', 'SEE LICENSE IN LICENSE', 'PROPRIETARY', 'COMMERCIAL',
  'BUSL-1.1', 'SSPL-1.0', 'ELASTIC-2.0'
]);

@Injectable({ providedIn: 'root' })
export class LicenseService {
  /**
   * Classify an npm `license` field — which may be a plain SPDX id
   * ("MIT"), a SPDX expression ("(MIT OR Apache-2.0)"), the legacy
   * object form ({ type, url }), or null/missing entirely.
   *
   * SPDX expressions are evaluated as "best primary license": we pick
   * the most permissive license in an OR group (because the consumer
   * can choose), or the strictest in an AND group (because the
   * consumer must satisfy both). This is the standard policy used by
   * the FSF compatibility wizard and Google's go/thirdparty review.
   */
  classify(raw: string | { type?: string } | null | undefined): LicenseClassification {
    const norm = this.normalizeRaw(raw);
    if (!norm) {
      return this.make(null, null, 'unknown');
    }

    // SPDX expression: choose the best representative.
    if (/\sOR\s|\sAND\s/i.test(norm)) {
      const parts = norm
        .replace(/[()]/g, '')
        .split(/\s+(?:OR|AND)\s+/i)
        .map((p) => p.trim())
        .filter(Boolean);
      const tiers = parts.map((p) => this.tierFor(p));
      // OR → pick the safest (consumer can opt into the friendlier license).
      // AND → must satisfy all, so pick the strictest.
      const isOr = /\sOR\s/i.test(norm);
      const pickIdx = isOr
        ? tiers.indexOf(this.bestTier(tiers))
        : tiers.indexOf(this.worstTier(tiers));
      const picked = parts[Math.max(0, pickIdx)];
      return this.make(norm, picked, this.tierFor(picked));
    }

    return this.make(norm, norm, this.tierFor(norm));
  }

  private normalizeRaw(raw: string | { type?: string } | null | undefined): string | null {
    if (!raw) return null;
    if (typeof raw === 'object') return raw.type?.trim() || null;
    const trimmed = raw.trim();
    return trimmed.length ? trimmed : null;
  }

  private tierFor(spdx: string): LicenseTier {
    const key = spdx.toUpperCase();
    if (SAFE_LICENSES.has(key)) return 'safe';
    if (WEAK_COPYLEFT.has(key)) return 'weak';
    if (STRONG_COPYLEFT.has(key)) return 'strong';
    if (PROPRIETARY_HINTS.has(key)) return 'proprietary';
    // Catch family prefixes for licenses we didn't enumerate every variant of.
    if (key.startsWith('AGPL')) return 'strong';
    if (key.startsWith('GPL')) return 'strong';
    if (key.startsWith('LGPL')) return 'weak';
    if (key.startsWith('MPL')) return 'weak';
    if (key.startsWith('EPL')) return 'weak';
    if (key.startsWith('CDDL')) return 'weak';
    if (key.startsWith('BSD')) return 'safe';
    if (key.startsWith('APACHE')) return 'safe';
    if (key.startsWith('CC0')) return 'safe';
    return 'unknown';
  }

  /** Tier ordering by friendliness — safe is "best", strong is "worst". */
  private order(t: LicenseTier): number {
    return { safe: 0, weak: 1, proprietary: 2, strong: 3, unknown: 4 }[t];
  }
  private bestTier(tiers: LicenseTier[]): LicenseTier {
    return tiers.slice().sort((a, b) => this.order(a) - this.order(b))[0];
  }
  private worstTier(tiers: LicenseTier[]): LicenseTier {
    return tiers.slice().sort((a, b) => this.order(b) - this.order(a))[0];
  }

  private make(raw: string | null, spdx: string | null, tier: LicenseTier): LicenseClassification {
    return {
      raw,
      spdx,
      tier,
      labelKey: `packageMeta.license.tier.${tier}`,
      descKey: `packageMeta.license.desc.${tier}`
    };
  }
}
