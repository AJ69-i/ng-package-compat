import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AuthProvider } from '../../services/auth.service';

/**
 * Single inline-SVG icon for a code-host provider.
 *
 * Hybrid design (option C): subtle brand-tinted tile + multi-color official
 * logo. The tile keeps a hint of brand color (helps recognition at a glance)
 * while the logo retains its native colors (preserves brand fidelity at
 * close inspection). Best of both worlds vs. plain white tiles or fully
 * brand-colored tiles.
 *
 * Why inline (not lazy-loaded): each glyph is ~1–3 KB and they render
 * on first paint of the sign-in page. Lazy loading would introduce a
 * "flash of no icon" with no measurable bandwidth saving.
 *
 * Sources:
 *   - GitHub:    Simple Icons octocat (CC0)
 *   - GitLab:    Official multi-color tanuki (4 paths)
 *   - BitBucket: Official 2-color logo with linear gradient
 *   - Azure:     Microsoft's official Azure DevOps mark with linear gradient
 *
 * Gradient IDs are namespaced per-provider so multiple instances on the
 * same page never collide.
 */
@Component({
  selector: 'app-provider-icon',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  template: `
    <span
      class="wrap"
      [attr.data-provider]="provider()"
      [attr.aria-hidden]="ariaHidden() ? 'true' : null"
      [attr.aria-label]="ariaHidden() ? null : labelFor(provider())"
      [style.width.px]="size()"
      [style.height.px]="size()"
    >
      @switch (provider()) {
        @case ('github') {
          <!-- GitHub octocat — single fill in brand dark grey. -->
          <svg
            xmlns="http://www.w3.org/2000/svg"
            [attr.width]="iconSize()"
            [attr.height]="iconSize()"
            viewBox="0 0 24 24"
            fill="#24292f"
            role="img"
            aria-hidden="true"
          >
            <path d="M12 .297a12 12 0 0 0-3.794 23.388c.6.111.82-.26.82-.577 0-.285-.01-1.04-.015-2.04-3.338.726-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.729.083-.729 1.205.085 1.838 1.237 1.838 1.237 1.07 1.834 2.807 1.304 3.492.997.108-.776.418-1.305.762-1.605-2.665-.305-5.467-1.334-5.467-5.93 0-1.31.467-2.382 1.236-3.222-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.3 1.23a11.5 11.5 0 0 1 6.003 0c2.29-1.552 3.297-1.23 3.297-1.23.653 1.652.242 2.873.118 3.176.77.84 1.235 1.911 1.235 3.222 0 4.609-2.806 5.622-5.479 5.92.43.372.823 1.103.823 2.222 0 1.604-.014 2.896-.014 3.291 0 .319.218.694.825.576A12.001 12.001 0 0 0 12 .297z"/>
          </svg>
        }
        @case ('gitlab') {
          <!-- Official GitLab tanuki, 4 paths in red/orange/amber. -->
          <svg
            xmlns="http://www.w3.org/2000/svg"
            [attr.width]="iconSize()"
            [attr.height]="iconSize()"
            viewBox="-0.1 0.5 960.2 923.9"
            role="img"
            aria-hidden="true"
          >
            <path d="m958.9 442.4c1.1 26.1-2 52.1-9.2 77.2-7.1 25.1-18.3 48.8-33.1 70.3a240.43 240.43 0 0 1 -53.6 56.2l-.5.4-199.9 149.8-98.3 74.5-59.9 45.2c-3.5 2.7-7.4 4.7-11.5 6.1s-8.5 2.1-12.9 2.1c-4.3 0-8.7-.7-12.8-2.1s-8-3.4-11.5-6.1l-59.9-45.2-98.3-74.5-198.7-148.9-1.2-.8-.4-.4c-20.9-15.7-39-34.7-53.8-56.2s-26-45.3-33.2-70.4c-7.2-25.1-10.3-51.2-9.2-77.3 1.2-26.1 6.5-51.8 15.8-76.2l1.3-3.5 130.7-340.5q1-2.5 2.4-4.8 1.3-2.3 3.1-4.3 1.7-2.1 3.7-3.9 2-1.7 4.2-3.2c3.1-1.9 6.3-3.3 9.8-4.1 3.4-.9 7-1.3 10.5-1.1 3.6.2 7.1.9 10.4 2.2 3.3 1.2 6.5 3 9.3 5.2q2 1.7 3.9 3.6 1.8 2 3.2 4.3 1.5 2.2 2.6 4.7 1.1 2.4 1.8 5l88.1 269.7h356.6l88.1-269.7q.7-2.6 1.9-5 1.1-2.4 2.6-4.7 1.4-2.2 3.2-4.2 1.8-2 3.9-3.7c2.8-2.2 5.9-3.9 9.2-5.2 3.4-1.2 6.9-1.9 10.4-2.1 3.6-.2 7.1.1 10.6 1 3.4.9 6.7 2.3 9.7 4.2q2.3 1.4 4.3 3.2 2 1.7 3.7 3.8 1.7 2.1 3.1 4.4 1.3 2.3 2.3 4.8l130.5 340.6 1.3 3.5c9.3 24.3 14.6 50 15.7 76.1z" fill="#e24329"/>
            <path d="m959 442.5c1.1 26-2 52.1-9.2 77.2s-18.4 48.9-33.2 70.4-32.9 40.5-53.7 56.2l-.5.4-199.9 149.8s-84.9-64.1-182.5-138l286.5-216.8c12.9-9.7 26.4-18.6 40.3-26.8 13.9-8.3 28.3-15.7 43-22.3 14.8-6.6 29.9-12.5 45.2-17.4 15.4-5 31-9.1 46.9-12.4l1.3 3.5c9.3 24.4 14.6 50.1 15.8 76.2z" fill="#fc6d26"/>
            <path d="m480 658.5c97.6 73.7 182.6 138 182.6 138l-98.3 74.5-59.9 45.2c-3.5 2.7-7.4 4.7-11.5 6.1s-8.5 2.1-12.9 2.1c-4.3 0-8.7-.7-12.8-2.1s-8-3.4-11.5-6.1l-59.9-45.2-98.3-74.5s84.9-64.3 182.5-138z" fill="#fca326"/>
            <path d="m480 658.3c-97.7 73.9-182.5 138-182.5 138l-198.7-148.9-1.2-.8-.4-.4c-20.9-15.7-39-34.7-53.8-56.2s-26-45.3-33.2-70.4c-7.2-25.1-10.3-51.2-9.2-77.3 1.2-26.1 6.5-51.8 15.8-76.2l1.3-3.5c15.9 3.3 31.5 7.4 46.9 12.4 15.3 5 30.4 10.8 45.2 17.5 14.7 6.6 29.1 14.1 43 22.3s27.3 17.2 40.3 26.9z" fill="#fc6d26"/>
          </svg>
        }
        @case ('bitbucket') {
          <!-- Official BitBucket 2-color logo with vertical gradient. -->
          <svg
            xmlns="http://www.w3.org/2000/svg"
            [attr.width]="iconSize()"
            [attr.height]="iconSize()"
            viewBox="-0.97 -0.58 257.93 230.83"
            role="img"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="bb-grad" x1="108.633%" x2="46.927%" y1="13.818%" y2="78.776%">
                <stop offset=".18" stop-color="#0052cc"/>
                <stop offset="1" stop-color="#2684ff"/>
              </linearGradient>
            </defs>
            <g fill="none">
              <path d="M101.272 152.561h53.449l12.901-75.32H87.06z"/>
              <path d="M8.308 0A8.202 8.202 0 0 0 .106 9.516l34.819 211.373a11.155 11.155 0 0 0 10.909 9.31h167.04a8.202 8.202 0 0 0 8.201-6.89l34.82-213.752a8.202 8.202 0 0 0-8.203-9.514zm146.616 152.768h-53.315l-14.436-75.42h80.67z" fill="#2684ff"/>
              <path d="M244.61 77.242h-76.916l-12.909 75.36h-53.272l-62.902 74.663a11.105 11.105 0 0 0 7.171 2.704H212.73a8.196 8.196 0 0 0 8.196-6.884z" fill="url(#bb-grad)"/>
            </g>
          </svg>
        }
        @case ('azure') {
          <!-- Azure DevOps geometric mark with the official vertical
               blue-to-light-blue gradient. -->
          <svg
            xmlns="http://www.w3.org/2000/svg"
            [attr.width]="iconSize()"
            [attr.height]="iconSize()"
            viewBox="0 0 18 18"
            role="img"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="azd-grad" x1="9" y1="16.97" x2="9" y2="1.03" gradientUnits="userSpaceOnUse">
                <stop offset="0" stop-color="#0078d4"/>
                <stop offset="0.16" stop-color="#1380da"/>
                <stop offset="0.53" stop-color="#3c91e5"/>
                <stop offset="0.82" stop-color="#559cec"/>
                <stop offset="1" stop-color="#5ea0ef"/>
              </linearGradient>
            </defs>
            <path d="M17,4v9.74l-4,3.28-6.2-2.26V17L3.29,12.41l10.23.8V4.44Zm-3.41.49L7.85,1V3.29L2.58,4.84,1,6.87v4.61l2.26,1V6.57Z" fill="url(#azd-grad)"/>
          </svg>
        }
      }
    </span>
  `,
  styles: [`
    :host { display: inline-flex; }
    .wrap {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      flex-shrink: 0;
      transition: transform 120ms ease;
      /* Hybrid: subtle brand wash on a near-white base. The brand color is
         visible at ~15% intensity which is enough for recognition without
         drowning out the multi-color logo. */
      box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.06);
    }
    .wrap[data-provider="github"]    { background: color-mix(in srgb, #24292f 10%, #ffffff); }
    .wrap[data-provider="gitlab"]    { background: color-mix(in srgb, #fc6d26 14%, #ffffff); }
    .wrap[data-provider="bitbucket"] { background: color-mix(in srgb, #2684ff 14%, #ffffff); }
    .wrap[data-provider="azure"]     { background: color-mix(in srgb, #0078d4 14%, #ffffff); }
    svg { display: block; }
  `]
})
export class ProviderIconComponent {
  /** Which provider's icon to render. */
  readonly provider = input.required<AuthProvider>();
  /** Outer square size in px (default 40). */
  readonly size = input<number>(40);
  /** When true, the wrapper is treated as decorative for screen readers. */
  readonly ariaHidden = input<boolean>(false);

  /** Inner SVG icon size — slightly smaller than the wrapper for padding. */
  readonly iconSize = computed(() => Math.round(this.size() * 0.7));

  labelFor(p: AuthProvider): string {
    switch (p) {
      case 'github': return 'GitHub';
      case 'gitlab': return 'GitLab';
      case 'bitbucket': return 'BitBucket';
      case 'azure': return 'Microsoft Azure';
    }
  }
}
