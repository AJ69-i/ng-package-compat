import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  PLATFORM_ID,
  inject,
  signal
} from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { TranslocoModule } from '@jsverse/transloco';
import { ShortcutsService } from '../../services/shortcuts.service';

/**
 * Modal cheat-sheet overlay listing every keyboard shortcut in the app.
 *
 * Open via:
 *   - Pressing `?` anywhere outside an input
 *   - Calling `shortcuts.openHelp()`
 *   - Clicking the "?" chip in the navbar (bound separately)
 *
 * Close via Esc, clicking the backdrop, or clicking the X.
 *
 * Self-contained: the template iterates `shortcuts.grouped()` and renders each
 * group as a section. Adding a new shortcut anywhere in the app surfaces it
 * here for free.
 */
@Component({
  selector: 'app-shortcuts-help',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, TranslocoModule],
  template: `
    @if (shortcuts.helpOpen()) {
      <div class="backdrop" (click)="close()" role="presentation"></div>
      <div class="dialog" role="dialog" aria-modal="true" [attr.aria-label]="'shortcuts.title' | transloco">
        <header>
          <h2>{{ 'shortcuts.title' | transloco }}</h2>
          <button type="button" class="close" aria-label="Close" (click)="close()">×</button>
        </header>
        <div class="grid">
          @for (section of sections; track section.group) {
            @if (section.items.length) {
              <section>
                <h3>{{ 'shortcuts.group.' + section.group | transloco }}</h3>
                <ul>
                  @for (s of section.items; track s.description) {
                    <li>
                      <span class="desc">{{ s.description }}</span>
                      <span class="keys">
                        @for (k of s.keys; track $index; let i = $index) {
                          @if (i > 0) { <span class="plus">+</span> }
                          <kbd>{{ k }}</kbd>
                        }
                      </span>
                    </li>
                  }
                </ul>
              </section>
            }
          }
        </div>
        <footer>
          <small>{{ 'shortcuts.tip' | transloco }}</small>
        </footer>
      </div>
    }
  `,
  styles: [
    `
      :host { display: contents; }
      .backdrop {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.38);
        backdrop-filter: blur(3px);
        -webkit-backdrop-filter: blur(3px);
        z-index: 70;
        animation: fade-in 0.15s ease-out;
      }
      .dialog {
        position: fixed;
        top: 50%; left: 50%;
        transform: translate(-50%, -50%);
        width: min(640px, 94vw);
        max-height: 80vh;
        overflow: auto;
        background: var(--surface-1, #fff);
        color: var(--fg, #111);
        border-radius: 16px;
        box-shadow: 0 24px 48px rgba(0,0,0,0.3);
        z-index: 71;
        padding: 1.25rem 1.5rem 1rem;
        animation: pop-in 0.22s cubic-bezier(.2,.8,.2,1);
      }
      @media (prefers-reduced-motion: reduce) {
        .backdrop, .dialog { animation: none; }
      }
      @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
      @keyframes pop-in {
        from { transform: translate(-50%, -45%) scale(0.96); opacity: 0; }
        to { transform: translate(-50%, -50%) scale(1); opacity: 1; }
      }
      header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem; }
      header h2 { margin: 0; font-size: 1.2rem; }
      .close {
        background: none; border: none; font-size: 1.5rem;
        cursor: pointer; color: var(--fg-dim, #666); padding: 0 0.25rem;
      }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1rem 1.25rem; }
      section h3 {
        font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.08em;
        color: var(--accent, #6366f1); margin: 0 0 0.35rem;
      }
      ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.4rem; }
      li {
        display: flex; align-items: center; justify-content: space-between; gap: 1rem;
        font-size: 0.88rem; color: var(--fg, #111);
      }
      .desc { color: var(--fg-dim, #555); }
      .keys { display: inline-flex; align-items: center; gap: 0.25rem; }
      kbd {
        background: var(--surface-2, #f3f4f6);
        border: 1px solid var(--border, #d1d5db);
        border-radius: 5px;
        padding: 2px 8px;
        font-family: ui-monospace, "SF Mono", monospace;
        font-size: 0.78rem;
        font-weight: 600;
        color: var(--fg, #111);
      }
      .plus { color: var(--fg-dim, #999); font-size: 0.78rem; }
      footer { margin-top: 1rem; color: var(--fg-dim, #777); text-align: center; }
    `
  ]
})
export class ShortcutsHelpComponent {
  protected readonly shortcuts = inject(ShortcutsService);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  get sections() {
    const g = this.shortcuts.grouped();
    return [
      { group: 'Navigation', items: g.Navigation },
      { group: 'Analysis', items: g.Analysis },
      { group: 'Export', items: g.Export },
      { group: 'Help', items: g.Help }
    ] as const;
  }

  /**
   * Global `?` listener. Skips form fields so typing a `?` in a textarea
   * still goes to the textarea.
   */
  @HostListener('window:keydown', ['$event'])
  onKeyDown(ev: KeyboardEvent): void {
    if (!this.isBrowser) return;
    if (ev.key === 'Escape' && this.shortcuts.helpOpen()) {
      this.close();
      ev.preventDefault();
      return;
    }
    if (ev.key !== '?') return;
    const tag = (ev.target as HTMLElement | null)?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || (ev.target as HTMLElement)?.isContentEditable) {
      return;
    }
    this.shortcuts.toggleHelp();
    ev.preventDefault();
  }

  close(): void {
    this.shortcuts.closeHelp();
  }
}
