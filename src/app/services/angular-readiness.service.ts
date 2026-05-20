import { Injectable } from '@angular/core';
import { NpmRegistryResponse, NpmVersionMetadata } from '../models/npm-package.model';

/**
 * Boolean signal per "is the package keeping up with modern Angular?"
 * dimension. All four can be derived from the packument + README
 * without any new API calls.
 */
export interface AngularReadiness {
  /**
   * Library exposes `provideX()`-style standalone APIs in addition to
   * (or instead of) the legacy NgModule `forRoot()` pattern. Strong
   * signal when README documents `provideX(...)` for app-config
   * registration; weaker signal when keywords mention "standalone".
   */
  standalone: boolean;
  /**
   * Library does not depend on Zone.js as a runtime requirement, OR
   * explicitly documents zoneless compatibility. Critical for
   * Angular 18+ apps that have opted into the zoneless change
   * detection model.
   */
  zoneless: boolean;
  /**
   * Library works under Angular Universal (server-side rendering /
   * hydration). README mentions SSR, or the package ships SSR-aware
   * entry points (separate `*-server` exports).
   */
  ssrSafe: boolean;
  /**
   * Library uses the Angular Signals primitives natively in its
   * public API — `signal()`, `computed()`, `effect()`, `toSignal()`,
   * or `Signal<T>` typings. Indicates the package is designed for
   * modern Angular state patterns rather than wrapped Subjects.
   */
  signals: boolean;
}

const EMPTY_READINESS: AngularReadiness = {
  standalone: false,
  zoneless: false,
  ssrSafe: false,
  signals: false
};

/**
 * Heuristic detector for the four "Modern-Angular ready?" flags
 * surfaced on the search results page.
 *
 * # Why heuristic and not authoritative
 *
 * There's no machine-readable manifest for "is this library
 * standalone-ready / zoneless-safe / SSR-compatible / signals-using."
 * Maintainers communicate these things in the README, in release
 * notes, and through the SHAPE of their public API. We approximate
 * those signals by string-matching against the README the packument
 * already gives us, and against the keywords + peerDependencies in
 * the package.json.
 *
 * # Trade-off accepted
 *
 * False positives are possible — a README that mentions `provideX()`
 * in passing as part of a comparison to a different library would
 * trip the standalone heuristic incorrectly. False negatives are
 * also possible — a library that genuinely supports standalone but
 * doesn't document it as `provideX()` (some still use the
 * `MyModule.forRoot()` form even though they're standalone-ready
 * underneath).
 *
 * We err toward false-negative-friendly thresholds (require multiple
 * signals, not one) because telling a user "this is modern-Angular
 * ready" when it isn't is more harmful than missing a true positive
 * — they'll find out the right answer either way the moment they
 * try to install.
 *
 * # SSR-safe is the loosest heuristic
 *
 * "Does it work in SSR" is the hardest to detect statically — many
 * libraries work fine in SSR but never mention it in their README
 * because it was never a problem. We only set this flag when there's
 * affirmative evidence (README mentions SSR / Angular Universal /
 * platform-server / `isPlatformBrowser`). Absence of evidence is not
 * evidence of absence; we just don't claim SSR-safety we can't see.
 */
@Injectable({ providedIn: 'root' })
export class AngularReadinessService {
  detect(pkg: NpmRegistryResponse | null | undefined): AngularReadiness {
    if (!pkg) return EMPTY_READINESS;

    const meta = this.latestMeta(pkg);
    const readme = (pkg.readme ?? '').toLowerCase();
    const keywords = (meta?.keywords ?? []).map((k) => k.toLowerCase());
    const peerDeps = meta?.peerDependencies ?? {};
    const allDeps = { ...peerDeps, ...(meta?.dependencies ?? {}) };

    return {
      standalone: this.detectStandalone(readme, keywords),
      zoneless: this.detectZoneless(readme, keywords, peerDeps, allDeps),
      ssrSafe: this.detectSsr(readme, keywords, meta),
      signals: this.detectSignals(readme, keywords)
    };
  }

