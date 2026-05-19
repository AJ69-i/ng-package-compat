/**
 * Shape of the response returned by https://registry.npmjs.org/<package>
 */
export interface NpmRegistryResponse {
  name: string;
  description?: string;
  'dist-tags': { [tag: string]: string };
  versions: { [version: string]: NpmVersionMetadata };
  // The npm registry also packs special keys "created"/"modified" into `time`.
  time: { [version: string]: string };
  homepage?: string;
  repository?: { type?: string; url?: string };
  license?: string;
  maintainers?: Array<{ name: string; email?: string }>;
  author?: { name?: string; email?: string } | string;
  keywords?: string[];
  readme?: string;
}

export interface NpmVersionMetadata {
  name: string;
  version: string;
  description?: string;
  deprecated?: string;
  dependencies?: { [name: string]: string };
  peerDependencies?: { [name: string]: string };
  peerDependenciesMeta?: { [name: string]: { optional?: boolean } };
  devDependencies?: { [name: string]: string };
  optionalDependencies?: { [name: string]: string };
  engines?: { [name: string]: string };
  license?: string;
  types?: string;
  typings?: string;
  module?: string;
  main?: string;
  /**
   * Lifecycle scripts npm will run on the user's machine. Presence of
   * `preinstall` / `install` / `postinstall` is a well-known
   * supply-chain risk surface — these scripts execute with the user's
   * privileges on `npm install`, which is how event-stream, ua-parser-js,
   * and the more recent crypto-wallet-drainer attacks delivered payloads.
   */
  scripts?: { [name: string]: string };
  /**
   * Path to the Angular schematics collection JSON (e.g. "./schematics/collection.json").
   * Presence of this field — or an `ng-add` keyword — indicates the
   * package supports `ng add <pkg>`, which we surface as a friendlier
   * install command than the bare `npm install`.
   */
  schematics?: string;
  /** Package-level keywords. `ng-add` / `schematics` here also signals ng-add support. */
  keywords?: string[];
  dist?: NpmDist;
  _npmUser?: { name: string; email?: string };
}

/**
 * The `dist` block on each published version. Beyond the historical
 * tarball/shasum fields, npm now ships supply-chain trust metadata:
 *
 *   - `attestations`: Sigstore-backed publish provenance. Present when
 *     the package was published via `npm publish --provenance` from a
 *     verified CI workflow (typically GitHub Actions). This is the
 *     post-xz, post-event-stream trust signal we surface as a
 *     "Provenance verified" chip on the search results page.
 *   - `signatures`: npm's registry signatures — present on every
 *     published version. Useful but not nearly as strong a signal as
 *     attestations, so we don't surface it in UI today.
 */
export interface NpmDist {
  tarball?: string;
  shasum?: string;
  unpackedSize?: number;
  attestations?: {
    url?: string;
    provenance?: {
      predicateType?: string;
    };
  };
  signatures?: Array<{ keyid: string; sig: string }>;
}

export type DetectionStrategy = 'peer' | 'peer-dep' | 'heuristic';

export type DetectionSource =
  | 'peer'
  | 'dependency'
  | 'devDependency'
  | 'angular-package-name'
  | 'none';

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

export interface VersionCompatibility {
  version: string;
  publishedAt: Date | null;
  isLatest: boolean;
  isDeprecated: boolean;
  deprecationMessage?: string;
  angularPeerRange: string | null;
  supportedAngularMajors: number[];
  supportsAny: boolean;
  detectionSource: DetectionSource;
  isPrerelease: boolean;
  hasTypes: boolean;
  license: string | null;
  unpackedSize: number | null;
  /** Full peer dependency map of this version (for dependency panel). */
  peerDependencies: { [name: string]: string };
  /** Full dependency map of this version (for dependency panel). */
  dependencies: { [name: string]: string };
  /** Node engine range, if any. */
  nodeEngine: string | null;
}

/** Response from api.npmjs.org downloads range endpoint. */
export interface NpmDownloadsRange {
  package: string;
  start: string;
  end: string;
  downloads: Array<{ day: string; downloads: number }>;
}

