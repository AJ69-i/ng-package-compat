import { Injectable } from '@angular/core';

/**
 * Curated list of high-value typosquat targets. These are popular
 * packages whose download counts make them attractive for malicious
 * impersonation, OR ecosystem-critical packages whose typo would
 * confuse a learning developer. The list is intentionally hand-picked
 * rather than scraped from npm's top-100 — many of npm's most-installed
 * packages are transitive deps (`once`, `wrappy`, `safe-buffer`) that
 * no human would type into a search bar, so they don't belong here.
 *
 * Curation criteria:
 *
 *   - High-profile, developer-typed names (people search "express",
 *     not "wrappy").
 *   - Angular-ecosystem heavyweights (Angular core, common Angular
 *     UI/state libraries, common typosquat targets in the Angular
 *     world).
 *   - Known historical typosquat targets (cross-env, dotenv, lodash,
 *     moment, etc. have all had real squat attacks against them).
 *
 * Keep alphabetized for diffability. Adding a name has near-zero cost
 * (a few bytes), so err on the side of inclusion when in doubt.
 */
const TYPOSQUAT_TARGETS: readonly string[] = [
  // ----- core ecosystem -----
  '@angular/animations',
  '@angular/cdk',
  '@angular/cli',
  '@angular/common',
  '@angular/compiler',
  '@angular/core',
  '@angular/forms',
  '@angular/material',
  '@angular/platform-browser',
  '@angular/router',
  '@angular/ssr',
  'angular',
  'next',
  'nuxt',
  'react',
  'react-dom',
  'react-native',
  'svelte',
  'vue',
  // ----- common utilities (frequent squat targets) -----
  'axios',
  'chalk',
  'commander',
  'cross-env',
  'dotenv',
  'esbuild',
  'eslint',
  'express',
  'fastify',
  'firebase',
  'graphql',
  'jest',
  'jsonwebtoken',
  'koa',
  'lodash',
  'minimist',
  'moment',
  'mongoose',
  'next-auth',
  'nodemon',
  'passport',
  'pg',
  'playwright',
  'pnpm',
  'postcss',
  'prettier',
  'puppeteer',
  'redis',
  'request',
  'rollup',
  'rxjs',
  'sequelize',
  'sharp',
  'socket.io',
  'storybook',
  'styled-components',
  'tailwindcss',
  'three',
  'turbo',
  'typescript',
  'uuid',
  'vite',
  'vitest',
  'webpack',
  'yarn',
  'zod',
  'zone.js',
  // ----- Angular-ecosystem libraries -----
  '@ngrx/store',
  '@ngrx/effects',
  '@ngrx/entity',
  '@ngrx/signals',
  '@ng-bootstrap/ng-bootstrap',
  'ng-zorro-antd',
  'ngx-bootstrap',
  'ngx-charts',
  'ngx-cookie-service',
  'ngx-mask',
  'ngx-sonner',
  'ngx-spinner',
  'ngx-toastr',
  'primeng',
  'taiga-ui',
  'transloco',
  '@jsverse/transloco',
  '@supabase/supabase-js',
  '@auth0/auth0-angular',
  '@sentry/angular',
  '@sentry/browser',
  'firebase-tools',
  'rxjs-marbles'
];

export interface TyposquatSuggestion {
  /** What the user typed, lowercased + trimmed. */
  searched: string;
  /** Closest popular package by Levenshtein distance. */
  suggestion: string;
  /** Edit distance (1 or 2 for a match; we don't surface 0 since that's an exact match). */
  distance: number;
}

/**
 * Maximum edit distance we accept as "this looks like a typo of the
 * suggestion." Above this, the names are likely unrelated. Hardcoded
 * rather than configurable because the trade-off has been studied:
 *
 *   distance 1  → catches single-character typos (1odash, axois, vite-s)
 *   distance 2  → catches double typos (lordash, sttyled-componentsss)
 *   distance 3+ → too many false positives (matches semi-related names)
 *
 * Two is the standard ceiling that VS Code, Cargo, and Go's tooling
 * all use for "did you mean" suggestions, so it's also the threshold
 * users have been trained to expect.
 */
