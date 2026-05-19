import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

export type EmptyStateIcon = 'search' | 'inbox' | 'package' | 'star' | 'history' | 'error';

/**
 * Reusable empty-state panel.
 *
 * Signature: `<app-empty-state icon="search" title="…" description="…">
 *              <ng-content> // CTAs go here </ng-content>
 *            </app-empty-state>`
 *
 * The SVG icons are inlined (no external asset fetch) so the empty state
 * renders instantly on first paint — important because empty states often
 * appear above the fold before any data has arrived.
 *
 * Consumers drop CTAs (buttons, links) as children and they land in a
 * `.actions` row beneath the description.
 */
@Component({
  selector: 'app-empty-state',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  template: `
    <div class="empty" role="status">
      <div class="art" aria-hidden="true" [innerHTML]="artFor(icon)"></div>
      <h3>{{ title }}</h3>
      @if (description) { <p>{{ description }}</p> }
      <div class="actions">
        <ng-content></ng-content>
      </div>
    </div>
  `,
  styles: [
    `
      :host { display: block; }
      .empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        padding: clamp(2.5rem, 5vw, 4rem) clamp(1rem, 3vw, 2rem);
        color: var(--fg, #111);
        animation: empty-fade-in 280ms cubic-bezier(0.2, 0.6, 0.2, 1) both;
      }
      .art {
        width: 128px;
        height: 128px;
        margin-bottom: 1.25rem;
        /* Soft halo behind the illustration anchors it visually. */
        background:
          radial-gradient(closest-side, var(--accent-bg, rgba(99,102,241,0.18)), transparent 70%);
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      /* Icon SVG is injected via [innerHTML]; ::ng-deep punches through
         component encapsulation only inside the host's .art wrapper, so
         the bleed stays scoped. */
      .art ::ng-deep svg { width: 78%; height: 78%; display: block; }
      h3 {
        margin: 0 0 0.4rem;
        font-size: 1.18rem;
        font-weight: 600;
        letter-spacing: -0.01em;
      }
      p {
        margin: 0 0 1.25rem;
        color: var(--fg-dim, #555);
        max-width: 48ch;
        line-height: 1.55;
      }
      .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; justify-content: center; }
      @keyframes empty-fade-in {
        from { opacity: 0; transform: translateY(6px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      @media (prefers-reduced-motion: reduce) {
        .empty { animation: none; }
      }
    `
  ]
})
export class EmptyStateComponent {
  @Input() icon: EmptyStateIcon = 'inbox';
  @Input({ required: true }) title!: string;
  @Input() description?: string;

  artFor(icon: EmptyStateIcon): string {
    const accent = 'var(--accent, #6366f1)';
    const dim = 'var(--fg-dim, #94a3b8)';
    switch (icon) {
      case 'search':
        return /* svg */ `
          <svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="54" cy="54" r="30" stroke="${accent}" stroke-width="5" opacity="0.85"/>
            <path d="M76 76l22 22" stroke="${accent}" stroke-width="7" stroke-linecap="round"/>
            <circle cx="54" cy="54" r="14" fill="${accent}" opacity="0.12"/>
          </svg>`;
      case 'inbox':
        return `
          <svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="16" y="30" width="88" height="62" rx="10" stroke="${accent}" stroke-width="5"/>
            <path d="M16 66h32l6 10h12l6-10h32" stroke="${accent}" stroke-width="5"/>
            <circle cx="60" cy="18" r="6" fill="${dim}" opacity="0.6"/>
          </svg>`;
      case 'package':
        return `
          <svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M60 14l40 22v48L60 106 20 84V36l40-22z" stroke="${accent}" stroke-width="5"/>
            <path d="M20 36l40 22 40-22M60 58v48" stroke="${accent}" stroke-width="5"/>
          </svg>`;
      case 'star':
        return `
          <svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M60 14l13.5 27.5L104 46l-22 21.4 5.2 30.3L60 84.4 32.8 97.7 38 67.4 16 46l30.5-4.5L60 14z"
              stroke="${accent}" stroke-width="5" fill="${accent}" fill-opacity="0.14" stroke-linejoin="round"/>
          </svg>`;
      case 'history':
        return `
          <svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="60" cy="60" r="42" stroke="${accent}" stroke-width="5"/>
            <path d="M60 34v28l18 10" stroke="${accent}" stroke-width="5" stroke-linecap="round"/>
          </svg>`;
      case 'error':
        return `
          <svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="60" cy="60" r="42" stroke="#d93025" stroke-width="5"/>
            <path d="M60 38v32" stroke="#d93025" stroke-width="6" stroke-linecap="round"/>
            <circle cx="60" cy="82" r="4" fill="#d93025"/>
          </svg>`;
    }
  }
}
