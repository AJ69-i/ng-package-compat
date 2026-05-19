import { Injectable } from '@angular/core';
import { NpmRegistryResponse, VersionDiff } from '../models/npm-package.model';

type DepMap = { [name: string]: string };

@Injectable({ providedIn: 'root' })
export class VersionDiffService {
  diff(pkg: NpmRegistryResponse, from: string, to: string): VersionDiff | null {
    const a = pkg.versions?.[from];
    const b = pkg.versions?.[to];
    if (!a || !b) return null;

    const depDiff = this.diffMap(a.dependencies ?? {}, b.dependencies ?? {});
    const peerDiff = this.diffMap(a.peerDependencies ?? {}, b.peerDependencies ?? {});

    const deprecationChange =
      a.deprecated !== b.deprecated ? { from: a.deprecated, to: b.deprecated } : null;

    return {
      pkg: pkg.name,
      from,
      to,
      addedDeps: depDiff.added,
      removedDeps: depDiff.removed,
      changedDeps: depDiff.changed,
      addedPeers: peerDiff.added,
      removedPeers: peerDiff.removed,
      changedPeers: peerDiff.changed,
      deprecationChange
    };
  }

  private diffMap(a: DepMap, b: DepMap) {
    const added: Array<{ name: string; range: string }> = [];
    const removed: Array<{ name: string; range: string }> = [];
    const changed: Array<{ name: string; from: string; to: string }> = [];

    for (const [name, range] of Object.entries(b)) {
      if (!(name in a)) added.push({ name, range });
      else if (a[name] !== range) changed.push({ name, from: a[name], to: range });
    }
    for (const [name, range] of Object.entries(a)) {
      if (!(name in b)) removed.push({ name, range });
    }
    added.sort((x, y) => x.name.localeCompare(y.name));
    removed.sort((x, y) => x.name.localeCompare(y.name));
    changed.sort((x, y) => x.name.localeCompare(y.name));
    return { added, removed, changed };
  }
}
