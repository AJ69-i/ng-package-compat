#!/usr/bin/env node
/**
 * ng-package-compat CLI
 *
 * Reads a package.json, fetches metadata from the npm registry, and emits a
 * compatibility report against a target Angular major version.
 *
 * Usage:
 *   ngpc analyze [--file ./package.json] [--target 21] [--format md|json|table]
 *                [--fail-on conflict|warn] [--out ./report.md] [--no-network]
 *
 *   ngpc check <package> [--target 21]   # quick single-package lookup
 *
 *   ngpc --help
 *
 * Exit codes:
 *   0 — clean / completed
 *   1 — runtime / IO error
 *   2 — fail-on threshold hit (e.g. conflicts with --fail-on conflict)
 *   3 — bad CLI arguments
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argv, exit, stdout, stderr } from 'node:process';
import semver from 'semver';
import { PackumentCache, defaultCacheDir } from './cache.mjs';

const VERSION = '1.1.0';
const REGISTRY = 'https://registry.npmjs.org';
const ANGULAR_CORE = '@angular/core';
const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- arg parsing ----------

function parseArgs(args) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') out.flags.help = true;
    else if (a === '--version' || a === '-v') out.flags.version = true;
    else if (a === '--no-network') out.flags.noNetwork = true;
    else if (a === '--quiet' || a === '-q') out.flags.quiet = true;
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        out.flags[key] = next;
        i++;
      } else {
        out.flags[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

// ---------- registry helpers ----------

/**
 * Build a cache configured by the CLI flags. We pass this object straight to
 * the analyze/check commands so they all share one cache + concurrency pool.
 */
function buildCache(flags) {
  const ttlHours = parseFloat(String(flags['cache-ttl'] ?? '24'));
  const ttlMs = Number.isFinite(ttlHours) && ttlHours > 0
    ? ttlHours * 60 * 60 * 1000
    : 24 * 60 * 60 * 1000;
  const concurrency = parseInt(String(flags.concurrency ?? '8'), 10) || 8;
  return new PackumentCache({
    ttlMs,
    concurrency,
    disabled: !!flags['no-cache'] || !!flags.noCache
  });
}

