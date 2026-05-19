import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { catchError, of } from 'rxjs';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import * as semver from 'semver';
import { NpmRegistryService } from '../../services/npm-registry.service';
import { CompatibilityService } from '../../services/compatibility.service';
import { VersionsTableComponent } from '../../components/versions-table/versions-table.component';
import { AutocompleteInputComponent } from '../../components/autocomplete-input/autocomplete-input.component';
import { ProsConsPanelComponent } from '../../components/pros-cons-panel/pros-cons-panel.component';
import { UsageGuidePanelComponent } from '../../components/usage-guide-panel/usage-guide-panel.component';
import { CompetitorChipsComponent } from '../../components/competitor-chips/competitor-chips.component';
import { VersionMigrationPanelComponent } from '../../components/version-migration-panel/version-migration-panel.component';
import { CompareHistoryService } from '../../services/compare-history.service';
import { NpmRegistryResponse, VersionCompatibility } from '../../models/npm-package.model';

interface Side {
  name: string;
  pkg: NpmRegistryResponse | null;
  rows: VersionCompatibility[];
  error: string | null;
  loading: boolean;
}

@Component({
  selector: 'app-compare-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    VersionsTableComponent,
    AutocompleteInputComponent,
    ProsConsPanelComponent,
    UsageGuidePanelComponent,
    CompetitorChipsComponent,
    VersionMigrationPanelComponent,
    TranslocoModule
  ],
  template: `
    <section class="search-panel">
      <h1>{{ 'compare.title' | transloco }}</h1>
      <p class="lede">{{ 'compare.subtitle' | transloco }}</p>

      <!-- No submit button — the form auto-fetches reactively:
           the (picked) event fires when the user confirms a suggestion
           (click or Enter on a highlighted row) and triggers fetchBoth()
           once the other side is non-empty; the (submitted) event fires
           on Enter in the raw input even without a suggestion, covering
           the "I typed a name I already remember" case. The explicit
           Compare button was redundant noise that suggested an extra
           step that doesn't exist. role="search" stays on the form so
           assistive tech still announces the landmark correctly. -->
      <form class="search-form" (submit)="$event.preventDefault()" role="search">
        <div class="field">
          <span class="lbl">{{ 'compare.pkgAFallback' | transloco }}</span>
          <!-- excludeName intentionally NOT bound here.
               That was a legacy guardrail from before self-mode
               existed — back when "same package on both sides" was
               an error we wanted to prevent. Now that self-mode is
               a first-class feature, hiding a package from the
               B-side dropdown when A has it (or vice versa) is
               exactly wrong: it traps users in a dead-end where
               they can't switch self-mode targets without
               refreshing the page. The CTA strip below handles
               the discoverability path; manual typing handles the
               escape hatch. -->
          <app-autocomplete-input
            inputId="compare-pkg-a"
            [value]="nameA()"
            [placeholder]="'compare.pkgAPlaceholder' | transloco"
            [ariaLabel]="'compare.pkgAFallback' | transloco"
            (valueChange)="nameA.set($event)"
            (picked)="onPickedA($event)"
            (submitted)="fetchBoth()"
          />
          <!-- Chips UNDER A: when A is empty AND B has a value, the
               strip fetches competitors OF B and renders chips here.
               Clicking a chip populates A and kicks off the comparison.
               The component handles all visibility gating itself via
               its computed visible signal — it returns no DOM when
               either side of the gate is wrong, so passing the live
               signals here is safe even before A is empty. -->
          <app-competitor-chips
            [targetPackage]="nameB()"
            [siblingValue]="nameA()"
            (picked)="onPickedA($event)"
          />
        </div>
        <div class="field">
          <span class="lbl">{{ 'compare.pkgBFallback' | transloco }}</span>
          <!-- See comment on the A-side input. excludeName binding
               intentionally omitted so self-mode is reachable from
               every starting state. -->
          <app-autocomplete-input
            inputId="compare-pkg-b"
            [value]="nameB()"
            [placeholder]="'compare.pkgBPlaceholder' | transloco"
            [ariaLabel]="'compare.pkgBFallback' | transloco"
            (valueChange)="nameB.set($event)"
            (picked)="onPickedB($event)"
            (submitted)="fetchBoth()"
          />
          <!-- Symmetrical chips UNDER B: when B is empty AND A has a
               value, fetch competitors OF A. The two strips together
               give us the symmetrical UX the product brief called for:
               pick either side, see suggestions for the empty side. -->
          <app-competitor-chips
            [targetPackage]="nameA()"
            [siblingValue]="nameB()"
            (picked)="onPickedB($event)"
          />
        </div>
      </form>

      <!-- "Compare versions of {pkg}" CTAs. Renders one button per
           candidate name from selfModeCandidates(): zero in self-mode
           or empty state, one when exactly one side is loaded, TWO
           when both sides have different packages loaded. The
           two-button case is what kills the dead-end — without it,
           a user in (A=rxjs, B=ngx-toastr) state has no path to
           self-compare either package without manually clearing an
           input and fighting the autocomplete. -->
      @if (selfModeCandidates().length > 0) {
        <div class="self-cta-row" role="group" [attr.aria-label]="'versionMigration.cta' | transloco: { pkg: '' }">
          @for (name of selfModeCandidates(); track name) {
            <button type="button" class="self-link" (click)="enterSelfMode(name)">
              ↔ {{ 'versionMigration.cta' | transloco: { pkg: name } }}
            </button>
          }
        </div>
      }

      @if (sharedMajors().length && !selfMode()) {
        <p class="summary">
          <strong>{{ 'compare.bothSupport' | transloco }}</strong>
          @for (m of sharedMajors(); track m) {
            <span class="pill">Angular {{ m }}</span>
          }
        </p>
      } @else if (a().pkg && b().pkg && !selfMode()) {
        <p class="summary warn">
          {{ 'compare.noCommon' | transloco }}
        </p>
      } @else if (selfMode()) {
        <p class="summary self-summary">
          <strong>{{ 'versionMigration.modeBanner' | transloco: { pkg: a().pkg!.name } }}</strong>
        </p>
      }
    </section>

    <!-- ===== A vs B mode (different packages) ===== -->
    @if (!selfMode()) {
      <div class="grid">
        <section class="col">
          <h2>{{ a().name || ('compare.pkgAFallback' | transloco) }}</h2>
          @if (a().error) { <p class="error">{{ a().error }}</p> }
          @if (a().loading) { <p class="muted">{{ 'common.loading' | transloco }}</p> }
          @if (a().rows.length) {
            <app-versions-table [rows]="a().rows" [pkgName]="a().pkg?.name ?? null" />
          }
        </section>
        <section class="col">
          <h2>{{ b().name || ('compare.pkgBFallback' | transloco) }}</h2>
          @if (b().error) { <p class="error">{{ b().error }}</p> }
          @if (b().loading) { <p class="muted">{{ 'common.loading' | transloco }}</p> }
          @if (b().rows.length) {
            <app-versions-table [rows]="b().rows" [pkgName]="b().pkg?.name ?? null" />
          }
        </section>
      </div>

      <!-- AI-generated Pros & Cons. Lazy on viewport so the API call's
           provider chunks aren't pulled until the user scrolls within
           range; opt-in to actually firing the AI request via the panel's
           own button. Renders only once both packages have loaded. -->
      @if (a().pkg && b().pkg) {
        @defer (on viewport; prefetch on idle) {
          <app-pros-cons-panel
            [pkgA]="a().pkg!.name"
            [pkgB]="b().pkg!.name"
          />
        } @placeholder { <div class="defer-spacer" aria-hidden="true"></div> }

        <!-- AI-generated Usage Guide (Feature 2). Separate @defer block so
             this lazy chunk loads independently of Pros & Cons. -->
        @defer (on viewport; prefetch on idle) {
          <app-usage-guide-panel
            [pkgA]="a().pkg!.name"
            [pkgB]="b().pkg!.name"
          />
        } @placeholder { <div class="defer-spacer" aria-hidden="true"></div> }
      }
    }

    <!-- ===== Self-version migration mode (same package on both sides) ===== -->
    @if (selfMode()) {
      <section class="self-panel">
        <header class="self-head">
          <h2>{{ a().pkg!.name }}</h2>
          <p class="self-hint">{{ 'versionMigration.pickVersions' | transloco }}</p>
        </header>

        <div class="version-pickers">
          <label class="vp-field">
            <span>{{ 'versionMigration.fromLabel' | transloco }}</span>
            <select
              [ngModel]="versionFrom() ?? ''"
              (ngModelChange)="versionFrom.set($event)"
              [attr.aria-label]="'versionMigration.fromLabel' | transloco"
            >
              <option value="" disabled>—</option>
              @for (v of availableVersions(); track v) {
                <option [value]="v">{{ v }}</option>
              }
            </select>
          </label>
          <span class="vp-arrow" aria-hidden="true">→</span>
          <label class="vp-field">
            <span>{{ 'versionMigration.toLabel' | transloco }}</span>
            <select
              [ngModel]="versionTo() ?? ''"
              (ngModelChange)="versionTo.set($event)"
              [attr.aria-label]="'versionMigration.toLabel' | transloco"
            >
              <option value="" disabled>—</option>
              @for (v of availableVersions(); track v) {
                <option [value]="v">{{ v }}</option>
              }
            </select>
          </label>
          <button
            type="button"
            class="self-exit"
            (click)="exitSelfMode()"
            [attr.aria-label]="'versionMigration.exit' | transloco"
          >
            {{ 'versionMigration.exit' | transloco }}
          </button>
        </div>

        @if (sameVersionPicked()) {
          <p class="self-warn">{{ 'versionMigration.pickDifferent' | transloco }}</p>
        }
      </section>

      @if (!sameVersionPicked() && versionFrom() && versionTo()) {
        @defer (on viewport; prefetch on idle) {
          <app-version-migration-panel
            [pkg]="a().pkg!.name"
            [fromVersion]="versionFrom()"
            [toVersion]="versionTo()"
            [repoUrl]="a().pkg?.repository?.url ?? null"
          />
        } @placeholder { <div class="defer-spacer" aria-hidden="true"></div> }
      }
    }
  `,
  styles: [`
    :host { display: block; }

    /* Hero panel — mirrors the Search page so both first-impression
       surfaces share the same brand language. No overflow:hidden here
       on purpose: backgrounds clip to the rounded corners by default
       (background-clip: border-box), so the radial gradient stays inside
       naturally. Adding overflow:hidden would also clip the autocomplete
       dropdown when it extends past the panel bottom edge. */
    .search-panel {
      background:
        radial-gradient(120% 120% at 0% 0%, var(--accent-bg) 0%, transparent 55%),
        var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--radius-xl);
      padding: clamp(1.25rem, 2.5vw, 1.75rem);
      box-shadow: var(--shadow-2);
      position: relative;
    }
    .search-panel h1 {
      margin: 0 0 0.25rem;
      font-size: clamp(1.3rem, 2vw + 0.8rem, 1.8rem);
      color: var(--fg);
      letter-spacing: -0.01em;
    }
    .search-panel .lede {
      margin: 0 0 1rem;
      color: var(--fg-dim);
    }

    /* Two autocomplete fields side-by-side on desktop, stacked on narrow
       screens. Each field has its own uppercase mini-label so users can
       distinguish A vs B without reading the placeholder.

       align-items: start (not end) is load-bearing. With end-alignment
       the AI competitor chips under one input would push its column
       taller, then both inputs would re-bottom-align — but with
       different content above them, "bottom" lands at different Y
       positions and the two inputs visibly drift apart. start-alignment
       top-anchors both columns so the inputs always share a Y, and the
       chips just hang below whichever side has them. */
    .search-form {
      display: grid;
      gap: 0.75rem;
      grid-template-columns: 1fr 1fr;
      align-items: start;
    }
    .field { display: flex; flex-direction: column; gap: 0.3rem; min-width: 0; }
    .field .lbl {
      font-size: var(--step--1);
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--fg-dim);
    }
    @media (max-width: 720px) {
      .search-form { grid-template-columns: 1fr; }
    }

    /* "Compare versions of {pkg}" CTA strip — a row of link-styled
       inline buttons. Subtle by design: in the common case the user
       is comparing two different libraries, and these CTAs are an
       optional pivot, not a forced move. They wrap on narrow screens
       and center as a group so the eye doesn't have to hunt left/right
       when there are two of them. */
    .self-cta-row {
      margin: 0.85rem 0 0;
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 0.5rem;
    }
    .self-link {
      background: transparent;
      border: 1px dashed var(--border);
      color: var(--accent);
      font-size: 0.85rem;
      padding: 0.45rem 0.95rem;
      border-radius: 999px;
      cursor: pointer;
      transition: border-color 140ms ease, background 140ms ease;
    }
    .self-link:hover { border-color: var(--accent); background: var(--accent-bg); }
    .self-link:focus-visible {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-ring, color-mix(in srgb, var(--accent) 25%, transparent));
    }

    /* Primary CTA — same gradient + glow tokens as the Search page. */
    button.primary {
      padding: 0 1.25rem;
      border-radius: var(--radius-md);
      border: 1px solid transparent;
      background: var(--accent-gradient);
      color: #fff;
      font-weight: 600; font-size: 0.95rem;
      letter-spacing: 0.01em;
      cursor: pointer;
      box-shadow: var(--shadow-1);
      transition: transform 120ms var(--ease), box-shadow 200ms var(--ease), filter 160ms var(--ease);
      min-height: 48px; min-width: 140px;
    }
    button.primary:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: var(--shadow-glow);
      filter: brightness(1.04);
    }
    button.primary:active:not(:disabled) { transform: translateY(0); filter: brightness(0.98); }

    .summary {
      margin: 1rem 0 0;
      color: var(--fg);
      display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center;
    }
    .summary.warn { color: var(--bad, #fca5a5); }
    .self-summary {
      background: var(--accent-bg);
      padding: 0.6rem 0.9rem;
      border-radius: var(--radius-md);
      border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
    }
    .pill {
      display: inline-block;
      background: var(--accent-bg);
      color: var(--accent);
      border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
      padding: 2px 10px; border-radius: var(--radius-pill, 999px); font-size: 0.8rem;
      font-variant-numeric: var(--num);
    }

    .grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem;
      margin-top: 1.5rem;
    }
    .col { min-width: 0; }
    .col h2 {
      font-size: 1.1rem; color: var(--fg);
      letter-spacing: -0.01em; margin: 0 0 0.5rem;
    }
    .error { color: var(--bad, #fca5a5); }
    .muted { color: var(--fg-dim); font-style: italic; }
    @media (max-width: 820px) { .grid { grid-template-columns: 1fr; } }

    /* ----- Self-mode panel ----- */
    .self-panel {
      margin-top: 1.5rem;
      padding: 1.25rem 1.5rem;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--radius-xl, 14px);
    }
    .self-head { margin-bottom: 1rem; }
    .self-head h2 {
      margin: 0 0 0.25rem;
      font-size: 1.25rem;
      color: var(--fg);
    }
    .self-hint { margin: 0; color: var(--fg-dim); }
    .version-pickers {
      display: flex; align-items: end; gap: 0.85rem; flex-wrap: wrap;
    }
    .vp-field {
      display: flex; flex-direction: column; gap: 0.25rem;
      min-width: 160px;
    }
    .vp-field span {
      font-size: var(--step--1, 0.75rem);
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--fg-dim);
    }
    .vp-field select {
      padding: 0.5rem 0.65rem;
      background: var(--surface-1);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: var(--radius-md, 10px);
      font: inherit;
      cursor: pointer;
      min-height: 40px;
    }
    .vp-field select:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent);
    }
    .vp-arrow { color: var(--fg-dim); font-size: 1.2rem; padding-bottom: 0.5rem; }
    .self-exit {
      margin-left: auto;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg-dim);
      padding: 0.45rem 0.9rem;
      border-radius: var(--radius-md, 10px);
      cursor: pointer;
      min-height: 40px;
      align-self: end;
    }
    .self-exit:hover { color: var(--fg); border-color: var(--accent); }

    .self-warn {
      margin: 0.9rem 0 0;
      padding: 0.55rem 0.85rem;
      background: color-mix(in srgb, #eab308 10%, transparent);
      border: 1px solid color-mix(in srgb, #eab308 35%, transparent);
      border-radius: var(--radius-md);
      color: #fde68a;
      font-size: 0.88rem;
    }

    /* Reserves vertical space so the @defer placeholder doesn't cause
       a layout shift when the panel hydrates on viewport entry. */
    .defer-spacer {
      min-height: 12rem;
      margin-top: 1.5rem;
    }
  `]
})
export class ComparePageComponent {
  private readonly registry = inject(NpmRegistryService);
  private readonly compat = inject(CompatibilityService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly transloco = inject(TranslocoService);
  private readonly compareHistory = inject(CompareHistoryService);

  /**
   * Last pair key we've already recorded to history this page visit.
   * Without this guard, the effect that watches both packages re-fires
   * on every signal change (URL param sync, share-state load, etc.)
   * and we'd record the same pair multiple times. The service dedupes
   * by pairKey internally so duplicates would collapse, but skipping
   * the redundant IDB write saves a few ms per change.
   */
  private lastRecordedPairKey: string | null = null;

  readonly nameA = signal('');
  readonly nameB = signal('');
  readonly a = signal<Side>({ name: '', pkg: null, rows: [], error: null, loading: false });
  readonly b = signal<Side>({ name: '', pkg: null, rows: [], error: null, loading: false });

  /**
   * Version selections in self-mode. null until self-mode is entered
   * and the auto-population effect runs.
   */
  readonly versionFrom = signal<string | null>(null);
  readonly versionTo = signal<string | null>(null);

  readonly sharedMajors = computed<number[]>(() => {
    const ma = new Set(this.a().rows.flatMap((r) => r.supportedAngularMajors));
    const mb = new Set(this.b().rows.flatMap((r) => r.supportedAngularMajors));
    return [...ma].filter((m) => mb.has(m)).sort((x, y) => y - x);
  });

  /**
   * True when BOTH sides have resolved to the SAME package — the
   * trigger for Migration Mode. Comparison uses the resolved
   * `pkg.name` rather than the raw input so it isn't fooled by
   * casing or whitespace.
   */
  readonly selfMode = computed<boolean>(() => {
    const an = this.a().pkg?.name;
    const bn = this.b().pkg?.name;
    return !!an && !!bn && an === bn;
  });

  /**
   * Names the user can switch into self-mode for. Drives the
   * "Compare versions of {pkg}" CTAs below the form.
   *
   * Returns:
   *   - `[]` when there's nothing to switch into — already in
   *     self-mode, or both inputs are empty.
   *   - `[name]` when exactly one side has a package loaded (the
   *     simple case: click to copy that name to the empty side).
   *   - `[nameA, nameB]` when both sides have DIFFERENT packages
   *     loaded — this is the dead-end the legacy excludeName rule
   *     created. Surfacing two CTAs lets the user pivot to
   *     "compare versions of A" OR "compare versions of B"
   *     without having to clear an input first.
   *
   * The both-sides case is what makes self-mode reachable from
   * every state. Without it, a user who's loaded rxjs vs ngx-toastr
   * has no path to self-compare either of them — they'd have to
   * clear one input, AND the dropdown wouldn't show the matching
   * name because of the (now-removed) excludeName filter.
   */
  readonly selfModeCandidates = computed<string[]>(() => {
    // Already in self-mode? No CTA — the user is where they want
    // to be, and they have the "Switch back" exit button instead.
    if (this.selfMode()) return [];
    const an = this.a().pkg?.name;
    const bn = this.b().pkg?.name;
    if (!an && !bn) return [];
    if (an && !bn) return [an];
    if (bn && !an) return [bn];
    // Both loaded, different packages — offer both pivots.
    return an === bn ? [] : [an!, bn!];
  });

  /**
   * All stable (non-prerelease, non-deprecated) versions of the
   * resolved package, sorted DESCENDING — newest first. Drives both
   * version-picker dropdowns in self-mode.
   *
   * We deliberately exclude prereleases (alpha/beta/rc) because the
   * Migration Mode prompt assumes the user is upgrading between stable
   * production versions; prereleases would explode the version count
   * and aren't the use case here. Deprecated versions are excluded too
   * so users don't pick a known-bad fromVersion.
   */
  readonly availableVersions = computed<string[]>(() => {
    const pkg = this.a().pkg;
    if (!pkg) return [];
    const versions = Object.keys(pkg.versions ?? {})
      .filter((v) => semver.valid(v))
      .filter((v) => !semver.prerelease(v))
      .filter((v) => !pkg.versions[v]?.deprecated)
      .sort(semver.rcompare);
    return versions;
  });

  /**
   * Catches the "user picked the same version on both sides" footgun.
   * Drives the inline warning under the pickers + suppresses the
   * Migration Panel render so we don't burn an AI call on a trivial
   * v17.0.0 → v17.0.0 nothing-changed comparison.
   */
  readonly sameVersionPicked = computed<boolean>(() => {
    const f = this.versionFrom();
    const t = this.versionTo();
    return !!f && !!t && f === t;
  });

  constructor() {
    effect(() => {
      const a = this.a().pkg?.name;
      const b = this.b().pkg?.name;
      if (a || b) {
        this.router.navigate([], {
          queryParams: { a: a ?? null, b: b ?? null },
          queryParamsHandling: 'merge',
          replaceUrl: true
        });
      }
    });

    // Record to compare history once BOTH packages have resolved
    // successfully. We DO record self-mode pairs too (pkg vs same pkg
    // becomes a single-key entry after the pair-sort) so they still
    // show up in the user's history — just collapsed to one chip.
    effect(() => {
      const pkgA = this.a().pkg?.name;
      const pkgB = this.b().pkg?.name;
      const shared = this.sharedMajors();
      if (!pkgA || !pkgB) return;
      const key = `${pkgA.toLowerCase()}|${pkgB.toLowerCase()}`;
      const sortedKey = key.split('|').sort().join('|');
      if (sortedKey === this.lastRecordedPairKey) return;
      this.lastRecordedPairKey = sortedKey;
      void this.compareHistory.record(pkgA, pkgB, shared);
    });

    /**
     * Auto-populate version pickers when self-mode kicks in. Defaults:
     *   - toVersion   = latest stable (from `dist-tags.latest`)
     *   - fromVersion = the newest version in the previous major, or
     *                   the 2nd-newest stable if everything's on one major.
     *
     * The intuition: a user comparing "ngx-toastr v15 vs ngx-toastr v17"
     * almost always wants the most-impactful diff — across a major
     * boundary if one exists, otherwise the most recent step backward.
     */
    effect(() => {
      const self = this.selfMode();
      const versions = this.availableVersions();
      const pkg = this.a().pkg;
      if (!self || !versions.length || !pkg) {
        // Reset on exit so re-entry starts fresh with the next package.
        if (!self && (this.versionFrom() || this.versionTo())) {
          this.versionFrom.set(null);
          this.versionTo.set(null);
        }
        return;
      }
      // Only populate if the user hasn't already picked something.
      if (this.versionFrom() && this.versionTo()) return;
      const latest = pkg['dist-tags']?.['latest'] ?? versions[0];
      const latestMajor = semver.major(latest);
      const previousMajor = versions.find((v) => semver.major(v) < latestMajor) ?? versions[1] ?? latest;
      this.versionFrom.set(previousMajor);
      this.versionTo.set(latest);
    });

    this.route.queryParamMap.subscribe((p) => {
      const a = p.get('a');
      const b = p.get('b');
      if (a) this.nameA.set(a);
      if (b) this.nameB.set(b);
      if (a || b) this.fetchBoth();
    });
  }

  fetchBoth(): void {
    const a = this.nameA().trim();
    const b = this.nameB().trim();
    if (a) this.load('a', a);
    if (b) this.load('b', b);
  }

  /**
   * The user confirmed a suggestion in the A-side autocomplete. Update
   * the signal and — if the B-side already has a value — kick off the
   * comparison automatically. This is the "I just picked the second
   * package, just show me the result" affordance: removes a click from
   * the common case while still letting the explicit submit button work.
   */
  onPickedA(name: string): void {
    this.nameA.set(name);
    if (this.nameB().trim()) this.fetchBoth();
    else this.load('a', name);
  }

  onPickedB(name: string): void {
    this.nameB.set(name);
    if (this.nameA().trim()) this.fetchBoth();
    else this.load('b', name);
  }

  /**
   * Triggered by the "Compare versions of this package" CTA. Copies
   * the loaded package name to the empty side and fetches it, which
   * makes the selfMode computed flip to true and surfaces the
   * Migration panel + version pickers.
   */
  enterSelfMode(name: string): void {
    this.nameA.set(name);
    this.nameB.set(name);
    this.load('a', name);
    this.load('b', name);
  }

  /**
   * Drop back to the "compare two packages" view. Wipes B-side state
   * so the empty input field is showing — A keeps its data so the user
   * can keep exploring without losing context.
   */
  exitSelfMode(): void {
    this.nameB.set('');
    this.b.set({ name: '', pkg: null, rows: [], error: null, loading: false });
    this.versionFrom.set(null);
    this.versionTo.set(null);
  }

  private load(slot: 'a' | 'b', name: string): void {
    const setter = slot === 'a' ? this.a : this.b;
    setter.set({ name, pkg: null, rows: [], error: null, loading: true });
    this.registry
      .fetchPackage(name)
      .pipe(catchError((e) => of({ __error: e } as any)))
      .subscribe((res: any) => {
        if (res?.__error) {
          setter.set({
            name,
            pkg: null,
            rows: [],
            error: res.__error.status === 404
              ? this.transloco.translate('common.notFound')
              : this.transloco.translate('common.failedToFetch'),
            loading: false
          });
        } else {
          setter.set({
            name,
            pkg: res,
            rows: this.compat.buildVersionRows(res, 'peer-dep'),
            error: null,
            loading: false
          });
        }
      });
  }
}
