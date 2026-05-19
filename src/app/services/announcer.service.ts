import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

export type AnnouncerPoliteness = 'polite' | 'assertive';

/**
 * A single screen-reader announcer service that owns one live region per
 * politeness level and exposes one `say()` method.
 *
 * Why a dedicated service instead of sprinkling `role=status` across the
 * template:
 *   - Exactly two live regions exist in the whole document, which screen
 *     readers handle much more reliably than dozens of tiny ones.
 *   - We re-use the same node for every message; changing the text content
 *     is what triggers the announcement, so we don't leak DOM.
 *   - SSR-safe — during prerender `say()` is a no-op.
 *
 * Coexistence with toasts: the toast host already has its own live regions
 * for UI-visible messages. Use the announcer for *invisible* context, e.g.
 * "Sorted by release date, descending" after a column header click.
 */
@Injectable({ providedIn: 'root' })
export class AnnouncerService {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private politeNode: HTMLElement | null = null;
  private assertiveNode: HTMLElement | null = null;

  say(message: string, politeness: AnnouncerPoliteness = 'polite'): void {
    if (!this.isBrowser || !message) return;
    const node = politeness === 'assertive' ? this.ensureAssertive() : this.ensurePolite();
    // Flip empty→message to force re-announce if the message hasn't changed.
    node.textContent = '';
    // setTimeout 40ms gives the screen reader's event loop a moment to pick up the diff.
    setTimeout(() => { node.textContent = message; }, 40);
  }

  private ensurePolite(): HTMLElement {
    if (!this.politeNode) this.politeNode = this.createRegion('polite');
    return this.politeNode;
  }

  private ensureAssertive(): HTMLElement {
    if (!this.assertiveNode) this.assertiveNode = this.createRegion('assertive');
    return this.assertiveNode;
  }

  private createRegion(politeness: AnnouncerPoliteness): HTMLElement {
    const el = document.createElement('div');
    el.setAttribute('aria-live', politeness);
    el.setAttribute('role', politeness === 'assertive' ? 'alert' : 'status');
    el.setAttribute('aria-atomic', 'true');
    // Visually hidden but reachable by assistive tech.
    Object.assign(el.style, {
      position: 'absolute',
      width: '1px',
      height: '1px',
      margin: '-1px',
      border: '0',
      padding: '0',
      overflow: 'hidden',
      clip: 'rect(0 0 0 0)',
      clipPath: 'inset(50%)',
      whiteSpace: 'nowrap'
    });
    document.body.appendChild(el);
    return el;
  }
}