async function fetchPackument(name, { offline, cache }) {
  if (offline) {
    // In offline mode we still consult the cache but never hit the network.
    // Tell the cache to return null for misses by setting an absurdly long TTL
    // and letting `_fetchFresh` fail-soft.
    if (!cache) return null;
    // Try cache without revalidation — if entry is missing, return null.
    const path = `${cache.dir}/${encodeURIComponent(name)}.json`;
    if (!existsSync(path)) return null;
    try {
      const raw = await readFile(path, 'utf8');
      return JSON.parse(raw)?.data ?? null;
    } catch {
      return null;
    }
  }
  if (!cache) {
    // No cache provided (legacy path): one-shot fetch.
    try {
      const res = await fetch(`${REGISTRY}/${encodeURIComponent(name).replace('%40', '@')}`, {
        headers: { accept: 'application/json' }
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }
  return await cache.get(name);
}

/**
 * Pick the highest stable version of `pkg` whose peer `@angular/core` range
 * satisfies `targetNg`. Falls back to a version that satisfies in `latest`.
 */
function pickCompatibleVersion(packument, targetNg) {
  if (!packument || !packument.versions) return null;
  const targetVer = `${targetNg}.0.0`;
  const candidates = Object.keys(packument.versions)
    .filter((v) => semver.valid(v) && !semver.prerelease(v))
    .sort(semver.rcompare);

  // Prefer the highest version whose peer range satisfies target.
  for (const v of candidates) {
    const meta = packument.versions[v];
    const peer = meta?.peerDependencies?.[ANGULAR_CORE];
    if (peer && semver.satisfies(targetVer, peer, { includePrerelease: true })) {
      return { version: v, peer, deprecated: !!meta.deprecated };
    }
  }
  // No peer match — return latest stable so the caller can flag it as conflict.
  const latest = packument['dist-tags']?.latest ?? candidates[0] ?? null;
  if (!latest) return null;
  const meta = packument.versions[latest];
  return {
    version: latest,
    peer: meta?.peerDependencies?.[ANGULAR_CORE] ?? null,
    deprecated: !!meta?.deprecated
  };
}

function detectStatus(currentRange, recommended, targetNg) {
  if (!recommended) return 'unknown';
  const target = `${targetNg}.0.0`;
  if (recommended.deprecated) return 'deprecated';
  if (!recommended.peer) return 'warn';
  if (!semver.satisfies(target, recommended.peer, { includePrerelease: true })) {
    return 'conflict';
  }
  // Already on the recommended version?
  const coerced = semver.coerce(currentRange ?? '');
  if (coerced && semver.eq(coerced, recommended.version)) return 'safe';
  return 'safe';
}

// ---------- package.json parsing ----------

function parsePackageJson(text) {
  const json = JSON.parse(text);
  const sections = ['dependencies', 'devDependencies', 'peerDependencies'];
  const deps = [];
  for (const section of sections) {
    const block = json[section] ?? {};
    for (const [name, range] of Object.entries(block)) {
      deps.push({ name, range, section });
    }
  }
  // Detect Angular major.
  const ngRange =
    json.dependencies?.[ANGULAR_CORE] ??
    json.devDependencies?.[ANGULAR_CORE] ??
    null;
  const ngCoerced = ngRange ? semver.coerce(ngRange) : null;
  return {
    name: json.name ?? null,
    version: json.version ?? null,
    deps,
    angularMajor: ngCoerced ? ngCoerced.major : null
  };
}

// ---------- report ----------

async function buildReport(parsed, target, { offline, quiet, cache }) {
  const entries = [];
  const total = parsed.deps.length;

  // Kick off all fetches in parallel — the cache's semaphore caps concurrency
  // to 8 by default so we don't hammer the registry.
  const tasks = parsed.deps.map((dep) =>
    fetchPackument(dep.name, { offline, cache }).then((packument) => ({
      dep,
      packument
    }))
  );

  let done = 0;
  for (const task of tasks) {
    const { dep, packument } = await task;
    done++;
    if (!quiet && stderr.isTTY) {
      stderr.write(`\r  fetched ${done}/${total} — ${dep.name}    \x1b[0K`);
    }
    const recommended = pickCompatibleVersion(packument, target);
    const status = detectStatus(dep.range, recommended, target);
    entries.push({
      name: dep.name,
      currentRange: dep.range,
      currentVersion: semver.coerce(dep.range ?? '')?.version ?? null,
      recommendedVersion: recommended?.version ?? null,
      peerRange: recommended?.peer ?? null,
      deprecated: !!recommended?.deprecated,
      status,
      section: dep.section
    });
  }
  if (!quiet && stderr.isTTY) stderr.write('\r\x1b[2K');

  const counts = {
    safe: entries.filter((e) => e.status === 'safe').length,
    warn: entries.filter((e) => e.status === 'warn').length,
    conflict: entries.filter((e) => e.status === 'conflict').length,
    deprecated: entries.filter((e) => e.status === 'deprecated').length,
    unknown: entries.filter((e) => e.status === 'unknown').length
  };
  const score = scoreFromCounts(counts, total || 1);

  return {
    project: parsed.name ?? 'unnamed-project',
    fromAngularMajor: parsed.angularMajor,
    targetAngularMajor: target,
    generatedAt: new Date().toISOString(),
    counts,
    healthScore: score,
    entries
  };
}

function scoreFromCounts(c, total) {
  // Roughly: safe = 100, warn = 70, conflict = 0, deprecated = 30, unknown = 60
  const sum = c.safe * 100 + c.warn * 70 + c.deprecated * 30 + c.unknown * 60;
  return Math.round(sum / Math.max(total, 1));
}

// ---------- formatters ----------

const STATUS_ICON = {
  safe: '\x1b[32m✔\x1b[0m',
  warn: '\x1b[33m!\x1b[0m',
  conflict: '\x1b[31m✘\x1b[0m',
  deprecated: '\x1b[35m✖\x1b[0m',
  unknown: '\x1b[2m?\x1b[0m'
};

function formatTable(report) {
  const rows = report.entries.map((e) => [
    e.name,
    e.section.replace('Dependencies', ''),
    e.currentRange ?? '?',
    e.recommendedVersion ?? '?',
    e.status
  ]);
  const headers = ['package', 'kind', 'current', 'recommended', 'status'];
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length))
  );
  const pad = (s, n) => String(s).padEnd(n);

  const lines = [];
  lines.push(
    `\nng-package-compat — ${report.project}  (Angular ${report.fromAngularMajor ?? '?'} → ${report.targetAngularMajor})`
  );
  lines.push(
    `Health: ${report.healthScore}/100  ·  safe ${report.counts.safe}  ·  warn ${report.counts.warn}  ·  conflict ${report.counts.conflict}  ·  deprecated ${report.counts.deprecated}\n`
  );
  lines.push(headers.map((h, i) => pad(h, widths[i])).join('  '));
  lines.push(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const r of rows) {
    const status = STATUS_ICON[r[4]] ?? r[4];
    const cells = r.map((c, i) => pad(c, widths[i]));
    cells[4] = `${status} ${pad(r[4], widths[4] - 2)}`;
    lines.push(cells.join('  '));
  }
  return lines.join('\n');
}

