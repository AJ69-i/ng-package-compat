import { Injectable, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpHeaders } from '@angular/common/http';

/**
 * A single registry binding: "anything under `@scope/*` (or an explicit host prefix)
 * goes to `url` and optionally ships `Authorization: Bearer <token>`."
 *
 * We deliberately mirror `.npmrc` semantics so users can paste-in what they
 * already have (e.g. `@acme:registry=https://npm.acme.co` -> `{ scope: '@acme', url: 'https://npm.acme.co' }`).
 */
export interface RegistryBinding {
  /** e.g. `@acme` — `null` means "apply to every request (this is the default registry)". */
  scope: string | null;
  /** Base URL, e.g. `https://npm.pkg.github.com` — no trailing slash. */
  url: string;
  /** Optional bearer token. Stored locally only; never leaves the browser except in requests the user made. */
  token: string | null;
  /** Free-form label the user set — purely cosmetic. */
  label: string;
}

/** LocalStorage key; keep it short and stable. */
const STORAGE_KEY = 'ngpc.registries.v1';

/** The public npm registry — baked-in fallback. */
const DEFAULT_PUBLIC: RegistryBinding = {
  scope: null,
  url: 'https://registry.npmjs.org',
  token: null,
  label: 'npm (public)'
};

/**
 * Central source of truth for "which npm registry should this request use?"
 *
 * Why it exists: enterprise users with Artifactory / Verdaccio / GitHub Packages
 * (or just a single scoped private mirror) need the whole compatibility tool
 * to hit their registry — otherwise scoped packages 404 and the report is junk.
 * This service lets them configure bindings once, persists them to localStorage,
 * and exposes a lookup API the rest of the app consumes without caring.
 *
 * SSR note: we gate all storage behind `isPlatformBrowser`; server renders with
 * the default registry only, which is exactly what we want (no user-scoped state
 * in a shared cache).
 */
@Injectable({ providedIn: 'root' })
export class RegistryConfigService {
  private readonly platformId = inject(PLATFORM_ID);

  /** All user-configured bindings, *excluding* the default public registry. */
  readonly bindings = signal<RegistryBinding[]>([]);

  /** The effective list, always ending in the public registry as catch-all. */
  readonly effective = computed<RegistryBinding[]>(() => [
    ...this.bindings(),
    DEFAULT_PUBLIC
  ]);

  constructor() {
    if (isPlatformBrowser(this.platformId)) {
      this.load();
    }
  }

  /**
   * Pick the binding that applies to `packageName`. We match scoped names first
   * (`@acme/foo` -> `@acme`), then fall back to the default.
   */
  resolve(packageName: string): RegistryBinding {
    const name = packageName.trim();
    if (name.startsWith('@')) {
      const scope = name.split('/')[0];
      const match = this.bindings().find((b) => b.scope === scope);
      if (match) return match;
    }
    // A binding with `scope: null` that isn't the built-in public one acts as
    // a global override (useful for Verdaccio-in-front-of-npm setups).
    const global = this.bindings().find((b) => b.scope === null);
    if (global) return global;
    return DEFAULT_PUBLIC;
  }

  /**
   * Build the URL to fetch `packageName` from its resolved registry. Handles
   * scope URL-encoding the same way npm does.
   */
  buildUrl(packageName: string): string {
    const binding = this.resolve(packageName);
    const name = packageName.trim();
    const encoded = name.startsWith('@')
      ? '@' + encodeURIComponent(name.slice(1))
      : encodeURIComponent(name);
    const base = binding.url.replace(/\/+$/, '');
    return `${base}/${encoded}`;
  }

  /**
   * Build HTTP headers for `packageName`. If the binding has a token we attach
   * `Authorization: Bearer <token>`, matching how GitHub Packages / Artifactory
   * authenticate registry GETs.
   */
  buildHeaders(packageName: string): HttpHeaders | undefined {
    const binding = this.resolve(packageName);
    if (!binding.token) return undefined;
    return new HttpHeaders({ Authorization: `Bearer ${binding.token}` });
  }

  addBinding(binding: RegistryBinding): void {
    // Upsert by scope (so `@acme` only ever has one active binding).
    const next = this.bindings().filter((b) => b.scope !== binding.scope);
    next.push(this.normalize(binding));
    this.bindings.set(next);
    this.persist();
  }

  removeBinding(scope: string | null): void {
    this.bindings.set(this.bindings().filter((b) => b.scope !== scope));
    this.persist();
  }

  clearAll(): void {
    this.bindings.set([]);
    this.persist();
  }

  /**
   * Import a subset of `.npmrc` syntax. We only look for two things:
   *   @scope:registry=https://...
   *   //host/path/:_authToken=xxxxx  (maps to the most recently-seen registry)
   * This is enough for 99% of enterprise setups without re-implementing npm.
   */
  importNpmrc(content: string): number {
    const lines = content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith(';'));

    const scopedRegistries: Array<{ scope: string; url: string }> = [];
    const tokens: Array<{ host: string; token: string }> = [];

    for (const line of lines) {
      const scoped = /^(@[^:]+):registry=(.+)$/.exec(line);
      if (scoped) {
        scopedRegistries.push({ scope: scoped[1], url: scoped[2].trim() });
        continue;
      }
      const auth = /^\/\/([^/]+\/?[^:]*):_authToken=(.+)$/.exec(line);
      if (auth) {
        tokens.push({ host: auth[1].replace(/\/$/, ''), token: auth[2].trim() });
      }
    }

    let imported = 0;
    for (const { scope, url } of scopedRegistries) {
      const host = new URL(url).host;
      const token = tokens.find((t) => t.host.startsWith(host))?.token ?? null;
      this.addBinding({
        scope,
        url,
        token,
        label: scope
      });
      imported++;
    }
    return imported;
  }

  private normalize(binding: RegistryBinding): RegistryBinding {
    return {
      scope: binding.scope ? binding.scope.trim() : null,
      url: binding.url.replace(/\/+$/, '').trim(),
      token: binding.token?.trim() || null,
      label: binding.label.trim() || binding.scope || binding.url
    };
  }

  private persist(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.bindings()));
    } catch {
      /* storage full / blocked — accept the loss, it's just config. */
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const cleaned = parsed
          .filter((b): b is RegistryBinding =>
            !!b && typeof b === 'object' && typeof b.url === 'string'
          )
          .map((b) => this.normalize(b));
        this.bindings.set(cleaned);
      }
    } catch {
      /* ignore corrupted blob */
    }
  }
}
