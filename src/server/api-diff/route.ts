import type { Express, Request, Response } from 'express';
import { readCache, writeCache } from './cache';
import { diffSurfaces } from './differ';
import { fetchDtsBundle } from './fetcher';
import { parseBundle } from './parser';

/**
 * GET /api/api-diff?pkg=ngx-toastr&from=16.0.0&to=17.2.0
 *
 * Returns an ApiSurfaceDiff (always with HTTP 200 on success, even
 * when types are unavailable — clients need to read
 * `sources.{from,to}.origin === 'none'` to know they should fall
 * back to narrative-only mode).
 *
 * # Why GET, not POST
 *
 * The diff is a pure function of (pkg, from, to). GET lets CDN
 * caches (Cloudflare / Vercel Edge / Fastly) layer over the
 * application's two-tier cache for high-traffic packages. The query
 * string is also easy to log and curl-test in development.
 *
 * # Order-invariant caching
 *
 * The (pkg, A, B) and (pkg, B, A) requests should share a cache
 * entry — the diff between two versions is symmetric in cost even
 * if asymmetric in semantics (the AI step is responsible for
 * orientation in its prose). We sort A and B semantically and
 * always store under the (low, high) ordering. The route's response
 * keys still match the request's input direction so clients don't
 * need to know about the normalization.
 *
 * # Error semantics
 *
 *   400  missing/empty pkg/from/to query params
 *   500  fetch + parse + diff threw an unexpected exception
 *   200  everything else, including "types unavailable" (origin: 'none')
 *
 * 200-with-empty is deliberate. Network errors fetching types are
 * NOT 500 — they're a known data condition the client UI handles
 * gracefully ("This package ships no TypeScript types; analysis is
 * based on the maintainer's CHANGELOG alone"). 500 is reserved for
 * unexpected exceptions in the parser/differ logic itself, which
 * always indicates a bug.
 */
export async function apiDiffRoute(req: Request, res: Response): Promise<void> {
  const pkg = String(req.query['pkg'] || '').trim();
  const from = String(req.query['from'] || '').trim();
  const to = String(req.query['to'] || '').trim();

  if (!pkg || !from || !to) {
    res.status(400).json({
      error: 'missing-params',
      detail: 'Query params pkg, from, to are all required.'
    });
    return;
  }

  // Cache under canonical (low, high) ordering so reverse-direction
  // requests share the entry. Semver-aware sort keeps "10.0.0" >
  // "9.0.0" (lexicographic would get this wrong).
  const [lo, hi] = compareSemver(from, to) <= 0 ? [from, to] : [to, from];

  // ── L1/L2 cache check ──
  const cached = await readCache(pkg, lo, hi);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    res.json(cached);
    return;
  }

  try {
    // Fetch both .d.ts bundles in parallel. Each fetcher call already
    // handles CDN failover, recursive re-export resolution, and the
    // @types fallback, so we don't need to manage that here.
    const [fromBundle, toBundle] = await Promise.all([
      fetchDtsBundle(pkg, lo),
      fetchDtsBundle(pkg, hi)
    ]);

    // Parse both bundles, then diff. Both steps are pure functions
    // — no I/O — so they're cheap and deterministic.
    const fromSymbols = parseBundle(fromBundle);
    const toSymbols = parseBundle(toBundle);
    const diff = diffSurfaces(pkg, lo, hi, fromSymbols, toSymbols, {
      from: fromBundle.source,
      to: toBundle.source
    });

    // Best-effort cache write — failures don't affect the response.
    await writeCache(diff);

    res.setHeader('X-Cache', 'MISS');
    res.json(diff);
  } catch (err) {
    // Unexpected exception in fetch/parse/diff. Log on the server,
    // return 500 to the client. The client UI is told to treat 500
    // as "API diff service degraded, falling back to narrative mode."
    console.error('[api-diff] unexpected error', { pkg, lo, hi, err });
    res.status(500).json({
      error: 'diff-failed',
      detail: err instanceof Error ? err.message : String(err)
    });
  }
}

/**
 * Lightweight semver comparator. We don't depend on the `semver`
 * package server-side because the diff endpoint only needs ordering,
 * not range matching, and the package adds ~40kB to the server
 * bundle for no benefit.
 *
 * Handles the common shape: "MAJOR.MINOR.PATCH" possibly with a
 * pre-release suffix ("17.0.0-rc.1"). Pre-release tail is compared
 * lexicographically as a tiebreaker, which is good enough for our
 * cache-keying use case.
 */
function compareSemver(a: string, b: string): number {
  const splitVersion = (v: string): [number[], string] => {
    const [core, ...preParts] = v.split('-');
    const nums = core.split('.').map((n) => Number(n) || 0);
    return [nums, preParts.join('-')];
  };
  const [aNums, aPre] = splitVersion(a);
  const [bNums, bPre] = splitVersion(b);

  for (let i = 0; i < Math.max(aNums.length, bNums.length); i++) {
    const an = aNums[i] ?? 0;
    const bn = bNums[i] ?? 0;
    if (an !== bn) return an - bn;
  }
  // Per semver spec, a version WITH a pre-release tail is LESS than
  // the same version without one (1.0.0-rc.1 < 1.0.0).
  if (aPre && !bPre) return -1;
  if (!aPre && bPre) return 1;
  return aPre.localeCompare(bPre);
}

/**
 * Mount the api-diff endpoint on the given Express app. Matches the
 * `register*(app)` convention used by every other server module in
 * this codebase (pr-proxy, registry-cache, ai-proxy, etc.).
 */
export function registerApiDiff(app: Express): void {
  app.get('/api/api-diff', apiDiffRoute);
}
