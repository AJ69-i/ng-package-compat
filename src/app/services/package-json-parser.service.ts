import { Injectable } from '@angular/core';
import * as semver from 'semver';
import { ParsedDep, ParsedPackageJson } from '../models/npm-package.model';

const ANGULAR_CORE = '@angular/core';

/**
 * Parses raw package.json content (or a pasted dep list) into a structured
 * `ParsedPackageJson`, extracting the Angular major from `@angular/core`
 * when present.
 */
@Injectable({ providedIn: 'root' })
export class PackageJsonParserService {
  /**
   * Parse raw JSON text of a package.json file.
   * Returns a `ParsedPackageJson` or throws with a helpful message.
   */
  parseJson(raw: string): ParsedPackageJson {
    const text = (raw ?? '').trim();
    if (!text) {
      throw new Error('The file is empty.');
    }
    let data: any;
    try {
      data = JSON.parse(text);
    } catch (e: any) {
      throw new Error(`Not valid JSON: ${e?.message ?? 'parse error'}`);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Expected a JSON object (a package.json).');
    }

    const deps: ParsedDep[] = [];
    const warnings: string[] = [];
    const sections: Array<ParsedDep['section']> = [
      'dependencies',
      'devDependencies',
      'peerDependencies'
    ];

    for (const section of sections) {
      const map = data[section];
      if (!map) continue;
      if (typeof map !== 'object') {
        warnings.push(`Ignoring non-object "${section}" section.`);
        continue;
      }
      for (const [name, range] of Object.entries(map)) {
        if (typeof range !== 'string') {
          warnings.push(`Skipping "${name}" — non-string range in ${section}.`);
          continue;
        }
        // Skip git/file/link ranges — we can't query them.
        if (/^(git\+|file:|link:|npm:|workspace:|http)/.test(range)) {
          warnings.push(`Skipping "${name}" — non-registry range "${range}".`);
          continue;
        }
        deps.push({ name, range, section });
      }
    }

    const angularMajor = this.resolveAngularMajor(deps);
    return {
      name: typeof data.name === 'string' ? data.name : undefined,
      version: typeof data.version === 'string' ? data.version : undefined,
      angularMajor,
      deps: this.dedupe(deps),
      warnings
    };
  }

  /**
   * Parse a pasted plain-text list. Accepts formats like:
   *   - `ngx-toastr` (just a name)
   *   - `ngx-toastr@17.0.0` (name + version)
   *   - `"ngx-toastr": "^17.0.0",` (copied from a package.json)
   * Extra whitespace, commas, quotes, and semicolons are ignored.
   */
  parseList(raw: string): ParsedPackageJson {
    const lines = (raw ?? '').split(/\r?\n/);
    const deps: ParsedDep[] = [];
    const warnings: string[] = [];

    for (const line of lines) {
      const cleaned = line.trim().replace(/[,;]$/, '').trim();
      if (!cleaned || cleaned.startsWith('//') || cleaned.startsWith('#')) continue;

      // package.json-style entry: "name": "range"
      const jsonStyle = /^"([^"]+)"\s*:\s*"([^"]+)"$/.exec(cleaned);
      if (jsonStyle) {
        deps.push({ name: jsonStyle[1], range: jsonStyle[2], section: 'dependencies' });
        continue;
      }

      // name@range
      const tokenized = cleaned.replace(/^['"]/, '').replace(/['"]$/, '');
      const atSplit = this.splitAt(tokenized);
      if (atSplit) {
        deps.push({ name: atSplit.name, range: atSplit.range, section: 'dependencies' });
        continue;
      }

      // Bare name
      if (/^@?[a-z0-9][a-z0-9._~/-]*$/i.test(tokenized)) {
        deps.push({ name: tokenized, range: null, section: 'dependencies' });
        continue;
      }

      warnings.push(`Could not parse line: "${line}"`);
    }

    return {
      angularMajor: this.resolveAngularMajor(deps),
      deps: this.dedupe(deps),
      warnings
    };
  }

  /**
   * Guess a concrete installed version from a range.
   * For something like `^17.2.0` we return `17.2.0`; for `17` we return `17.0.0`.
   * Returns `null` if the range is not parseable.
   */
  resolveInstalledVersion(range: string | null): string | null {
    if (!range) return null;
    const min = semver.minVersion(range);
    if (min) return min.version;
    const coerced = semver.coerce(range);
    return coerced ? coerced.version : null;
  }

  private splitAt(s: string): { name: string; range: string } | null {
    // Scoped: "@angular/core@^17.0.0"
    if (s.startsWith('@')) {
      const secondAt = s.indexOf('@', 1);
      if (secondAt > 1 && secondAt < s.length - 1) {
        return { name: s.slice(0, secondAt), range: s.slice(secondAt + 1) };
      }
      return null;
    }
    const at = s.indexOf('@');
    if (at > 0 && at < s.length - 1) {
      return { name: s.slice(0, at), range: s.slice(at + 1) };
    }
    return null;
  }

  private resolveAngularMajor(deps: ParsedDep[]): number | null {
    const ngCore = deps.find((d) => d.name === ANGULAR_CORE);
    if (!ngCore?.range) return null;
    const min = semver.minVersion(ngCore.range);
    if (min) return min.major;
    return semver.coerce(ngCore.range)?.major ?? null;
  }

  private dedupe(deps: ParsedDep[]): ParsedDep[] {
    const seen = new Map<string, ParsedDep>();
    for (const d of deps) {
      const prior = seen.get(d.name);
      // Prefer dependencies > devDependencies > peerDependencies if we see duplicates.
      const rank = (s: ParsedDep['section']) =>
        s === 'dependencies' ? 3 : s === 'devDependencies' ? 2 : s === 'peerDependencies' ? 1 : 0;
      if (!prior || rank(d.section) > rank(prior.section)) {
        seen.set(d.name, d);
      }
    }
    return [...seen.values()];
  }
}
