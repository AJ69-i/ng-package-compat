import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

/**
 * Minimal, versioned payload that survives a full round trip through the URL.
 *
 * Intentionally small — the URL is the worst place to put 10kB of JSON, so we
 * only persist the *inputs* needed to reproduce the analysis, not the report
 * itself. The app can regenerate the report deterministically from these.
 */
export interface ShareablePayload {
  /** Schema version — increment on breaking changes so old links don't crash. */
  v: number;
  /** Short, trimmed `package.json` text the user analyzed. */
  pkg?: string;
  /** Target Angular major the user picked (e.g. 17). */
  target?: number;
  /** Current Angular major, if the parser couldn't infer it. */
  current?: number;
  /** Selected severity filter on the upgrade page. */
  filter?: 'all' | 'critical' | 'warning' | 'healthy';
  /** Free-form tags the user attached (e.g. "q3-migration"). */
  tags?: string[];
}

const SCHEMA_VERSION = 1;
const HASH_PREFIX = 'share=';
const MAX_PKG_CHARS = 8000; // ~8kB of package.json text is plenty

/**
 * Encode/decode analysis state as a URL hash so users can bookmark or DM a
 * report link without any server-side storage.
 *
 * Why hash (`#share=...`) and not query (`?share=...`):
 *   - Servers never receive the hash (good for privacy/compliance)
 *   - It never triggers a full reload when the app is SPA-routed
 *   - It survives Angular's prerender + the PWA cache cleanly
 *
 * Encoding:
 *   1. JSON-stringify the payload
 *   2. Optionally strip whitespace from the package.json text (it's noise)
 *   3. Base64-URL-encode (replace +,/ with -,_ and drop `=`)
 *   4. Prepend `share=` so we can detect our own links unambiguously
 *
 * We deliberately skip any compression library — keeping the payload small at
 * the source (trimmed package.json, minimal fields) is more robust than
 * shipping a 30kB pako wasm just to save 40% off a 1kB URL.
 */
@Injectable({ providedIn: 'root' })
export class ShareUrlService {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** Encode a payload into a hash fragment (no leading `#`). */
  encode(payload: Omit<ShareablePayload, 'v'>): string {
    const body: ShareablePayload = { v: SCHEMA_VERSION, ...payload };

    // Truncate pkg if crazy-big so we never blow past URL length limits (~32kB).
    if (body.pkg && body.pkg.length > MAX_PKG_CHARS) {
      body.pkg = body.pkg.slice(0, MAX_PKG_CHARS);
    }

    const json = JSON.stringify(body);
    const b64 = this.toBase64Url(json);
    return `${HASH_PREFIX}${b64}`;
  }

  /**
   * Try to decode a share payload from either:
   *   - a raw hash fragment (`share=XYZ` or `#share=XYZ`)
   *   - the current `window.location.hash`
   *
   * Returns `null` if there's nothing to decode or the payload is malformed.
   */
  decode(hashOrNull?: string | null): ShareablePayload | null {
    const source = hashOrNull ?? (this.isBrowser ? window.location.hash : '');
    if (!source) return null;

    const clean = source.startsWith('#') ? source.slice(1) : source;
    if (!clean.startsWith(HASH_PREFIX)) return null;

    try {
      const b64 = clean.slice(HASH_PREFIX.length);
      const json = this.fromBase64Url(b64);
      const parsed = JSON.parse(json) as ShareablePayload;
      if (!parsed || parsed.v !== SCHEMA_VERSION) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** Build a full shareable URL pointing at the current origin + path. */
  buildLink(payload: Omit<ShareablePayload, 'v'>, origin?: string): string {
    const base =
      origin ??
      (this.isBrowser ? `${window.location.origin}${window.location.pathname}` : 'https://ng-compat.app/');
    return `${base}#${this.encode(payload)}`;
  }

  /**
   * Best-effort copy to clipboard — falls back to a textarea + `execCommand`
   * for older Safari. Returns true on success.
   */
  async copyToClipboard(text: string): Promise<boolean> {
    if (!this.isBrowser) return false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // fall through to legacy path
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

  /** Strip the hash after the user has loaded a shared report. */
  clearHash(): void {
    if (!this.isBrowser) return;
    const { origin, pathname, search } = window.location;
    window.history.replaceState(null, '', `${origin}${pathname}${search}`);
  }

  private toBase64Url(input: string): string {
    // Use TextEncoder for correct UTF-8 before base64
    const bytes = new TextEncoder().encode(input);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    const b64 = this.isBrowser ? window.btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  private fromBase64Url(input: string): string {
    const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (input.length % 4)) % 4);
    const binary = this.isBrowser ? window.atob(padded) : Buffer.from(padded, 'base64').toString('binary');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
}
