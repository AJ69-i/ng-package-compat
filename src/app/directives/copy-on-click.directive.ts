import {
  Directive,
  ElementRef,
  HostListener,
  Input,
  PLATFORM_ID,
  inject
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { ToastService } from '../services/toast.service';

/**
 * One-click copy-to-clipboard directive.
 *
 * Usage:
 *   <code [appCopyOnClick]="'npm i @angular/core@17'">npm i @angular/core@17</code>
 *   <span [appCopyOnClick]="pkg.version" copyLabel="version">{{ pkg.version }}</span>
 *
 * Behavior:
 *   - On click: copies the value (or the element's text content if value is empty).
 *   - Fires a success toast with the copied label.
 *   - Adds a brief ✓ visual confirmation via a data attribute (the host uses
 *     [attr.data-copied] to style the flash).
 *   - Falls back to the textarea + execCommand path in old Safari / Edge.
 *
 * Why a directive and not a service: making copy an interaction primitive —
 * the user sees the code snippet *is* the button — dramatically reduces
 * ceremony. Every install command, every version, every CVE id becomes
 * clickable without an explicit copy button.
 */
@Directive({
  selector: '[appCopyOnClick]',
  standalone: true,
  host: {
    role: 'button',
    tabindex: '0',
    'aria-label': 'Copy to clipboard',
    style: 'cursor: pointer;'
  }
})
export class CopyOnClickDirective {
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly toast = inject(ToastService);

  /** Value to copy. If empty, the host's textContent is copied instead. */
  @Input('appCopyOnClick') value: string | null | undefined;

  /** Shown in the toast, e.g. "version", "install command". */
  @Input() copyLabel = 'value';

  /** Set to `false` to silence the toast (e.g. when an outer handler shows its own). */
  @Input() silent = false;

  @HostListener('click', ['$event'])
  @HostListener('keydown.enter', ['$event'])
  @HostListener('keydown.space', ['$event'])
  async onActivate(ev: Event): Promise<void> {
    if (!this.isBrowser) return;
    ev.preventDefault();
    const value = (this.value ?? this.host.nativeElement.textContent ?? '').trim();
    if (!value) return;

    const ok = await this.copy(value);
    if (!ok) {
      if (!this.silent) this.toast.error('Could not access the clipboard.');
      return;
    }

    // Visual flash — consumers can style [data-copied="true"] however they like.
    this.host.nativeElement.setAttribute('data-copied', 'true');
    setTimeout(() => this.host.nativeElement.removeAttribute('data-copied'), 900);

    if (!this.silent) this.toast.success(`Copied ${this.copyLabel}: ${this.truncate(value)}`);
  }

  private async copy(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fall through */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  private truncate(s: string): string {
    return s.length > 64 ? s.slice(0, 61) + '…' : s;
  }
}
