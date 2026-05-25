import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  PLATFORM_ID,
  computed,
  effect,
  inject,
  input,
  signal
} from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { TranslocoModule } from '@jsverse/transloco';

/**
 * Floating sticky table-of-contents / quick-nav (Polish #4).
 *
 * # The problem this solves
 *
 * The Search page is now ~6 viewport-heights tall on desktop:
 * Overview → Install → Alternatives → Versions → Dependencies →
 * Ask AI → Changelog → README. Scrolling to a specific section means
 * either Ctrl-F-ing for a heading or scrolling through everything in
 * between. A small side-anchored TOC turns the dashboard from "long"
 * into "navigable" without taking any real estate from the primary
 * content.
 *
 * # When this renders
 *
 * - Desktop only (≥1100px viewport). Mobile/tablet users get full
 *   width for the content and can scroll naturally; a TOC on a
 *   narrow screen costs more than it saves.
 * - Fades in after the user has scrolled past the first 200px. On
 *   landing, the TOC stays hidden so the page hero gets full
 *   attention; once the user is committed to exploration (scrolling),
 *   the TOC fades in to help them navigate.
 *
 * # Active-section tracking
 *
 * IntersectionObserver watches every section element (resolved by
 * id from the `items` input). The section currently most-visible in
 * the viewport gets the .active style — same pattern as MDN, Stripe
 * docs, every modern documentation site.
 *
 * # RTL
 *
 * Uses `inset-inline-end: 1rem` instead of `right: 1rem`, so when
 * the user switches to Arabic (locale: ar) the TOC moves to the
 * LEFT side automatically — no separate dir="rtl" branch needed.
 *
 * # A11Y
 *
 * Wrapped in a `<nav aria-label="..">` landmark. Each anchor has a
 * keyboard-accessible click target (≥36px tall, focus-visible
 * outline). When the active section changes the SR sees the
 * `aria-current="location"` flip — but we don't announce it via
 * live region (would be too chatty during fast scrolls).
 */

export interface TocItem {
  /** DOM id of the target section element. */
  id: string;
  /**
   * Translation key under `pageToc.label.*`. Component looks it up
   * via the | transloco pipe in the template.
   */
  labelKey: string;
  /** Optional short glyph rendered before the label (decorative). */
  icon?: string;
}

@Component({
  selector: 'app-page-toc',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TranslocoModule],
  template: `
    @if (visible()) {
      <nav
        class="toc"
        [class.visible]="shown()"
        [attr.aria-label]="'pageToc.aria' | transloco"
      >
        <p class="toc-heading">{{ 'pageToc.heading' | transloco }}</p>
        <ol class="toc-list">
          @for (i of items(); track i.id) {
            <li>
              <a
                [href]="'#' + i.id"
                [class.active]="activeId() === i.id"
                [attr.aria-current]="activeId() === i.id ? 'location' : null"
                (click)="onClick($event, i.id)"
              >
                @if (i.icon) {
                  <span class="ico" aria-hidden="true">{{ i.icon }}</span>
                }
                <span class="lbl">{{ ('pageToc.label.' + i.labelKey) | transloco }}</span>
              </a>
            </li>
          }
        </ol>
      </nav>
    }
  `,
  styles: [`
    /* Fixed to the page's trailing edge (right in LTR, left in RTL).
       inset-block keeps it vertically centered without resorting to
       translate trickery. min(70vh, ...) caps height so it never
       runs into the footer on shorter screens. */
    .toc {
      position: fixed;
      inset-block-start: 30vh;
      inset-inline-end: 1.25rem;
      width: 12rem;
      max-height: min(60vh, 480px);
      overflow-y: auto;
      padding: 0.85rem 0.85rem 0.7rem;
      background: color-mix(in srgb, var(--surface-2) 96%, transparent);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg, 12px);
      box-shadow: var(--shadow-2, 0 4px 12px rgba(0,0,0,0.08));
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      z-index: 50;
      opacity: 0;
      transform: translateX(8px);
      pointer-events: none;
      transition: opacity 240ms var(--ease, ease),
                  transform 240ms var(--ease, ease);
    }
    /* In RTL the slide-in direction flips. inset-inline-end already
       puts the TOC on the left; mirroring the entry translate makes
       the fade-in feel directionally correct. */
    :host-context([dir="rtl"]) .toc {
      transform: translateX(-8px);
    }
    .toc.visible {
      opacity: 1;
      transform: translateX(0);
      pointer-events: auto;
    }

    .toc-heading {
      margin: 0 0 0.5rem;
      font-size: 0.7rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--fg-dim);
    }

    .toc-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 0.15rem;
    }

    .toc-list a {
      display: flex;
      align-items: center;
      gap: 0.45rem;
      padding: 0.4rem 0.55rem;
      border-radius: var(--radius-sm, 6px);
      color: var(--fg-dim);
      text-decoration: none;
      font-size: 0.83rem;
      line-height: 1.3;
      transition: background-color 140ms var(--ease, ease),
                  color 140ms var(--ease, ease);
      min-height: 32px;
      /* Left border-stripe lights up on the active item. Cheap visual
         indicator that doesn't require flipping the bg color (which
         would compete with the chip-style accents elsewhere). */
      border-inline-start: 2px solid transparent;
    }
    .toc-list a:hover {
      background: var(--surface-1);
      color: var(--fg);
    }
    .toc-list a:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .toc-list a.active {
      background: color-mix(in srgb, var(--accent) 10%, var(--surface-1));
      color: var(--accent);
      font-weight: 600;
      border-inline-start-color: var(--accent);
    }
    .ico { font-size: 0.95rem; line-height: 1; }
    .lbl { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    /* Hide entirely below 1100px viewport — narrower screens don't
       have room for a side-pinned widget without crowding the main
       column. Same media-query split as enterprise doc sites. */
    @media (max-width: 1100px) {
      .toc { display: none; }
    }

    /* Reduced-motion users get an instant fade with no slide. */
    @media (prefers-reduced-motion: reduce) {
      .toc {
        transition: opacity 100ms linear;
        transform: none;
      }
    }
  `]
})
export class PageTocComponent implements AfterViewInit {
  /**
   * Items to render. Each id must match a real DOM section id on the
   * host page; otherwise the link 404s silently (no crash, just no
   * scroll target).
   */
  readonly items = input<TocItem[]>([]);

