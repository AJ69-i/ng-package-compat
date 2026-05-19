# ng-package-compat

> "Does this npm package work with the Angular version I'm on — and how do I ship the upgrade?"

A production-ready Angular 21 toolchain that takes you from "drop a `package.json`" all the way to "open the PR." 100 features across the upgrade workflow, an opinionated tri-backend architecture, and a standalone CLI for CI gating.

**📘 The complete reference is at [`docs/REFERENCE.md`](./docs/REFERENCE.md).** This README is the elevator pitch.

---

## What it does

- **Search** any npm package and see its Angular compatibility matrix.
- **Drop** a `package.json` and get a full upgrade plan: breaking changes, peer conflicts, bundle delta, license risk, codemod previews, ng-update commands, rollback.
- **Walk through a guided wizard** that progressively discloses risk before continuing (policy blockers → bumps → PR).
- **Generate a PR-ready patch + Markdown body**, then open the PR — through the in-browser flow or via the server-side proxy that keeps PATs off the wire.
- **Sync** policies, snapshots, and favorites across devices.
- **Notify** Slack, Teams, email, or browser-push when monitored projects change.
- **Run from CI** via the standalone `ngpc` CLI with on-disk packument cache.

---

## Stack

| Layer        | Choice                                                                |
| ------------ | --------------------------------------------------------------------- |
| Framework    | **Angular 21** — standalone components, signals, OnPush, new control flow |
| Builder      | `@angular/build:application` (esbuild + Vite)                         |
| SSR          | `@angular/ssr` with a Node/Express adapter (also hosts the `/api/*` endpoints) |
| State        | Signal-backed services throughout                                     |
| i18n         | Transloco — `en`, `es`, `fr`, `ar` (RTL)                              |
| PWA          | `@angular/service-worker`, install prompt, push notifications         |
| Testing      | Karma + Jasmine; CLI smoke tests; Lighthouse CI                       |
| **Backends** | **Supabase** (relational core) + **Firebase** (identity hub + real-time) + **Appwrite** (preferences & logs vault) |
| CI           | GitHub Actions — lint, test, build, Lighthouse, Docker                |
| Deploy       | Docker (SSR via Node) or Nginx (static CSR-only variant)              |

---

## Quick start

```bash
# 1. Install
npm install

# 2. Server-side secrets
cp .env.example .env       # then fill APPWRITE_SERVER_KEY, GITHUB_PR_TOKEN, etc.

# 3. Apply Supabase migrations (paste each into the SQL editor as a separate query)
#    supabase/migrations/20260425_user_state_sync.sql
#    supabase/migrations/20260425b_orgs_and_teams.sql

# 4. Provision Appwrite collections (idempotent — safe to re-run)
npm run setup:appwrite

# 5. Dev
npm start                  # http://localhost:4200
```

**Requirements:** Node ≥ 20.19.0, npm 10.

---

## Common commands

```bash
npm start                  # dev server
npm run build              # production build (browser + SSR)
npm run serve:ssr          # serve hydrated SSR bundle on :4000
npm test                   # unit tests (Karma headless)
npm run test:cli           # CLI smoke tests (offline, deterministic, ~3s)
npm run ngpc -- --help     # CLI help
npm run setup:appwrite     # provision Appwrite collections
```

---

## CLI

```bash
# Analyze a package.json against an Angular target
npm run ngpc -- analyze --target 21 --format md --out report.md

# CI gate: fail if any conflicts
npm run ngpc -- analyze --fail-on conflict

# Quick single-package check
npm run ngpc -- check rxjs --target 21

# Cache management
npm run ngpc -- cache stats
npm run ngpc -- cache clear
```

The CLI keeps a slim packument cache at `~/.cache/ngpc/packuments/` with ETag revalidation and 8-way concurrency. First run on a 200-dep `package.json` warms the cache; subsequent runs within 24 h are sub-second.

---

## Three-backend architecture

| Backend                    | Role                | Stores                                                                           |
| -------------------------- | ------------------- | -------------------------------------------------------------------------------- |
| **Supabase** (Postgres)    | The Core Engine     | Policies, snapshots, favorites, teams, org policy templates                      |
| **Firebase** (Firestore)   | The Identity Hub    | Gmail-as-workspace identity, real-time notifications, presence                   |
| **Appwrite**               | The Secure Vault    | User preferences, append-only logs, JSON backups, profile assets                 |

A single `BackendRouterService` exposes unified `userId` / `displayName` / `avatarUrl` signals so the rest of the app doesn't have to care which backend the user signed in with.

Two parallel **identity-hub** flows are supported:
- **LinkedIn workspace** (Supabase) — sign in with LinkedIn, then link any combination of GitHub / GitLab / BitBucket / Azure.
- **Gmail workspace** (Firebase) — sign in with Gmail, then link GitHub / Microsoft Azure.

Plus four **direct provider** flows (Supabase OAuth) for users who want to skip the workspace step.

---

## Documentation

- **[`docs/REFERENCE.md`](./docs/REFERENCE.md)** — the complete technical reference (architecture, all 100 features, services, routes, server endpoints, CLI, env vars, troubleshooting).
- **[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)** — historical architecture notes.
- **[`docs/CLI-TROUBLESHOOTING.md`](./docs/CLI-TROUBLESHOOTING.md)** — CLI-specific issues.

---

## Docker

```bash
docker build -f docker/Dockerfile -t ng-package-compat .
docker run --rm -p 4000:4000 \
  -e GITHUB_PR_TOKEN=... \
  -e GITHUB_PR_OWNERS_ALLOW=my-org \
  -e EMAIL_PROVIDER=resend -e EMAIL_API_KEY=... \
  ng-package-compat
```

A static-only build is available — swap the final stage of the Dockerfile to `nginx:alpine` and copy `dist/ng-package-compat/browser/` into `/usr/share/nginx/html`. (You lose SSR + the `/api/*` endpoints in that variant.)

---

## License

[MIT](./LICENSE).
