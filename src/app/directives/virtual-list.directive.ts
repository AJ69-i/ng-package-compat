import {
  ChangeDetectorRef,
  Directive,
  ElementRef,
  EmbeddedViewRef,
  Input,
  NgZone,
  OnChanges,
  OnDestroy,
  PLATFORM_ID,
  SimpleChanges,
  TemplateRef,
  ViewContainerRef,
  inject
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

/**
 * Zero-dependency virtual scrolling directive for fixed-height rows.
 *
 * Pattern:
 *   <div class="scroll-host" style="height: 480px; overflow: auto;">
 *     <ng-container
 *       *appVirtualList="rows; itemSize: 48; buffer: 6; let item; let i = index"
 *     >
 *       <div style="height: 48px;">{{ item.name }}</div>
 *     </ng-container>
 *   </div>
 *
 * How it works:
 *   - Measures the scroll host's viewport + scrollTop.
 *   - Computes the visible window [first, last] given `itemSize`.
 *   - Renders only the rows in that window (plus a buffer).
 *   - Pushes a spacer <div> before the rendered rows equal to `first*itemSize`
 *     and sets the scroll host's total scroll height by sizing a trailing
 *     spacer, so the scroll thumb accurately reflects total items.
 *
 * Compared with @angular/cdk/scrolling this is ~25 lines of logic, has zero
 * third-party dependencies, and works fine for the upgrade table's row shape.
 */
@Directive({
  selector: '[appVirtualList]',
  standalone: true
})
export class VirtualListDirective<T> implements OnChanges, OnDestroy {
  @Input('appVirtualList') items: readonly T[] = [];
  @Input('appVirtualListItemSize') itemSize = 44;
  @Input('appVirtualListBuffer') buffer = 6;

  private readonly template = inject(TemplateRef<{ $implicit: T; index: number }>);
  private readonly vcr = inject(ViewContainerRef);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly zone = inject(NgZone);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  private scroller: HTMLElement | null = null;
  private topSpacer: HTMLElement | null = null;
  private bottomSpacer: HTMLElement | null = null;
  private rendered: EmbeddedViewRef<{ $implicit: T; index: number }>[] = [];
  private rafHandle = 0;
  private onScrollBound = () => this.schedule();
  private onResizeBound = () => this.schedule();

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.isBrowser) {
      // SSR fallback: render everything so the page is crawlable.
      this.fallbackRender();
      return;
    }
    this.ensureSpacers();
    this.schedule();
  }

  ngOnDestroy(): void {
    if (this.scroller) {
      this.scroller.removeEventListener('scroll', this.onScrollBound);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.onResizeBound);
    }
    cancelAnimationFrame(this.rafHandle);
    this.clearViews();
    this.topSpacer?.remove();
    this.bottomSpacer?.remove();
    this.topSpacer = null;
    this.bottomSpacer = null;
  }

  private ensureSpacers(): void {
    // The template's comment anchor lives inside the scroll host's
    // flow container; we find the nearest overflow:auto ancestor and insert
    // spacers above / below the anchor to control total content height.
    const anchor = this.host.nativeElement;
    this.scroller = this.findScrollHost(anchor);
    if (!this.scroller) return;

    if (!this.topSpacer) {
      this.topSpacer = document.createElement('div');
      this.topSpacer.setAttribute('aria-hidden', 'true');
      this.topSpacer.style.cssText = 'width:100%;flex:0 0 auto;';
      anchor.parentElement?.insertBefore(this.topSpacer, anchor);
    }
    if (!this.bottomSpacer) {
      this.bottomSpacer = document.createElement('div');
      this.bottomSpacer.setAttribute('aria-hidden', 'true');
      this.bottomSpacer.style.cssText = 'width:100%;flex:0 0 auto;';
      anchor.parentElement?.insertBefore(this.bottomSpacer, anchor.nextSibling);
    }

    this.scroller.addEventListener('scroll', this.onScrollBound, { passive: true });
    window.addEventListener('resize', this.onResizeBound);
  }

  private findScrollHost(el: HTMLElement): HTMLElement | null {
    let cur: HTMLElement | null = el.parentElement;
    while (cur) {
      const style = getComputedStyle(cur);
      if (/(auto|scroll)/.test(style.overflowY)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  private schedule(): void {
    if (!this.isBrowser) return;
    cancelAnimationFrame(this.rafHandle);
    this.zone.runOutsideAngular(() => {
      this.rafHandle = requestAnimationFrame(() => {
        this.zone.run(() => this.render());
      });
    });
  }

  private render(): void {
    const scroller = this.scroller;
    if (!scroller) { this.fallbackRender(); return; }
    const total = this.items.length;
    const itemSize = Math.max(1, this.itemSize);
    const viewportH = scroller.clientHeight;
    const scrollTop = scroller.scrollTop;

    const firstVisible = Math.floor(scrollTop / itemSize);
    const visibleCount = Math.ceil(viewportH / itemSize) + 1;
    const first = Math.max(0, firstVisible - this.buffer);
    const last = Math.min(total, firstVisible + visibleCount + this.buffer);

    if (this.topSpacer) this.topSpacer.style.height = `${first * itemSize}px`;
    if (this.bottomSpacer) this.bottomSpacer.style.height = `${Math.max(0, (total - last) * itemSize)}px`;

    // Replace rendered views in place. Trade-off: we fully clear and recreate
    // when the slice changes. Templates are cheap enough that this is fine for
    // lists in the hundreds; for tens of thousands you'd want a recycler.
    this.clearViews();
    for (let i = first; i < last; i++) {
      const view = this.vcr.createEmbeddedView(this.template, {
        $implicit: this.items[i],
        index: i
      });
      this.rendered.push(view);
    }
    this.cdr.markForCheck();
  }

  private fallbackRender(): void {
    this.clearViews();
    for (let i = 0; i < this.items.length; i++) {
      const view = this.vcr.createEmbeddedView(this.template, {
        $implicit: this.items[i],
        index: i
      });
      this.rendered.push(view);
    }
    this.cdr.markForCheck();
  }

  private clearViews(): void {
    for (const v of this.rendered) v.destroy();
    this.rendered = [];
    this.vcr.clear();
  }

  /** Strict-template ng-template context typing. */
  static ngTemplateContextGuard<T>(
    _dir: VirtualListDirective<T>,
    ctx: unknown
  ): ctx is { $implicit: T; index: number } {
    return true;
  }
}