  /**
   * Pixels of vertical scroll before we fade in. 200px is roughly the
   * height of the search-panel hero on desktop — past this point the
   * user has committed to the result view.
   */
  readonly scrollThreshold = input<number>(200);

  /** Whether the TOC should render at all (true when items > 0). */
  readonly visible = computed<boolean>(() => this.items().length > 0);

  /** Whether the fade-in has triggered. */
  readonly shown = signal<boolean>(false);

  /** Id of the currently most-visible section (used for `.active`). */
  readonly activeId = signal<string>('');

  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  private scrollHandler?: () => void;
  private observer?: IntersectionObserver;

  constructor() {
    // Re-wire the observer whenever the items input changes (e.g.
    // navigating from one package to another resets the list).
    effect(() => {
      const items = this.items();
      if (!this.isBrowser) return;
      // Defer to the next animation frame so the host page has time
      // to render the new sections before we query for them.
      requestAnimationFrame(() => this.setupObserver(items));
    });

    this.destroyRef.onDestroy(() => {
      if (this.scrollHandler && this.isBrowser) {
        window.removeEventListener('scroll', this.scrollHandler);
      }
      this.observer?.disconnect();
    });
  }

  ngAfterViewInit(): void {
    if (!this.isBrowser) return;

    // Set initial visibility from current scroll position (handles
    // the case where the user navigates to a deep-link with a hash
    // — the page is already scrolled, so the TOC should be visible).
    this.shown.set(window.scrollY > this.scrollThreshold());

    this.scrollHandler = () => {
      const past = window.scrollY > this.scrollThreshold();
      if (past !== this.shown()) this.shown.set(past);
    };
    window.addEventListener('scroll', this.scrollHandler, { passive: true });
  }

  private setupObserver(items: TocItem[]): void {
    if (!this.isBrowser) return;
    this.observer?.disconnect();
    const targets = items
      .map((i) => document.getElementById(i.id))
      .filter((el): el is HTMLElement => !!el);
    if (!targets.length) return;

    // Top-band root margin: a section counts as "active" when its
    // top edge is between 10% and 60% down the viewport. This
    // produces the expected behavior where scrolling slowly into a
    // section's headline flips the active marker before the section
    // fills the screen.
    this.observer = new IntersectionObserver(
      (entries) => {
        // We can have multiple entries firing for the same scroll —
        // pick the one closest to the top of the viewport that's
        // currently intersecting.
        const intersecting = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (intersecting.length) {
          const id = intersecting[0].target.id;
          if (id && id !== this.activeId()) this.activeId.set(id);
        }
      },
      { rootMargin: '-10% 0px -40% 0px', threshold: 0 }
    );
    for (const t of targets) this.observer.observe(t);
  }

  /**
   * Smooth-scroll on link click instead of the default jump. Updates
   * the URL hash so the user can copy/share the deep link, but we
   * intercept the default scroll (which is instant) and use the
   * smooth-scroll behavior for a calmer UX.
   */
  onClick(ev: MouseEvent, id: string): void {
    if (!this.isBrowser) return;
    const el = document.getElementById(id);
    if (!el) return;
    ev.preventDefault();
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Update the URL hash so the link is shareable and the browser
    // history pushes a state. `history.replaceState` (not pushState)
    // because we don't want every TOC click to add a back-button stop.
    try {
      history.replaceState(null, '', '#' + id);
    } catch {
      /* SSR or sandboxed iframe — no-op */
    }
    this.activeId.set(id);
  }
}
