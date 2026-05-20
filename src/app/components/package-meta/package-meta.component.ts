import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslocoModule } from '@jsverse/transloco';
import { SparklineComponent } from '../sparkline/sparkline.component';
import { StorageService } from '../../services/storage.service';
import { LicenseService } from '../../services/license.service';
import { Advisory, NpmRegistryResponse } from '../../models/npm-package.model';
import { MaintainerVitality } from '../../services/maintainer-vitality.service';
import { StripHtmlPipe } from '../../pipes/strip-html.pipe';
import { ProvenanceSignal, InstallScriptSignal, EngineSignal, FundingSignal, DeprecatedSignal } from '../../services/package-trust.service';
import { ScorecardResult } from '../../services/scorecard.service';
import { AngularReadiness } from '../../services/angular-readiness.service';

@Component({
  selector: 'app-package-meta',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TranslocoModule, SparklineComponent, StripHtmlPipe],
  template: `
    @let p = pkg();
    @if (p) {
      <!-- Deprecated-latest banner. Rendered at the very top of the
           result panel because it's the single most important thing
           the user needs to know — the package they're evaluating
           has been officially deprecated by its own maintainer. Uses
           the same --bad treatment as advisories. The role="alert"
           ensures screen-reader users get the announcement
           immediately when the result loads. -->
      @if (deprecated()?.isDeprecated) {
        <aside class="deprecated-banner" role="alert">
          <span class="dep-icon" aria-hidden="true">⛔</span>
          <div class="dep-body">
            <strong>{{ 'packageMeta.deprecated.heading' | transloco }}</strong>
            @if (deprecated()?.message; as msg) {
              <p class="dep-message">{{ msg }}</p>
            } @else {
              <p class="dep-message">{{ 'packageMeta.deprecated.bodyGeneric' | transloco }}</p>
            }
          </div>
        </aside>
      }

      <section class="package-header">
        <div class="header-top">
          <div>
            <h2>
              {{ p.name }}
              <button
                type="button"
                class="fav"
                [class.active]="isFavorite()"
                (click)="toggleFav()"
                [attr.aria-pressed]="isFavorite()"
                [attr.aria-label]="isFavorite() ? 'Remove from favorites' : 'Add to favorites'"
              >{{ isFavorite() ? '★' : '☆' }}</button>
            </h2>
            <!-- Some npm packages (ngx-toastr et al.) stuff raw README
                 banner HTML into the description field. The stripHtml
                 pipe strips tags + decodes common entities; the gates
                 below suppress the row entirely when the strip leaves
                 nothing useful: (1) under 3 chars of prose, or (2)
                 just the package name itself — which is what
                 ngx-toastr strips down to after the banner HTML is
                 removed, and would render redundantly under the H2. -->
            @let desc = p.description | stripHtml;
            @if (desc.length >= 3 && desc.toLowerCase() !== p.name.toLowerCase()) {
              <p class="description">{{ desc }}</p>
            }
          </div>

          @if ((downloads() ?? []).length) {
            <div class="downloads">
              <div class="dl-total">
                {{ totalWeekly() | number }}
                <span>downloads / week</span>
              </div>
              <app-sparkline [data]="downloadsSeries()" />
            </div>
          }
        </div>

        <div class="meta">
          @if (latest()) { <span class="chip chip-latest">latest: {{ latest() }}</span> }

          @let lic = license();
          @if (lic.raw) {
            <span
              class="chip chip-license"
              [class.chip-license-safe]="lic.tier === 'safe'"
              [class.chip-license-weak]="lic.tier === 'weak'"
              [class.chip-license-strong]="lic.tier === 'strong'"
              [class.chip-license-proprietary]="lic.tier === 'proprietary'"
              [class.chip-license-unknown]="lic.tier === 'unknown'"
            >
              <span class="lic-dot" aria-hidden="true"></span>
              <span class="lic-name">{{ lic.raw }}</span>
              <span class="lic-tier">{{ lic.labelKey | transloco }}</span>
            </span>
          }

          @if (lastPublish()) { <span class="chip">Updated {{ lastPublish() }}</span> }
          @if (authorName()) { <span class="chip">by {{ authorName() }}</span> }
          @if (maintainerCount()) {
            <span class="chip">{{ maintainerCount() }} maintainer{{ maintainerCount() === 1 ? '' : 's' }}</span>
          }

          @let vit = vitality();
          @if (vit && vit.tier !== 'unknown') {
            <span
              class="chip chip-vitality"
              [class.chip-vitality-active]="vit.tier === 'active'"
              [class.chip-vitality-maintained]="vit.tier === 'maintained'"
              [class.chip-vitality-slow]="vit.tier === 'slow'"
              [class.chip-vitality-inactive]="vit.tier === 'inactive'"
              [class.chip-vitality-archived]="vit.tier === 'archived'"
            >
              <span class="vit-dot" aria-hidden="true"></span>
              {{ vit.labelKey | transloco }}
            </span>
          }

          <!-- Stars + Open Issues — already fetched in the vitality
               response (GitHub /repos endpoint returns both for free),
               just not surfaced until now. Compact chips with a leading
               glyph keep them scannable next to the vitality chip. -->
          @if (vit && vit.stars !== null && vit.stars > 0) {
            <span class="chip chip-stars">
              <span aria-hidden="true">★</span>
              {{ formatCount(vit.stars) }}
            </span>
          }
          @if (vit && vit.openIssuesCount !== null && vit.openIssuesCount > 0) {
            <span class="chip chip-issues">
              <span aria-hidden="true">●</span>
              {{ formatCount(vit.openIssuesCount) }} {{ 'packageMeta.openIssues.short' | transloco }}
            </span>
          }

          <!-- Provenance verified — only renders when the latest
               version carries Sigstore attestation. Sky-blue accent
               distinguishes it from the green "safe" semantics
               (provenance proves *who* published, not whether the
               package is safe — those are independent properties). -->
          @if (provenance()?.verified) {
            @let prov = provenance()!;
            @if (prov.url) {
              <a
                class="chip chip-provenance link"
                [href]="prov.url"
                target="_blank"
                rel="noopener"
                [attr.aria-label]="'packageMeta.provenance.verifiedLong' | transloco"
              >
                <span class="prov-shield" aria-hidden="true">🛡</span>
                {{ 'packageMeta.provenance.verified' | transloco }}
              </a>
            } @else {
              <span
                class="chip chip-provenance"
                [attr.aria-label]="'packageMeta.provenance.verifiedLong' | transloco"
              >
                <span class="prov-shield" aria-hidden="true">🛡</span>
                {{ 'packageMeta.provenance.verified' | transloco }}
              </span>
            }
          }

          <!-- OpenSSF Scorecard — opens the public report in a new tab
               when the chip is clicked, so users can drill into the
               per-check breakdown without us re-implementing the viewer. -->
          @if (scorecard(); as sc) {
            <a
              class="chip chip-scorecard link"
              [class.scorecard-high]="sc.band === 'high'"
              [class.scorecard-medium]="sc.band === 'medium'"
              [class.scorecard-low]="sc.band === 'low'"
              [href]="sc.reportUrl"
              target="_blank"
              rel="noopener"
              [attr.aria-label]="'packageMeta.scorecard.ariaLabel' | transloco: { score: sc.score }"
            >
              <span aria-hidden="true">🏅</span>
              {{ 'packageMeta.scorecard.label' | transloco }}
              <span class="sc-score">{{ sc.score }}/10</span>
            </a>
          }

          <!-- Engine ranges from package.json — TS via peerDeps,
               Node via engines. Compact chips with a leading glyph
               so they read as version requirements at a glance. -->
          @let eng = engines();
          @if (eng && eng.typescript) {
            <span class="chip chip-engine">
              <span class="eng-label" aria-hidden="true">TS</span>
              {{ eng.typescript }}
            </span>
          }
          @if (eng && eng.node) {
            <span class="chip chip-engine">
              <span class="eng-label" aria-hidden="true">Node</span>
              {{ eng.node }}
            </span>
          }

          <!-- Sponsor / funding chip — when present, opens the
               maintainer's funding page in a new tab. The heart
               glyph is the universal sponsorship cue (GitHub Sponsors,
               OpenCollective, Buy Me a Coffee all use the same icon). -->
          @if (funding(); as fund) {
            @if (fund.present && fund.primaryUrl) {
              <a
                class="chip chip-funding link"
                [href]="fund.primaryUrl"
                target="_blank"
                rel="noopener"
                [attr.aria-label]="'packageMeta.funding.ariaLabel' | transloco"
              >
                <span aria-hidden="true">💖</span>
                {{ 'packageMeta.funding.sponsor' | transloco }}
              </a>
            }
          }

          @if (p.homepage) { <a [href]="p.homepage" target="_blank" rel="noopener" class="chip link">Homepage</a> }
          @if (p.repository?.url) { <a [href]="p.repository?.url" target="_blank" rel="noopener" class="chip link">Repository</a> }
        </div>

        <!-- Modern-Angular readiness strip — four chips inferred
             heuristically from the README and package.json. Each
             chip renders only when the corresponding signal fires
             true; libraries that don't trip any of the four
             heuristics show no strip at all rather than a row of
             "✗" chips, which would read as ACCUSATIONS rather than
             positive signals. -->
        @let ready = readiness();
        @if (ready && (ready.standalone || ready.zoneless || ready.ssrSafe || ready.signals)) {
          <div class="readiness-strip" role="list" [attr.aria-label]="'packageMeta.readiness.ariaLabel' | transloco">
            <span class="readiness-label">{{ 'packageMeta.readiness.heading' | transloco }}:</span>
            @if (ready.standalone) {
              <span class="readiness-chip" role="listitem">
                <span aria-hidden="true">✓</span>
                {{ 'packageMeta.readiness.standalone' | transloco }}
              </span>
            }
            @if (ready.zoneless) {
              <span class="readiness-chip" role="listitem">
                <span aria-hidden="true">✓</span>
                {{ 'packageMeta.readiness.zoneless' | transloco }}
              </span>
            }
            @if (ready.ssrSafe) {
              <span class="readiness-chip" role="listitem">
                <span aria-hidden="true">✓</span>
                {{ 'packageMeta.readiness.ssr' | transloco }}
              </span>
            }
            @if (ready.signals) {
              <span class="readiness-chip" role="listitem">
                <span aria-hidden="true">✓</span>
                {{ 'packageMeta.readiness.signals' | transloco }}
              </span>
            }
          </div>
        }

        <!-- Signal notes — always-visible inline explanations under
             the meta chips. NOT tooltips, NOT click-to-toggle: every
             tier (Safe / Weak / Strong / Proprietary / Unknown for
             license; Active / Maintained / Slow / Inactive / Archived
             for vitality) gets a permanent contextual row so users
             see the full picture without any interaction. Styled with
             theme-aware tokens (--ok / --warn / --bad / --fg / --fg-dim
             / --surface-1) so the colors stay correct when the
             ThemeService toggles between dark and light. The only
             skip is vitality 'unknown' — there's literally no
             description text to show in that case, so rendering an
             empty row would be visual noise without any signal. -->
        @if (lic.raw || (vit && vit.tier !== 'unknown')) {
          <ul class="signal-notes" role="list">
            @if (lic.raw) {
              <li
                class="signal-note"
                [class.note-license-safe]="lic.tier === 'safe'"
                [class.note-license-weak]="lic.tier === 'weak'"
                [class.note-license-strong]="lic.tier === 'strong'"
                [class.note-license-proprietary]="lic.tier === 'proprietary'"
                [class.note-license-unknown]="lic.tier === 'unknown'"
              >
                <span class="note-dot" aria-hidden="true"></span>
                <span class="note-label">{{ 'packageMeta.license.rowLabel' | transloco }}:</span>
                <span class="note-body">{{ lic.descKey | transloco }}</span>
              </li>
            }
            @if (vit && vit.tier !== 'unknown') {
              <li
                class="signal-note"
                [class.note-vit-active]="vit.tier === 'active'"
                [class.note-vit-maintained]="vit.tier === 'maintained'"
                [class.note-vit-slow]="vit.tier === 'slow'"
                [class.note-vit-inactive]="vit.tier === 'inactive'"
                [class.note-vit-archived]="vit.tier === 'archived'"
              >
                <span class="note-dot" aria-hidden="true"></span>
                <span class="note-label">{{ 'packageMeta.vitality.rowLabel' | transloco }}:</span>
                <span class="note-body">{{ vit.descKey | transloco }}</span>
                @if (vitalityMeasurement()) {
                  <span class="note-measure"> · {{ vitalityMeasurement() }}</span>
                }
              </li>
            }
          </ul>
        }

        <!-- Install-script warning. Surfaces when the latest version
             declares a preinstall / install / postinstall hook — the
             well-known supply-chain primitive behind event-stream,
             ua-parser-js, and the more recent crypto-wallet drainers.
             We don't accuse the package of being malicious (plenty of
             legitimate libraries use install hooks for native-binding
             builds), we just inform the user the hook exists so they
             can review it before running npm install. Visual weight
             is somewhere between advisories (confirmed danger, red)
             and the typosquat banner (possible danger, amber) — also
             amber, since "may run code on install" is a *risk*, not
             a confirmed vulnerability. -->
        @if (installScripts()?.present) {
          @let scr = installScripts()!;
          <div class="install-scripts" role="status">
            <div class="is-title">
              <span aria-hidden="true">⚙</span>
              {{ 'packageMeta.installScripts.heading' | transloco }}
            </div>
            <p class="is-body">
              {{ 'packageMeta.installScripts.body' | transloco: { hooks: scr.hooks.join(', ') } }}
            </p>
          </div>
        }

        @if ((advisories() ?? []).length) {
          <div class="advisories" role="alert">
            <div class="adv-title">⚠ {{ advisories()!.length }} known advisor{{ advisories()!.length === 1 ? 'y' : 'ies' }}</div>
            <ul>
              @for (a of advisories(); track a.id) {
                <li>
                  <strong>{{ a.id }}</strong>
                  @if (a.severity) { <span class="sev">{{ a.severity }}</span> }
                  — {{ a.summary }}
                  <span class="muted">affects {{ a.affectedRanges }}</span>
                  @if (a.references[0]) { <a [href]="a.references[0]" target="_blank" rel="noopener">details</a> }
                </li>
              }
            </ul>
          </div>
        }
      </section>
    }
  `,
  styles: [`
    .package-header {
      margin-top: 1.5rem; padding: 1.25rem 1.5rem;
      background: var(--surface-2); border: 1px solid var(--border); border-radius: 14px;
    }
    .header-top {
      display: grid; grid-template-columns: 1fr auto; gap: 1.5rem; align-items: flex-start;
    }
    h2 {
      font-size: clamp(1.1rem, 2vw + 0.6rem, 1.4rem);
      color: var(--fg); display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
    }
    .fav {
      background: transparent; border: none; color: #fbbf24;
      font-size: 1.15rem; cursor: pointer; padding: 0; min-width: 32px; min-height: 32px;
    }
    .fav:not(.active) { color: var(--fg-dim); }
    .description { margin-top: 0.25rem; color: var(--fg-dim); }
    .meta { margin-top: 0.75rem; display: flex; flex-wrap: wrap; gap: 0.5rem; }


    /* ----- Always-visible signal notes (no tooltips, no toggles) -----
       One permanent row per signal — license tier + vitality tier —
       so the user always sees the full context without hovering or
       clicking. The tier color shows up in TWO places only: the dot
       and a left border accent. ALL TEXT uses --fg / --fg-dim so
       readability stays correct in both [data-theme='dark'] and
       [data-theme='light'] (the project's theme tokens flip those
       foreground values automatically). The background also uses
       --surface-1 with a tiny tier-tint via color-mix so the row
       reads as a soft surface in dark mode and a faintly tinted
       white in light mode — no hardcoded hex text colors anywhere. */
    .signal-notes {
      list-style: none;
      margin: 0.7rem 0 0;
      padding: 0;
      display: grid;
      gap: 0.4rem;
    }
    .signal-note {
      position: relative;
      display: flex;
      align-items: flex-start;
      flex-wrap: wrap;
      gap: 0.45rem;
      padding: 0.5rem 0.75rem 0.5rem 0.9rem;
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-left: 3px solid var(--border);
      border-radius: var(--radius-md, 10px);
      color: var(--fg);
      font-size: 0.85rem;
      line-height: 1.5;
    }
    .signal-note .note-dot {
      display: inline-block;
      width: 8px; height: 8px;
      border-radius: 50%;
      margin-top: 0.45rem;
      flex: 0 0 auto;
      /* Defaults to neutral; each tier variant overrides this. */
      background: var(--fg-dim);
    }
    .signal-note .note-label {
      font-weight: 600;
      letter-spacing: 0.02em;
      color: var(--fg);
      /* Slightly larger label so the row scans as "Label: explanation". */
      font-size: 0.85rem;
    }
    .signal-note .note-body { color: var(--fg-dim); }
    .signal-note .note-measure { color: var(--fg-dim); opacity: 0.85; }

    /* ----- License tier variants -----
       Each variant only changes the bullet color, the left-border
       accent color, and a subtle background tint. Text stays
       theme-token-driven so contrast is correct in both themes. */
    .note-license-safe {
      border-left-color: var(--ok);
      background: color-mix(in srgb, var(--ok) 6%, var(--surface-1));
    }
    .note-license-safe .note-dot { background: var(--ok); }

    .note-license-weak {
      border-left-color: var(--warn);
      background: color-mix(in srgb, var(--warn) 6%, var(--surface-1));
    }
    .note-license-weak .note-dot { background: var(--warn); }

    .note-license-strong {
      border-left-color: var(--bad);
      background: color-mix(in srgb, var(--bad) 7%, var(--surface-1));
    }
    .note-license-strong .note-dot { background: var(--bad); }

    /* Proprietary uses a stable purple — no semantic token in styles.scss
       for "non-OSS commercial", but color-mix with --surface-1 keeps
       the tinted background sensible across both themes. */
    .note-license-proprietary {
      border-left-color: #a855f7;
      background: color-mix(in srgb, #a855f7 7%, var(--surface-1));
    }
    .note-license-proprietary .note-dot { background: #a855f7; }

    .note-license-unknown {
      border-left-color: var(--fg-dim);
      background: var(--surface-1);
    }
    .note-license-unknown .note-dot { background: var(--fg-dim); }

    /* ----- Vitality tier variants -----
       Same approach as license — the only color in the row that
       changes per tier is the left edge and the dot. Active uses
       --ok, slow uses --warn, inactive uses --bad, archived uses
       --fg-dim (a calm muted treatment that says "off"). Maintained
       gets --accent which adapts (indigo-light on dark, indigo on
       light) — it's a positive but more measured signal than active. */
    .note-vit-active {
      border-left-color: var(--ok);
      background: color-mix(in srgb, var(--ok) 6%, var(--surface-1));
    }
    .note-vit-active .note-dot { background: var(--ok); }

    .note-vit-maintained {
      border-left-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 8%, var(--surface-1));
    }
    .note-vit-maintained .note-dot { background: var(--accent); }

    .note-vit-slow {
      border-left-color: var(--warn);
      background: color-mix(in srgb, var(--warn) 6%, var(--surface-1));
    }
    .note-vit-slow .note-dot { background: var(--warn); }

    .note-vit-inactive {
      border-left-color: var(--bad);
      background: color-mix(in srgb, var(--bad) 7%, var(--surface-1));
    }
    .note-vit-inactive .note-dot { background: var(--bad); }

    .note-vit-archived {
      border-left-color: var(--fg-dim);
      background: color-mix(in srgb, var(--fg-dim) 6%, var(--surface-1));
    }
    .note-vit-archived .note-dot { background: var(--fg-dim); }
    .chip {
      background: var(--surface-1); border: 1px solid var(--border);
      padding: 4px 10px; border-radius: 999px; font-size: 0.8rem; color: var(--fg-dim);
      display: inline-flex; align-items: center; gap: 0.4rem;
    }
    .chip.link { text-decoration: none; color: var(--accent); }
    /* Theme-aware tier chips. The background+border use color-mix with
       transparent (tints the underlying surface, so they work on both
       dark and light theme backgrounds). The TEXT color is the
       semantic token (--ok / --warn / --bad / --accent) which keeps
       readable contrast on either theme — the old hardcoded light
       hex values (#86efac etc.) were invisible on white. */
    .chip-latest {
      background: color-mix(in srgb, var(--ok) 12%, transparent);
      border-color: color-mix(in srgb, var(--ok) 40%, transparent);
      color: var(--ok);
    }

    /* ----- License tier chips -----
       Two-tone chip: dot + license name + smaller tier label so the
       SPDX id stays scannable while the tier is the loud signal. */
    .chip-license { padding: 4px 10px; }
    .chip-license .lic-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: currentColor; opacity: 0.85;
    }
    .chip-license .lic-name { font-weight: 500; }
    .chip-license .lic-tier {
      font-size: 0.7rem; padding: 1px 6px; border-radius: 999px;
      background: color-mix(in srgb, currentColor 18%, transparent);
      letter-spacing: 0.02em;
    }
    .chip-license-safe {
      background: color-mix(in srgb, var(--ok) 10%, transparent);
      border-color: color-mix(in srgb, var(--ok) 35%, transparent);
      color: var(--ok);
    }
    .chip-license-weak {
      background: color-mix(in srgb, var(--warn) 10%, transparent);
      border-color: color-mix(in srgb, var(--warn) 35%, transparent);
      color: var(--warn);
    }
    .chip-license-strong {
      background: color-mix(in srgb, var(--bad) 10%, transparent);
      border-color: color-mix(in srgb, var(--bad) 40%, transparent);
      color: var(--bad);
    }
    .chip-license-proprietary {
      /* Proprietary uses a stable mid-tone purple — works on both
         themes without needing a semantic token. */
      background: color-mix(in srgb, #a855f7 10%, transparent);
      border-color: color-mix(in srgb, #a855f7 40%, transparent);
      color: #a855f7;
    }
    .chip-license-unknown { /* falls through to default chip styling */ }

    /* ----- Vitality pills -----
       Pulsing dot is reserved for the active tier so the eye finds
       it first; the other tiers use a static dot to avoid creating
       motion everywhere. Respect prefers-reduced-motion globally. */
    .chip-vitality { padding: 4px 10px; }
    .chip-vitality .vit-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: currentColor; opacity: 0.85;
    }
    .chip-vitality-active {
      background: color-mix(in srgb, var(--ok) 12%, transparent);
      border-color: color-mix(in srgb, var(--ok) 40%, transparent);
      color: var(--ok);
    }
    .chip-vitality-active .vit-dot {
      animation: vit-pulse 1.8s ease-in-out infinite;
    }
    .chip-vitality-maintained {
      /* Sky-blue maps to --accent in this project — which flips
         indigo-light on dark, indigo on light. Both readable. */
      background: color-mix(in srgb, var(--accent) 10%, transparent);
      border-color: color-mix(in srgb, var(--accent) 35%, transparent);
      color: var(--accent);
    }
    .chip-vitality-slow {
      background: color-mix(in srgb, var(--warn) 10%, transparent);
      border-color: color-mix(in srgb, var(--warn) 35%, transparent);
      color: var(--warn);
    }
    .chip-vitality-inactive {
      background: color-mix(in srgb, var(--bad) 10%, transparent);
      border-color: color-mix(in srgb, var(--bad) 40%, transparent);
      color: var(--bad);
    }
    .chip-vitality-archived {
      background: color-mix(in srgb, var(--fg-dim) 18%, transparent);
      border-color: color-mix(in srgb, var(--fg-dim) 45%, transparent);
      color: var(--fg-dim);
      text-decoration: line-through;
    }
    @keyframes vit-pulse {
      0%, 100% { transform: scale(1); opacity: 0.85; }
      50%      { transform: scale(1.25); opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      .chip-vitality-active .vit-dot { animation: none; }
    }

    /* ----- Stars + Open Issues chips -----
       Neutral-toned compact chips. Star glyph uses the existing
       favorites yellow (#fbbf24) for instant recognition; open-issue
       dot uses --warn at moderate intensity because an unread issue
       count is informational, not alarming. */
    .chip-stars { color: #fbbf24; }
    .chip-stars span[aria-hidden] { font-size: 0.9rem; line-height: 1; }
    .chip-issues span[aria-hidden] { color: var(--warn); }

    /* ----- Provenance chip -----
       Sky-blue sits between green (safe) and indigo (accent) — the
       chip color shouldn't conflate provenance ("we know who shipped
       this") with safety ("the package itself is benign"). Those are
       independent guarantees. */
    .chip-provenance {
      background: color-mix(in srgb, #38bdf8 10%, transparent);
      border-color: color-mix(in srgb, #38bdf8 45%, var(--border));
      color: var(--fg);
      font-weight: 500;
    }
    .chip-provenance .prov-shield { font-size: 0.9rem; }
    a.chip-provenance { text-decoration: none; }
    a.chip-provenance:hover {
      filter: brightness(1.1);
      border-color: color-mix(in srgb, #38bdf8 60%, var(--border));
    }

    /* ----- Scorecard chip -----
       Band-driven coloring: high = green (--ok), medium = amber
       (--warn), low = red (--bad). The score itself is shown in a
       monospace-numeric pill so 7.8/10 and 10.0/10 line up. */
    .chip-scorecard {
      color: var(--fg);
      text-decoration: none;
      font-weight: 500;
    }
    .chip-scorecard .sc-score {
      font-variant-numeric: tabular-nums;
      font-size: 0.72rem;
      padding: 1px 6px;
      border-radius: 999px;
      background: color-mix(in srgb, currentColor 18%, transparent);
    }
    .scorecard-high {
      background: color-mix(in srgb, var(--ok) 10%, transparent);
      border-color: color-mix(in srgb, var(--ok) 45%, var(--border));
      color: var(--ok);
    }
    .scorecard-medium {
      background: color-mix(in srgb, var(--warn) 10%, transparent);
      border-color: color-mix(in srgb, var(--warn) 45%, var(--border));
      color: var(--warn);
    }
    .scorecard-low {
      background: color-mix(in srgb, var(--bad) 10%, transparent);
      border-color: color-mix(in srgb, var(--bad) 45%, var(--border));
      color: var(--bad);
    }
    a.chip-scorecard:hover { filter: brightness(1.08); }

    /* ----- Deprecated banner -----
       Top-of-panel red banner for the case the user MOST needs to
       know about: this package is officially deprecated. --bad
       semantic token + thick left border + explicit icon. The
       message is the maintainer's own deprecation notice, which
       often points to a replacement. */
    .deprecated-banner {
      display: flex;
      align-items: flex-start;
      gap: 0.85rem;
      padding: 0.85rem 1rem;
      margin-bottom: 1rem;
      background: color-mix(in srgb, var(--bad) 10%, var(--surface-1));
      border: 1px solid color-mix(in srgb, var(--bad) 45%, var(--border));
      border-left: 4px solid var(--bad);
      border-radius: var(--radius-md, 10px);
      color: var(--fg);
    }
    .dep-icon { font-size: 1.3rem; color: var(--bad); flex: 0 0 auto; line-height: 1.1; }
    .dep-body { flex: 1 1 auto; min-width: 0; }
    .dep-body strong { color: var(--bad); display: block; margin-bottom: 0.25rem; font-size: 0.95rem; }
    .dep-message { margin: 0; color: var(--fg); font-size: 0.9rem; line-height: 1.5; }

    /* ----- Engine + funding + readiness chips ----- */
    .chip-engine {
      color: var(--fg-dim);
      font-variant-numeric: tabular-nums;
    }
    .chip-engine .eng-label {
      font-size: 0.65rem;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      padding: 1px 5px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--fg-dim) 18%, transparent);
      color: var(--fg);
    }

    .chip-funding {
      color: var(--accent);
      font-weight: 500;
      text-decoration: none;
      background: color-mix(in srgb, var(--accent) 8%, transparent);
      border-color: color-mix(in srgb, var(--accent) 30%, var(--border));
    }
    .chip-funding:hover {
      filter: brightness(1.05);
      border-color: color-mix(in srgb, var(--accent) 50%, var(--border));
    }

    /* ----- Modern-Angular readiness strip -----
       Renders as a labeled row of green check chips. Lives below
       the chip strip in its own row so the readiness story doesn't
       get lost in the longer meta chip strip — it's a compact
       summary of "is this library keeping up with modern Angular?"
       worth its own visual real estate. */
    .readiness-strip {
      margin-top: 0.7rem;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.4rem;
    }
    .readiness-label {
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--fg-dim);
      margin-right: 0.2rem;
    }
    .readiness-chip {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      padding: 3px 9px;
      border-radius: 999px;
      font-size: 0.78rem;
      font-weight: 500;
      background: color-mix(in srgb, var(--ok) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--ok) 35%, var(--border));
      color: var(--ok);
    }

    /* ----- Install-scripts warning -----
       Amber styling matches the typosquat banner — both are "risk,
       not confirmed danger." Visually distinct from .advisories
       (which uses --bad red) so users can tell at a glance whether
       they're looking at a confirmed CVE or a "review this before
       you install" notice. */
    .install-scripts {
      margin-top: 0.9rem;
      padding: 0.75rem 1rem;
      background: color-mix(in srgb, var(--warn) 8%, var(--surface-1));
      border: 1px solid color-mix(in srgb, var(--warn) 35%, var(--border));
      border-left: 3px solid var(--warn);
      border-radius: var(--radius-md, 10px);
      color: var(--fg);
    }
    .is-title {
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      color: var(--fg);
    }
    .is-body {
      margin: 0.25rem 0 0;
      color: var(--fg-dim);
      font-size: 0.88rem;
      line-height: 1.5;
    }

    .downloads { text-align: right; min-width: 160px; }
    .dl-total { font-size: 1.2rem; font-weight: 600; color: var(--fg); }
    .dl-total span { display: block; font-size: 0.75rem; color: var(--fg-dim); font-weight: 400; }
    /* Advisories block — all reds now go through --bad so the block
       inverts correctly on light theme. Body text uses --fg for the
       primary content with --bad-tinted accents on titles, severity
       pills, and links. */
    .advisories {
      margin-top: 0.9rem; padding: 0.75rem 1rem;
      background: color-mix(in srgb, var(--bad) 8%, var(--surface-1));
      border: 1px solid color-mix(in srgb, var(--bad) 35%, var(--border));
      border-left: 3px solid var(--bad);
      border-radius: 10px; color: var(--fg);
    }
    .adv-title { font-weight: 600; color: var(--bad); }
    .advisories ul { list-style: none; padding: 0; margin: 0.4rem 0 0; font-size: 0.85rem; }
    .advisories li { padding: 0.3rem 0; border-top: 1px solid color-mix(in srgb, var(--bad) 15%, var(--border)); color: var(--fg-dim); }
    .advisories li:first-child { border-top: none; }
    .advisories li strong { color: var(--fg); }
    .advisories .sev {
      margin-left: 0.25rem; font-size: 0.7rem; padding: 1px 6px;
      border-radius: 4px; background: color-mix(in srgb, var(--bad) 25%, transparent);
      color: var(--bad);
    }
    .advisories .muted { color: var(--fg-dim); margin-left: 0.35rem; }
    .advisories a { color: var(--bad); margin-left: 0.35rem; }

    @media (max-width: 640px) {
      .package-header { padding: 1rem; }
      .header-top { grid-template-columns: 1fr; }
      .downloads { text-align: left; }
    }
  `]
})
export class PackageMetaComponent {
  private readonly storage = inject(StorageService);
  private readonly licenseSvc = inject(LicenseService);

