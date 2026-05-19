# Changelog

All notable changes to `ng-package-compat` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
[SemVer](https://semver.org/).

## [3.0.0] — 2026-04-18

### Added
- **Angular 21** upgrade: zoneless change detection, signal inputs/outputs,
  `@if` / `@for` / `@switch` / `@let` / `@defer` control flow, `viewChild`,
  `provideClientHydration(withEventReplay())`.
- **SSR** via `@angular/ssr` with an Express host (`src/server.ts`).
- **PWA**: `@angular/service-worker` enabled in production.
- Migrated to the new `@angular/build:application` builder.
- New pages: `/dependencies/:pkg/:version`, `/diff/:pkg`, `/about`.
- Command palette (`Cmd/Ctrl+K`) for navigation, theme switching, and
  package recall.
- Recommendation engine (`RecommendationService`) that picks a stable + latest
  version per target Angular major.
- Version diff engine (`VersionDiffService`) for comparing two releases of a
  package.
- Filters service (deprecated / prerelease / date range / free text).
- Package manager service: choose `npm` / `yarn` / `pnpm` / `bun` globally.
- `DependenciesPanelComponent`, `VersionDiffComponent`,
  `RecommendationCardComponent`, `FiltersBarComponent`, `BreadcrumbsComponent`,
  `SkeletonComponent`, `TimelineComponent`, `ErrorBoundaryComponent`.
- GitHub Actions CI (`.github/workflows/ci.yml`) covering typecheck, tests,
  build, and Docker image.
- Multi-stage `docker/Dockerfile` for SSR + fallback `docker/nginx.conf` for
  static CSR.
- Arabic (`ar`) XLIFF translation scaffold at `src/locale/messages.ar.xlf`.
- `CONTRIBUTING.md`, `ARCHITECTURE.md`, `LICENSE`, `CHANGELOG.md`.
- Global responsive base styles (`src/styles.css`): fluid type scale, print
  styles, reduced-motion support, RTL tweaks, touch-friendly tap targets.

### Changed
- Node engine floor raised to `>= 20.19.0`.
- All services made SSR-safe (guarded `localStorage`, `matchMedia`, `document`).
- Registry parser now emits a richer `VersionCompatibility` (prerelease, types,
  license, unpacked size, full peer/dep maps, node engine).
- `CompatibilityService` uses `node-semver` for range resolution (replaces the
  hand-rolled parser).
- Theme service now supports `'system'` and reacts to OS preference changes.
- Upgrade assistant emits a bulk install command for the active package manager.

### Removed
- `@angular-devkit/build-angular` (replaced by `@angular/build`).
- Legacy NgModules-based bootstrap in `main.ts`.

## [2.0.0] — 2025-09-02

### Added
- Compare page.
- Search history + favorites persisted to `localStorage`.
- CSV / JSON export.
- Sparkline of weekly npm downloads.

## [1.0.0] — 2025-06-10

### Added
- Initial release: search any npm package, list every version, and infer
  Angular major support from `peerDependencies`.
