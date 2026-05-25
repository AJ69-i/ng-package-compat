import {
  ChangeDetectionStrategy,
  Component,
  PLATFORM_ID,
  computed,
  inject,
  input,
  signal
} from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import { PackageManagerService } from '../../services/package-manager.service';
import { ToastService } from '../../services/toast.service';

/**
 * Multi-package-manager install strip (Polish #3).
 *
 * One-tap copy of the install command for any of npm / yarn / pnpm /
 * bun / ng-add. Replaces the older single-line install command which
 * silently committed users to whichever PM their preference was set
 * to — fine for one project, frustrating when copy-pasting commands
 * to a teammate who uses a different manager.
 *
 * # Why this is its own component
 *
 * Three reasons:
 *   1. Reuse — the Recommendation Card and the dependencies-page
 *      detail view will both want a tabbed install strip eventually,
 *      so isolating it now lets them adopt it later without churn.
 *   2. Defer — wrapped in @defer on the search page so the strip
 *      doesn't ship in the initial JS for users who land on /search
 *      and bounce without scrolling.
 *   3. A11Y discipline — tab-list + tab + tabpanel pattern needs
 *      careful ARIA wiring; keeping it isolated lets us audit the
 *      pattern once and reuse it.
 *
 * # The "ng add" tab
 *
 * Surfaced ONLY when the target package ships an `ng add` schematic
 * (`supportsNgAdd === true`). The order matters: when ng-add is
 * available, we put that tab FIRST and pre-select it because for
 * Angular packages it's almost always what the user wants — it
 * configures imports, providers, polyfills, and module wiring
 * automatically, which a bare `npm install` does not. For non-
 * Angular packages the tab simply isn't rendered.
 *
 * # Defaults
 *
 * - When ng-add is supported → ng-add is the default active tab.
 * - When ng-add is NOT supported → use the user's saved preference
 *   from PackageManagerService (npm/yarn/pnpm/bun).
 *
 * The active tab is local component state — flipping tabs here does
 * NOT mutate the user's global PM preference. That's intentional:
 * "I want to copy a yarn command this one time" shouldn't reconfigure
 * the rest of the app's install hints.
 */

type TabId = 'npm' | 'yarn' | 'pnpm' | 'bun' | 'ng-add';

interface Tab {
  id: TabId;
  /** Pre-translated label shown on the tab button. */
  label: string;
  /** Command text to display + copy. */
  command: string;
}