/** Subset of the Bundlephobia API response. */
export interface BundleSize {
  name: string;
  version: string;
  size: number;
  gzip: number;
  hasJSModule: boolean;
  hasJSNext: boolean;
  dependencyCount: number;
}

/** Advisory returned by OSV.dev. */
export interface Advisory {
  id: string;
  summary: string;
  severity?: string;
  affectedRanges: string;
  references: string[];
  publishedAt?: Date;
}

export interface StoredSearch {
  name: string;
  ts: number;
}

/** A recommendation produced by RecommendationService. */
export interface Recommendation {
  angularMajor: number;
  /** Best stable match. */
  stable: VersionCompatibility | null;
  /** Latest match of any kind (including prerelease). */
  latest: VersionCompatibility | null;
  /** All matches, descending. */
  all: VersionCompatibility[];
}

/** A change detected between two versions of the same package. */
export interface VersionDiff {
  pkg: string;
  from: string;
  to: string;
  addedDeps: Array<{ name: string; range: string }>;
  removedDeps: Array<{ name: string; range: string }>;
  changedDeps: Array<{ name: string; from: string; to: string }>;
  addedPeers: Array<{ name: string; range: string }>;
  removedPeers: Array<{ name: string; range: string }>;
  changedPeers: Array<{ name: string; from: string; to: string }>;
  deprecationChange: { from?: string; to?: string } | null;
}

/** Filter options for the versions table. */
export interface VersionFilters {
  hideDeprecated: boolean;
  hidePrerelease: boolean;
  onlyAngularMajor: number | null;
  minPublishDate: string | null; // ISO date
  maxPublishDate: string | null;
  search: string;
}

export type SortKey = 'semver' | 'date' | 'major';
export type SortDir = 'asc' | 'desc';

/** Status of a single package in the compatibility report. */
export type CompatStatus = 'safe' | 'warning' | 'conflict' | 'unknown';

/** Mode of the compatibility analysis. */
export type CompatMode = 'same-version' | 'upgrade';

/** A parsed entry from the user's package.json (or pasted list). */
export interface ParsedDep {
  /** Package name, e.g. "ngx-toastr". */
  name: string;
  /** Raw range from package.json, e.g. "^17.0.0" or `null` if unknown. */
  range: string | null;
  /** Section the dep came from. */
  section: 'dependencies' | 'devDependencies' | 'peerDependencies' | 'unknown';
}

/** Parsed view of a package.json file, with Angular major extracted. */
export interface ParsedPackageJson {
  name?: string;
  version?: string;
  angularMajor: number | null;
  deps: ParsedDep[];
  /** Anything we couldn't parse but shouldn't drop silently. */
  warnings: string[];
}

/** Deprecation info attached to a report row. */
export interface DeprecationInfo {
  /** `true` if the package itself is officially deprecated on npm. */
  npmDeprecated: boolean;
  /** Reason (if the tool has curated, Angular-specific advice). */
  reason?: string;
  /** One or more modern alternatives. */
  alternatives?: Alternative[];
}

export interface Alternative {
  name: string;
  rationale: string;
  /** Optional URL to the migration guide. */
  link?: string;
}

/** A code-level breaking change relevant to upgrading this package. */
export interface BreakingChange {
  /** Human-readable title, e.g. "toPromise() removed". */
  title: string;
  /** Short description of the impact and the migration. */
  detail: string;
  /** Since which major version of the package/lib this applies. */
  since?: string;
  /** Optional link to the official changelog / migration guide. */
  link?: string;
  /** Severity for sorting / highlighting. */
  severity: 'info' | 'warning' | 'critical';
  /**
   * Optional symbols/APIs that trigger this breaking change.
   * Used by SourceScannerService to filter to only breaks that actually
   * apply to the user's codebase. Can be:
   *  - plain identifier: `toPromise`, `HttpInterceptor`
   *  - decorator name: `@NgModule` (written without `@`)
   *  - template syntax token: `*ngIf`, `*ngFor`
   *  - Angular directive/module class names: `IonicModule`, `TuiRootModule`
   */
  symbols?: string[];
  /**
   * Citations attached after a source scan — file paths + line numbers where
   * the symbols were found. Populated by SourceScannerService.annotate().
   */
  citations?: SymbolCitation[];
}

