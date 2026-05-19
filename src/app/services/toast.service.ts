import { Injectable, signal } from '@angular/core';

export type ToastVariant = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
  /** Auto-dismiss in ms. 0 = sticky until clicked. */
  ttl: number;
  /** Optional inline action (button label + handler). */
  action?: { label: string; run: () => void };
  createdAt: number;
}

/**
 * Global toast notification service.
 *
 * Design goals:
 *   - One-liner API: `toast.success('Copied!')`, `toast.error(...)`.
 *   - Stackable: the host renders all active toasts bottom-up.
 *   - Accessible: variants map to aria-live politeness (`assertive` for error,
 *     `polite` for the rest). The host owns the actual live region.
 *   - Time-aware: each toast has its own TTL; the host uses the signal to
 *     drive animations. Auto-dismiss is handled here so the component stays
 *     stateless and SSR-safe.
 *
 * Not coupled to Angular Material or any UI kit — everything is plain
 * signals + TypeScript, renderable by any host component.
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly items = signal<Toast[]>([]);

  success(message: string, opts: Partial<Toast> = {}): string {
    return this.push({ variant: 'success', ttl: 3500, ...opts, message });
  }
  error(message: string, opts: Partial<Toast> = {}): string {
    return this.push({ variant: 'error', ttl: 6000, ...opts, message });
  }
  info(message: string, opts: Partial<Toast> = {}): string {
    return this.push({ variant: 'info', ttl: 3500, ...opts, message });
  }
  warning(message: string, opts: Partial<Toast> = {}): string {
    return this.push({ variant: 'warning', ttl: 5000, ...opts, message });
  }

  /** Dismiss a specific toast. No-op if it's already gone. */
  dismiss(id: string): void {
    this.items.update((list) => list.filter((t) => t.id !== id));
  }

  /** Clear everything (useful on route change for transient toasts). */
  clear(): void {
    this.items.set([]);
  }

  private push(partial: Partial<Toast> & { message: string; variant: ToastVariant; ttl: number }): string {
    const toast: Toast = {
      id: this.uuid(),
      createdAt: Date.now(),
      message: partial.message,
      variant: partial.variant,
      ttl: partial.ttl,
      action: partial.action
    };
    this.items.update((list) => [...list, toast]);
    if (toast.ttl > 0) {
      // Use queueMicrotask + setTimeout so it works under zoneless Angular.
      setTimeout(() => this.dismiss(toast.id), toast.ttl);
    }
    return toast.id;
  }

  private uuid(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
    return 't-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }
}