@Component({
  selector: 'app-install-strip',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TranslocoModule],
  template: `
    @if (visible()) {
      <section class="install-strip" [attr.aria-label]="'installStrip.aria' | transloco">
        <div
          class="tabs"
          role="tablist"
          [attr.aria-label]="'installStrip.tabsAria' | transloco"
        >
          @for (t of tabs(); track t.id) {
            <button
              type="button"
              class="tab"
              [class.active]="active() === t.id"
              [class.tab-ng-add]="t.id === 'ng-add'"
              role="tab"
              [attr.aria-selected]="active() === t.id"
              [attr.aria-controls]="'install-panel-' + t.id"
              [id]="'install-tab-' + t.id"
              [tabindex]="active() === t.id ? 0 : -1"
              (click)="setActive(t.id)"
              (keydown)="onTabKey($event, t.id)"
            >
              @if (t.id === 'ng-add') {
                <span class="ng-mark" aria-hidden="true">▲</span>
              }
              {{ t.label }}
            </button>
          }
        </div>

        @if (activeTab(); as t) {
          <div
            class="panel"
            role="tabpanel"
            [id]="'install-panel-' + t.id"
            [attr.aria-labelledby]="'install-tab-' + t.id"
          >
            <code class="cmd">
              <span class="prompt" aria-hidden="true">$</span>
              <span class="cmd-text">{{ t.command }}</span>
            </code>
            <button
              type="button"
              class="copy-btn"
              [class.copied]="copiedTab() === t.id"
              (click)="copy(t)"
              [attr.aria-label]="('installStrip.copyAria' | transloco: { pm: t.label })"
            >
              @if (copiedTab() === t.id) {
                <span aria-hidden="true">✓</span>
                <span class="lbl">{{ 'installStrip.copied' | transloco }}</span>
              } @else {
                <span aria-hidden="true">⧉</span>
                <span class="lbl">{{ 'installStrip.copy' | transloco }}</span>
              }
            </button>
          </div>
          @if (t.id === 'ng-add') {
            <p class="ng-hint">{{ 'installStrip.ngAddHint' | transloco }}</p>
          }
        }
      </section>
    }
  `,
  styles: [`
    :host { display: block; margin-top: 1rem; }

    .install-strip {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg, 12px);
      overflow: hidden;
    }

    /* Tab row — horizontal scroll on mobile to keep the tabs on one
       line at very narrow widths without wrapping awkwardly. */
    .tabs {
      display: flex;
      gap: 0;
      background: var(--surface-1);
      border-bottom: 1px solid var(--border);
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
    }
    .tabs::-webkit-scrollbar { display: none; }

    .tab {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.6rem 1rem;
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--fg-dim);
      font: inherit;
      font-size: 0.85rem;
      font-weight: 600;
      letter-spacing: 0.01em;
      cursor: pointer;
      transition: color 140ms var(--ease, ease),
                  border-color 140ms var(--ease, ease),
                  background-color 140ms var(--ease, ease);
      min-height: 38px;
      white-space: nowrap;
    }
    .tab:hover { color: var(--fg); background: var(--surface-2); }
    .tab:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    .tab.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
      background: var(--surface-2);
    }

    /* ng add tab gets a subtle accent glow to communicate "this is
       the Angular-native option". The red triangle is the Angular
       wordmark hint without being a literal logo. */
    .tab.tab-ng-add {
      color: color-mix(in srgb, var(--accent) 70%, var(--fg));
    }
    .tab.tab-ng-add.active {
      color: var(--accent);
      background: color-mix(in srgb, var(--accent) 10%, var(--surface-2));
    }
    .ng-mark {
      color: var(--accent);
      font-size: 0.7rem;
      line-height: 1;
    }

    .panel {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.7rem 0.9rem;
    }

    .cmd {
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      flex: 1 1 auto;
      min-width: 0;
      padding: 0.5rem 0.7rem;
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-md, 10px);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.83rem;
      color: var(--fg);
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    .prompt {
      color: var(--fg-dim);
      flex: 0 0 auto;
      user-select: none;
    }
    .cmd-text {
      flex: 1 1 auto;
      white-space: nowrap;
    }

    .copy-btn {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.45rem 0.8rem;
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-md, 10px);
      color: var(--fg);
      font: inherit;
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      transition: background-color 140ms var(--ease, ease),
                  border-color 140ms var(--ease, ease),
                  color 140ms var(--ease, ease);
      min-height: 36px;
    }
    .copy-btn:hover {
      background: var(--surface-2);
      border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
      color: var(--accent);
    }
    .copy-btn:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .copy-btn.copied {
      background: color-mix(in srgb, var(--ok) 12%, var(--surface-1));
      border-color: color-mix(in srgb, var(--ok) 45%, var(--border));
      color: var(--ok);
    }
    .copy-btn .lbl { white-space: nowrap; }

    .ng-hint {
      margin: 0 0.9rem 0.7rem;
      padding: 0.5rem 0.75rem;
      background: color-mix(in srgb, var(--accent) 6%, var(--surface-1));
      border: 1px dashed color-mix(in srgb, var(--accent) 35%, var(--border));
      border-radius: var(--radius-sm, 6px);
      color: var(--fg-dim);
      font-size: 0.78rem;
      line-height: 1.5;
    }

    /* Mobile: panel stacks vertically so the copy button gets full
       width and isn't squeezed by long commands. */
    @media (max-width: 560px) {
      .panel {
        flex-direction: column;
        align-items: stretch;
        gap: 0.55rem;
      }
      .copy-btn {
        width: 100%;
        justify-content: center;
        min-height: 40px;
      }
      .cmd {
        font-size: 0.78rem;
      }
      .tab {
        padding: 0.55rem 0.85rem;
        font-size: 0.82rem;
      }
    }
  `]
})
export class InstallStripComponent {
  /** npm package name (e.g. "@angular/material"). */
  readonly pkgName = input.required<string>();
  /** Latest published version. */
  readonly version = input<string | null>(null);
  /**
   * True when the package ships an `ng add` schematic. Drives whether
   * the ng-add tab is rendered (and pre-selected).
   */
  readonly supportsNgAdd = input<boolean>(false);