/** A reference to a symbol/API in the user's source code. */
export interface SymbolCitation {
  file: string;
  line: number;
  /** The matched symbol, exactly as listed on BreakingChange.symbols. */
  symbol: string;
  /** The trimmed source line (truncated to 120 chars). */
  snippet: string;
}

/** Summary produced by scanning a set of user-provided TS/HTML files. */
export interface SourceScanResult {
  /** Total files scanned. */
  fileCount: number;
  /** Unique imports grouped by package name. */
  importsByPackage: Record<string, Set<string>>;
  /** Every citation we found, indexed by `${pkg}::${symbol}`. */
  hits: Record<string, SymbolCitation[]>;
}

/** A detected peer-dep conflict between two of the user's own deps. */
export interface PeerConflict {
  /** Package A that introduced the peer requirement. */
  source: string;
  /** Package B whose version does not match. */
  target: string;
  /** Declared peer range on `source` for `target`. */
  expected: string;
  /** The actual version the user has for `target`. */
  actual: string | null;
  /** Resolution suggestion. */
  hint: string;
}

/** Bundle-size delta between current and recommended version. */
export interface BundleDelta {
  /** Current gzip size in bytes, if known. */
  currentGzip: number | null;
  /** Recommended version's gzip size in bytes. */
  recommendedGzip: number | null;
  /** Negative means smaller; positive means larger. */
  deltaBytes: number | null;
  /** Percentage change (e.g. -15 for 15% smaller). */
  deltaPercent: number | null;
}

/** License change risk between current and recommended version. */
export interface LicenseRisk {
  currentLicense: string | null;
  recommendedLicense: string | null;
  /**
   * - `safe`: unchanged, or changed within the permissive family.
   * - `review`: MIT/ISC → Apache (still fine, but noteworthy).
   * - `blocker`: changed to a copyleft license (GPL, AGPL, etc.).
   */
  risk: 'safe' | 'review' | 'blocker';
  note: string;
}

/** UI-framework-specific alert (Material / PrimeNG / Ng-Zorro / Taiga UI). */
export interface UiFrameworkAlert {
  framework: string;
  title: string;
  detail: string;
  link?: string;
}

/** One row of the compatibility report. */
export interface ReportEntry {
  /** Package name. */
  name: string;
  /** The raw range the user currently has ("^16.2.0"). */
  currentRange: string | null;
  /** The concrete version resolved from their range (best-guess). */
  currentVersion: string | null;
  /** Does the user's current version support the target Angular major? */
  currentSupportsTarget: boolean;
  /** Does the user's current version support their current Angular major? */
  currentSupportsCurrent: boolean;
  /** Latest non-deprecated stable release that supports target Angular. */
  recommendedForTarget: VersionCompatibility | null;
  /** Latest non-deprecated stable release that supports the current Angular major. */
  recommendedForCurrent: VersionCompatibility | null;
  /** Rolled-up status. */
  status: CompatStatus;
  /** Human-readable summary of the row. */
  note: string;
  /** `name@version` spec for install / ng-update commands, or null if N/A. */
  installSpec: string | null;
  /** `true` if the package has `ng-update` schematics (best-guess). */
  ngUpdateAware: boolean;
  /** `true` if we could not fetch or evaluate this entry. */
  unresolved: boolean;
  /** Deprecation / alternative info (may be null if not deprecated). */
  deprecation?: DeprecationInfo | null;
  /** Code-level breaking changes to review. */
  breakingChanges?: BreakingChange[];
  /** Bundle-size delta between current and recommended. */
  bundleDelta?: BundleDelta | null;
  /** License-risk assessment. */
  licenseRisk?: LicenseRisk | null;
  /** UI-framework alert if this package is a known UI framework. */
  uiFrameworkAlert?: UiFrameworkAlert | null;
  /** `true` if this dep supports Angular standalone APIs. */
  supportsStandalone?: boolean;
}

