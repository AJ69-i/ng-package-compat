import {
  Directive,
  ElementRef,
  EventEmitter,
  HostBinding,
  HostListener,
  Input,
  Output,
  inject
} from '@angular/core';

/**
 * Swipe-to-dismiss gesture directive.
 *
 * Usage on a toast, notification, card, or list row:
 *   <div appSwipeToDismiss (dismissed)="onClose()">…</div>
 *
 * Behavior:
 *   - Tracks horizontal pointer delta while the user drags.
 *   - Applies a live translateX + fading opacity for visual feedback.
 *   - On release: if the drag exceeds `threshold` px OR velocity exceeds
 *     `velocityThreshold` px/ms, emits `dismissed` and animates out.
 *   - Under-threshold drags snap back with a short transition.
 *
 * Works for both pointer events (desktop trackpads, Surface) and touch (iOS,
 * Android). Mouse drag is optional — default off to avoid conflicting with
 * desktop selection.
 */
@Directive({
  selector: '[appSwipeToDismiss]',
  standalone: true
})
export class SwipeToDismissDirective {
  private readonly host = inject(ElementRef<HTMLElement>);

  /** Horizontal distance (px) required to trigger dismiss. */
  @Input() threshold = 80;

  /** Pixels/ms — fast flicks still dismiss even below the distance threshold. */
  @Input() velocityThreshold = 0.5;

  /** Only react to touch events (default); set true to include mouse drags. */
  @Input() enableMouse = false;

  /** Direction: start=LTR swipes toward inline-start, end=LTR toward inline-end, both. */
  @Input() direction: 'start' | 'end' | 'both' = 'both';

  @Output() dismissed = new EventEmitter<void>();

  @HostBinding('style.touchAction') hostTouchAction = 'pan-y';

  private startX = 0;
  private startY = 0;
  private startTime = 0;
  private dragging = false;
  private width = 0;
  private locked: 'x' | 'y' | null = null;

  @HostListener('pointerdown', ['$event'])
  onPointerDown(ev: PointerEvent): void {
    if (ev.pointerType === 'mouse' && !this.enableMouse) return;
    // Ignore drags initiated on interactive children (buttons, links) so they
    // still register their clicks.
    const tag = (ev.target as HTMLElement | null)?.tagName?.toLowerCase();
    if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'textarea') return;

    this.dragging = true;
    this.startX = ev.clientX;
    this.startY = ev.clientY;
    this.startTime = performance.now();
    this.width = this.host.nativeElement.offsetWidth || 1;
    this.locked = null;
    this.host.nativeElement.style.transition = 'none';
    try { (ev.target as Element | null)?.setPointerCapture?.(ev.pointerId); } catch { /* ignore */ }
  }

  @HostListener('pointermove', ['$event'])
  onPointerMove(ev: PointerEvent): void {
    if (!this.dragging) return;
    const dx = ev.clientX - this.startX;
    const dy = ev.clientY - this.startY;

    if (this.locked === null) {
      // Lock axis on first substantive movement.
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      this.locked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (this.locked === 'y') { this.reset(); this.dragging = false; return; }
    }

    if (!this.directionAllows(dx)) return;

    const opacity = Math.max(0.25, 1 - Math.abs(dx) / (this.width * 0.8));
    this.host.nativeElement.style.transform = `translateX(${dx}px)`;
    this.host.nativeElement.style.opacity = String(opacity);
  }

  @HostListener('pointerup', ['$event'])
  @HostListener('pointercancel', ['$event'])
  onPointerUp(ev: PointerEvent): void {
    if (!this.dragging) return;
    const dx = ev.clientX - this.startX;
    const dt = Math.max(1, performance.now() - this.startTime);
    const velocity = Math.abs(dx) / dt;
    this.dragging = false;
    this.host.nativeElement.style.transition = 'transform 220ms ease, opacity 220ms ease';

    const passesDistance = Math.abs(dx) >= this.threshold;
    const passesVelocity = velocity >= this.velocityThreshold && Math.abs(dx) > 30;

    if (this.directionAllows(dx) && (passesDistance || passesVelocity)) {
      const flyTo = dx < 0 ? -this.width * 1.1 : this.width * 1.1;
      this.host.nativeElement.style.transform = `translateX(${flyTo}px)`;
      this.host.nativeElement.style.opacity = '0';
      setTimeout(() => this.dismissed.emit(), 210);
    } else {
      this.reset();
    }
  }

  private reset(): void {
    const el = this.host.nativeElement;
    el.style.transition = 'transform 180ms ease, opacity 180ms ease';
    el.style.transform = 'translateX(0)';
    el.style.opacity = '1';
  }

  private directionAllows(dx: number): boolean {
    if (this.direction === 'both') return true;
    const isRtl = getComputedStyle(this.host.nativeElement).direction === 'rtl';
    const isStart = isRtl ? dx > 0 : dx < 0;
    if (this.direction === 'start') return isStart;
    if (this.direction === 'end') return !isStart;
    return true;
  }
}
