import { Injectable } from '@angular/core';
import { ParsedDep, ProjectKind } from '../models/npm-package.model';

/**
 * Detects whether the project is a classic Angular CLI app, an Nx workspace,
 * or (potentially) a micro-frontend host. Also generates the Nx migrate
 * command when applicable.
 */
@Injectable({ providedIn: 'root' })
export class NxDetectionService {
  detect(deps: ParsedDep[]): ProjectKind {
    const names = new Set(deps.map((d) => d.name));
    const isNx =
      names.has('nx') ||
      [...names].some((n) => n.startsWith('@nx/') || n.startsWith('@nrwl/'));
    if (isNx) return 'nx';
    const isMfe =
      names.has('@angular-architects/module-federation') ||
      names.has('@angular-architects/native-federation');
    if (isMfe) return 'mfe';
    return 'cli';
  }

  nxMigrateCommand(targetNg: number, deps: ParsedDep[]): string {
    // Prefer @nx/angular as the migration driver; fall back to nx@latest.
    const hasNxAngular = deps.some(
      (d) => d.name === '@nx/angular' || d.name === '@nrwl/angular'
    );
    const pkg = hasNxAngular ? '@nx/angular' : 'nx';
    return (
      `nx migrate ${pkg}@${targetNg}\n` +
      `nx migrate --run-migrations --create-commits`
    );
  }
}
