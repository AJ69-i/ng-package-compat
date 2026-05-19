import { ChangeDetectionStrategy, Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TranslocoModule } from '@jsverse/transloco';

@Component({
  selector: 'app-about-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, RouterLink, TranslocoModule],
  template: `
    <article class="about">
      <header>
        <h1>{{ 'about.title' | transloco }}</h1>
        <p class="lede">
          <em>{{ 'about.lede' | transloco }}</em>
        </p>
      </header>

      <section>
        <h2>{{ 'about.whatItDoes' | transloco }}</h2>
        <ul>
          <li>Look up any npm package and show every published version.</li>
          <li>Flag which Angular majors each version supports, based on <code>peerDependencies["&#64;angular/core"]</code>.</li>
          <li>Recommend a stable and a latest version for the Angular major you care about.</li>
          <li>Compare two packages side-by-side to find an Angular major they both support.</li>
          <li>Bulk-check a list of packages for an upgrade, and emit ready-to-run install commands.</li>
          <li>Diff two versions of the same package to see added/removed/changed peer deps and deps.</li>
          <li>Surface deprecations, prereleases, TypeScript support, package size, and security advisories.</li>
        </ul>
      </section>

      <section>
        <h2>{{ 'about.howItWorks' | transloco }}</h2>
        <p>
          For every version listed on the registry, we read the declared
          <code>peerDependencies["&#64;angular/core"]</code> range (plus <code>&#64;angular/common</code>
          as a fallback) and test it against each known Angular major using
          <a href="https://github.com/npm/node-semver" target="_blank" rel="noopener">node-semver</a>.
          A major is marked "supported" if any version in that major (e.g. <code>X.0.0</code> through
          <code>X.999.999</code>) satisfies the range.
        </p>
        <p>
          We also surface versions that declare <strong>no</strong> Angular peer — those are usually
          framework-agnostic helpers and are shown as "supports any". Deprecated versions are kept
          in the table but clearly marked and excluded from the recommendation engine.
        </p>
      </section>

      <section>
        <h2>{{ 'about.dataSources' | transloco }}</h2>
        <!-- Hostnames stay visible in the link TEXT so the user can
             see exactly which endpoints we hit. The link HREFs point
             at each API's canonical docs page instead of the raw
             endpoint — clicking through to a JSON 404 makes the
             whole page look broken, even though the endpoints
             themselves are fine. -->
        <ul>
          <li><a href="https://github.com/npm/registry/blob/master/docs/REGISTRY-API.md" target="_blank" rel="noopener">registry.npmjs.org</a> — versions, peerDependencies, deprecations, maintainers.</li>
          <li><a href="https://github.com/npm/registry/blob/master/docs/download-counts.md" target="_blank" rel="noopener">api.npmjs.org/downloads</a> — weekly download counts.</li>
          <li><a href="https://google.github.io/osv.dev/api/" target="_blank" rel="noopener">api.osv.dev</a> — security advisories.</li>
          <li><a href="https://bundlephobia.com" target="_blank" rel="noopener">bundlephobia.com</a> — bundle size estimates.</li>
        </ul>
        <p class="small">{{ 'about.allClient' | transloco }}</p>
      </section>

      <section>
        <h2>{{ 'about.underHood' | transloco }}</h2>
        <ul>
          <li>Angular 21 with zoneless change detection, signals, and the new control flow.</li>
          <li>SSR + hydration via <code>&#64;angular/ssr</code> (Node/Express adapter).</li>
          <li>Service worker for offline shell, powered by <code>&#64;angular/service-worker</code>.</li>
          <li>Standalone components everywhere — no NgModules.</li>
          <li>i18n-ready with an English default and Arabic locale scaffolded.</li>
        </ul>
      </section>

      <section class="cta">
        <h2>{{ 'about.cta' | transloco }}</h2>
        <p>
          Try <a routerLink="/" [queryParams]="{ q: 'ngx-toastr' }">ngx-toastr</a>,
          <a routerLink="/" [queryParams]="{ q: '@angular/material' }">&#64;angular/material</a>,
          or hop to the
          <a routerLink="/upgrade">Upgrade Assistant</a> and paste your <code>package.json</code> deps.
        </p>
      </section>
    </article>
  `,
  styles: [`
    .about { max-width: 68ch; margin: 0 auto; color: var(--fg); line-height: 1.55; }
    header { margin-bottom: 1.5rem; }
    h1 { font-size: clamp(1.6rem, 3vw + 1rem, 2.2rem); color: var(--fg); }
    .lede { font-size: 1.05rem; color: var(--fg-dim); margin-top: 0.3rem; }
    .lede em { color: var(--fg); font-style: italic; }
    section { margin-top: 2rem; }
    h2 { font-size: 1.15rem; color: var(--fg); margin-bottom: 0.5rem; }
    ul { padding-left: 1.25rem; margin: 0; }
    li { margin: 0.25rem 0; color: var(--fg-dim); }
    li strong { color: var(--fg); }
    p { margin: 0.5rem 0; color: var(--fg-dim); }
    code {
      background: var(--surface-1); border: 1px solid var(--border);
      padding: 1px 6px; border-radius: 4px; font-size: 0.85em;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover, a:focus-visible { text-decoration: underline; outline: none; }
    .small { font-size: 0.82rem; }
    .cta {
      padding: 1rem 1.25rem; background: var(--surface-2);
      border: 1px solid var(--border); border-radius: 12px;
    }
  `]
})
export class AboutPageComponent {}
