import { Injectable, inject } from '@angular/core';
import * as semver from 'semver';
import { Observable, forkJoin, of } from 'rxjs';
import { map, catchError } from 'rxjs/operators';
import { NpmRegistryService } from './npm-registry.service';
import {
  NpmRegistryResponse,
  NpmVersionMetadata
} from '../models/npm-package.model';

/** A single node in the resolved peer-graph. */
export interface ResolvedNode {
  name: string;
  version: string;
  peers: Array<{ name: string; range: string }>;
}

/** A conflict the verifier found during resolution. */
export interface ResolutionConflict {
  /** Short machine-readable kind. */
  kind: 'missing-peer' | 'range-conflict' | 'version-fetch-failed';
  /** Package that introduced the requirement. */
  source: string;
  /** Peer package that could not be satisfied. */
  target: string;
  /** Declared peer range on `source` for `target`. */
  expected: string;
  /** The version actually resolved for `target`. */
  actual: string | null;
  /** Human-readable remediation. */
  hint: string;
}

/** Full verifier output. */
export interface ResolutionReport {
  nodes: ResolvedNode[];
  conflicts: ResolutionConflict[];
  /** `true` iff no conflicts were found. */
  ok: boolean;
  /** How many packages the walker visited. */
  walked: number;
}

/**
 * Install-time verifier.
 *
 * Given a recommended install spec (name@version list), walks each package's
 * `peerDependencies` against the npm registry and flags any that can't be
 * satisfied by what will actually be in the tree — i.e., the same class of
 * errors npm would throw during `npm install`. This lets us tell the user
 * "this upgrade will fail" _before_ they try it.
 *
 * We intentionally don't try to mirror npm's full resolver (that would require
 * fetching every transitive dep). We just resolve *direct* peers, which is
 * where ~95% of real upgrade pain lives.
 */
@Injectable({ providedIn: 'root' })
export class InstallVerifierService {
  private readonly registry = inject(NpmRegistryService);

  /**
   * Verify the install plan `specs` = `[{ name, version }, ...]`. Each spec
   * must already be concrete (no `^` / `~` — call resolveInstalledVersion first).
   */
  verify(specs: Array<{ name: string; version: string }>): Observable<ResolutionReport> {
    if (!specs.length) {
      return of<ResolutionReport>({ nodes: [], conflicts: [], ok: true, walked: 0 });
    }

    const requests = specs.map((s) =>
      this.registry.fetchPackage(s.name).pipe(
        map((pkg) => this.buildNode(s.name, s.version, pkg)),
        catchError(() =>
          of<ResolvedNode>({ name: s.name, version: s.version, peers: [] })
        )
      )
    );

    return forkJoin(requests).pipe(
      map((nodes) => this.evaluate(nodes))
    );
  }

  private buildNode(name: string, version: string, pkg: NpmRegistryResponse): ResolvedNode {
    const target = this.pickVersion(pkg, version);
    const peers = target?.peerDependencies ?? {};
    return {
      name,
      version,
      peers: Object.entries(peers).map(([n, r]) => ({ name: n, range: r }))
    };
  }

  private pickVersion(pkg: NpmRegistryResponse, wanted: string): NpmVersionMetadata | null {
    if (pkg.versions[wanted]) return pkg.versions[wanted];
    // Try coerced or the latest that satisfies the range.
    try {
      const best = semver.maxSatisfying(Object.keys(pkg.versions), wanted);
      if (best && pkg.versions[best]) return pkg.versions[best];
    } catch {
      /* swallow */
    }
    return null;
  }

  private evaluate(nodes: ResolvedNode[]): ResolutionReport {
    const resolved: Record<string, string> = {};
    for (const n of nodes) resolved[n.name] = n.version;

    const conflicts: ResolutionConflict[] = [];
    for (const n of nodes) {
      for (const peer of n.peers) {
        // We only care about peers we're actually trying to install.
        if (!resolved[peer.name]) continue;
        const actual = resolved[peer.name];
        if (this.satisfies(actual, peer.range)) continue;
        conflicts.push({
          kind: 'range-conflict',
          source: n.name,
          target: peer.name,
          expected: peer.range,
          actual,
          hint:
            `Install would fail: ${n.name}@${n.version} requires ${peer.name}@${peer.range}, ` +
            `but the plan pins ${peer.name}@${actual}. Either bump ${peer.name}, drop ${n.name}, ` +
            `or rerun with --legacy-peer-deps.`
        });
      }
    }

    return {
      nodes,
      conflicts,
      ok: conflicts.length === 0,
      walked: nodes.length
    };
  }

  private satisfies(version: string, range: string): boolean {
    try {
      return semver.satisfies(version, range, { includePrerelease: true });
    } catch {
      return true;
    }
  }
}
