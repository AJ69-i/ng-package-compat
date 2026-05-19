import { Injectable } from '@angular/core';
import * as semver from 'semver';
import { PeerConflict, VersionCompatibility } from '../models/npm-package.model';

/**
 * Detects peer-dependency conflicts between the user's own declared deps.
 *
 * The input is a map of `name` → the version record we picked as the
 * "recommended" release for each package. For each package we scan its
 * declared `peerDependencies` and check whether the user has a version of
 * that peer that satisfies the declared range.
 */
@Injectable({ providedIn: 'root' })
export class PeerConflictService {
  detect(
    recommended: Record<string, VersionCompatibility>,
    userVersions: Record<string, string | null>
  ): PeerConflict[] {
    const conflicts: PeerConflict[] = [];
    for (const [sourceName, row] of Object.entries(recommended)) {
      const peers = row.peerDependencies ?? {};
      for (const [peerName, peerRange] of Object.entries(peers)) {
        if (peerName.startsWith('@angular/')) continue; // handled elsewhere
        if (!userVersions[peerName] && !recommended[peerName]) continue;

        const actualVersion =
          recommended[peerName]?.version ?? userVersions[peerName] ?? null;

        if (!actualVersion) continue;
        const ok = this.rangeSatisfies(actualVersion, peerRange);
        if (ok) continue;

        conflicts.push({
          source: sourceName,
          target: peerName,
          expected: peerRange,
          actual: actualVersion,
          hint: this.hint(sourceName, peerName, peerRange, actualVersion)
        });
      }
    }
    return conflicts;
  }

  private rangeSatisfies(version: string, range: string): boolean {
    try {
      return semver.satisfies(version, range, { includePrerelease: true });
    } catch {
      return true;
    }
  }

  private hint(source: string, target: string, expected: string, actual: string): string {
    return (
      `${source} expects ${target}@${expected} but your tree resolves ${actual}. ` +
      `Bump ${target} or pin ${source} to a version that declares a matching peer range. ` +
      `If you can't, install with --legacy-peer-deps and revisit in a follow-up.`
    );
  }
}
