import { Injectable } from '@angular/core';
import * as semver from 'semver';
import {
  DetectionSource,
  DetectionStrategy,
  NpmRegistryResponse,
  NpmVersionMetadata,
  VersionCompatibility
} from '../models/npm-package.model';

/**
 * Known released Angular major versions. Extend as new Angular majors ship.
 */
export const KNOWN_ANGULAR_MAJORS: readonly number[] = Object.freeze([
  2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21
]);

const ANGULAR_SCOPE = '@angular/';
const ANGULAR_CORE_KEYS = ['@angular/core', '@angular/common', '@angular/compiler'];

@Injectable({ providedIn: 'root' })
export class CompatibilityService {
  /** Convert a raw npm registry response into rows ready for the UI. */
  buildVersionRows(
    pkg: NpmRegistryResponse,
    strategy: DetectionStrategy = 'peer'
  ): VersionCompatibility[] {
    const latestTag = pkg['dist-tags']?.['latest'];
    const rows: VersionCompatibility[] = [];

    for (const [version, meta] of Object.entries(pkg.versions ?? {})) {
      const detection = this.detectCompatibility(pkg.name, version, meta, strategy);

      const supportedMajors =
        detection.precomputedMajors.length > 0
          ? detection.precomputedMajors
          : detection.range
          ? this.majorsSatisfiedByRange(detection.range)
          : [];

      rows.push({
        version,
        publishedAt: pkg.time?.[version] ? new Date(pkg.time[version]) : null,
        isLatest: version === latestTag,
        isDeprecated: !!meta.deprecated,
        deprecationMessage: meta.deprecated,
        angularPeerRange: detection.range,
        supportedAngularMajors: supportedMajors,
        supportsAny: detection.source === 'none' && !!detection.explicitAny,
        detectionSource: detection.source,
        isPrerelease: !!semver.parse(version)?.prerelease.length,
        hasTypes: !!(meta.types || meta.typings),
        license: meta.license ?? pkg.license ?? null,
        unpackedSize: meta.dist?.unpackedSize ?? null,
        peerDependencies: meta.peerDependencies ?? {},
        dependencies: meta.dependencies ?? {},
        nodeEngine: meta.engines?.['node'] ?? null
      });
    }

    rows.sort((a, b) => this.compareSemverDesc(a.version, b.version));
    return rows;
  }

  private detectCompatibility(
    pkgName: string,
    version: string,
    meta: NpmVersionMetadata,
    strategy: DetectionStrategy
  ): {
    range: string | null;
    source: DetectionSource;
    precomputedMajors: number[];
    explicitAny?: boolean;
  } {
    const peerRange = this.pickAngularRange(meta.peerDependencies);
    if (peerRange) return { range: peerRange, source: 'peer', precomputedMajors: [] };

    if (strategy === 'peer') {
      return { range: null, source: 'none', precomputedMajors: [], explicitAny: true };
    }

    const depRange = this.pickAngularRange(meta.dependencies);
    if (depRange) return { range: depRange, source: 'dependency', precomputedMajors: [] };

    if (strategy === 'peer-dep') {
      return { range: null, source: 'none', precomputedMajors: [], explicitAny: true };
    }

    // Heuristic: Angular-scoped packages track their own major with Angular's.
    if (pkgName.startsWith(ANGULAR_SCOPE)) {
      const parsed = semver.parse(version);
      if (parsed && parsed.major > 0 && KNOWN_ANGULAR_MAJORS.includes(parsed.major)) {
        return {
          range: `${parsed.major}.x`,
          source: 'angular-package-name',
          precomputedMajors: [parsed.major]
        };
      }
    }

    const devRange = this.pickAngularRange(meta.devDependencies);
    if (devRange) return { range: devRange, source: 'devDependency', precomputedMajors: [] };

    return { range: null, source: 'none', precomputedMajors: [], explicitAny: true };
  }

  private pickAngularRange(map: { [key: string]: string } | undefined): string | null {
    if (!map) return null;
    for (const key of ANGULAR_CORE_KEYS) {
      if (map[key]) return map[key];
    }
    for (const key of Object.keys(map)) {
      if (key.startsWith(ANGULAR_SCOPE)) return map[key];
    }
    return null;
  }

  /**
   * Union of known Angular majors satisfied by the given semver range.
   * Probes every minor 0..40 plus an M.999.999 high sentinel.
   */
  majorsSatisfiedByRange(range: string): number[] {
    const cleaned = (range ?? '').trim();
    if (!cleaned) return [];

    if (cleaned === '*' || cleaned.toLowerCase() === 'x') {
      return [...KNOWN_ANGULAR_MAJORS];
    }

    const validated = semver.validRange(cleaned);
    if (!validated) return [];

    const result: number[] = [];
    for (const m of KNOWN_ANGULAR_MAJORS) {
      let hit = false;
      for (let minor = 0; minor <= 40 && !hit; minor++) {
        if (semver.satisfies(`${m}.${minor}.0`, validated)) hit = true;
      }
      if (!hit && semver.satisfies(`${m}.999.999`, validated)) hit = true;
      if (hit) result.push(m);
    }
    return result;
  }

  /** Descending semver comparison; invalid versions go to the end. */
  compareSemverDesc(a: string, b: string): number {
    const va = semver.coerce(a)?.version ? semver.valid(a) || semver.coerce(a)!.version : null;
    const vb = semver.coerce(b)?.version ? semver.valid(b) || semver.coerce(b)!.version : null;
    if (!va && !vb) return 0;
    if (!va) return 1;
    if (!vb) return -1;
    return semver.rcompare(va, vb);
  }

  compareSemverAsc(a: string, b: string): number {
    return -this.compareSemverDesc(a, b);
  }

  /** Distinct sorted Angular majors appearing across the computed rows. */
  collectAngularMajorsInUse(rows: VersionCompatibility[]): number[] {
    const set = new Set<number>();
    for (const r of rows) for (const m of r.supportedAngularMajors) set.add(m);
    return [...set].sort((a, b) => b - a);
  }

  /** Parse a version into its major for grouping. */
  majorOf(version: string): number | null {
    return semver.parse(version)?.major ?? semver.coerce(version)?.major ?? null;
  }
}
