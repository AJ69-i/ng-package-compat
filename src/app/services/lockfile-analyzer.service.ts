import { Injectable } from '@angular/core';

export interface LockfileEntry {
  name: string;
  version: string;
  path: string;
  requestedBy?: string[];
}

export interface LockfileSummary {
  kind: 'npm' | 'yarn' | 'pnpm' | 'unknown';
  total: number;
  entries: LockfileEntry[];
  transitiveRisks: Array<{ name: string; version: string; reason: string }>;
}

/**
 * Parses `package-lock.json` (npm v7+ schema) and produces a flat list of
 * transitive dependencies. Yarn/pnpm lockfiles are YAML-ish; for now we
 * flag them but don't deeply parse without a YAML dep.
 */
@Injectable({ providedIn: 'root' })
export class LockfileAnalyzerService {
  private readonly transitiveRiskRules: Array<(name: string, version: string) => string | null> = [
    (name, version) => {
      const [maj] = version.split('.').map((n) => Number(n));
      if (name === 'rxjs' && maj < 7) {
        return 'RxJS < 7 is incompatible with Angular 16+.';
      }
      return null;
    },
    (name, version) => {
      const [maj] = version.split('.').map((n) => Number(n));
      if (name === 'typescript' && maj < 5) {
        return 'TypeScript < 5 is incompatible with Angular 17+.';
      }
      return null;
    },
    (name) => {
      if (name === '@angular/flex-layout') {
        return 'Deprecated — replace with Tailwind / native CSS Grid.';
      }
      return null;
    },
    (name) => {
      if (name === 'zone.js') {
        return 'Zone.js is only needed for apps that have not migrated to zoneless change detection.';
      }
      return null;
    }
  ];

  analyze(raw: string, filename: string): LockfileSummary {
    const kind = this.detectKind(filename);
    if (kind !== 'npm') {
      return {
        kind,
        total: 0,
        entries: [],
        transitiveRisks: [{
          name: '(unsupported lockfile)',
          version: '',
          reason:
            kind === 'unknown'
              ? 'Unrecognized lockfile format.'
              : `${kind} lockfiles are not JSON — please upload package-lock.json for deep analysis.`
        }]
      };
    }

    let doc: any;
    try {
      doc = JSON.parse(raw);
    } catch {
      return {
        kind: 'npm',
        total: 0,
        entries: [],
        transitiveRisks: [{ name: '(parse error)', version: '', reason: 'Not valid JSON.' }]
      };
    }

    const entries: LockfileEntry[] = [];
    const packages = doc.packages ?? {};
    for (const [path, meta] of Object.entries<any>(packages)) {
      if (!path || !meta?.version) continue;
      const segs = path.split('node_modules/');
      const name = segs[segs.length - 1];
      if (!name) continue;
      entries.push({ name, version: meta.version, path });
    }

    const transitiveRisks: LockfileSummary['transitiveRisks'] = [];
    const seen = new Set<string>();
    for (const e of entries) {
      for (const rule of this.transitiveRiskRules) {
        const reason = rule(e.name, e.version);
        if (!reason) continue;
        const key = `${e.name}@${e.version}`;
        if (seen.has(key)) continue;
        seen.add(key);
        transitiveRisks.push({ name: e.name, version: e.version, reason });
      }
    }

    return { kind: 'npm', total: entries.length, entries, transitiveRisks };
  }

  private detectKind(filename: string): LockfileSummary['kind'] {
    const lower = filename.toLowerCase();
    if (lower.endsWith('package-lock.json') || lower.endsWith('npm-shrinkwrap.json')) return 'npm';
    if (lower.endsWith('yarn.lock')) return 'yarn';
    if (lower.endsWith('pnpm-lock.yaml')) return 'pnpm';
    return 'unknown';
  }
}
