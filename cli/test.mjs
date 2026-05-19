/**
 * CLI smoke tests — exercise analyze + cache against fixture package.json
 * files using only seeded cache data. No network access required; safe for CI.
 *
 * Run: node cli/test.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const NGPC = join(ROOT, 'cli', 'ngpc.mjs');
const FIXTURES = join(ROOT, 'cli', '__fixtures__');

let passed = 0;
let failed = 0;

function run(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', [NGPC, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✔ ${msg}`);
  } else {
    failed++;
    console.log(`  ✘ ${msg}`);
  }
}

async function withFreshCache(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ngpc-test-'));
  const env = { XDG_CACHE_HOME: dir };
  // Seed fixtures into the temp cache dir so analyze runs offline.
  await new Promise((resolve, reject) => {
    const child = spawn(
      'node',
      [
        join(FIXTURES, 'seed-cache.mjs'),
        join(dir, 'ngpc', 'packuments')
      ],
      { stdio: 'ignore' }
    );
    child.on('close', (code) => (code === 0 ? resolve(null) : reject(new Error('seed failed'))));
  });
  try {
    await fn(env, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n→ ngpc smoke tests\n');

// --- 1. CLI surface
{
  console.log('CLI surface:');
  const v = await run(['--version']);
  assert(v.code === 0 && /^\d+\.\d+\.\d+/.test(v.out.trim()), 'prints semver-ish version');

  const h = await run(['--help']);
  assert(h.code === 0 && h.out.includes('analyze'), 'help mentions analyze');
  assert(h.out.includes('cache'), 'help mentions cache subcommand');
  assert(h.out.includes('--cache-ttl'), 'help mentions --cache-ttl');

  const bad = await run(['nonsense']);
  assert(bad.code === 3, 'unknown command exits 3');
}

// --- 2. analyze against quickstart fixture
await withFreshCache(async (env) => {
  console.log('\nanalyze quickstart fixture (offline + seeded cache):');
  const r = await run(
    [
      'analyze',
      '--file',
      join(FIXTURES, 'quickstart.package.json'),
      '--target',
      '21',
      '--no-network',
      '--quiet',
      '--format',
      'json'
    ],
    env
  );
  assert(r.code === 0, 'exits 0');
  let report = null;
  try {
    report = JSON.parse(r.out);
  } catch {
    /* fall through */
  }
  assert(report && Array.isArray(report.entries), 'emits valid JSON report');
  assert(report?.targetAngularMajor === 21, 'target is 21');
  assert(report?.fromAngularMajor === 21, 'detects current Angular major');
  const rxjs = report?.entries?.find((e) => e.name === 'rxjs');
  assert(!!rxjs, 'includes rxjs from fixture');
  assert(rxjs?.recommendedVersion === '7.8.1', 'rxjs recommendation comes from cache');
});

// --- 3. analyze legacy ng16 fixture, target 21
await withFreshCache(async (env) => {
  console.log('\nanalyze legacy-ng16 fixture (target 21):');
  const r = await run(
    [
      'analyze',
      '--file',
      join(FIXTURES, 'legacy-ng16.package.json'),
      '--target',
      '21',
      '--no-network',
      '--quiet',
      '--format',
      'json'
    ],
    env
  );
  assert(r.code === 0, 'exits 0');
  const report = JSON.parse(r.out);
  const tox = report.entries.find((e) => e.name === 'ngx-toastr');
  assert(tox?.recommendedVersion === '19.0.0', 'recommends ngx-toastr 19 for ng21');
  const ngrx = report.entries.find((e) => e.name === '@ngrx/store');
  assert(ngrx?.recommendedVersion === '21.0.0', 'recommends ngrx 21 for ng21');
});

// --- 4. fail-on conflict gating
await withFreshCache(async (env) => {
  console.log('\nfail-on conflict gating:');
  // Quickstart fixture is already on Angular 21 — should NOT fail-on conflict.
  const ok = await run(
    [
      'analyze',
      '--file',
      join(FIXTURES, 'quickstart.package.json'),
      '--target',
      '21',
      '--no-network',
      '--quiet',
      '--fail-on',
      'conflict',
      '--format',
      'json'
    ],
    env
  );
  assert(ok.code === 0, 'no conflicts → exit 0');
});

// --- 5. cache subcommand
await withFreshCache(async (env, base) => {
  console.log('\ncache subcommand:');
  const where = await run(['cache', 'where'], env);
  assert(where.code === 0 && where.out.includes(base), 'cache where points at XDG_CACHE_HOME');

  const stats = await run(['cache', 'stats'], env);
  assert(stats.code === 0, 'cache stats exits 0');
  assert(/cached packages\s*:\s*[1-9]/.test(stats.out), 'cache stats reports >0 entries');

  const cleared = await run(['cache', 'clear'], env);
  assert(cleared.code === 0, 'cache clear exits 0');
  const stats2 = await run(['cache', 'stats'], env);
  assert(/cached packages\s*:\s*0/.test(stats2.out), 'cache empty after clear');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