  /**
   * Standalone detection. We require at least one strong signal so a
   * passing mention of "standalone components" in a comparison
   * section doesn't trip the flag.
   *
   * Strong signals:
   *   - README contains `provideX(` or `provide_*(` calls — direct
   *     evidence of standalone-style registration API.
   *   - README mentions `app.config.ts` (the standalone app-config
   *     pattern).
   *   - Keywords include `standalone` or `provide`.
   *
   * Weak signals (only count when combined):
   *   - README mentions "standalone components" or "standalone API".
   *   - README mentions `bootstrapApplication` (the standalone bootstrap).
   */
  private detectStandalone(readme: string, keywords: string[]): boolean {
    const hasProvideCall = /\bprovide[a-z][a-z0-9]+\s*\(/i.test(readme);
    const mentionsAppConfig = readme.includes('app.config.ts') || readme.includes('appconfig');
    const mentionsBootstrapApplication = readme.includes('bootstrapapplication');
    const kw = keywords.includes('standalone') || keywords.includes('provide');
    const mentionsStandalone = /standalone\s+(component|api|library|package|support)/i.test(readme);

    // Strong: any one is enough.
    if (hasProvideCall || mentionsAppConfig || kw) return true;
    // Weak: need two coincident hints.
    return mentionsBootstrapApplication && mentionsStandalone;
  }

  /**
   * Zoneless detection. Two complementary paths:
   *
   *   1. Affirmative claim in the README — the maintainer explicitly
   *      says "zoneless" or "noop zone". This is the strongest signal.
   *   2. Absence of `zone.js` from peer-deps AND absence from regular
   *      deps. Doesn't prove zoneless-safety (the library might just
   *      not need to declare it), but combined with "library doesn't
   *      use NgZone APIs" (which we approximate via keyword check)
   *      it's a reasonable inference.
   *
   * We're deliberately conservative — Angular's zoneless mode is
   * recent and most libraries haven't audited for it yet. A false
   * "zoneless-safe" claim is much more damaging than a missing one.
   */
  private detectZoneless(
    readme: string,
    keywords: string[],
    peerDeps: Record<string, string>,
    allDeps: Record<string, string>
  ): boolean {
    // Strong: explicit mention.
    if (readme.includes('zoneless') || readme.includes('noop zone') || readme.includes('without zone.js')) {
      return true;
    }
    if (keywords.includes('zoneless')) return true;

    // Weak: no Zone.js anywhere in the dep tree AND library doesn't
    // mention NgZone in its README (libraries that use NgZone are
    // not zoneless-safe even if they don't declare zone.js as a peer).
    const hasZoneDep = 'zone.js' in peerDeps || 'zone.js' in allDeps;
    const usesNgZone = readme.includes('ngzone') || readme.includes('zone.run');
    return !hasZoneDep && !usesNgZone && this.isAngularLibrary(allDeps, keywords);
  }

  /**
   * SSR detection. We require an affirmative signal — absence of
   * evidence is not evidence of absence. Libraries that "just work"
   * in SSR without saying so will be marked SSR-safe = false, which
   * is the safe default.
   */
  private detectSsr(readme: string, keywords: string[], meta: NpmVersionMetadata | null): boolean {
    if (
      readme.includes('server-side rendering') ||
      readme.includes('server side rendering') ||
      readme.includes('@angular/ssr') ||
      readme.includes('platform-server') ||
      readme.includes('angular universal') ||
      readme.includes('isplatformbrowser')
    ) {
      return true;
    }
    if (keywords.includes('ssr') || keywords.includes('universal') || keywords.includes('hydration')) {
      return true;
    }
    // Some libraries ship a separate `*-server` entrypoint — strong
    // signal of SSR-awareness.
    if (typeof meta?.module === 'string' && /(?:^|[/.-])(server|ssr)(?:[/.-]|$)/.test(meta.module)) {
      return true;
    }
    return false;
  }

  /**
   * Signals detection. Looks for the canonical Signal-API symbols
   * in the README. We avoid raw "signal" matching because that word
   * appears in many unrelated contexts ("emits a signal", "send a
   * signal to the server" — both false positives).
   */
  private detectSignals(readme: string, keywords: string[]): boolean {
    // Canonical Signal API call shapes. The `(` requirement filters
    // out the word "signal" in unrelated prose.
    if (/\bsignal\s*\(/i.test(readme)) return true;
    if (/\bcomputed\s*\(/i.test(readme)) return true;
    if (/\beffect\s*\(/i.test(readme) && readme.includes('@angular')) return true;
    if (/\btosignal\s*\(/i.test(readme)) return true;
    // Typed import shape: `Signal<T>` or `WritableSignal<T>`.
    if (/\bsignal<[a-z]/i.test(readme)) return true;
    if (/\bwritablesignal/i.test(readme)) return true;
    if (keywords.includes('signals') || keywords.includes('signal')) return true;
    return false;
  }

  /**
   * Cheap "is this an Angular library at all" check, used to gate
   * the zoneless "no zone.js dep" inference — we shouldn't claim a
   * non-Angular utility is zoneless-safe just because it doesn't
   * depend on zone.js (of course it doesn't).
   */
  private isAngularLibrary(allDeps: Record<string, string>, keywords: string[]): boolean {
    if (Object.keys(allDeps).some((k) => k.startsWith('@angular/'))) return true;
    return keywords.some((k) => k.startsWith('angular') || k === 'ng');
  }

  private latestMeta(pkg: NpmRegistryResponse): NpmVersionMetadata | null {
    const latest = pkg['dist-tags']?.['latest'];
    if (!latest) return null;
    return pkg.versions?.[latest] ?? null;
  }
}