function formatMarkdown(report) {
  const lines = [];
  lines.push(`# ng-package-compat report — ${report.project}`);
  lines.push('');
  lines.push(
    `Upgrade target: **Angular ${report.fromAngularMajor ?? '?'} → ${report.targetAngularMajor}**`
  );
  lines.push('');
  lines.push(`Health score: **${report.healthScore} / 100**`);
  lines.push('');
  lines.push(
    `| Safe | Warn | Conflict | Deprecated | Unknown |`
  );
  lines.push(`| ---- | ---- | -------- | ---------- | ------- |`);
  lines.push(
    `| ${report.counts.safe} | ${report.counts.warn} | ${report.counts.conflict} | ${report.counts.deprecated} | ${report.counts.unknown} |`
  );
  lines.push('');
  lines.push('## Per-package');
  lines.push('');
  lines.push('| Package | Kind | Current | Recommended | Peer range | Status |');
  lines.push('| ------- | ---- | ------- | ----------- | ---------- | ------ |');
  for (const e of report.entries) {
    lines.push(
      `| \`${e.name}\` | ${e.section.replace('Dependencies', '')} | ${e.currentRange ?? '—'} | ${e.recommendedVersion ?? '—'} | ${e.peerRange ?? '—'} | ${e.status} |`
    );
  }
  lines.push('');
  lines.push(`_Generated by ng-package-compat CLI v${VERSION} on ${report.generatedAt}._`);
  return lines.join('\n');
}

// ---------- commands ----------

async function cmdAnalyze(flags) {
  const file = resolve(String(flags.file ?? './package.json'));
  if (!existsSync(file)) {
    stderr.write(`✘ package.json not found at ${file}\n`);
    return 1;
  }
  const raw = await readFile(file, 'utf8');
  let parsed;
  try {
    parsed = parsePackageJson(raw);
  } catch (e) {
    stderr.write(`✘ Could not parse ${file}: ${e?.message ?? e}\n`);
    return 1;
  }
  const target =
    parseInt(String(flags.target ?? parsed.angularMajor ?? '21'), 10) || 21;
  const format = String(flags.format ?? 'table');
  const offline = !!flags.noNetwork;
  const quiet = !!flags.quiet;

  const cache = buildCache(flags);

  if (!quiet) {
    const cacheNote = flags['no-cache'] || flags.noCache ? ' [cache off]' : '';
    stderr.write(
      `→ analyzing ${parsed.deps.length} deps for Angular ${target} ` +
        `(detected ${parsed.angularMajor ?? '?'})${offline ? ' [offline]' : ''}${cacheNote}\n`
    );
  }

  const report = await buildReport(parsed, target, { offline, quiet, cache });

  if (!quiet) {
    const s = cache.stats();
    stderr.write(
      `  cache: ${s.hits} hit / ${s.revalidated} revalidated / ${s.misses} miss / ${s.errors} err\n`
    );
  }

  let outputText;
  if (format === 'json') outputText = JSON.stringify(report, null, 2);
  else if (format === 'md' || format === 'markdown') outputText = formatMarkdown(report);
  else outputText = formatTable(report);

  if (flags.out) {
    await writeFile(resolve(String(flags.out)), outputText, 'utf8');
    if (!quiet) stderr.write(`✔ wrote ${flags.out}\n`);
  } else {
    stdout.write(outputText + '\n');
  }

  // fail-on threshold
  const failOn = String(flags['fail-on'] ?? '').toLowerCase();
  if (failOn === 'conflict' && report.counts.conflict > 0) return 2;
  if (failOn === 'warn' && report.counts.conflict + report.counts.warn > 0) return 2;
  return 0;
}

