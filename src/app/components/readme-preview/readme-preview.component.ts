import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { TranslocoModule } from '@jsverse/transloco';
import { MarkdownRendererService } from '../../services/markdown-renderer.service';

/**
 * README preview for the Search page (Feature #1 of the search-page
 * "masterpiece" plan).
 *
 * The npm registry already ships the full README text on the root of
 * the packument response (`NpmRegistryResponse.readme`). We don't make
 * any extra network calls — we just render what's already in memory.
 *
 * Why a `<details>` collapsible instead of always-open?
 *   • Page rhythm: the README can be enormous (Angular Material's README
 *     is 7000+ lines of markdown). An always-open render would push
 *     every other section — versions table, recommendation card,
 *     timeline — three or four scrolls down.
 *   • Print: the print stylesheet expands `<details>` open via
 *     `details[open]` in `styles.scss`, so when the user prints to PDF
 *     the README still shows up if they had it open. Closed details
 *     stay collapsed in print too, matching what they see on screen.
 *   • A11Y: native `<details>`/`<summary>` is fully keyboard-accessible
 *     and screen-reader-announced as a disclosure widget without any
 *     ARIA bookkeeping on our part.
 *
 * Why an inner `.scroll-table-tall` body wrapper?
 *   Even with the details collapsed by default, when the user opens
 *   a long README we don't want it to dominate the rest of the page.
 *   The wrapper caps the inner scroll at 80vh and gives the content
 *   its own scroll context. The global `.scroll-table` utility also
 *   handles theme-aware scrollbars + print-friendly cap-lift.
 */
@Component({
  selector: 'app-readme-preview',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TranslocoModule],
  template: `
    @if (rendered(); as html) {
      <details class="readme" [attr.open]="defaultOpen() ? '' : null">
        <summary>
          <span class="ico" aria-hidden="true">📖</span>
          <span class="title">{{ 'readme.title' | transloco }}</span>
          <span class="muted">{{ 'readme.lengthHint' | transloco: { kb: sizeKb() } }}</span>
          <span class="grow"></span>
          @if (npmUrl(); as u) {
            <a class="ext" [href]="u" target="_blank" rel="noopener" (click)="$event.stopPropagation()">
              {{ 'readme.viewOnNpm' | transloco }} ↗
            </a>
          }
        </summary>

        <div class="body scroll-table scroll-table-tall" [innerHTML]="html"></div>
      </details>
    } @else if (markdown() && !rendered()) {
      <!-- Defensive empty state — should never fire because rendered()
           is derived synchronously from markdown(), but keeps the
           component graceful if a future change introduces async
           processing. -->
      <p class="empty muted">{{ 'readme.empty' | transloco }}</p>
    }
  `,
  styles: [`
    :host { display: block; margin-top: 1.25rem; }

    /* Disclosure shell — looks like the surrounding panels so it feels
       like a first-class section instead of a sidebar widget. */
    .readme {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg, 12px);
      overflow: hidden;
    }
    .readme summary {
      list-style: none;
      cursor: pointer;
      display: flex; align-items: center; gap: 0.55rem;
      padding: 0.85rem 1.1rem;
      font-weight: 600;
      color: var(--fg);
      transition: background-color 160ms var(--ease, ease);
    }
    .readme summary::-webkit-details-marker { display: none; }
    .readme summary:hover { background: var(--surface-1); }
    .readme summary:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    .readme[open] summary { border-bottom: 1px solid var(--border); }

    .ico { font-size: 1.1rem; }
    .title { font-size: 0.95rem; }
    .muted { color: var(--fg-dim); font-size: 0.82rem; font-weight: 500; }
    .grow { flex: 1 1 auto; }
    .ext {
      color: var(--accent);
      text-decoration: none;
      font-size: 0.82rem;
      font-weight: 600;
    }
    .ext:hover { text-decoration: underline; }

    .body {
      padding: 1.1rem 1.25rem 1.5rem;
      background: var(--surface-1);
      color: var(--fg);
      font-size: 0.93rem;
      line-height: 1.6;
    }
    .empty { padding: 1rem 1.25rem; }

    /* ===== Markdown element styles =====
       Every selector starts with .body to keep the README's eccentric
       markup from leaking into the rest of the page. Tokens come from
       the global theme so this looks right in both dark and light. */
    .body :global { display: contents; }
    .body ::ng-deep .md-h1,
    .body ::ng-deep .md-h2,
    .body ::ng-deep .md-h3,
    .body ::ng-deep .md-h4,
    .body ::ng-deep .md-h5,
    .body ::ng-deep .md-h6 {
      margin: 1.25rem 0 0.5rem;
      line-height: 1.25;
      color: var(--fg);
      font-weight: 700;
    }
    .body ::ng-deep .md-h1 { font-size: 1.55rem; padding-bottom: 0.25rem; border-bottom: 1px solid var(--border); }
    .body ::ng-deep .md-h2 { font-size: 1.3rem;  padding-bottom: 0.2rem; border-bottom: 1px solid var(--border); }
    .body ::ng-deep .md-h3 { font-size: 1.1rem; }
    .body ::ng-deep .md-h4 { font-size: 1rem; }
    .body ::ng-deep .md-h5,
    .body ::ng-deep .md-h6 { font-size: 0.92rem; color: var(--fg-dim); }

    .body ::ng-deep .md-p { margin: 0.55rem 0; }
    .body ::ng-deep .md-ul,
    .body ::ng-deep .md-ol { margin: 0.55rem 0; padding-left: 1.4rem; }
    .body ::ng-deep .md-ul li,
    .body ::ng-deep .md-ol li { margin: 0.2rem 0; }

    .body ::ng-deep .md-a {
      color: var(--accent);
      text-decoration: none;
      border-bottom: 1px dotted color-mix(in srgb, var(--accent) 50%, transparent);
    }
    .body ::ng-deep .md-a:hover { text-decoration: none; border-bottom-style: solid; }

    .body ::ng-deep .md-code {
      background: var(--surface-2);
      border: 1px solid var(--border);
      padding: 0.05rem 0.4rem;
      border-radius: 6px;
      font-size: 0.85em;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    .body ::ng-deep .md-pre {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--radius-md, 10px);
      padding: 0.85rem 1rem;
      overflow-x: auto;
      margin: 0.7rem 0;
    }
    .body ::ng-deep .md-pre .md-code-block {
      background: none;
      border: none;
      padding: 0;
      font-size: 0.83rem;
      line-height: 1.55;
      color: var(--fg);
    }

    .body ::ng-deep .md-img {
      max-width: 100%;
      height: auto;
      border-radius: var(--radius-sm, 6px);
      background: var(--surface-2);
    }

    .body ::ng-deep .md-bq {
      border-left: 3px solid color-mix(in srgb, var(--accent) 50%, var(--border));
      background: color-mix(in srgb, var(--accent) 5%, var(--surface-1));
      padding: 0.5rem 0.85rem;
      margin: 0.7rem 0;
      color: var(--fg-dim);
      border-radius: 0 var(--radius-sm, 6px) var(--radius-sm, 6px) 0;
    }

    .body ::ng-deep hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 1.25rem 0;
    }

    .body ::ng-deep .md-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.88rem;
      margin: 0.7rem 0;
    }
    .body ::ng-deep .md-table th,
    .body ::ng-deep .md-table td {
      padding: 0.45rem 0.65rem;
      border-bottom: 1px solid var(--border);
      text-align: left;
    }
    .body ::ng-deep .md-table th {
      color: var(--fg-dim);
      font-weight: 600;
      background: var(--surface-2);
    }
  `]
})
export class ReadmePreviewComponent {
  /** Raw markdown text from the npm packument. */
  readonly markdown = input<string | null>(null);
  /** Repository URL — used to resolve relative images/links. */
  readonly repoUrl = input<string | null>(null);
  /** Optional npm package name — produces the "View on npm" link. */
  readonly pkgName = input<string | null>(null);
  /** When true the section expands by default (false is the polite default). */
  readonly defaultOpen = input<boolean>(false);