  private readonly pmSvc = inject(PackageManagerService);
  private readonly toast = inject(ToastService);
  private readonly transloco = inject(TranslocoService);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** Currently active tab — local component state, not the global pm pref. */
  readonly active = signal<TabId>('npm');

  /** Toggled briefly after a successful copy to show the "✓ Copied" affordance. */
  readonly copiedTab = signal<TabId | null>(null);

  /**
   * Compose the tabs from the supportsNgAdd input. ng-add comes first
   * when present so it's pre-selected; the four package-managers
   * follow in popularity order (npm by far the most installed across
   * the npm registry's published download stats).
   *
   * Each command is computed against the resolved name + version,
   * matching what PackageManagerService would produce — but we build
   * the strings inline here so we don't have to toggle the service's
   * global pm signal just to render one command.
   */
  readonly tabs = computed<Tab[]>(() => {
    const name = this.pkgName();
    const ver = this.version();
    const spec = ver ? `${name}@${ver}` : name;
    const list: Tab[] = [];
    if (this.supportsNgAdd()) {
      list.push({
        id: 'ng-add',
        label: 'ng add',
        command: `ng add ${spec}`
      });
    }
    list.push(
      { id: 'npm', label: 'npm', command: `npm install ${spec}` },
      { id: 'yarn', label: 'yarn', command: `yarn add ${spec}` },
      { id: 'pnpm', label: 'pnpm', command: `pnpm add ${spec}` },
      { id: 'bun', label: 'bun', command: `bun add ${spec}` }
    );
    return list;
  });

  /** Hides the entire strip if we don't yet have a package name. */
  readonly visible = computed<boolean>(() => !!this.pkgName());

  /** Lookup the active tab object so the template binds clean refs. */
  readonly activeTab = computed<Tab | undefined>(() => {
    const id = this.active();
    return this.tabs().find((t) => t.id === id);
  });

  constructor() {
    // Initialise the active tab: ng-add first if available, else the
    // user's preferred PM (from PackageManagerService). We do this
    // once at construction — re-running on every signal change would
    // fight the user every time they switched tabs.
    this.active.set(this.computeInitialActive());
  }

  private computeInitialActive(): TabId {
    if (this.supportsNgAdd()) return 'ng-add';
    const pm = this.pmSvc.pm();
    if (pm === 'yarn' || pm === 'pnpm' || pm === 'bun') return pm;
    return 'npm';
  }

  setActive(id: TabId): void {
    this.active.set(id);
  }

  /**
   * Keyboard navigation for the tab row — arrow keys cycle, Home/End
   * jump to ends. Matches the WAI-ARIA Authoring Practices for
   * tab-list patterns so screen-reader + keyboard users get the
   * expected behavior.
   */
  onTabKey(ev: KeyboardEvent, id: TabId): void {
    const ids = this.tabs().map((t) => t.id);
    const i = ids.indexOf(id);
    if (i < 0) return;
    let next = i;
    switch (ev.key) {
      case 'ArrowRight': next = (i + 1) % ids.length; break;
      case 'ArrowLeft':  next = (i - 1 + ids.length) % ids.length; break;
      case 'Home':       next = 0; break;
      case 'End':        next = ids.length - 1; break;
      default: return;
    }
    ev.preventDefault();
    this.active.set(ids[next]);
    // Move focus to the new active tab button so keyboard users see
    // the focus ring track their selection. Defer one tick so the
    // template re-renders the `[tabindex]` changes first.
    if (this.isBrowser) {
      queueMicrotask(() => {
        const el = document.getElementById('install-tab-' + ids[next]);
        el?.focus();
      });
    }
  }

  async copy(t: Tab): Promise<void> {
    if (!this.isBrowser) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(t.command);
      ok = true;
    } catch {
      // execCommand fallback for older Safari + locked-down browsers.
      try {
        const ta = document.createElement('textarea');
        ta.value = t.command;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    if (ok) {
      this.copiedTab.set(t.id);
      this.toast.success(
        this.transloco.translate('installStrip.copiedToast', { pm: t.label }),
        { ttl: 1800 }
      );
      window.setTimeout(() => {
        if (this.copiedTab() === t.id) this.copiedTab.set(null);
      }, 1800);
    } else {
      this.toast.error(this.transloco.translate('installStrip.copyFailed'));
    }
  }
}
