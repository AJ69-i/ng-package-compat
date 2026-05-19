import { Injectable, inject } from '@angular/core';
import { LicenseRisk, VersionCompatibility } from '../models/npm-package.model';
import { KnowledgeBaseService } from './knowledge-base.service';

/**
 * Detects license changes between a package's current version and its
 * recommended target. Flags copyleft transitions as a blocker.
 */
@Injectable({ providedIn: 'root' })
export class LicenseRiskService {
  private readonly kb = inject(KnowledgeBaseService);

  assess(
    current: VersionCompatibility | null,
    recommended: VersionCompatibility | null
  ): LicenseRisk | null {
    if (!current && !recommended) return null;
    const currentLicense = current?.license ?? null;
    const recommendedLicense = recommended?.license ?? null;
    if (!recommendedLicense) return null;

    const currentIsCopyleft = this.kb.isCopyleft(currentLicense);
    const targetIsCopyleft = this.kb.isCopyleft(recommendedLicense);

    if (currentLicense && currentLicense === recommendedLicense) {
      return {
        currentLicense,
        recommendedLicense,
        risk: targetIsCopyleft ? 'review' : 'safe',
        note: 'License unchanged.'
      };
    }

    if (!currentIsCopyleft && targetIsCopyleft) {
      return {
        currentLicense,
        recommendedLicense,
        risk: 'blocker',
        note:
          `License changed from ${currentLicense ?? 'unknown'} to ${recommendedLicense} ` +
          `(copyleft). Do not upgrade without explicit approval from your legal / compliance team.`
      };
    }

    if (currentLicense && recommendedLicense && currentLicense !== recommendedLicense) {
      return {
        currentLicense,
        recommendedLicense,
        risk: 'review',
        note:
          `License changed from ${currentLicense} to ${recommendedLicense}. ` +
          `Review for compatibility with your project's policy.`
      };
    }

    return {
      currentLicense,
      recommendedLicense,
      risk: 'safe',
      note: 'License is permissive.'
    };
  }
}