async function cmdCheck(args, flags) {
  const name = args[0];
  if (!name) {
    stderr.write('✘ usage: ngpc check <package-name> [--target 21]\n');
    return 3;
  }
  const target = parseInt(String(flags.target ?? '21'), 10) || 21;
  const cache = buildCache(flags);
  const pack = await fetchPackument(name, {
    offline: !!flags.noNetwork,
    cache
  });
  if (!pack) {
    stderr.write(`✘ Could not fetch ${name} from npm.\n`);
    return 1;
  }
  const rec = pickCompatibleVersion(pack, target);
  if (!rec) {
    stdout.write(`${name}: no published versions.\n`);
    return 0;
  }
  const status = detectStatus(null, rec, target);
  stdout.write(
    `${name}@${rec.version}  peer ${ANGULAR_CORE} ${rec.peer ?? '—'}  → status: ${status}\n`
  );
  return 0;
}

async function cmdCache(args, flags) {
  const sub = args[0] ?? 'stats';
  const cache = buildCache(flags);
  if (sub === 'clear') {
    const { removed } = await cache.clear();
    stdout.write(`✔ cleared ${removed} cached packument(s) from ${cache.dir}\n`);
    return 0;
  }
  if (sub === 'stats') {
    const bytes = await cache.diskBytes();
    const kb = (bytes / 1024).toFixed(1);
    const dir = cache.dir;
    let count = 0;
    if (existsSync(dir)) {
      const fs = await import('node:fs/promises');
      const files = await fs.readdir(dir);
      count = files.filter((f) => f.endsWith('.json')).length;
    }
    stdout.write(`cache directory : ${dir}\n`);
    stdout.write(`cached packages : ${count}\n`);
    stdout.write(`disk usage      : ${kb} kB\n`);
    stdout.write(`default ttl     : 24 h (override with --cache-ttl <hours>)\n`);
    return 0;
  }
  if (sub === 'where') {
    stdout.write(`${defaultCacheDir()}\n`);
    return 0;
  }
  stderr.write(`✘ Unknown cache subcommand: ${sub}\n`);
  stderr.write(`   try: ngpc cache stats | ngpc cache clear | ngpc cache where\n`);
  return 3;
}

function printHelp() {
  stdout.write(`ng-package-compat CLI v${VERSION}

Commands:
  analyze [opts]            Analyze a package.json against an Angular target
  check <pkg> [opts]        Quickly check a single package's Angular peer range
  cache <stats|clear|where> Inspect or clear the local packument cache

Options:
  --file <path>             Path to package.json (default: ./package.json)
  --target <major>          Target Angular major (default: detected, else 21)
  --format <md|json|table>  Output format (default: table)
  --out <path>              Write report to file instead of stdout
  --fail-on <conflict|warn> Exit non-zero on threshold for CI
  --no-network              Skip registry calls (offline; cache-only)
  --no-cache                Bypass the on-disk packument cache
  --cache-ttl <hours>       Cache freshness window (default: 24)
  --concurrency <n>         Parallel registry fetches (default: 8)
  --quiet, -q               Suppress progress output
  --version, -v             Print CLI version
  --help, -h                Show this help

Examples:
  ngpc analyze --target 21 --format md --out report.md
  ngpc analyze --fail-on conflict
  ngpc analyze --concurrency 16 --cache-ttl 6
  ngpc check rxjs --target 21
  ngpc cache stats
  ngpc cache clear
`);
}

// ---------- entry ----------

async function main() {
  const args = parseArgs(argv.slice(2));
  if (args.flags.version) {
    stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (args.flags.help || args._.length === 0) {
    printHelp();
    return 0;
  }
  const cmd = args._[0];
  const rest = args._.slice(1);
  try {
    if (cmd === 'analyze') return await cmdAnalyze(args.flags);
    if (cmd === 'check') return await cmdCheck(rest, args.flags);
    if (cmd === 'cache') return await cmdCache(rest, args.flags);
    stderr.write(`✘ Unknown command: ${cmd}\n`);
    printHelp();
    return 3;
  } catch (e) {
    stderr.write(`✘ ${e?.stack ?? e}\n`);
    return 1;
  }
}

main().then((code) => exit(code ?? 0));