  readonly pkg = input<NpmRegistryResponse | null>(null);
  readonly latest = input<string | null>(null);
  readonly downloads = input<Array<{ week: string; downloads: number }> | null>(null);
  readonly advisories = input<Advisory[] | null>(null);
  readonly lastPublish = input<string | null>(null);
  readonly authorName = input<string | null>(null);
  readonly maintainerCount = input<number>(0);
  /** Optional vitality summary fetched async by the host page. Null while loading; absent for non-GitHub repos. */
  readonly vitality = input<MaintainerVitality | null>(null);
  /** Provenance signal — computed synchronously from the packument by PackageTrustService. */
  readonly provenance = input<ProvenanceSignal | null>(null);
  /** Install-script signal — computed synchronously from the packument. */
  readonly installScripts = input<InstallScriptSignal | null>(null);
  /** OpenSSF Scorecard result — fetched async by the host page, null until resolved. */
  readonly scorecard = input<ScorecardResult | null>(null);
  /** Engine ranges (TS via peerDeps, Node via engines). Computed synchronously. */
  readonly engines = input<EngineSignal | null>(null);
  /** Funding declarations from package.json (normalized). Computed synchronously. */
  readonly funding = input<FundingSignal | null>(null);
  /** Deprecation status of the latest version. Computed synchronously. */
  readonly deprecated = input<DeprecatedSignal | null>(null);
  /** Heuristic Modern-Angular readiness flags. Computed synchronously. */
  readonly readiness = input<AngularReadiness | null>(null);

