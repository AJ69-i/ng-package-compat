# ng-package-compat — Complete Reference

The single source of truth for everything in this codebase. Bookmark this.

> Last updated for the **100-feature + tri-backend** release. Angular 21, signals, standalone components, SSR, Supabase + Firebase + Appwrite.

---

## Table of contents

1. [What this is](#1-what-this-is)
2. [Quick start](#2-quick-start)
3. [Architecture](#3-architecture)
4. [Backend setup](#4-backend-setup)
5. [Environment variables](#5-environment-variables)
6. [Authentication flows](#6-authentication-flows)
7. [Routes](#7-routes)
8. [Services map](#8-services-map)
9. [Server endpoints](#9-server-endpoints)
10. [CLI](#10-cli)
11. [Internationalization](#11-internationalization)
12. [Testing](#12-testing)
13. [CI/CD](#13-cicd)
14. [Feature catalog](#14-feature-catalog) — all 100 features
15. [Project layout](#15-project-layout)
16. [Troubleshooting](#16-troubleshooting)

---

## 1. What this is

A production-ready Angular 21 toolchain that closes the loop from "what npm packages work with my Angular version?" to "open the PR." The headline workflows:

- **Search** any npm package and see its Angular compatibility matrix.
- **Drop** a `package.json` and get a full upgrade plan (breaking changes, peer conflicts, bundle delta, license risk, codemod previews, ng-update commands, rollback).
- **Walk through a guided wizard** that progressively discloses risk before letting you continue (policy blockers → bumps → PR).
- **Generate a PR-ready patch + Markdown body**, then open the PR on GitHub via the in-browser flow or — better — via the server-side proxy that keeps the user's PAT off the wire.
- **Sync** policies, snapshots, and favorites across devices via Supabase.
- **Notify** Slack, Teams, email, or browser-push when monitored projects change.
- **Run from CI** via the standalone Node CLI with on-disk packument cache.

---

## 2. Quick start

### Prerequisites

- Node **≥ 20.19.0** and npm 10
- A Supabase project (free tier is fine)
- A Firebase project with Google + GitHub + Microsoft auth enabled
- An Appwrite project (free tier is fine)

### Five-minute setup

```bash
# 1. Install
npm install

# 2. Set up env vars (server-side secrets only)
cp .env.example .env
# then fill in: APPWRITE_SERVER_KEY, GITHUB_PR_TOKEN, EMAIL_PROVIDER…

# 3. Apply Supabase migrations
#    Open the Supabase SQL editor and paste each file as a separate query:
#      supabase/migrations/20260425_user_state_sync.sql
#      supabase/migrations/20260425b_orgs_and_teams.sql

# 4. Provision Appwrite collections (idempotent, safe to re-run)
npm run setup:appwrite

# 5. Start the dev server
npm start          # http://localhost:4200
```

### Common commands

```bash
npm start                  # dev server
npm run build              # production build (browser + SSR)
npm run serve:ssr          # production SSR server on :4000
npm test                   # unit tests (Karma headless)
npm run test:cli           # CLI smoke tests (offline, deterministic)
npm run ngpc -- --help     # CLI help
npm run setup:appwrite     # provision Appwrite collections
```

---

## 3. Architecture

### The three-backend split

We use three storage backends, each playing to its strengths:

| Backend                    | Role                | Stores                                                                           |
| -------------------------- | ------------------- | -------------------------------------------------------------------------------- |
| **Supabase** (Postgres)    | The Core Engine     | Relational data — policies, snapshots, favorites, teams, org policy templates    |
| **Firebase** (Firestore)   | The Identity Hub    | Gmail-as-workspace identity, real-time notifications, presence                   |
| **Appwrite**               | The Secure Vault    | User preferences, append-only logs, JSON backups, profile assets                 |

**Why this split rather than one backend?**

- **Supabase** gives us Postgres + RLS + first-class OAuth for LinkedIn / GitHub / GitLab / BitBucket / Azure. RLS is exactly the right fit for "every user sees their own rows."
- **Firebase** gives us Google sign-in (Gmail) plus Firestore's real-time `onSnapshot` for live notifications and presence — a perfect match for the LinkedIn-style "identity hub" pattern but extended to Gmail.
- **Appwrite** is cheap, has very generous free-tier limits, and is the pragmatic place to store low-frequency settings and append-only logs without burning Firestore reads.

### Data ownership matrix

| Data                       | Backend            | Why                                                                |
| -------------------------- | ------------------ | ------------------------------------------------------------------ |
| Policies                   | Supabase           | Relational, RLS-gated, occasional bulk reads via JOINs             |
| Monitor snapshots          | Supabase           | Append-only, time-series, indexed by `(user_id, project_label)`    |
| Favorites                  | Supabase           | Tiny per-user list, RLS-gated                                      |
| Teams + members            | Supabase           | RBAC enforced via RLS predicates                                   |
| Org policy templates       | Supabase           | Multi-tenant with public/team scoping                              |
| Gmail identity             | Firebase Auth      | Native Google provider                                             |
| Linked GitHub / Microsoft  | Firebase Auth      | `linkWithPopup` API                                                |
| Live notifications         | Firestore          | `onSnapshot` real-time channel                                     |
| User presence              | Firestore          | Real-time, ephemeral writes                                        |
| User preferences           | Appwrite           | Slow-changing per-user settings (theme, scale, language…)          |
| Audit logs                 | Appwrite           | Append-only, cheap                                                 |
| JSON backups               | Appwrite           | Append-only blobs                                                  |
| LinkedIn / GitLab / BitBucket / Azure auth | Supabase | Already wired via Supabase OAuth                       |

The `BackendRouterService` exposes a single `userId` / `displayName` / `avatarUrl` / `identitySource` signal regardless of which backend the user signed in with.

### Frontend stack

- **Angular 21** — standalone components everywhere, `OnPush`, signals, new control flow (`@if`/`@for`/`@switch`).
- **`@angular/build:application`** — esbuild + Vite, prerendered routes for SEO.
- **`@angular/ssr`** with the Node/Express adapter — the SSR server is also where our API endpoints live.
- **Transloco** — i18n, four locales (en, es, fr, ar with RTL).
- **PWA** — `@angular/service-worker`, install prompt, push notifications.

### Server stack

The same `src/server.ts` Express app handles SSR *and* the proxy endpoints:

- `/api/pr` — server-side PR creation (PAT stays on the server).
- `/api/registry/packument/:name` — slim packument cache shared between CLI and browser.
- `/api/webhooks/npm-release` — release event ingest.
- `/api/notify/email` — email digest send via SendGrid / Resend / console.
- `/api/codemod/list` + `/api/codemod/run` — server-side codemod runner.

### CLI

`cli/ngpc.mjs` is a standalone Node CLI with an on-disk packument cache (slim format, ETag revalidation, 8-way concurrency). Used in CI to gate PRs on policy violations.

---

## 4. Backend setup

### 4.1 Supabase

You should already have:

- Project URL and anon key set in `src/environments/environment.ts`.
- LinkedIn / GitHub / GitLab / BitBucket / Azure OAuth providers configured under **Authentication → Sign-in method**.

Apply the two migrations:

1. Open the SQL editor.
2. Paste `supabase/migrations/20260425_user_state_sync.sql`. Click **Run**. Click **Run this query** on the destructive-operations warning (it's just `DROP POLICY IF EXISTS` / `DROP TRIGGER IF EXISTS`, both immediately recreated — no data is destroyed).
3. Open a new tab. Paste `supabase/migrations/20260425b_orgs_and_teams.sql`. Run.

Migrations create these tables:

| Table                     | Purpose                                                       |
| ------------------------- | ------------------------------------------------------------- |
| `user_policies`           | Per-user policy rule set (single JSONB row per user)          |
| `user_favorites`          | Per-user favorites list (single JSONB row per user)           |
| `user_snapshots`          | Append-only project health snapshots                          |
| `teams`                   | Team workspace records                                        |
| `team_members`            | Membership with `admin` / `member` roles                      |
| `org_policy_templates`    | Shared policy templates, scoped to a team or marked public    |

All RLS predicates default to "owner-only" except `org_policy_templates` where public templates are world-readable.

### 4.2 Firebase

In the Firebase console:

1. **Authentication → Sign-in method** — enable Google, GitHub, and Microsoft. Add `localhost`, `127.0.0.1`, and your production domain to **Authorized domains**.
2. **Firestore Database** — create a Cloud Firestore instance. Suggested rules:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{uid} {
         allow read, write: if request.auth != null && request.auth.uid == uid;
       }
       match /notifications/{doc} {
         allow read: if request.auth != null && resource.data.uid == request.auth.uid;
         allow write: if false; // server-only writes
       }
     }
   }
   ```

3. The Firebase config in `src/environments/environment.ts` is already filled in.

### 4.3 Appwrite

Run the bootstrap script — it idempotently creates the database, collections, attributes, and indexes:

```bash
export APPWRITE_SERVER_KEY=standard_...
npm run setup:appwrite
```

The script needs an API key with these nine scopes:

```
databases.read    tables.read    tables.write
columns.read      columns.write  indexes.read
indexes.write     rows.read      rows.write
```

It creates:

| Collection      | Stores                                                                    |
| --------------- | ------------------------------------------------------------------------- |
| `preferences`   | One row per user — theme, accent, font scale, motion, contrast, language |
| `logs`          | Append-only structured log entries                                        |
| `backups`       | Append-only JSON blobs (e.g. snapshots of local state)                    |

Indexes: `preferences.uid` (unique), `logs.uid`, `logs.(uid, createdAt DESC)`, `backups.uid`, `backups.(uid, createdAt DESC)`.

> **After setup, rotate the API key.** Generate a fresh one with the same scopes, keep it in `.env`, revoke the old one. Server keys never go in the browser bundle.

---

## 5. Environment variables

All in `.env` (gitignored). See `.env.example` for the full template.

| Variable                       | Used by                | Notes                                                              |
| ------------------------------ | ---------------------- | ------------------------------------------------------------------ |
| `APPWRITE_SERVER_KEY`          | bootstrap script       | The 9-scope Appwrite key                                           |
| `APPWRITE_ENDPOINT`            | bootstrap script       | Optional override; defaults to `fra.cloud.appwrite.io/v1`          |
| `APPWRITE_PROJECT_ID`          | bootstrap script       | Optional override                                                  |
| `APPWRITE_DATABASE_ID`         | bootstrap script       | Optional override; defaults to `ngpc`                              |
| `GITHUB_PR_TOKEN`              | `/api/pr`              | Server-held PAT or App installation token                          |
| `GITHUB_PR_OWNERS_ALLOW`       | `/api/pr`              | Comma-separated owner allow-list. Empty = proxy refuses everything |
| `GITHUB_API_BASE`              | `/api/pr`              | Optional GHES override                                             |
| `EMAIL_PROVIDER`               | `/api/notify/email`    | `sendgrid` / `resend` / `console` (default)                        |
| `EMAIL_FROM`                   | `/api/notify/email`    | Required for sendgrid/resend                                       |
| `EMAIL_API_KEY`                | `/api/notify/email`    | Required for sendgrid/resend                                       |
| `EMAIL_RECIPIENTS_ALLOW`       | `/api/notify/email`    | Optional comma-separated allow-list                                |
| `PORT`                         | SSR server             | Defaults to `4000`                                                 |

The Supabase / Firebase / Appwrite **publishable** ids and keys live in `src/environments/environment.ts` — those are safe in the browser bundle.

---

## 6. Authentication flows

The app supports **two parallel identity hubs** plus four **direct provider** flows.

### 6.1 Direct providers (Supabase OAuth)

GitHub, GitLab, BitBucket, or Microsoft Azure DevOps. One click → OAuth round-trip → land on `/projects` with the user's repos enumerated. The provider token is captured volatile in `ProviderTokenStore` (cleared on reload).

### 6.2 LinkedIn workspace (Supabase)

LinkedIn → land on `/workspace`. From there the user can link any combination of GitHub / GitLab / BitBucket / Azure to enrich their account, all tied to the original LinkedIn identity via Supabase identity-linking.

### 6.3 Gmail workspace (Firebase) — the new "identity hub"

Mirrors the LinkedIn flow on Firebase:

1. User clicks **Sign in with Gmail** → Google OAuth popup.
2. We call `firebase.signInWithPopup(googleProvider)` and land on `/workspace`.
3. From the workspace, the user can call `firebase.linkProvider('github')` or `linkProvider('microsoft')` to attach those providers via `linkWithPopup`. GitLab and BitBucket aren't native Firebase providers, so for those the user keeps using the Supabase flow in parallel.

The Firebase user's profile is mirrored to a Firestore `users/{uid}` doc on every sign-in so other services (notifications, presence) can attach data keyed by uid.

### 6.4 Token storage strategy

| Token type                 | Where it lives                                | Lifetime           |
| -------------------------- | --------------------------------------------- | ------------------ |
| Supabase session           | `supabase.client.auth` (managed by SDK)       | Persists across reloads |
| Firebase session           | `getAuth()` (managed by SDK)                  | Persists across reloads |
| Provider OAuth tokens      | `ProviderTokenStore` (in-memory + localStorage) | Volatile preferred; reload-survival via localStorage |
| GitHub PAT (server PR proxy) | `process.env.GITHUB_PR_TOKEN` on the server | Server-only        |

---

## 7. Routes

| Path                    | Component                          | Purpose                                                                |
| ----------------------- | ---------------------------------- | ---------------------------------------------------------------------- |
| `/`                     | `SearchPageComponent`              | npm package search                                                     |
| `/compare`              | `ComparePageComponent`             | Side-by-side compare                                                   |
| `/upgrade`              | `UpgradePageComponent`             | Dense upgrade dashboard                                                |
| `/upgrade/wizard`       | `UpgradeWizardComponent`           | Guided 4-step upgrade flow (feature #81)                               |
| `/dependencies/:pkg/:v` | `DependenciesPageComponent`        | Per-version dependency inspector                                       |
| `/diff/:pkg`            | `DiffPageComponent`                | Version-vs-version peer/dependency diff                                |
| `/snapshot-diff`        | `SnapshotDiffPageComponent`        | Time-travel snapshot diff (feature #94)                                |
| `/favorites`            | `FavoritesPageComponent`           | Starred packages dashboard with drag-to-reorder (#96)                  |
| `/history`              | `HistoryPageComponent`             | Search history + sparkline                                             |
| `/about`                | `AboutPageComponent`               | About / methodology                                                    |
| `/sign-in`              | `SignInPageComponent`              | Multi-provider sign-in + Gmail (Firebase)                              |
| `/auth/callback`        | `AuthCallbackPageComponent`        | OAuth round-trip handler                                               |
| `/projects`             | `ProjectsPageComponent`            | Repo list (direct providers)                                           |
| `/workspace`            | `WorkspacePageComponent`           | Identity hub (LinkedIn / Gmail)                                        |

---

## 8. Services map

Located under `src/app/services/`. Each is signal-backed (`OnPush`-friendly) and SSR-safe.

### Auth & identity

| Service                       | Responsibility                                                       |
| ----------------------------- | -------------------------------------------------------------------- |
| `SupabaseService`             | Supabase client wrapper, session signal, primary provider detection  |
| `AuthService`                 | Supabase OAuth sign-in / linking / unlinking                         |
| `FirebaseService`             | Firebase Auth + Firestore wrapper (Gmail / GitHub / Microsoft)       |
| `BackendRouterService`        | Identity-source-aware unified user signals                           |
| `ProviderTokenStore`          | In-memory + localStorage fallback for provider OAuth tokens          |
| `ProviderRepoService`         | Repo-list adapter per provider (GitHub / GitLab / BitBucket / Azure) |
| `ProjectHandoffService`       | Pass repo identifier from workspace into `/upgrade`                  |

### Domain logic

| Service                       | Responsibility                                                       |
| ----------------------------- | -------------------------------------------------------------------- |
| `NpmRegistryService`          | npm packument fetcher (browser-side)                                 |
| `CompatibilityService`        | Per-version compatibility analysis                                   |
| `CompatibilityReportService`  | Whole-project orchestration (drop a package.json → full report)      |
| `PackageJsonParserService`    | Parse `package.json` and source-list inputs                          |
| `PolicyService`               | Block/warn rules; `evaluateReport()` returns violations              |
| `MonitorService`              | Project snapshot capture + digests                                   |
| `BundleImpactService`         | Bundlephobia integration                                             |
| `LicenseRiskService`          | License-change risk classification                                   |
| `HealthScoreService`          | Aggregate project health (0–100)                                     |
| `BreakingChangeService`       | Curated breaking-change DB                                           |
| `CodemodRegistryService`      | Codemod previews (browser-side)                                      |
| `MfeAnalyzerService`          | Module-Federation host detection                                     |
| `ConfigAnalyzerService`       | angular.json / tsconfig / browserslist sanity checks                 |
| `LockfileAnalyzerService`     | npm/yarn/pnpm lockfile peer-conflict scan                            |
| `InstallVerifierService`      | "Will `npm install` succeed?" pre-flight check                       |
| `OrgScanService`              | npm org-wide health scan                                             |

### Persistence & sync

| Service                       | Responsibility                                                       |
| ----------------------------- | -------------------------------------------------------------------- |
| `StorageService`              | localStorage-backed search history & favorites legacy cache          |
| `FavoritesService`            | Starred packages with drag-to-reorder                                |
| `SupabaseSyncService`         | Two-way sync of policies / favorites / snapshots                     |
| `PolicyTemplatesService`      | Org-shared policy templates                                          |
| `TeamService`                 | Team membership + active-team selection                              |
| `AppwriteService`             | Preferences / logs / backups CRUD                                    |
| `RegistryConfigService`       | Private registry bindings (.npmrc-style)                             |
| `NotesService`                | Per-package user notes                                               |
| `AiCopilotService`            | Bring-your-own-key AI assistant                                      |

### UI & UX

| Service                       | Responsibility                                                       |
| ----------------------------- | -------------------------------------------------------------------- |
| `ThemeService`                | Light/dark/system theme                                              |
| `PreferencesService`          | Accent color, font scale, motion, contrast, color-blind palette      |
| `LocaleService`               | Active locale + RTL flip                                             |
| `ToastService`                | Toast notifications + swipe-to-dismiss                               |
| `ShortcutsService`            | Global keyboard shortcuts                                            |
| `OnboardingService`           | First-run tour state                                                 |
| `CommandPaletteService`       | ⌘+K palette state                                                    |
| `NotifierService`             | Slack / Teams / email / push dispatcher (#90–#93)                    |
| `SeoService`                  | Per-route title + meta tags                                          |

---

## 9. Server endpoints

All mounted in `src/server.ts`. Hit them on the SSR server (default `:4000`).

### `POST /api/pr`

Open a PR using the server's GitHub token instead of the user's PAT.

**Request:**
```json
{
  "fullName": "owner/repo",
  "baseBranch": "main",
  "headBranch": "chore/ng21-deps-2026-04-25",
  "title": "chore(angular): upgrade to Angular 21",
  "body": "## Summary…",
  "commitMessage": "chore(angular): upgrade to Angular 21",
  "packageJsonBase64": "<base64 of patched package.json>"
}
```

**Response:** `{ "url": "https://github.com/...", "number": 42 }`

**Validation:**
- `fullName` must match `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$`
- `owner` must be in `GITHUB_PR_OWNERS_ALLOW`
- `packageJsonBase64` must decode to valid JSON, ≤ 1 MB

### `GET /api/pr/health`

Returns `{ configured, ownersAllowed, apiBase }`. Used by the browser to detect whether to use the proxy or fall back to the direct flow.

### `GET /api/registry/packument/:name`

Slim packument with `Cache-Control: public, max-age=900`. Reuses the same on-disk cache the CLI populates so a single warm cache serves both surfaces.

### `POST /api/webhooks/npm-release`

```json
{ "name": "rxjs", "version": "8.0.0", "time": "2026-04-25T11:00:00Z" }
```

Returns `202`. Per-IP rate limit of 60/min.

### `GET /api/webhooks/npm-release/recent[?since=ISO]`

Returns the last 50 events (or events since `since`).

### `POST /api/notify/email`

```json
{
  "to": "user@example.com",
  "digest": { "label": "...", "changes": [...], ... }
}
```

Sends via `EMAIL_PROVIDER`. Console mode (default) just logs.

### `GET /api/codemod/list`

Lists registered codemods: `rxjs6-to-7`, `ngrx16-to-21`, `angular-standalone-imports`.

### `POST /api/codemod/run`

```json
{
  "codemodId": "rxjs6-to-7",
  "files": [{ "path": "src/app/foo.ts", "content": "..." }]
}
```

Returns patched files plus a unified diff. Files capped at 256 KB each.

---

## 10. CLI

```
ngpc <analyze|check|cache> [opts]
```

### `analyze`

```bash
npm run ngpc -- analyze --target 21 --format md --out report.md
npm run ngpc -- analyze --fail-on conflict       # CI gate
npm run ngpc -- analyze --concurrency 16 --cache-ttl 6
npm run ngpc -- analyze --no-network             # offline (cache only)
```

### `check`

```bash
npm run ngpc -- check rxjs --target 21
```

### `cache`

```bash
npm run ngpc -- cache stats     # disk usage, entry count
npm run ngpc -- cache clear     # wipe cache
npm run ngpc -- cache where     # print cache directory path
```

### Cache details

- **Location:** `$XDG_CACHE_HOME/ngpc/packuments/` (default `~/.cache/ngpc/packuments/`).
- **Format:** slim packument (`application/vnd.npm.install-v1+json`), ~10× smaller than full.
- **TTL:** 24h default, configurable via `--cache-ttl <hours>`.
- **Revalidation:** ETag-aware; expired entries get `If-None-Match`, 304 just bumps the timestamp.
- **Concurrency:** semaphore-capped (default 8 in-flight).
- **Stats reported per analyze run:** `cache: N hit / M revalidated / K miss / E err`.

### Exit codes

| Code | Meaning                                            |
| ---- | -------------------------------------------------- |
| 0    | Success                                            |
| 1    | Runtime / IO error                                 |
| 2    | `--fail-on` threshold hit (CI gate failed)         |
| 3    | Bad CLI arguments                                  |

---

## 11. Internationalization

Locales: **`en`** (default), **`es`**, **`fr`**, **`ar`** (RTL).

- Translation files: `src/assets/i18n/{en,es,fr,ar}.json`.
- Switching: `LocaleService.set(code)` (also flips `<html dir>` for RTL).
- Adding a locale: copy `en.json`, translate, register in `LocaleService.supported`, wire into Transloco config.

Total translation keys at present: ~430 across all four locales.

---

## 12. Testing

### Unit tests (Karma + Jasmine)

```bash
npm test           # interactive
npm run test:ci    # headless, with coverage
```

Spec files cover:
- `BundleDeltaSummaryComponent.aggregate` (8 tests)
- `PolicyService` (CRUD, evaluation, glob matching — 6 tests)
- `FavoritesService` (toggle, move, persistence — 5 tests)
- `NotifierService` (channel toggle, persistence — 4 tests)

### CLI smoke tests

```bash
npm run test:cli
```

Twenty deterministic, network-free tests covering CLI surface, analyze with seeded cache, fail-on gating, and the cache subcommand lifecycle. Each test runs in an isolated temp dir for `XDG_CACHE_HOME`.

### Lighthouse CI

Configured in `lighthouserc.json`:

- Performance ≥ 0.85 (warn)
- Accessibility ≥ 0.9 (**error** — blocks the merge)
- Best practices ≥ 0.9 (warn)
- SEO ≥ 0.9 (warn)

Runs on every PR via `.github/workflows/lighthouse.yml`.

---

## 13. CI/CD

### GitHub Actions

| Workflow                  | Trigger              | What it does                                      |
| ------------------------- | -------------------- | ------------------------------------------------- |
| `.github/workflows/ci.yml`        | push, PR     | install → lint → test → build → docker            |
| `.github/workflows/lighthouse.yml`| push, PR     | full Lighthouse run against the production build  |

### Docker

```bash
docker build -f docker/Dockerfile -t ng-package-compat .
docker run --rm -p 4000:4000 \
  -e GITHUB_PR_TOKEN=... \
  -e GITHUB_PR_OWNERS_ALLOW=my-org \
  -e EMAIL_PROVIDER=resend \
  -e EMAIL_API_KEY=... \
  ng-package-compat
```

A static-only build is also available — swap the final stage of the Dockerfile to `nginx:alpine` and copy `dist/ng-package-compat/browser` to `/usr/share/nginx/html`. (You lose SSR + the `/api/*` endpoints in that variant.)

---

## 14. Feature catalog

All 100 features. Group headings reflect when each batch was built.

### Foundation (#1–#10)
1. Upgrade to Angular 21 + fix build errors
2. Rewrite services and models using signals + new APIs
3. Recommendation engine + version diff + filters
4. New UI components and pages
5. Responsive design for all devices
6. CI, Docker, SSR, i18n, docs
7. Compatibility report + SEO + CLI scaffolding
8. Enterprise feature set: knowledge base, health score, exports, analyzers
9. MFE analyzer + community gotchas service
10. Multi-file ingestion (drop zone)

### Reporting & UI (#11–#20)
11. CompatibilityReportService orchestration
12. UpgradePage UI surfacing 20 features
13. Transloco i18n
14. Translations for 4 locales
15. Language switcher
16. Global animations + route transitions
17. Authoring of Features document (Word)
18. Build verification after animations + i18n
19. SCSS wiring
20. Translate upgrade page results section

### Discovery & sharing (#21–#30)
21. PackageRelocationService + search banner
22. ProsConsService for alternatives
23. DeadButWorkingService (abandoned-but-usable detection)
24. ReleaseDateService + timeline UI
25. Rebuild + verify SSR + browser bundles
26. Comprehensive sales Word doc
27. Enterprise RxJS autocomplete search
28. Sticky summary bar with filter pills
29. Sales doc with 2 new features
30. GitHub URL package.json import

### Sharing, scanning, history (#31–#40)
31. Share-via-URL state encoder
32. Jira-compatible bulk CSV export
33. npm organization-wide health scan
34. IndexedDB history + snapshot diff
35. BYO-key AI migration assistant
36. One-click PDF report export
37. PWA + offline mode + install prompt
38. Sales doc to 34 features
39. Toast notification system
40. Keyboard shortcuts cheat sheet

### Polish & UX (#41–#50)
41. First-run onboarding tour
42. Reusable EmptyStateComponent
43. Session auto-save service
44. Virtual scrolling on upgrade table
45. Per-package notes & flags
46. CopyOnClick directive
47. PreferencesService + theme customizer
48. Command palette with fuzzy search
49. Health-score celebration
50. Diff sparkline visualization

### Enterprise depth (#51–#60)
51. Skeleton loading across pages
52. Favorites dashboard page
53. URL query-param state sync
54. Mobile gesture support
55. Print-friendly global CSS
56. Screen-reader announcer
57. Sales doc to 52 features
58. data-tour attributes for onboarding
59. appCopyOnClick wiring
60. appVirtualList on upgrade results

### Mobile + monorepo (#61–#70)
61. Swipe-to-dismiss on toasts
62. Pull-to-refresh on scroll container
63. Notes popover on package rows
64. Diff sparkline on history page
65. Health-celebration on upgrade page
66. Favorites star button on search results
67. Verify production build still passes
68. Source-aware breaking-change detection
69. Codemod registry + preview
70. Workspace / monorepo analysis

### Verification & policy (#71–#80)
71. Install verification (resolver)
72. Private registry support
73. **Policy / rule engine**
74. **Continuous monitoring + digest**
75. **Automated PR generation**
76. **First-class CLI**
77. **Bundle-size delta viewer**
78. Wire all of the above into the upgrade page
79. **Multi-provider SSO + workspace architecture**
80. **CLI cache + concurrency layer**

### Platform completion (#81–#100)
81. **Guided upgrade wizard (4-step)**
82. **Supabase user-state sync**
83. **Server-side PR proxy**
84. **CLI test fixtures + smoke tests**
85. **Server-side packument cache endpoint**
86. **Webhook ingest for new releases**
87. **Snapshot sync to Supabase**
88. **Org-level policy templates**
89. **Team workspace with RBAC**
90. **Slack webhook for monitor digest**
91. **Microsoft Teams webhook**
92. **Email digest**
93. **Browser push for critical advisories**
94. **Snapshot-vs-snapshot time-travel diff**
95. **Search-as-you-type filter on upgrade table**
96. **Drag-to-reorder favorites**
97. **Unit test suite for core services**
98. **Accessibility audit pass**
99. **Lighthouse CI configuration**
100. **Server-side codemod runner**

---

## 15. Project layout

```
ng-package-compat/
├─ cli/                                  # Standalone Node CLI
│  ├─ ngpc.mjs                           # Entry point (analyze, check, cache)
│  ├─ cache.mjs                          # PackumentCache
│  ├─ test.mjs                           # CLI smoke tests
│  └─ __fixtures__/                      # Sample package.json files + cache seeder
├─ docs/                                 # ← this file lives here
│  ├─ REFERENCE.md
│  ├─ ARCHITECTURE.md
│  └─ CLI-TROUBLESHOOTING.md
├─ scripts/
│  └─ bootstrap-appwrite.mjs             # One-shot Appwrite provisioning
├─ supabase/
│  └─ migrations/
│     ├─ 20260425_user_state_sync.sql    # policies / favorites / snapshots tables
│     └─ 20260425b_orgs_and_teams.sql    # teams / templates tables
├─ src/
│  ├─ app/
│  │  ├─ components/                     # Presentational UI
│  │  ├─ models/                         # Typed contracts
│  │  ├─ pages/                          # Route components
│  │  ├─ services/                       # Signal-backed state + IO
│  │  ├─ app.component.ts
│  │  ├─ app.config.ts                   # Browser providers
│  │  ├─ app.config.server.ts            # Merged SSR providers
│  │  └─ app.routes.ts
│  ├─ assets/i18n/                       # en/es/fr/ar JSON
│  ├─ environments/                      # publishable config per env
│  ├─ server/                            # SSR server endpoint modules
│  │  ├─ pr-proxy.ts                     # /api/pr
│  │  ├─ registry-cache.ts               # /api/registry/packument/:name
│  │  ├─ release-webhook.ts              # /api/webhooks/npm-release
│  │  ├─ email-notify.ts                 # /api/notify/email
│  │  └─ codemod-runner.ts               # /api/codemod/run
│  ├─ main.ts                            # Browser bootstrap
│  ├─ main.server.ts                     # SSR bootstrap
│  ├─ server.ts                          # Express host
│  └─ styles.scss                        # Global tokens, RTL, print
├─ .env.example                          # Server-side secrets template
├─ angular.json
├─ docker/                               # Dockerfile + nginx.conf
├─ lighthouserc.json                     # Lighthouse CI thresholds
├─ package.json
└─ README.md
```

---

## 16. Troubleshooting

### "Application bundle generation complete" with semver / @grpc CommonJS warnings

**Expected.** `semver` (used by `compatibility.service.ts`) and `@grpc/grpc-js` (transitive from Firestore) ship CommonJS modules in addition to ESM. Angular's bundler nags about it but the optimization difference is negligible. Ignore it.

### Sign-in succeeds but "Cannot read properties of null (reading 'replaceAll')"

You haven't applied the Supabase migrations yet. Apply both files in `supabase/migrations/` and reload.

### `setup:appwrite` fails with `EAI_AGAIN` / network error

Your machine can't reach `fra.cloud.appwrite.io`. Check DNS / firewall / VPN. The script needs outbound HTTPS to Appwrite.

### `npm run ngpc -- analyze` runs but every entry is `unknown`

You're offline (no `--no-network` flag) and either (a) the registry is unreachable or (b) `EAI_AGAIN`. Run `npm run ngpc -- cache stats` to see whether you have any cached entries; if zero, the previous runs all failed network-side. Try `--no-network --quiet` after one successful online run to verify the cache works.

### "Potential issue detected" warning when running migrations

It's the destructive-operations heuristic firing on `DROP POLICY IF EXISTS`. Click **Run this query** — those drops are paired with immediate `CREATE POLICY` on the next line. Tables and data are preserved.

### Browser console: "Firebase: Error (auth/unauthorized-domain)"

Add `localhost` (and your prod domain) under Firebase Console → Authentication → Settings → Authorized domains.

### Bundle warning: `anyComponentStyle exceeded`

The component-style budget is set to 20 kB warning / 32 kB error in `angular.json`. If a single component crosses 20 kB of CSS, factor styles into shared SCSS or use CSS variables instead of inlining. The `upgrade-page.component.ts` styles are intentionally chunky because of all the embedded sub-section UI.

### CLI `--fail-on conflict` always exits 0 in CI

You probably need `--target X` set explicitly — the CLI defaults to the major detected from `package.json`, which on a project that's already on the target version produces zero conflicts.

---

## Where to go next

- **Adding a new feature**: pick a name + ID, add a service or component under the right folder, register the route if it has one, add transloco keys to all four locales, add a unit test, run `npm run build && npm run test:cli` to verify nothing regressed.
- **Changing the data model**: update the relevant migration file in `supabase/migrations/`, write a *new* migration file if the change isn't pure schema-add, never edit an applied migration in place.
- **Adding a notifier channel**: add the URL/recipient field to `NotifierService.NotifierConfig`, add a `postX` method, dispatch from `dispatch()`. Browser-side webhooks work directly; server-side dependencies (e.g. Discord with a different format) get a new `/api/notify/...` endpoint.
- **Rotating credentials**: Supabase anon key → `src/environments/environment.ts`. Firebase config → same. Appwrite project id → same. Server keys (`APPWRITE_SERVER_KEY`, `GITHUB_PR_TOKEN`, `EMAIL_API_KEY`) → `.env`. Always rotate after sharing in a chat or PR.
