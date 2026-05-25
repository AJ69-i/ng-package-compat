import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal
} from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { TranslocoModule } from '@jsverse/transloco';
import { Subscription } from 'rxjs';
import * as semver from 'semver';

import {
  ChangelogRagService,
  ReleaseEntry
} from '../../services/changelog-rag.service';
import { MarkdownRendererService } from '../../services/markdown-renderer.service';

/**
 * CHANGELOG preview for the Search page (Feature #2 of the masterpiece
 * plan).
 *
 * Reuses the existing `ChangelogRagService` that was originally built
 * for the Compare page's self-version migration panel. The service
 * already handles:
 *   1. GitHub Releases API (preferred — per-version markdown bodies)
 *   2. CHANGELOG.md / CHANGES.md / HISTORY.md fallback
 *   3. 24h localStorage cache
 *
 * Strategy on /search:
 *   - Call `service.between(pkg, '0.0.0', latest, repoUrl)` — the "0.0.0"
 *     lower bound is a sentinel that asks for ALL releases up to latest.
 *   - Take the first `MAX_ENTRIES` (newest first by rcompare).
 *   - Render each as a collapsible block with the body markdown.
 *
 * Why a separate component instead of inlining into search-page:
 *   - Lets us defer-load it independently from the rest of the page
 *     (Angular @defer at the call site keeps the lazy chunk lean).
 *   - Keeps the markdown rendering + skeleton + empty-state logic
 *     out of the search-page component, which is already heavy.
 */

const MAX_ENTRIES = 5;

interface IdleState { kind: 'idle'; }
interface LoadingState { kind: 'loading'; }
interface ResultState {
  kind: 'result';
  releases: RenderedRelease[];
  /** Where the data came from — drives the source attribution footer. */
  source: 'releases' | 'changelog-md';
  /** Resolved owner/repo slug for the "view all releases" link. */
  slug: string | null;
}
interface EmptyState { kind: 'empty'; }
interface ErrorState { kind: 'error'; }
type State = IdleState | LoadingState | ResultState | EmptyState | ErrorState;

/** Pre-rendered shape we pass to the template (avoid markdown work in CD). */
interface RenderedRelease {
  version: string;
  /** ISO date string or null. */
  date: string | null;
  /** Safe HTML produced from the markdown body. */
  body: SafeHtml | null;
  /** True when the body was empty — drives a different copy line. */
  emptyBody: boolean;
}