/** Health score (0–100) with a gamified grade. */
export interface HealthScore {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  breakdown: Array<{ label: string; value: number; weight: number; note?: string }>;
}

/** Effort estimate for performing the upgrade. */
export interface TimeEstimate {
  /** Low/high bounds in hours. */
  lowHours: number;
  highHours: number;
  summary: string;
  contributors: Array<{ reason: string; hours: number }>;
}

/** Kind of project detected from the uploaded files. */
export type ProjectKind = 'cli' | 'nx' | 'mfe' | 'unknown';

/** Analyzer result for angular.json / tsconfig.json / .browserslistrc. */
export interface ConfigAnalysis {
  angularJson?: Array<{ level: 'info' | 'warning' | 'critical'; message: string }>;
  tsconfig?: Array<{ level: 'info' | 'warning' | 'critical'; message: string }>;
  browserslist?: Array<{ level: 'info' | 'warning' | 'critical'; message: string }>;
}

/** Micro-frontend cross-package.json analysis result. */
export interface MfeAnalysis {
  apps: string[];
  sharedDeps: Array<{ name: string; versions: Record<string, string>; consistent: boolean }>;
}

/** Bundle of files uploaded by the user for full-project analysis. */
export interface UploadedProject {
  /** Primary `package.json` (required). */
  packageJson: ParsedPackageJson;
  /** Additional package.json files for Nx / Module-Federation apps. */
  extraPackageJsons?: ParsedPackageJson[];
  /** Raw `angular.json` content, if provided. */
  angularJsonRaw?: string;
  /** Raw `tsconfig.json` content, if provided. */
  tsconfigRaw?: string;
  /** Raw `.browserslistrc` content, if provided. */
  browserslistRaw?: string;
  /** Raw lockfile content (package-lock.json / yarn.lock / pnpm-lock.yaml), if provided. */
  lockfileRaw?: string;
  /** Lockfile filename (used to detect the package manager). */
  lockfileName?: string;
}

/** Lockfile-analysis result, surfaced on the report. */
export interface LockfileReport {
  kind: 'npm' | 'yarn' | 'pnpm' | 'unknown';
  total: number;
  transitiveRisks: Array<{ name: string; version: string; reason: string }>;
}

/** A full report generated by the CompatibilityReportService. */
export interface CompatibilityReport {
  mode: CompatMode;
  currentAngularMajor: number | null;
  targetAngularMajor: number;
  entries: ReportEntry[];
  conflictCount: number;
  warningCount: number;
  safeCount: number;
  unknownCount: number;
  /** Ready-to-run `ng update` command for packages known to have schematics. */
  ngUpdateCommand: string;
  /** For Nx workspaces — `nx migrate` command. */
  nxMigrateCommand?: string;
  /** Fallback `npm/yarn/pnpm install` command for the rest. */
  installCommand: string;
  /** Full rollback command that restores the original versions. */
  rollbackCommand: string;
  /** Post-update smoke-test command. */
  verifyCommand: string;
  /** Detected kind of project. */
  projectKind: ProjectKind;
  /** Cross-package peer-dep conflicts. */
  peerConflicts: PeerConflict[];
  /** 0–100 project health score. */
  health: HealthScore;
  /** Estimated effort range. */
  estimate: TimeEstimate;
  /** Optional analysis of uploaded config files. */
  config?: ConfigAnalysis;
  /** Optional micro-frontend cross-check. */
  mfe?: MfeAnalysis;
  /** Number of deps flagged as deprecated. */
  deprecatedCount: number;
  /** Number of UI-framework alerts raised. */
  uiAlertCount: number;
  /** Number of license-risk rows. */
  licenseBlockerCount: number;
  /** Optional lockfile analysis (transitive deps). */
  lockfile?: LockfileReport;
}
