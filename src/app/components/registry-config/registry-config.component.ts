import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslocoModule } from '@jsverse/transloco';
import { RegistryConfigService, RegistryBinding } from '../../services/registry-config.service';
import { ToastService } from '../../services/toast.service';

/**
 * Compact UI for configuring private npm registries (feature #72).
 *
 * Exposed as a collapsible `<details>` so it doesn't take up real estate for
 * the 90% case (public npm). Supports two entry paths:
 *
 *   1. Manual — add `@scope → url [+ token]` bindings one at a time.
 *   2. Paste an `.npmrc` — we parse scoped registries + auth tokens and
 *      create bindings for each. Covers the Artifactory / GitHub Packages /
 *      Verdaccio setups most enterprise users already have.
 *
 * Tokens live in localStorage only. We never ship them anywhere except the
 * registry request the user triggered.
 */
@Component({
  selector: 'app-registry-config',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, TranslocoModule],
  template: `
    <details class="rc" data-tour="registry">
      <summary>
        <span>{{ 'registry.title' | transloco }}</span>
        @if (bindingCount() > 0) {
          <span class="pill">{{ bindingCount() }}</span>
        }
      </summary>

      @if (bindings().length) {
        <!-- .scroll-table for sticky thead consistency with the rest
             of the app. Most users have 1-5 registries so the cap
             rarely engages, but the sticky thead still looks tidy
             if it does. -->
        <div class="scroll-table scroll-table-short">
        <table>
          <thead>
            <tr>
              <th>{{ 'registry.scope' | transloco }}</th>
              <th>{{ 'registry.url' | transloco }}</th>
              <th>{{ 'registry.auth' | transloco }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (b of bindings(); track b.scope ?? b.url) {
              <tr>
                <td><code>{{ b.scope || ('registry.globalOverride' | transloco) }}</code></td>
                <td><code class="url">{{ b.url }}</code></td>
                <td>{{ b.token ? ('registry.tokenYes' | transloco) : ('registry.tokenNo' | transloco) }}</td>
                <td>
                  <button type="button" class="link danger" (click)="remove(b)">
                    {{ 'registry.remove' | transloco }}
                  </button>
                </td>
              </tr>
            }
          </tbody>
        </table>
        </div>
      } @else {
        <p class="muted">{{ 'registry.empty' | transloco }}</p>
      }

      <fieldset class="form">
        <legend>{{ 'registry.addTitle' | transloco }}</legend>
        <div class="grid">
          <label>
            <span>{{ 'registry.scope' | transloco }}</span>
            <input
              type="text"
              [ngModel]="formScope()"
              (ngModelChange)="formScope.set($event)"
              placeholder="@acme"
              autocomplete="off"
              spellcheck="false"
            />
          </label>
          <label class="wide">
            <span>{{ 'registry.url' | transloco }}</span>
            <input
              type="url"
              [ngModel]="formUrl()"
              (ngModelChange)="formUrl.set($event)"
              placeholder="https://npm.acme.co"
              autocomplete="off"
              spellcheck="false"
            />
          </label>
          <label class="wide">
            <span>{{ 'registry.token' | transloco }}</span>
            <input
              type="password"
              [ngModel]="formToken()"
              (ngModelChange)="formToken.set($event)"
              placeholder="(optional)"
              autocomplete="off"
              spellcheck="false"
            />
          </label>
        </div>
        <div class="row">
          <button type="button" class="primary" [disabled]="!canSubmit()" (click)="add()">
            {{ 'registry.add' | transloco }}
          </button>
          <button type="button" class="ghost" (click)="reset()">
            {{ 'registry.reset' | transloco }}
          </button>
        </div>
      </fieldset>

      <fieldset class="form">
        <legend>{{ 'registry.importTitle' | transloco }}</legend>
        <textarea
          rows="4"
          spellcheck="false"
          [ngModel]="npmrcInput()"
          (ngModelChange)="npmrcInput.set($event)"
          [placeholder]="'registry.importPlaceholder' | transloco"
        ></textarea>
        <div class="row">
          <button type="button" class="primary" (click)="importNpmrc()">
            {{ 'registry.import' | transloco }}
          </button>
          @if (bindings().length) {
            <button type="button" class="link danger" (click)="clearAll()">
              {{ 'registry.clearAll' | transloco }}
            </button>
          }
        </div>
      </fieldset>
    </details>
  `,
  styles: [`
    :host { display: block; }
    .rc {
      border: 1px solid var(--border, #e5e7eb);
      border-radius: var(--r-md, 10px);
      padding: 0.5rem 0.8rem;
      background: var(--surface-2, #f8fafc);
      margin: 0.75rem 0;
    }
    summary {
      cursor: pointer; font-weight: 600; font-size: 0.92rem;
      display: inline-flex; align-items: center; gap: 0.4rem;
      color: var(--fg, #0f172a);
    }
    .pill {
      background: var(--accent, #2563eb); color: #fff;
      font-size: 0.72rem; padding: 0.05rem 0.5rem;
      border-radius: 999px;
    }
    .muted { color: var(--fg-dim, #64748b); font-size: 0.85rem; margin: 0.5rem 0; }
    table { width: 100%; border-collapse: collapse; margin: 0.5rem 0; font-size: 0.82rem; }
    th, td { padding: 0.4rem 0.5rem; text-align: left; border-bottom: 1px solid var(--border-soft, #f1f5f9); }
    th { font-weight: 600; background: var(--surface-1, #fff); }
    code { background: var(--surface-1, #fff); padding: 0.05rem 0.3rem; border-radius: 4px; font-size: 0.78rem; }
    code.url { word-break: break-all; }
    .form { border: 1px solid var(--border-soft, #e5e7eb); border-radius: 8px; padding: 0.6rem 0.8rem; margin-top: 0.6rem; background: var(--surface-1, #fff); }
    .form legend { padding: 0 0.4rem; font-size: 0.82rem; color: var(--fg-dim, #475569); }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.5rem; }
    .grid label { display: grid; gap: 0.25rem; font-size: 0.82rem; }
    .grid label.wide { grid-column: 1 / -1; }
    .grid input, textarea {
      width: 100%;
      padding: 0.4rem 0.55rem;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 6px;
      background: var(--surface-2, #f8fafc);
      color: var(--fg, #0f172a);
      font: inherit;
      font-size: 0.82rem;
    }
    textarea { font-family: ui-monospace, monospace; }
    .row { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.5rem; align-items: center; }
    button { font: inherit; cursor: pointer; }
    button.primary {
      padding: 0.4rem 0.9rem; border-radius: 6px; border: none;
      background: var(--accent, #2563eb); color: #fff; font-weight: 600; font-size: 0.82rem;
    }
    button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
    button.ghost {
      padding: 0.4rem 0.9rem; border-radius: 6px; border: 1px solid var(--border, #e5e7eb);
      background: transparent; font-size: 0.82rem;
    }
    button.link {
      background: none; border: none; color: var(--accent, #2563eb);
      text-decoration: underline; padding: 0;
    }
    button.link.danger { color: #dc2626; }
  `]
})
export class RegistryConfigComponent {
  private readonly config = inject(RegistryConfigService);
  private readonly toast = inject(ToastService);

