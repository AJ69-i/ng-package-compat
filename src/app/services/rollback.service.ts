import { Injectable, inject } from '@angular/core';
import { ParsedDep } from '../models/npm-package.model';
import { PackageManagerService } from './package-manager.service';

/**
 * Generates a copy-paste rollback command that restores the user's
 * package.json to exactly the versions they had before running the upgrade.
 */
@Injectable({ providedIn: 'root' })
export class RollbackService {
  private readonly pm = inject(PackageManagerService);

  command(originalDeps: ParsedDep[]): string {
    const specs = originalDeps
      .filter((d) => d.range && !d.range.startsWith('*'))
      .map((d) => `${d.name}@${d.range!.replace(/^[\^~]/, '')}`)
      .sort();
    if (!specs.length) return '';
    const pm = this.pm.pm();
    const verb = pm === 'yarn' ? 'yarn add' : pm === 'pnpm' ? 'pnpm add' : pm === 'bun' ? 'bun add' : 'npm install';
    return `${verb} ${specs.join(' ')}`;
  }

  /** Post-update verification command. */
  verifyCommand(): string {
    const pm = this.pm.pm();
    const run = pm === 'yarn' ? 'yarn' : pm === 'pnpm' ? 'pnpm' : pm === 'bun' ? 'bun run' : 'npm run';
    return `${run} build -- --configuration production && ${run} test -- --watch=false --browsers=ChromeHeadless`;
  }
}