  private readonly md = inject(MarkdownRendererService);
  private readonly sanitizer = inject(DomSanitizer);

  /**
   * Render the markdown to safe HTML.
   *
   * We bypass DomSanitizer only because we control the entire output
   * shape — every user-supplied substring goes through `escapeHtml()`
   * in MarkdownRendererService, and URLs go through a scheme allowlist.
   * Without bypassing, Angular would strip `class` attributes (which
   * we need for the `.md-*` styling hooks above) on every node.
   */
  readonly rendered = computed<SafeHtml | null>(() => {
    const raw = this.markdown();
    if (!raw || !raw.trim()) return null;
    const base = this.resolveBaseUrl(this.repoUrl());
    const html = this.md.render(raw, base ?? undefined);
    return this.sanitizer.bypassSecurityTrustHtml(html);
  });

  /** Rough size hint shown next to the title — gives users an at-a-glance
   *  sense of how big the README is before they expand. */
  readonly sizeKb = computed<number>(() => {
    const raw = this.markdown();
    if (!raw) return 0;
    return Math.max(1, Math.round(raw.length / 1024));
  });

  readonly npmUrl = computed<string | null>(() => {
    const n = this.pkgName();
    if (!n) return null;
    return `https://www.npmjs.com/package/${encodeURIComponent(n)}`;
  });

  /**
   * Turn `git+https://github.com/owner/repo.git` into
   * `https://raw.githubusercontent.com/owner/repo/HEAD/` so that
   * relative `![logo](./logo.png)` references in the README resolve
   * to actual image URLs.
   *
   * For non-GitHub repos we strip the `git+` prefix / `.git` suffix
   * and return the URL unchanged — relative images won't resolve,
   * which is fine: alt text falls back gracefully and the README
   * still reads.
   */
  private resolveBaseUrl(repoUrl: string | null): string | null {
    if (!repoUrl) return null;
    let u = repoUrl.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^ssh:\/\/git@/, 'https://').replace(/^git:\/\//, 'https://');

    // GitHub: rewrite the host to raw.githubusercontent.com so
    // relative paths resolve to raw file bytes (not the HTML
    // file-viewer page).
    const gh = u.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/);
    if (gh) return `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/HEAD/`;

    // Anything else — return a directory-prefixed URL so relative
    // paths combine reasonably even if they don't resolve.
    if (!u.endsWith('/')) u += '/';
    return u;
  }
}
