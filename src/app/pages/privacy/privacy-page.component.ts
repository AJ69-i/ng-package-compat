import { ChangeDetectionStrategy, Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TranslocoModule } from '@jsverse/transloco';

/**
 * Static Privacy Policy page.
 *
 * # Why this lives in the app and not as a static doc
 *
 * Three reasons. First, it's i18n'd alongside the rest of the UI so
 * non-English users get a policy they can actually read. Second, it
 * links to live in-app routes (account deletion, AI settings) — those
 * deep links rot if the policy is a separate static HTML page on a
 * docs subdomain. Third, the styling inherits the app's theme tokens
 * automatically; a separate HTML page would diverge over time.
 *
 * # Scope
 *
 * This is a starting policy that's honest about what the app does
 * today — Supabase auth/storage, Groq via our proxy, BYO keys staying
 * client-side, error telemetry to Sentry, deletion via the Danger
 * Zone. It's NOT a legal substitute for review by an actual attorney
 * before serving traffic in the EU/UK/California, but it's enough to
 * launch with — every claim here matches actual code behaviour.
 */
@Component({
  selector: 'app-privacy-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, RouterLink, TranslocoModule],
  template: `
    <section class="head">
      <h1>{{ 'privacy.title' | transloco }}</h1>
      <p class="muted">{{ 'privacy.lastUpdated' | transloco: { date: 'May 13, 2026' } }}</p>
    </section>

    <section class="block">
      <h2>{{ 'privacy.summary.title' | transloco }}</h2>
      <p>{{ 'privacy.summary.body' | transloco }}</p>
    </section>

    <section class="block">
      <h2>{{ 'privacy.collect.title' | transloco }}</h2>
      <p>{{ 'privacy.collect.intro' | transloco }}</p>
      <ul>
        <li><strong>{{ 'privacy.collect.identity.label' | transloco }}</strong> — {{ 'privacy.collect.identity.body' | transloco }}</li>
        <li><strong>{{ 'privacy.collect.workspace.label' | transloco }}</strong> — {{ 'privacy.collect.workspace.body' | transloco }}</li>
        <li><strong>{{ 'privacy.collect.tokens.label' | transloco }}</strong> — {{ 'privacy.collect.tokens.body' | transloco }}</li>
        <li><strong>{{ 'privacy.collect.errors.label' | transloco }}</strong> — {{ 'privacy.collect.errors.body' | transloco }}</li>
      </ul>
      <p class="callout">{{ 'privacy.collect.byo' | transloco }}</p>
      <!-- The byo callout key is nested under privacy.collect so it
           reads naturally as "what we DON'T collect (BYO keys)" — sits
           after the four collection bullets and gives the strongest
           privacy promise visual emphasis without needing a separate
           section. -->
    </section>

    <section class="block">
      <h2>{{ 'privacy.thirdParties.title' | transloco }}</h2>
      <p>{{ 'privacy.thirdParties.intro' | transloco }}</p>
      <ul>
        <li>
          <a href="https://supabase.com/privacy" target="_blank" rel="noopener noreferrer">Supabase</a>
          — {{ 'privacy.thirdParties.supabase' | transloco }}
        </li>
        <li>
          <a href="https://groq.com/privacy-policy" target="_blank" rel="noopener noreferrer">Groq</a>
          — {{ 'privacy.thirdParties.groq' | transloco }}
        </li>
        <li>
          <a href="https://sentry.io/privacy/" target="_blank" rel="noopener noreferrer">Sentry</a>
          — {{ 'privacy.thirdParties.sentry' | transloco }}
        </li>
        <li>
          <a href="https://bundlephobia.com" target="_blank" rel="noopener noreferrer">Bundlephobia</a>,
          <a href="https://www.npmjs.com" target="_blank" rel="noopener noreferrer">npm registry</a>,
          <a href="https://docs.github.com/en/rest" target="_blank" rel="noopener noreferrer">GitHub API</a>
          — {{ 'privacy.thirdParties.publicApis' | transloco }}
        </li>
      </ul>
    </section>

    <section class="block">
      <h2>{{ 'privacy.storage.title' | transloco }}</h2>
      <p>{{ 'privacy.storage.body' | transloco }}</p>
    </section>

    <section class="block">
      <h2>{{ 'privacy.rights.title' | transloco }}</h2>
      <p>
        {{ 'privacy.rights.body' | transloco }}
        <a routerLink="/projects" fragment="danger-zone">{{ 'privacy.rights.linkLabel' | transloco }}</a>.
      </p>
    </section>

    <section class="block">
      <h2>{{ 'privacy.contact.title' | transloco }}</h2>
      <p [innerHTML]="'privacy.contact.body' | transloco"></p>
    </section>
  `,
  styles: [`
    :host {
      display: block;
      max-width: 760px;
      margin: 0 auto;
      padding: 2rem 1.25rem 4rem;
    }
    .head { margin-bottom: 2rem; }
    .head h1 {
      margin: 0 0 0.4rem;
      font-size: clamp(1.4rem, 2vw + 0.8rem, 1.9rem);
      color: var(--fg);
    }
    .muted { margin: 0; color: var(--fg-dim, #64748b); font-size: 0.88rem; }

    .block { margin-bottom: 1.75rem; }
    .block h2 {
      margin: 0 0 0.6rem;
      font-size: 1.05rem;
      color: var(--fg);
    }
    .block p {
      margin: 0 0 0.5rem;
      color: var(--fg);
      line-height: 1.65;
      font-size: 0.95rem;
    }
    .block ul {
      margin: 0.4rem 0 0;
      padding-inline-start: 1.2rem;
      display: grid;
      gap: 0.45rem;
      color: var(--fg);
      line-height: 1.55;
      font-size: 0.92rem;
    }
    .block ul a {
      color: var(--accent);
      text-decoration: none;
    }
    .block ul a:hover { text-decoration: underline; }

    /* Honest callout box for the BYO-key claim — the single most
       important privacy promise the app makes, so it gets visual
       emphasis without screaming. */
    .callout {
      margin-top: 0.85rem;
      padding: 0.7rem 0.9rem;
      border-radius: var(--radius-md, 10px);
      background: color-mix(in srgb, var(--accent) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
      color: var(--fg);
      font-size: 0.9rem;
      line-height: 1.5;
    }
  `]
})
export class PrivacyPageComponent {}
