# Contributing

Thanks for your interest in improving `ng-package-compat`.

## Development setup

```bash
npm install
npm start        # dev server at http://localhost:4200
npm test         # unit tests (Karma + Jasmine)
npm run build    # production build (browser + server)
```

Requirements: Node `>= 20.19.0`, npm 10+.

## Branching & commits

- Branch off `main`: `feat/short-name`, `fix/short-name`, or `docs/short-name`.
- Keep PRs small and scoped — one concern per PR.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
  messages: `feat(compat): support Angular 22`, `fix(upgrade): handle empty list`.

## Code style

- Standalone components everywhere — **no `NgModule`s**.
- `ChangeDetectionStrategy.OnPush` on every component.
- Signals (`signal`, `computed`, `input`, `output`) instead of `@Input` /
  `@Output` / `BehaviorSubject` where possible.
- New control flow (`@if`, `@for`, `@switch`, `@let`, `@defer`) instead of
  `*ngIf` / `*ngFor` / `ng-container *ngSwitch`.
- Services must be SSR-safe — guard `window`, `localStorage`, `document`, and
  `matchMedia` access with `isPlatformBrowser(inject(PLATFORM_ID))`.
- TypeScript: `strict` mode, no `any` in new code unless you explain why in a
  comment, prefer `readonly` on class fields.

## Testing

- Add a unit test alongside any non-trivial logic change
  (`*.spec.ts` next to the subject).
- Tests must pass under headless Chrome in CI:
  `npm test -- --watch=false --browsers=ChromeHeadlessCI`.
- For SSR-sensitive code, also assert it doesn't crash when `window` is
  `undefined` (see `storage.service.spec.ts`).

## Pull request checklist

- [ ] `npm test` passes.
- [ ] `npm run build` completes without errors.
- [ ] Added / updated docs where relevant.
- [ ] No lint warnings (`npx tsc --noEmit`).
- [ ] Screenshots for visible UI changes.
- [ ] Linked to the related issue in the description.

## Filing issues

When filing a bug, include:

- Package name that reproduces it (e.g. `ngx-toastr`).
- Angular major you targeted.
- What you expected vs. what you saw.
- Browser + OS (we target evergreen Chromium, Firefox, Safari).

Thanks!