@Component({
  selector: 'app-changelog-preview',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, DatePipe, TranslocoModule],
  template: `
    <details class="cl" [attr.open]="defaultOpen() ? '' : null">
      <summary>
        <span class="ico" aria-hidden="true">📝</span>
        <span class="title">{{ 'changelogPreview.title' | transloco }}</span>
        @switch (state().kind) {
          @case ('loading') {
            <span class="muted">{{ 'changelogPreview.loading' | transloco }}</span>
          }
          @case ('result') {
            @let r = asResult(state());
            <span class="muted">
              {{ 'changelogPreview.countSuffix' | transloco: { n: r.releases.length } }}
            </span>
          }
          @case ('empty') {
            <span class="muted">{{ 'changelogPreview.empty' | transloco }}</span>
          }
        }
        <span class="grow"></span>
        @if (state().kind === 'result' && asResult(state()).slug; as slug) {
          <a
            class="ext"
            [href]="releasesUrl(slug)"
            target="_blank"
            rel="noopener"
            (click)="$event.stopPropagation()"
          >
            {{ 'changelogPreview.viewAll' | transloco }} ↗
          </a>
        }
      </summary>

      <div class="body">
        @switch (state().kind) {
          @case ('loading') {
            <div class="skeletons" aria-hidden="true">
              @for (i of [1,2,3]; track i) {
                <div class="sk-block">
                  <div class="sk-line w20"></div>
                  <div class="sk-line w90"></div>
                  <div class="sk-line w75"></div>
                </div>
              }
            </div>
          }
          @case ('empty') {
            <!-- Empty doesn't always mean "package has no changelog" —
                 it can also mean "we couldn't reach GitHub". Either way,
                 give the user an escape hatch: a "view on GitHub" link
                 when we can derive a slug, plus a Try-again button that
                 bypasses the cache to recover from poisoned caches
                 (rate-limit failures get a 24h cache that this resets). -->
            <p class="empty-msg">{{ 'changelogPreview.emptyBody' | transloco }}</p>
            <div class="empty-actions">
              @if (fallbackUrl(); as url) {
                <a class="empty-link" [href]="url" target="_blank" rel="noopener">
                  {{ 'changelogPreview.viewOnGithub' | transloco }} ↗
                </a>
              }
              <button type="button" class="retry-btn" (click)="retry()">
                {{ 'changelogPreview.tryAgain' | transloco }}
              </button>
            </div>
          }
          @case ('error') {
            <p class="empty-msg">{{ 'changelogPreview.error' | transloco }}</p>
            <div class="empty-actions">
              @if (fallbackUrl(); as url) {
                <a class="empty-link" [href]="url" target="_blank" rel="noopener">
                  {{ 'changelogPreview.viewOnGithub' | transloco }} ↗
                </a>
              }
              <button type="button" class="retry-btn" (click)="retry()">
                {{ 'changelogPreview.tryAgain' | transloco }}
              </button>
            </div>
          }
          @case ('result') {
            @let r = asResult(state());
            <ul class="release-list">
              @for (rel of r.releases; track rel.version) {
                <li class="release">
                  <div class="rel-head">
                    <h4 class="rel-ver">
                      <code>{{ rel.version }}</code>
                      @if (rel.date) {
                        <span class="rel-date">
                          · {{ rel.date | date: 'mediumDate' }}
                        </span>
                      }
                    </h4>
                  </div>
                  @if (rel.body) {
                    <div class="rel-body" [innerHTML]="rel.body"></div>
                  } @else {
                    <p class="rel-empty">{{ 'changelogPreview.noNotes' | transloco }}</p>
                  }
                </li>
              }
            </ul>
            @if (r.source === 'changelog-md') {
              <!-- When we fell back to scraping CHANGELOG.md the
                   per-release segmentation is lossy — the user
                   should know. -->
              <p class="src-note">{{ 'changelogPreview.changelogMdNote' | transloco }}</p>
            }
          }
        }
      </div>
    </details>
  `,
  styles: [`
    :host { display: block; margin-top: 1.25rem; }

    .cl {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg, 12px);
      overflow: hidden;
    }
    .cl summary {
      list-style: none;
      cursor: pointer;
      display: flex; align-items: center; gap: 0.55rem;
      padding: 0.85rem 1.1rem;
      font-weight: 600;
      color: var(--fg);
      transition: background-color 160ms var(--ease, ease);
    }
    .cl summary::-webkit-details-marker { display: none; }
    .cl summary:hover { background: var(--surface-1); }
    .cl summary:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    .cl[open] summary { border-bottom: 1px solid var(--border); }

    .ico { font-size: 1.1rem; }
    .title { font-size: 0.95rem; }
    .muted { color: var(--fg-dim); font-size: 0.82rem; font-weight: 500; }
    .grow { flex: 1 1 auto; }
    .ext {
      color: var(--accent); text-decoration: none;
      font-size: 0.82rem; font-weight: 600;
    }
    .ext:hover { text-decoration: underline; }

    .body {
      padding: 1rem 1.25rem 1.25rem;
      background: var(--surface-1);
      color: var(--fg);
      max-height: min(700px, 75vh);
      overflow-y: auto;
    }

    /* Skeleton — shimmer lines per release, three blocks deep so the
       preview occupies roughly the same vertical space as the final
       render to avoid a layout shift when results land. */
    .skeletons { display: grid; gap: 1.1rem; }
    .sk-block { display: grid; gap: 0.45rem; }
    .sk-line {
      height: 12px;
      background: linear-gradient(
        90deg,
        color-mix(in srgb, var(--accent) 8%, transparent) 0%,
        color-mix(in srgb, var(--accent) 14%, transparent) 50%,
        color-mix(in srgb, var(--accent) 8%, transparent) 100%
      );
      background-size: 200% 100%;
      animation: cl-shimmer 1.4s ease-in-out infinite;
      border-radius: 6px;
    }
    .sk-line.w20 { width: 20%; }
    .sk-line.w75 { width: 75%; }
    .sk-line.w90 { width: 90%; }
    @keyframes cl-shimmer { to { background-position: -200% 0; } }
    @media (prefers-reduced-motion: reduce) {
      .sk-line { animation: none; }
    }

    .release-list {
      list-style: none;
      margin: 0; padding: 0;
      display: grid;
      gap: 1.1rem;
    }
    .release {
      padding: 0.85rem 1rem;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-left: 3px solid var(--accent);
      border-radius: var(--radius-md, 10px);
    }
    .rel-head { margin-bottom: 0.4rem; }
    .rel-ver {
      margin: 0;
      font-size: 0.95rem;
      font-weight: 600;
      color: var(--fg);
    }
    .rel-ver code {
      background: var(--surface-1);
      border: 1px solid var(--border);
      padding: 0.05rem 0.45rem;
      border-radius: 6px;
      font-size: 0.88em;
      color: var(--accent);
    }
    .rel-date {
      color: var(--fg-dim);
      font-weight: 500;
      font-size: 0.82rem;
    }
    .rel-empty {
      margin: 0.25rem 0 0;
      color: var(--fg-dim);
      font-style: italic;
      font-size: 0.85rem;
    }

    /* Re-use the .md-* hooks defined by MarkdownRendererService. */
    .rel-body { font-size: 0.9rem; line-height: 1.55; color: var(--fg); }
    .rel-body ::ng-deep .md-h1,
    .rel-body ::ng-deep .md-h2,
    .rel-body ::ng-deep .md-h3,
    .rel-body ::ng-deep .md-h4 {
      margin: 0.7rem 0 0.3rem;
      font-size: 0.95rem;
      color: var(--fg);
      font-weight: 700;
    }
    .rel-body ::ng-deep .md-h1:first-child,
    .rel-body ::ng-deep .md-h2:first-child,
    .rel-body ::ng-deep .md-h3:first-child {
      margin-top: 0;
    }
    .rel-body ::ng-deep .md-p { margin: 0.35rem 0; }
    .rel-body ::ng-deep .md-ul,
    .rel-body ::ng-deep .md-ol { margin: 0.35rem 0; padding-left: 1.4rem; }
    .rel-body ::ng-deep .md-a {
      color: var(--accent);
      text-decoration: none;
      border-bottom: 1px dotted color-mix(in srgb, var(--accent) 50%, transparent);
    }
    .rel-body ::ng-deep .md-a:hover { border-bottom-style: solid; }
    .rel-body ::ng-deep .md-code {
      background: var(--surface-1);
      border: 1px solid var(--border);
      padding: 0.05rem 0.4rem;
      border-radius: 6px;
      font-size: 0.85em;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    .rel-body ::ng-deep .md-pre {
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-md, 10px);
      padding: 0.65rem 0.85rem;
      overflow-x: auto;
      margin: 0.5rem 0;
    }
    .rel-body ::ng-deep .md-pre .md-code-block {
      background: none;
      border: none;
      padding: 0;
      font-size: 0.8rem;
      line-height: 1.5;
    }

    .empty-msg {
      margin: 0;
      color: var(--fg-dim);
      font-size: 0.9rem;
    }
    .empty-actions {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
      margin-top: 0.7rem;
    }
    .empty-link {
      display: inline-flex;
      align-items: center;
      padding: 0.35rem 0.8rem;
      background: var(--surface-2);
      color: var(--accent);
      border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
      border-radius: var(--radius-sm, 6px);
      font-size: 0.82rem;
      font-weight: 600;
      text-decoration: none;
      transition: background-color 140ms ease, border-color 140ms ease, transform 100ms ease;
    }
    .empty-link:hover {
      background: color-mix(in srgb, var(--accent) 10%, var(--surface-2));
      border-color: var(--accent);
      transform: translateY(-1px);
    }
    .retry-btn {
      padding: 0.35rem 0.8rem;
      background: transparent;
      color: var(--fg-dim);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm, 6px);
      font: inherit;
      font-size: 0.82rem;
      cursor: pointer;
      transition: background-color 140ms ease, color 140ms ease, border-color 140ms ease;
    }
    .retry-btn:hover {
      background: var(--surface-2);
      color: var(--fg);
      border-color: var(--accent);
    }
    .retry-btn:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    .src-note {
      margin: 1rem 0 0;
      padding: 0.55rem 0.8rem;
      background: color-mix(in srgb, var(--warn) 8%, var(--surface-2));
      border: 1px solid color-mix(in srgb, var(--warn) 35%, var(--border));
      border-left: 3px solid var(--warn);
      border-radius: var(--radius-sm, 6px);
      color: var(--fg-dim);
      font-size: 0.78rem;
      line-height: 1.5;
    }
  `]
})
export class ChangelogPreviewComponent {
  /** npm package name. */
  readonly pkgName = input.required<string>();
  /** Latest published version (from `pkg.dist-tags.latest`). */
  readonly latestVersion = input<string | null>(null);
  /** npm repository.url field (we extract owner/repo). */
  readonly repoUrl = input<string | null>(null);
  /**
   * Monorepo subdirectory from `pkg.repository.directory`. Lets the
   * service look for the per-package CHANGELOG inside a workspace
   * (rxjs → packages/rxjs, @angular/* under packages/<name>, every
   * Nx / Lerna / Yarn-workspaces package). Falls back to the repo
   * root when null.
   */
  readonly repoDirectory = input<string | null>(null);
  /** Whether the details element renders open by default. */
  readonly defaultOpen = input<boolean>(false);