  readonly bindings = this.config.bindings;
  readonly bindingCount = computed(() => this.bindings().length);

  readonly formScope = signal('');
  readonly formUrl = signal('');
  readonly formToken = signal('');
  readonly npmrcInput = signal('');

  readonly canSubmit = computed(
    () => this.formUrl().trim().startsWith('http')
  );

  add(): void {
    const url = this.formUrl().trim();
    if (!url) return;
    const scope = this.formScope().trim();
    try {
      new URL(url);
    } catch {
      this.toast.error('That URL doesn\u2019t look valid.');
      return;
    }
    this.config.addBinding({
      scope: scope || null,
      url,
      token: this.formToken().trim() || null,
      label: scope || new URL(url).host
    });
    this.toast.success(scope ? `Routed ${scope} to ${new URL(url).host}` : 'Registry added');
    this.reset();
  }

  remove(b: RegistryBinding): void {
    this.config.removeBinding(b.scope);
    this.toast.success(b.scope ? `Removed ${b.scope}` : 'Override removed');
  }

  clearAll(): void {
    this.config.clearAll();
    this.toast.success('All registries cleared');
  }

  reset(): void {
    this.formScope.set('');
    this.formUrl.set('');
    this.formToken.set('');
  }

  importNpmrc(): void {
    const raw = this.npmrcInput();
    if (!raw.trim()) return;
    const n = this.config.importNpmrc(raw);
    if (n > 0) {
      this.toast.success(`Imported ${n} registr${n === 1 ? 'y' : 'ies'}`);
      this.npmrcInput.set('');
    } else {
      this.toast.error('No @scope:registry entries found in that .npmrc');
    }
  }
}