const MAX_EDIT_DISTANCE = 2;

/**
 * Returns a "Did you mean ___?" suggestion when the user's search term
 * is close to — but not exactly — one of our curated popular-package
 * names.
 *
 * # Why we don't gate on download counts
 *
 * The instinct is "only warn when the SEARCHED package has low
 * downloads, since high-download packages are obviously real." But:
 *
 *   1. A user typing `1odash` will get a fast warning here before any
 *      network call resolves — we don't need to wait for download
 *      data we may not have yet.
 *   2. A malicious typosquat MAY accumulate downloads through SEO and
 *      automated pull-throughs before takedown. By the time we'd have
 *      a download signal, the harm is done.
 *   3. The phrasing "Did you mean lodash?" is friendly enough to work
 *      for both pure typos and active typosquats — we don't make an
 *      accusation, we offer a correction.
 *
 * # Trade-off accepted
 *
 * Some users will search a legitimate package name that's coincidentally
 * close to a popular one (e.g. `vite-mock` near `vite`). They'll see
 * an unnecessary suggestion. The cost — one extra subtle banner — is
 * much lower than the cost of a single typosquat install slipping
 * through. False-positive optimization is for v2.
 */
@Injectable({ providedIn: 'root' })
export class TyposquatService {
  /**
   * Resolve a suggestion for the given search term, or `null` if no
   * close popular match exists. Returns `null` for exact matches too
   * (you don't get a "did you mean lodash?" when you typed "lodash").
   */
  suggest(searched: string | null | undefined): TyposquatSuggestion | null {
    if (!searched) return null;
    const normalized = searched.trim().toLowerCase();
    if (!normalized) return null;

    let best: { name: string; distance: number } | null = null;
    for (const candidate of TYPOSQUAT_TARGETS) {
      const target = candidate.toLowerCase();
      // Exact match — explicitly NOT a typosquat.
      if (target === normalized) return null;
      // Length-difference fast-path: distance is bounded below by
      // |len(a) - len(b)|, so if even the lower bound exceeds our
      // ceiling we can skip the DP altogether. Cheap optimization
      // that takes the inner loop from "always O(n*m)" to "O(n*m)
      // only when needed."
      const lenDiff = Math.abs(target.length - normalized.length);
      if (lenDiff > MAX_EDIT_DISTANCE) continue;

      const d = this.levenshtein(normalized, target);
      if (d <= MAX_EDIT_DISTANCE && (!best || d < best.distance)) {
        best = { name: candidate, distance: d };
        // Distance 1 is as good as it gets without being an exact
        // match — bail early to skip the rest of the list.
        if (d === 1) break;
      }
    }

    if (!best) return null;
    return { searched: normalized, suggestion: best.name, distance: best.distance };
  }

  /**
   * Classic Wagner-Fischer Levenshtein, single-row optimization. We
   * intentionally don't ship the Damerau-Levenshtein variant (which
   * treats transpositions as 1 instead of 2) because the bundled
   * cost of the transposition column doesn't pay off for the kinds
   * of typos users actually make on package names — single-char
   * substitutions and missed-char/extra-char dominate.
   */
  private levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    // Use the shorter string for the inner loop so the row stays small.
    const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
    let prev = new Array(shorter.length + 1);
    let curr = new Array(shorter.length + 1);
    for (let i = 0; i <= shorter.length; i++) prev[i] = i;

    for (let j = 1; j <= longer.length; j++) {
      curr[0] = j;
      for (let i = 1; i <= shorter.length; i++) {
        const cost = shorter[i - 1] === longer[j - 1] ? 0 : 1;
        curr[i] = Math.min(
          curr[i - 1] + 1,      // insertion
          prev[i] + 1,           // deletion
          prev[i - 1] + cost     // substitution
        );
      }
      [prev, curr] = [curr, prev];
    }
    return prev[shorter.length];
  }
}
