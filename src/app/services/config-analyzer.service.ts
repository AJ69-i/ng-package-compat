import { Injectable } from '@angular/core';
import { ConfigAnalysis } from '../models/npm-package.model';

/**
 * Analyzes the ancillary config files of an Angular project against a target
 * Angular major and flags deprecated or missing settings.
 *
 * Supported:
 *   - angular.json
 *   - tsconfig.json
 *   - .browserslistrc
 */
@Injectable({ providedIn: 'root' })
export class ConfigAnalyzerService {
  analyzeAngularJson(raw: string, targetNg: number): ConfigAnalysis['angularJson'] {
    const results: NonNullable<ConfigAnalysis['angularJson']> = [];
    let doc: any;
    try {
      doc = JSON.parse(raw);
    } catch {
      results.push({ level: 'critical', message: 'angular.json is not valid JSON.' });
      return results;
    }

    const projects = doc?.projects ?? {};
    for (const [name, project] of Object.entries<any>(projects)) {
      const build = project?.architect?.build ?? project?.targets?.build;
      if (!build) continue;

      const builder = build.builder;
      if (targetNg >= 17 && builder === '@angular-devkit/build-angular:browser') {
        results.push({
          level: 'warning',
          message:
            `Project "${name}": using the old \`@angular-devkit/build-angular:browser\` builder. ` +
            `Angular ${targetNg} recommends migrating to \`@angular/build:application\` (run \`ng update @angular/cli\`).`
        });
      }
      if (targetNg >= 21 && builder === '@angular-devkit/build-angular:browser-esbuild') {
        results.push({
          level: 'warning',
          message: `Project "${name}": the esbuild browser builder moved to \`@angular/build:application\` in v17.`
        });
      }

      const options = build.options ?? {};
      if (options.buildOptimizer === false) {
        results.push({ level: 'warning', message: `Project "${name}": \`buildOptimizer: false\` — re-enable for smaller builds.` });
      }
      if (options.aot === false) {
        results.push({ level: 'warning', message: `Project "${name}": \`aot: false\` is no longer supported in production.` });
      }
      if (!options.serviceWorker && targetNg >= 17) {
        results.push({ level: 'info', message: `Project "${name}": no service worker configured. Consider adding one via \`ng add @angular/pwa\`.` });
      }
    }

    const cli = doc?.cli ?? {};
    if (cli?.cache?.enabled === false) {
      results.push({ level: 'info', message: 'CLI persistent cache is disabled. Remove `cli.cache.enabled = false` for faster builds.' });
    }
    if (cli?.analytics === true) {
      results.push({ level: 'info', message: 'CLI analytics is on. Review company policy — consider setting `cli.analytics = false`.' });
    }

    return results;
  }

  analyzeTsconfig(raw: string, targetNg: number): ConfigAnalysis['tsconfig'] {
    const results: NonNullable<ConfigAnalysis['tsconfig']> = [];
    let doc: any;
    try {
      doc = JSON.parse(raw.replace(/\/\/.*$/gm, '')); // strip line comments
    } catch {
      results.push({ level: 'critical', message: 'tsconfig.json is not valid JSON.' });
      return results;
    }
    const co = doc?.compilerOptions ?? {};
    const target = String(co.target ?? '').toLowerCase();

    if (targetNg >= 17 && target && !['es2022', 'esnext'].includes(target)) {
      results.push({
        level: 'warning',
        message: `compilerOptions.target is "${target}" — Angular ${targetNg} expects "ES2022".`
      });
    }
    if (co.strict === false) {
      results.push({
        level: 'warning',
        message: 'compilerOptions.strict is false. Enable strict mode to match Angular CLI defaults.'
      });
    }
    if (co.useDefineForClassFields === false && targetNg >= 17) {
      results.push({
        level: 'info',
        message: 'useDefineForClassFields is false. Angular 17+ relies on standard class fields.'
      });
    }
    const ao = doc?.angularCompilerOptions ?? {};
    if (ao.enableI18nLegacyMessageIdFormat === undefined && targetNg >= 17) {
      results.push({
        level: 'info',
        message: 'angularCompilerOptions.enableI18nLegacyMessageIdFormat not set — defaults to false. Safe to remove.'
      });
    }
    if (ao.strictTemplates === false) {
      results.push({
        level: 'warning',
        message: 'angularCompilerOptions.strictTemplates is false. Enable for safer template type-checking.'
      });
    }
    return results;
  }

  analyzeBrowserslist(raw: string, targetNg: number): ConfigAnalysis['browserslist'] {
    const results: NonNullable<ConfigAnalysis['browserslist']> = [];
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('['));

    const droppedByNg: Record<number, string[]> = {
      15: ['ie 11', 'safari < 14', 'chrome < 90', 'firefox < 78'],
      16: ['safari < 14'],
      17: ['safari < 14.1', 'ios_saf < 14.5', 'chrome < 109', 'firefox < 115'],
      18: ['safari < 16.4'],
      19: ['safari < 17'],
      20: ['safari < 17.4'],
      21: ['safari < 17.4']
    };

    const risky = droppedByNg[targetNg] ?? [];
    const lower = lines.join(' ').toLowerCase();

    for (const pattern of risky) {
      if (lower.includes(pattern)) {
        results.push({
          level: 'critical',
          message: `Target browser "${pattern}" is no longer supported by Angular ${targetNg}.`
        });
      }
    }
    if (lower.includes('ie 11') || lower.includes('ie_mob')) {
      results.push({ level: 'critical', message: 'Internet Explorer was dropped in Angular 13. Remove from .browserslistrc.' });
    }
    if (!lines.length) {
      results.push({ level: 'info', message: '.browserslistrc is empty. Angular will fall back to its built-in defaults.' });
    }
    return results;
  }
}
