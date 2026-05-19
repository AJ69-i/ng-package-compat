/**
 * Seed the local packument cache with realistic-looking data so the smoke
 * tests can run offline. Each entry contains just enough shape for the CLI's
 * `pickCompatibleVersion` to behave correctly: dist-tags, versions[].peerDeps,
 * and deprecation flags where relevant.
 *
 * Run with: node cli/__fixtures__/seed-cache.mjs [cacheDir]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const dir = process.argv[2] ?? join(homedir(), '.cache', 'ngpc', 'packuments');
if (!existsSync(dir)) await mkdir(dir, { recursive: true });

const now = new Date().toISOString();
const entries = {
  rxjs: {
    'dist-tags': { latest: '7.8.1' },
    versions: {
      '7.8.1': { name: 'rxjs', version: '7.8.1', peerDependencies: {} }
    }
  },
  'zone.js': {
    'dist-tags': { latest: '0.15.0' },
    versions: {
      '0.15.0': { name: 'zone.js', version: '0.15.0', peerDependencies: {} },
      '0.14.4': { name: 'zone.js', version: '0.14.4', peerDependencies: {} }
    }
  },
  'ngx-toastr': {
    'dist-tags': { latest: '19.0.0' },
    versions: {
      '19.0.0': {
        name: 'ngx-toastr',
        version: '19.0.0',
        peerDependencies: {
          '@angular/common': '^20.0.0 || ^21.0.0',
          '@angular/core': '^20.0.0 || ^21.0.0'
        }
      },
      '17.0.2': {
        name: 'ngx-toastr',
        version: '17.0.2',
        peerDependencies: {
          '@angular/common': '^16.0.0',
          '@angular/core': '^16.0.0'
        }
      }
    }
  },
  '@angular/core': {
    'dist-tags': { latest: '21.0.0' },
    versions: {
      '21.0.0': { name: '@angular/core', version: '21.0.0', peerDependencies: {} },
      '16.2.0': { name: '@angular/core', version: '16.2.0', peerDependencies: {} }
    }
  },
  '@ngrx/store': {
    'dist-tags': { latest: '21.0.0' },
    versions: {
      '21.0.0': {
        name: '@ngrx/store',
        version: '21.0.0',
        peerDependencies: {
          '@angular/core': '^21.0.0',
          rxjs: '^7.5.0'
        }
      },
      '16.0.1': {
        name: '@ngrx/store',
        version: '16.0.1',
        peerDependencies: {
          '@angular/core': '^16.0.0',
          rxjs: '^7.5.0'
        }
      }
    }
  },
  primeng: {
    'dist-tags': { latest: '21.0.0' },
    versions: {
      '21.0.0': {
        name: 'primeng',
        version: '21.0.0',
        peerDependencies: { '@angular/core': '^21.0.0' }
      }
    }
  }
};

let written = 0;
for (const [name, data] of Object.entries(entries)) {
  const file = join(dir, encodeURIComponent(name) + '.json');
  await writeFile(
    file,
    JSON.stringify({ fetchedAt: now, etag: null, data: { name, ...data } })
  );
  written++;
}
console.log(`✔ seeded ${written} packuments at ${dir}`);
