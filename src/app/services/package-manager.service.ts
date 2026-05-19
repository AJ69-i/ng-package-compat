import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { PackageManager } from '../models/npm-package.model';

const KEY = 'ngpc.pm';

@Injectable({ providedIn: 'root' })
export class PackageManagerService {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  readonly pm = signal<PackageManager>(this.initial());

  set(pm: PackageManager): void {
    this.pm.set(pm);
    if (!this.isBrowser) return;
    try { localStorage.setItem(KEY, pm); } catch { /* ignore */ }
  }

  /** Produces "install" command text for a given pm. */
  installCommand(pkg: string, version?: string): string {
    const spec = version ? `${pkg}@${version}` : pkg;
    switch (this.pm()) {
      case 'yarn': return `yarn add ${spec}`;
      case 'pnpm': return `pnpm add ${spec}`;
      case 'bun':  return `bun add ${spec}`;
      default:     return `npm install ${spec}`;
    }
  }

  /** Produces "ng add" command text for the preferred pm (falls back to npx). */
  ngAddCommand(pkg: string, version?: string): string {
    const spec = version ? `${pkg}@${version}` : pkg;
    switch (this.pm()) {
      case 'yarn': return `yarn dlx @angular/cli@latest add ${spec}`;
      case 'pnpm': return `pnpm dlx @angular/cli@latest add ${spec}`;
      case 'bun':  return `bunx --bun @angular/cli@latest add ${spec}`;
      default:     return `npx @angular/cli@latest add ${spec}`;
    }
  }

  /**
   * Capability-aware install recommendation. When the target package
   * ships an `ng add` schematic (detected by PackageTrustService),
   * the user is much better served by `ng add <pkg>` than by `npm
   * install <pkg>`: ng add wires up imports, providers, polyfills,
   * and config files automatically, where npm install leaves the
   * user to discover the manual setup steps in the README.
   *
   * When ng-add isn't supported (or we don't know yet — `null`),
   * we fall back to the plain install command. The null branch
   * matters because the schematic check runs synchronously off the
   * packument but is gated on the latest dist-tag metadata being
   * present, which is true on real packages but defensively typed
   * as optional.
   */
  recommendedInstall(pkg: string, version: string | undefined, supportsNgAdd: boolean | null | undefined): string {
    return supportsNgAdd ? this.ngAddCommand(pkg, version) : this.installCommand(pkg, version);
  }

  private initial(): PackageManager {
    if (!this.isBrowser) return 'npm';
    try {
      const saved = localStorage.getItem(KEY);
      if (saved === 'npm' || saved === 'yarn' || saved === 'pnpm' || saved === 'bun') {
        return saved;
      }
    } catch { /* ignore */ }
    return 'npm';
  }
}
