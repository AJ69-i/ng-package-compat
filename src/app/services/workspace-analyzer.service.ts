import { Injectable, inject, signal } from '@angular/core';
import { PackageJsonParserService } from './package-json-parser.service';
import { ParsedPackageJson, ParsedDep } from '../models/npm-package.model';

/** A single workspace project (app or lib) inside a monorepo. */
export interface WorkspaceProject {
  /** Relative path or package name, e.g. `apps/admin` or `@org/ui`. */
  id: string;
  /** Parsed package.json contents. */
  pkg: ParsedPackageJson;
  /** Raw path to the package.json, for display. */
  path: string;
}

/** A dependency that appears in multiple projects — with version drift or without. */
export interface SharedDependency {
  name: string;
  /** Map of project id → range in that project. */
  ranges: Record<string, string>;
  /** Unique distinct ranges. If > 1, the dep is misaligned. */
  distinct: number;
  /** The majority range, if any. */
  majority: string | null;
}

/** Output of workspace analysis — one shared view of a monorepo. */
export interface WorkspaceReport {
  kind: 'nx' | 'npm-workspaces' | 'angular-multi-project' | 'unknown';
  projects: WorkspaceProject[];
  sharedDeps: SharedDependency[];
  /** Deps that are in drift (distinct > 1). */
  drift: SharedDependency[];
  /** All distinct Angular majors seen across projects — the list flags v-mismatches. */
  angularMajors: number[];
}

/**
 * Reads multi-project inputs (`nx.json`, `workspaces` field in a root
 * package.json, or a collection of `projects/*\/package.json`) and emits a
 * unified report of shared deps + drift. The idea is:
 *
 *   - Find every `package.json` the user uploaded.
 *   - Parse each as a project.
 *   - Group deps by name, detect version drift.
 *   - Surface the drifting ones so teams can align.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceAnalyzerService {
  readonly report = signal<WorkspaceReport | null>(null);
  private readonly parser = inject(PackageJsonParserService);

  analyze(projects: WorkspaceProject[], nxJsonRaw?: string): WorkspaceReport {
    const kind = inferKind(projects, nxJsonRaw);

    const shared = new Map<string, SharedDependency>();
    for (const p of projects) {
      for (const d of p.pkg.deps) {
        if (!d.range) continue;
        let entry = shared.get(d.name);
        if (!entry) {
          entry = { name: d.name, ranges: {}, distinct: 0, majority: null };
          shared.set(d.name, entry);
        }
        entry.ranges[p.id] = d.range;
      }
    }
    const sharedDeps: SharedDependency[] = [];
    for (const entry of shared.values()) {
      const values = Object.values(entry.ranges);
      const counts = countBy(values);
      entry.distinct = Object.keys(counts).length;
      entry.majority =
        Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      if (Object.keys(entry.ranges).length >= 2) sharedDeps.push(entry);
    }
    sharedDeps.sort((a, b) => b.distinct - a.distinct || a.name.localeCompare(b.name));

    const drift = sharedDeps.filter((s) => s.distinct > 1);

    const angularMajors = [
      ...new Set(
        projects
          .map((p) => p.pkg.angularMajor)
          .filter((m): m is number => m !== null)
      )
    ].sort((a, b) => a - b);

    const report: WorkspaceReport = {
      kind,
      projects,
      sharedDeps,
      drift,
      angularMajors
    };
    this.report.set(report);
    return report;
  }

  clear(): void {
    this.report.set(null);
  }

  /**
   * Build a quick "align-to-majority" shopping list the user can send through
   * normal install commands.
   */
  alignCommand(pm: 'npm' | 'yarn' | 'pnpm' = 'npm'): string {
    const r = this.report();
    if (!r || !r.drift.length) return '';
    const installs = r.drift
      .filter((d) => d.majority)
      .map((d) => `${d.name}@${d.majority!.replace(/^[\^~]/, '')}`)
      .join(' ');
    const verb = pm === 'npm' ? 'install' : 'add';
    return installs ? `${pm} ${verb} ${installs}` : '';
  }
}

function inferKind(
  projects: WorkspaceProject[],
  nxJsonRaw?: string
): WorkspaceReport['kind'] {
  if (nxJsonRaw) return 'nx';
  if (projects.some((p) => /packages\//i.test(p.path))) return 'npm-workspaces';
  if (projects.some((p) => /projects\//i.test(p.path))) return 'angular-multi-project';
  return projects.length > 1 ? 'npm-workspaces' : 'unknown';
}

function countBy<T extends string | number>(items: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) {
    const key = String(i);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
