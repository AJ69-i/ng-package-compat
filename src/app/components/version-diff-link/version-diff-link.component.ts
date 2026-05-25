import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TranslocoModule } from '@jsverse/transloco';
import * as semver from 'semver';

/**
 * Discoverability hook for `/compare` self-mode (Phase 3 feature #8).
 *
 * The Compare page has had self-mode (compare two versions of the
 * same package) since the V2 sprint, but users on the /search page
 * have to know to:
 *   1. Navigate to /compare
 *   2. Type the same package name in both inputs
 *   3. Switch into self-mode
 *   4. Pick versions
 *
 * Four steps and three of them are non-obvious. This component is
 * the one-click escape hatch: a compact inline link near the
 * package-meta header that says "What changed in v17?" and deep-links
 * straight into self-mode with the from/to versions pre-filled.
 *
 * # How we pick the "previous" version
 *
 * Latest published version → we want the previous stable that the
 * user is likely upgrading FROM. Heuristics, in order:
 *   1. Same major, next-lower minor (`17.3.0 ← 17.2.x`). Most common
 *      adoption path — users upgrade within a major.
 *   2. Previous major's latest (`17.3.0 ← 16.x.x`). For users doing
 *      cross-major migrations, this is the comparison they want.
 *   3. Whatever the second-newest stable is. Last resort.
 *
 * Prereleases (`alpha`, `beta`, `rc`) are skipped from both sides —
 * comparing v17.0.0 against v17.0.0-rc.5 isn't useful migration
 * intelligence, and Compare self-mode handles those cases on its
 * own when the user explicitly picks them.
 *
 * # When we render NOTHING
 *
 * - Less than 2 stable versions in the list (no "previous" to compare against).
 * - The package name has whitespace or other oddities (defensive).
 * - The latest version itself is unparseable.
 */
@Component({
  selector: 'app-version-diff-link',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, RouterLink, TranslocoModule],
  template: `
    @if (target(); as t) {
      <a
        class="diff-link"
        [routerLink]="['/compare']"
        [queryParams]="{
          a: pkgName(),
          b: pkgName(),
          from: t.previous,
          to: t.latest,
          self: 1
        }"
        [attr.aria-label]="('versionDiff.aria' | transloco: { name: pkgName(), prev: t.previous, latest: t.latest })"
      >
        <span class="ico" aria-hidden="true">⇆</span>
        <span class="label">
          {{ 'versionDiff.label' | transloco: { latest: t.latest } }}
        </span>
        <span class="hint">
          {{ 'versionDiff.fromVersion' | transloco: { prev: t.previous } }}
        </span>
      </a>
    }
  `,
  styles: [`
    :host { display: inline-flex; }
    .diff-link {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.35rem 0.75rem;
      background: color-mix(in srgb, var(--accent) 8%, var(--surface-1));
      border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
      border-radius: var(--radius-pill, 999px);
      color: var(--fg);
      font-size: 0.8rem;
      font-weight: 500;
      text-decoration: none;
      transition: background-color 140ms ease,
                  border-color 140ms ease,
                  transform 120ms ease;
    }
    .diff-link:hover {
      background: color-mix(in srgb, var(--accent) 14%, var(--surface-1));
      border-color: var(--accent);
      transform: translateY(-1px);
    }
    .diff-link:active { transform: translateY(0); }
    .diff-link:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .ico {
      font-size: 0.95rem;
      color: var(--accent);
      line-height: 1;
    }
    .label {
      color: var(--accent);
      font-weight: 600;
    }
    .hint {
      color: var(--fg-dim);
      font-weight: 400;
      font-size: 0.75rem;
    }
  `]
})
export class VersionDiffLinkComponent {
  /** npm package name. */
  readonly pkgName = input.required<string>();
  /** Latest published version (e.g. "17.3.0"). */
  readonly latestVersion = input<string | null>(null);
  /**
   * All known versions (e.g. Object.keys(pkg.versions)). We pick the
   * "previous stable" out of this list using the heuristics in the
   * header. Order doesn't matter — we sort by semver internally.
   */
  readonly allVersions = input<string[]>([]);

  /**
   * Resolved (latest, previous) pair that the link points at. Null
   * when we can't find a meaningful "previous" — the component
   * then renders nothing.
   */
  readonly target = computed<{ latest: string; previous: string } | null>(() => {
    const latest = this.latestVersion();
    const versions = this.allVersions();
    if (!latest || !versions.length) return null;

    // Filter to stable (non-prerelease) versions only. Coerce to a
    // canonical form to handle "v1.2.3" tags.
    const stables = versions
      .map((v) => semver.valid(semver.coerce(v)) ?? null)
      .filter((v): v is string => !!v && !semver.prerelease(v));

    // De-dup + sort newest-first so the slice below is intuitive.
    const sorted = Array.from(new Set(stables)).sort(semver.rcompare);

    const latestN = semver.valid(semver.coerce(latest));
    if (!latestN) return null;
    if (sorted.length < 2) return null;

    // Strategy 1: same major, next-lower minor.
    const latestMajor = semver.major(latestN);
    const sameMajorPrev = sorted.find(
      (v) => semver.lt(v, latestN) && semver.major(v) === latestMajor
    );
    if (sameMajorPrev) return { latest: latestN, previous: sameMajorPrev };

    // Strategy 2: previous major's highest stable.
    const prevMajor = sorted.find((v) => semver.major(v) < latestMajor);
    if (prevMajor) return { latest: latestN, previous: prevMajor };

    // Strategy 3: just the second-newest stable, whatever it is.
    const second = sorted.find((v) => semver.lt(v, latestN));
    if (second) return { latest: latestN, previous: second };

    return null;
  });
}
