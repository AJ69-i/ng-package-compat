# Architecture

A quick map of how `ng-package-compat` is wired, intended for contributors who
want to extend it or debug a weird edge case.

## Runtime

```
┌──────────────────────────┐       ┌─────────────────────────────┐
│  Browser (client-side)   │       │   Node SSR (src/server.ts)  │
│  - Angular 21 hydrated   │       │   - Express + @angular/ssr  │
│  - service worker (prod) │       │   - Renders + streams HTML  │
└────────────┬─────────────┘       └────────────┬────────────────┘
             │                                   │
             └─────────── share code ────────────┘
                          (standalone
                          components +
                          signal state)
```

Angular's new zoneless change detection (`provideZonelessChangeDetection`) is
enabled, so signals drive every update. `provideClientHydration(withEventReplay())`
replays pre-hydration clicks once hydration finishes.

## Module boundary

There is no `NgModule`. Bootstrap flow:

- **Browser:** `main.ts` → `bootstrapApplication(AppComponent, appConfig)`
- **Server:** `main.server.ts` → `bootstrapApplication(AppComponent, mergeApplicationConfig(appConfig, serverConfig))`
- **Host:** `src/server.ts` hosts an Express app and delegates to
  `AngularNodeAppEngine` for SSR.

## State & services

All mutable state lives in `@Injectable({ providedIn: 'root' })` services backed
by signals:

| Service                      | Purpose |
| ---------------------------- | ------- |
| `NpmRegistryService`         | Fetches `registry.npmjs.org/<pkg>`, cached per session. |
| `NpmDownloadsService`        | Weekly download series from `api.npmjs.org`. |
| `AdvisoriesService`          | OSV.dev advisories for the npm ecosystem. |
| `BundlephobiaService`        | Bundle size estimates. |
| `CompatibilityService`       | Builds a `VersionCompatibility[]` from a registry response using `semver`. |
| `RecommendationService`      | Per target Angular major, picks a stable + latest candidate. |
| `VersionDiffService`         | Diffs two versions' deps and peerDeps. |
| `FiltersService`             | Signal-backed filter + sort state applied to any `rows` list. |
| `PackageManagerService`      | Current pm (`npm`/`yarn`/`pnpm`/`bun`) + install-command factory. |
| `StorageService`             | SSR-safe `localStorage` wrapper for history + favorites. |
| `ThemeService`               | `'light'` / `'dark'` / `'system'` with `matchMedia` reactivity. |
| `ExportService`              | CSV + JSON export helpers. |

Components consume these via `inject()` and re-render through `computed()`.

## Compatibility detection

Given a raw `NpmRegistryResponse`, `CompatibilityService.buildVersionRows(...)`:

1. Iterates every entry in `response.versions`.
2. Reads `peerDependencies["@angular/core"]` (or a fallback for the chosen
   strategy).
3. For each Angular major in `KNOWN_ANGULAR_MAJORS`, tests a set of candidate
   semvers (`M.0.0` .. `M.40.0` + an `M.999.999` sentinel) against the declared
   peer range via `semver.satisfies`.
4. Augments the row with `isLatest`, `isPrerelease`, `isDeprecated`, publish
   date, license, unpacked size, node engine, and the full peer/dep maps.
5. Sorts descending by semver.

If no Angular peer is declared, the row is marked `supportsAny: true` — the UI
calls that "no Angular peer declared (framework-agnostic)".

## Routing

`app.routes.ts` uses `loadComponent()` for every route so each page is a
separate lazy chunk. Route configs carry a `data.label` for breadcrumbs, and
query params (`?q=`, `?a=&b=`, `?from=&to=`) are the single source of truth for
deep-linking state.

## SSR safety

Any code that might run during SSR must guard browser APIs:

```ts
if (isPlatformBrowser(inject(PLATFORM_ID))) {
  localStorage.setItem(...);
}
```

The relevant services (`StorageService`, `ThemeService`) already do this. When
adding new services, follow the same pattern.

## Styling

- `src/styles.css` holds the global theme tokens (`--surface-1`, `--fg`,
  `--accent`, fluid type scale, …), the responsive base, print styles, RTL
  tweaks, and reduced-motion overrides.
- Component styles use those tokens and `color-mix(in srgb, …)` so both dark
  and light themes look right without maintaining two stylesheets.
- Tables use a card layout on `max-width: 720px` via `data-label` attributes.
- The navbar collapses to a hamburger at `max-width: 780px`.

## Tests

Unit tests live next to the code they cover (`*.spec.ts`). The Karma config
runs a headless Chrome, and CI uses `ChromeHeadlessCI` (headless + `--no-sandbox`)
to stay reliable inside Docker-backed runners.

## Build

- Dev: `ng serve` (Vite under the hood, courtesy of `@angular/build`).
- Prod: `ng build` — emits
  - `dist/ng-package-compat/browser/` (hashed static assets, service worker)
  - `dist/ng-package-compat/server/server.mjs` (Node SSR entry)
- `ngsw-config.json` controls service worker caching — bump `appData.version`
  when shipping a breaking asset change.
