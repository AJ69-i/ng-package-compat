import { Injectable } from '@angular/core';
import { NpmRegistryResponse, NpmVersionMetadata } from '../models/npm-package.model';

/**
 * Hook names npm executes during `npm install`. Any of these running
 * arbitrary code on the user's machine is the supply-chain primitive
 * behind event-stream, ua-parser-js, and the crypto-wallet drainers
 * of 2023-2024. Even legitimate packages that use these (node-gyp
 * builds, native bindings) deserve a flag — the user should know.
 */
const INSTALL_HOOK_NAMES = ['preinstall', 'install', 'postinstall'] as const;

/**
 * Keywords commonly used by Angular package authors to advertise
 * `ng add` schematic support. We tolerate both because the convention
 * has drifted over time: the official Angular docs say `schematics`,
 * the community frequently uses `ng-add`.
 */
const NG_ADD_KEYWORDS = new Set(['ng-add', 'schematics', 'schematic']);

export interface ProvenanceSignal {
  /** True when the latest published version carries Sigstore attestation. */
  verified: boolean;
  /** Public attestation URL if known, for the "View attestation" link. */
  url: string | null;
  /** Optional predicateType from the provenance (typically "https://slsa.dev/provenance/v1"). */
  predicateType: string | null;
}

export interface InstallScriptSignal {
  /** True when at least one lifecycle install hook is declared. */
  present: boolean;
  /** Which hooks were declared, e.g. ['postinstall']. Empty when none. */
  hooks: string[];
}

/**
 * Stateless extractor for the three supply-chain trust signals that
 * live inside the npm packument we already fetch on every search.
 *
 * # Why a separate service
 *
 * These checks are pure transformations of registry data — no I/O,
 * no caching, no async. Keeping them out of `NpmRegistryService`
 * means the registry service stays focused on the network call, and
 * the trust service is independently testable with a single
 * stub-packument fixture per scenario.
 *
 * # Why focus on the `latest` dist-tag
 *
 * Provenance and install-script presence can vary version-to-version
 * (a maintainer may have started signing only at v17, or stopped at
 * v18). For the search-results trust chip we report the state of the
 * `latest` tag because that's what the user will install if they
 * follow the recommendation. The version table separately surfaces
 * per-version data when needed.
 */
@Injectable({ providedIn: 'root' })
export class PackageTrustService {
  /**
   * Detect Sigstore provenance on the latest published version. We
   * accept either form the npm registry currently returns:
   *
   *   versions[v].dist.attestations.url
   *   versions[v].dist.attestations.provenance.predicateType
   *
   * The registry returns `attestations` as an object only when at
   * least one attestation was uploaded during `npm publish --provenance`,
   * so a truthy `attestations` is itself the signal — we don't need to
   * also verify the Sigstore bundle client-side (that would require
   * crypto + the Rekor transparency log).
   */
  provenance(pkg: NpmRegistryResponse | null | undefined): ProvenanceSignal {
    const meta = this.latestMeta(pkg);
    const att = meta?.dist?.attestations;
    if (!att) return { verified: false, url: null, predicateType: null };
    return {
      verified: true,
      url: att.url ?? null,
      predicateType: att.provenance?.predicateType ?? null
    };
  }

  /**
   * Detect install-script lifecycle hooks. Returns the list of hook
   * names found so the UI can be specific in its warning ("This
   * package runs a postinstall script" reads better than a generic
   * "install hooks present").
   *
   * Note: a hook value of empty string or whitespace is still treated
   * as present — `"postinstall": ""` is a valid npm script declaration
   * that no-ops, but the field's PRESENCE is what npm uses to decide
   * whether to invoke the hook, so we report it.
   */
  installScripts(pkg: NpmRegistryResponse | null | undefined): InstallScriptSignal {
    const meta = this.latestMeta(pkg);
    const scripts = meta?.scripts;
    if (!scripts) return { present: false, hooks: [] };
    const hooks = INSTALL_HOOK_NAMES.filter((h) => h in scripts);
    return { present: hooks.length > 0, hooks };
  }

  /**
   * Detect `ng add` support. Two signals are considered authoritative:
   *
   *   1. `schematics` field on the version metadata pointing to a
   *      collection.json. This is the canonical Angular signal — when
   *      `ng add <pkg>` runs, it reads this field to find the
   *      `ng-add` schematic inside the collection.
   *   2. `ng-add` / `schematics` / `schematic` in the package's
   *      `keywords` array. Community convention for packages whose
   *      schematics field lives elsewhere or isn't in the latest
   *      version metadata yet.
   *
   * We accept either because both reliably correlate with `ng add`
   * working in the field. False positives would be packages that
   * SHIP schematics but don't actually expose an `ng-add` schematic
   * — rare, and the failure mode is mild (user runs `ng add`, gets
   * an error, falls back to `npm install`).
   */
  supportsNgAdd(pkg: NpmRegistryResponse | null | undefined): boolean {
    const meta = this.latestMeta(pkg);
    if (!meta) return false;
    if (typeof meta.schematics === 'string' && meta.schematics.length > 0) return true;
    const kw = meta.keywords;
    if (kw && kw.some((k) => NG_ADD_KEYWORDS.has(k.toLowerCase()))) return true;
    return false;
  }

  /** Locate the version metadata block for the `latest` dist-tag, or null. */
  private latestMeta(pkg: NpmRegistryResponse | null | undefined): NpmVersionMetadata | null {
    if (!pkg) return null;
    const latest = pkg['dist-tags']?.['latest'];
    if (!latest) return null;
    return pkg.versions?.[latest] ?? null;
  }
}
