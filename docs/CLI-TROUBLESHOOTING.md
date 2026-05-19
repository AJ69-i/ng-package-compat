# CLI troubleshooting

## `Could not find the '@angular/build:dev-server' builder's node package`

You're seeing this because **your installed `node_modules` don't match Angular 21**. The message is the CLI saying "the builder package isn't present on disk," which happens when:

1. **Node / npm are too old.** The logs show `npm 8.19.3` — that's the npm that ships with Node 16. Angular 21 requires **Node ≥ 20.19.0** (or ≥ 22.12.0) and **npm ≥ 10**.
2. **`node_modules` is stale** (leftovers from a previous install with a different Angular major).

### Fix it in four commands

```bash
# 1. Install a modern Node (via nvm, fnm, or volta). Example with nvm:
nvm install 22
nvm use 22
node -v     # should print v22.x
npm -v      # should print 10.x or newer

# 2. From the project root:
cd ng-package-compat
rm -rf node_modules package-lock.json

# 3. Fresh install with the modern toolchain:
npm install

# 4. Start the app:
npm start
# or: npm run dev:ssr   (to test the server-side rendering entry)
```

### Why this works

Angular 21 ships two new builder packages:

- `@angular/build:application` — the production builder
- `@angular/build:dev-server` — the dev server you hit with `ng serve`
- `@angular/build:karma` — the unit-test runner

These are declared as runtime deps in this project's `package.json`. With a modern npm on Node 22 they resolve correctly; with `npm 8` they don't install fully because peer-dep resolution changed between npm 8 → 9.

If you still see the error after the steps above, run `npm ls @angular/build` — you should see a single top-level `@angular/build@21.x`. If npm reports extraneous / missing, run `npm install --force` once to re-link.

### Prefer a different package manager?

```bash
# pnpm:
corepack enable
pnpm install
pnpm start

# yarn berry:
corepack enable
yarn
yarn start

# bun (experimental):
bun install
bun run start
```