  private readonly svc = inject(ChangelogRagService);
  private readonly md = inject(MarkdownRendererService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly destroyRef = inject(DestroyRef);

  readonly state = signal<State>({ kind: 'idle' });

  /**
   * Bumped by retry() to force the next fetch to bypass the cache.
   * Read inside the effect so a click on the Try-again button triggers
   * a fresh subscription with bypassCache=true.
   */
  private readonly bypassToken = signal<number>(0);

  private currentSub?: Subscription;

  constructor() {
    // Fire whenever pkgName / latestVersion / repoUrl changes.
    effect(() => {
      const name = this.pkgName();
      const latest = this.latestVersion();
      const repo = this.repoUrl();
      const dir = this.repoDirectory();
      const bypass = this.bypassToken() > 0;
      this.currentSub?.unsubscribe();
      if (!name || !latest) {
        this.state.set({ kind: 'idle' });
        return;
      }
      this.state.set({ kind: 'loading' });
      // We pass "0.0.0" as the lower bound — the service's between()
      // treats lo as exclusive, so this returns every release up to
      // latest. The 100-entry GitHub cap inside the service is fine
      // because we only render the top MAX_ENTRIES anyway. The
      // `dir` argument lets monorepo packages (rxjs, @angular/*,
      // @nestjs/*, every Lerna/Nx/Yarn-workspace package) resolve
      // their per-package CHANGELOG instead of 404ing on the repo
      // root.
      this.currentSub = this.svc.between(name, '0.0.0', latest, repo ?? undefined, bypass, dir).subscribe({
        next: (result) => {
          if (result.source === 'none') {
            this.state.set({ kind: 'empty' });
            return;
          }
          // GitHub Releases path — we have structured entries already.
          if (result.releases.length) {
            const top = this.takeNewest(result.releases, MAX_ENTRIES);
            const rendered = top.map((r) => this.render(r));
            this.state.set({
              kind: 'result',
              releases: rendered,
              source: 'releases',
              slug: result.slug
            });
            return;
          }
          // CHANGELOG.md fallback — service returns text only, no
          // per-release structure. Render as a single "block" entry
          // labelled with the resolved-latest version so the UI
          // doesn't degrade to a wall of text without context.
          if (result.text) {
            const rendered: RenderedRelease = {
              version: latest,
              date: null,
              body: this.sanitizer.bypassSecurityTrustHtml(
                this.md.render(result.text)
              ),
              emptyBody: false
            };
            this.state.set({
              kind: 'result',
              releases: [rendered],
              source: 'changelog-md',
              slug: result.slug
            });
            return;
          }
          this.state.set({ kind: 'empty' });
        },
        error: () => this.state.set({ kind: 'error' })
      });
    });
    this.destroyRef.onDestroy(() => this.currentSub?.unsubscribe());
  }

  /** GitHub releases URL for the repo (used by the "view all" link). */
  releasesUrl(slug: string): string {
    return `https://github.com/${slug}/releases`;
  }

  /**
   * Best-effort fallback URL surfaced in the empty/error state so the
   * user always has a way out — even when our fetch failed (rate-limit,
   * 404 on the API but the repo exists, etc.). Prefers the GitHub
   * Releases page when we can extract a slug, otherwise falls back to
   * the npm package page where users can hop to the repo from there.
   */
  readonly fallbackUrl = computed<string | null>(() => {
    const repo = this.repoUrl();
    const slug = this.parseGithubSlug(repo);
    if (slug) return this.releasesUrl(slug);
    const name = this.pkgName();
    return name ? `https://www.npmjs.com/package/${encodeURIComponent(name)}` : null;
  });

  /**
   * Force a fresh fetch that bypasses the 24h cache. Helpful when a
   * prior network failure (most commonly GitHub rate-limiting at 60
   * req/hr unauthenticated) wrote an empty result to the cache and
   * subsequent loads keep serving that empty even after the limit
   * resets. Bumping the bypassToken triggers a fresh effect run with
   * bypassCache=true.
   */
  retry(): void {
    this.bypassToken.update((v) => v + 1);
  }

  /**
   * Local copy of the same GitHub-slug regex the service uses. We
   * duplicate (rather than expose a service helper) for two reasons:
   * (1) keeps the component standalone if someone consumes it on a
   * different page that doesn't inject the service yet, and (2) the
   * service comment explicitly calls out that the parser is owned
   * per-caller. Defensive minor differences in URL shapes are
   * acceptable — the worst case is `null`, which falls through to
   * the npm package page as a fallback.
   */
  private parseGithubSlug(input: string | undefined | null): string | null {
    if (!input) return null;
    const cleaned = input.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
    if (!cleaned) return null;
    const url = /(?:^|:\/\/)(?:[^/]*@)?github\.com\/([\w.-]+)\/([\w.-]+)(?:[/?#]|$)/i.exec(cleaned);
    if (url) return `${url[1]}/${url[2]}`;
    const ssh = /^git@github\.com:([\w.-]+)\/([\w.-]+)$/i.exec(cleaned);
    if (ssh) return `${ssh[1]}/${ssh[2]}`;
    return null;
  }

  private takeNewest(rels: ReleaseEntry[], n: number): ReleaseEntry[] {
    // Service already returns rcompare-sorted, but defensive in case
    // someone changes that assumption later.
    return [...rels]
      .sort((a, b) => semver.rcompare(a.version, b.version))
      .slice(0, n);
  }

  private render(rel: ReleaseEntry): RenderedRelease {
    const body = (rel.body ?? '').trim();
    if (!body) {
      return { version: rel.version, date: rel.date, body: null, emptyBody: true };
    }
    return {
      version: rel.version,
      date: rel.date,
      body: this.sanitizer.bypassSecurityTrustHtml(this.md.render(body)),
      emptyBody: false
    };
  }

  /** Template type-narrowing helpers. */
  asResult(s: State): ResultState { return s as ResultState; }
}
