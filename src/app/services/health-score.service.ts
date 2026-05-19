import { Injectable } from '@angular/core';
import {
  HealthScore,
  PeerConflict,
  ReportEntry
} from '../models/npm-package.model';

/**
 * Produces a 0–100 "project health" score from the report entries.
 *
 * Weighting:
 *   +40 for "on-target Angular core/major alignment"
 *   +20 for "no conflicts"
 *   +15 for "no deprecated deps"
 *   +15 for "most deps are safe/up-to-date"
 *   +10 for "no peer conflicts"
 */
@Injectable({ providedIn: 'root' })
export class HealthScoreService {
  score(
    entries: ReportEntry[],
    peerConflicts: PeerConflict[],
    currentAngular: number | null,
    targetAngular: number
  ): HealthScore {
    const total = Math.max(entries.length, 1);
    const safe = entries.filter((e) => e.status === 'safe').length;
    const warning = entries.filter((e) => e.status === 'warning').length;
    const conflict = entries.filter((e) => e.status === 'conflict').length;
    const deprecated = entries.filter((e) => e.deprecation?.npmDeprecated || e.deprecation?.reason).length;
    const licenseBlockers = entries.filter((e) => e.licenseRisk?.risk === 'blocker').length;

    const alignmentFactor =
      currentAngular == null
        ? 0.5
        : currentAngular === targetAngular
          ? 1
          : Math.max(0, 1 - (targetAngular - currentAngular) / 6);

    const noConflictsFactor = 1 - conflict / total;
    const noDeprecatedFactor = 1 - deprecated / total;
    const safeFactor = safe / total;
    const peerConflictFactor = peerConflicts.length === 0 ? 1 : 1 / (1 + peerConflicts.length);
    const licenseFactor = licenseBlockers === 0 ? 1 : 0.5;

    const breakdown = [
      { label: 'Angular alignment', value: Math.round(alignmentFactor * 100), weight: 40, note: currentAngular == null ? 'Angular not detected' : `Angular ${currentAngular} → ${targetAngular}` },
      { label: 'No breaking conflicts', value: Math.round(noConflictsFactor * 100), weight: 20, note: `${conflict} blocking` },
      { label: 'No deprecated deps', value: Math.round(noDeprecatedFactor * 100), weight: 15, note: `${deprecated} deprecated` },
      { label: 'Up-to-date ratio', value: Math.round(safeFactor * 100), weight: 15, note: `${safe}/${total} already compatible` },
      { label: 'No peer conflicts', value: Math.round(peerConflictFactor * 100), weight: 10, note: `${peerConflicts.length} detected` }
    ];

    const raw =
      alignmentFactor * 40 +
      noConflictsFactor * 20 +
      noDeprecatedFactor * 15 +
      safeFactor * 15 +
      peerConflictFactor * 10;

    const score = Math.max(0, Math.min(100, Math.round(raw * licenseFactor)));
    // warning count slightly depresses score but doesn't dominate
    const adjusted = Math.max(0, score - Math.round((warning / total) * 5));

    const grade: HealthScore['grade'] =
      adjusted >= 90 ? 'A' :
      adjusted >= 80 ? 'B' :
      adjusted >= 70 ? 'C' :
      adjusted >= 55 ? 'D' : 'F';

    return { score: adjusted, grade, breakdown };
  }
}
