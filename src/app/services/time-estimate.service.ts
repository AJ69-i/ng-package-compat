import { Injectable, inject } from '@angular/core';
import { ReportEntry, TimeEstimate } from '../models/npm-package.model';
import { KnowledgeBaseService } from './knowledge-base.service';

/**
 * Estimates the human effort required to perform an upgrade.
 *
 * Rough model:
 *   - Baseline 0.5h for running the update + verifying.
 *   - Each `warning` adds 0.5–1h.
 *   - Each `conflict` adds 2–4h (manual intervention).
 *   - Each breaking change adds 0.5–2h.
 *   - Each peer conflict adds 1–2h.
 *   - Each deprecated replacement adds 2–4h.
 */
@Injectable({ providedIn: 'root' })
export class TimeEstimateService {
  private readonly kb = inject(KnowledgeBaseService);

  estimate(entries: ReportEntry[], peerConflictCount: number): TimeEstimate {
    const contributors: Array<{ reason: string; hours: number }> = [
      { reason: 'Run commands, sanity check', hours: 0.5 }
    ];

    let lowHours = 0.5;
    let highHours = 0.5;

    for (const e of entries) {
      const weight = this.kb.estimateEffort(e.name);
      if (e.status === 'warning') {
        lowHours += weight * 0.5;
        highHours += weight * 1.5;
      } else if (e.status === 'conflict') {
        lowHours += weight * 2;
        highHours += weight * 4;
        contributors.push({ reason: `Resolve ${e.name} (no compatible release)`, hours: weight * 3 });
      }

      const bcCount = e.breakingChanges?.length ?? 0;
      if (bcCount > 0) {
        lowHours += bcCount * 0.5;
        highHours += bcCount * 2;
      }

      if (e.deprecation?.alternatives?.length) {
        lowHours += 2;
        highHours += 4;
        contributors.push({ reason: `Replace deprecated ${e.name}`, hours: 3 });
      }
    }

    if (peerConflictCount > 0) {
      lowHours += peerConflictCount * 1;
      highHours += peerConflictCount * 2;
      contributors.push({ reason: `Untangle ${peerConflictCount} peer conflict(s)`, hours: peerConflictCount * 1.5 });
    }

    const summary = this.summarize(lowHours, highHours);
    return {
      lowHours: Math.round(lowHours * 2) / 2,
      highHours: Math.round(highHours * 2) / 2,
      summary,
      contributors
    };
  }

  private summarize(lo: number, hi: number): string {
    if (hi <= 3) return `Simple update — roughly ${lo}–${hi} hours.`;
    if (hi <= 8) return `Moderate update — about a working day (${lo}–${hi} hours).`;
    if (hi <= 24) return `Sprint-sized upgrade — plan ${Math.ceil(lo / 6)}–${Math.ceil(hi / 6)} business days.`;
    return `Major migration — allocate ${Math.ceil(lo / 6)}–${Math.ceil(hi / 6)} business days and a dedicated reviewer.`;
  }
}
