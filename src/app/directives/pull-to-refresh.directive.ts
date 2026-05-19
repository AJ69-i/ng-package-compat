import {
  Directive,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  Output,
  inject
} from '@angular/core';

/**
 * Pull-to-refresh gesture directive.
 *
 * Apply to a scrollable container. When the user touches the content at the
 * top (scrollTop === 0) and drags down past `threshold` px, emits `refresh`.
 * A small pill-shaped indicator is injected into the host showing live pull
 * progress and a "Release to refresh" affordance at the trigger distance.
 *
 * Usage:
 *   <main appPullToRefresh (refresh)="reload()">…</main>
 */
@Directive({
  selector: '[appPullToRefresh]',
  standalone: true
})
export class PullToRefreshDirective {
  private readonly host = inject(ElementRef<HTMLElement>);

  /** Distance the user must pull to trigger the refresh. */
  @Input() threshold = 80;

  /** Disable on desktop (default). Set false to allow mouse simulation. */
  @Input() touchOnly = true;

  @Output() refresh = new EventEmitter<void>();

  private startY = 0;
  private pulling = false;
  private armed = false;
  private indicator: HTMLElement | null = null;

  @HostListener('touchstart', ['$event'])
  onStart(ev: TouchEvent): void {
    const host = this.host.nativeElement;
    if (host.scrollTop > 0) return;
    this.startY = ev.touches[0]?.clientY ?? 0;
    this.pulling = true;
    this.armed = false;
  }

  @HostListener('touchmove', ['$event'])
  onMove(ev: TouchEvent): void {
    if (!this.pulling) return;
    const y = ev.touches[0]?.clientY ?? 0;
    const dy = y - this.startY;
    if (dy <= 0) { this.cleanup(); return; }
    // Resistance curve — harder to pull past the threshold.
    const travel = dy < this.threshold ? dy : this.threshold + Math.sqrt(dy - this.threshold) * 4;
    this.ensureIndicator();
    if (this.indicator) {
      this.indicator.style.transform = `translate(-50%, ${Math.min(travel, this.threshold + 24)}px)`;
      this.indicator.style.opacity = String(Math.min(1, dy / this.threshold));
      this.armed = dy >= this.threshold;
      this.indicator.textContent = this.armed ? '↻ Release to refresh' : '↓ Pull to refresh';
    }
  }

  @HostListener('touchend')
  @HostListener('touchcancel')
  onEnd(): void {
    if (!this.pulling) return;
    if (this.armed) {
      if (this.indicator) this.indicator.textContent = '⟳ Refreshing…';
      this.refresh.emit();
      setTimeout(() => this.cleanup(), 500);
    } else {
      this.cleanup();
    }
    this.pulling = false;
  }

  @HostListener('mousedown', ['$event'])
  onMouseDown(ev: MouseEvent): void {
    if (this.touchOnly) return;
    const host = this.host.nativeElement;
    if (host.scrollTop > 0) return;
    this.startY = ev.clientY;
    this.pulling = true;
    this.armed = false;
  }

  @HostListener('mousemove', ['$event'])
  onMouseMove(ev: MouseEvent): void {
    if (this.touchOnly || !this.pulling) return;
    this.onMove({ touches: [{ clientY: ev.clientY } as Touch] } as unknown as TouchEvent);
  }

  @HostListener('mouseup')
  @HostListener('mouseleave')
  onMouseUp(): void { if (!this.touchOnly) this.onEnd(); }

  private ensureIndicator(): void {
    if (this.indicator || typeof document === 'undefined') return;
    const el = document.createElement('div');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('role', 'status');
    el.textContent = '↓ Pull to refresh';
    el.style.cssText = `
      position: absolute; top: 0; left: 50%;
      transform: translate(-50%, 0); opacity: 0;
      background: var(--accent, #6366f1); color: #fff;
      padding: 0.3rem 0.75rem; font-size: 0.82rem;
      border-radius: 999px; pointer-events: none;
      box-shadow: 0 6px 18px rgba(0,0,0,0.18);
      transition: opacity 150ms ease;
      z-index: 30;
    `;
    const host = this.host.nativeElement;
    const pos = getComputedStyle(host).position;
    if (pos === 'static') host.style.position = 'relative';
    host.appendChild(el);
    this.indicator = el;
  }

  private cleanup(): void {
    if (this.indicator) {
      this.indicator.remove();
      this.indicator = null;
    }
    this.pulling = false;
    this.armed = false;
  }
}