  /**
   * Format star/issue counts the way GitHub does — 12.5k instead of
   * 12543, 1.2M instead of 1234567. Compact representation keeps the
   * chip width predictable across packages with wildly different
   * popularity scales.
   */
  formatCount(n: number): string {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return (Math.round(n / 100) / 10).toFixed(1).replace(/\.0$/, '') + 'k';
    return (Math.round(n / 100_000) / 10).toFixed(1).replace(/\.0$/, '') + 'M';
  }

  readonly isFavorite = computed(() => {
    const p = this.pkg();
    // Access favorites() signal so this recomputes on toggle
    this.storage.favorites();
    return p ? this.storage.isFavorite(p.name) : false;
  });

  readonly downloadsSeries = computed(() =>
    (this.downloads() ?? []).map((d) => d.downloads)
  );

  readonly totalWeekly = computed(() => {
    const series = this.downloads() ?? [];
    if (!series.length) return 0;
    return series[series.length - 1].downloads;
  });

  /** SPDX classification of the package's license field. */
  readonly license = computed(() => this.licenseSvc.classify(this.pkg()?.license));

  /**
   * Human-readable measurement of the last push to the default branch,
   * shown inline in the vitality note. Snapped to a friendly unit:
   * days for fresh activity, months mid-range, years for stale repos.
   * Empty string when we don't have a measurement (archived repos, or
   * before the vitality fetch lands).
   */
  readonly vitalityMeasurement = computed<string>(() => {
    const v = this.vitality();
    if (!v) return '';
    const days = v.daysSinceLastPush;
    if (days == null) return '';
    if (days < 1) return 'Pushed today';
    if (days < 30) return `Pushed ${days} day${days === 1 ? '' : 's'} ago`;
    const months = Math.round(days / 30);
    if (months < 24) return `Pushed ~${months} month${months === 1 ? '' : 's'} ago`;
    const years = Math.round(days / 365);
    return `Pushed ~${years} year${years === 1 ? '' : 's'} ago`;
  });


  toggleFav(): void {
    const p = this.pkg();
    if (!p) return;
    this.storage.toggleFavorite(p.name);
  }
}
