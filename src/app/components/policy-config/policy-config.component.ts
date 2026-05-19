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
import {
  PolicyKind,
  PolicyRule,
  PolicyService,
  PolicySeverity
} from '../../services/policy.service';
import { ToastService } from '../../services/toast.service';

interface DraftRule {
  kind: PolicyKind;
  pattern: string;
  version: string;
  license: string;
  scopes: string;
  severity: PolicySeverity;
  label: string;
  note: string;
}

const EMPTY_DRAFT: DraftRule = {
  kind: 'block-package',
  pattern: '',
  version: '',
  license: '',
  scopes: '',
  severity: 'block',
  label: '',
  note: ''
};

/**
 * Collapsible card for managing policy rules. Lives on the upgrade page
 * (alongside RegistryConfig) and on the workspace page so the same rules
 * apply whether the user is in direct mode or the LinkedIn workspace.
 *
 * Each rule is drafted in a single form, then committed to the service.
 * The form re-renders its inputs based on `kind` so we don't show every
 * field for every kind (unused fields would just confuse).
 */
@Component({
  selector: 'app-policy-config',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, TranslocoModule],
  template: `
    <details class="policy" [open]="open()">
      <summary (click)="toggle($event)">
        <span class="title">{{ 'policy.title' | transloco }}</span>
        <span class="meta">
          @if (rules().length) {
            {{ 'policy.summary.count' | transloco: { count: rules().length, enabled: enabled() } }}
          } @else {
            {{ 'policy.summary.empty' | transloco }}
          }
        </span>
      </summary>

      <p class="lede">{{ 'policy.lede' | transloco }}</p>

      @if (rules().length) {
        <ul class="rules">
          @for (r of rules(); track r.id) {
            <li [class.disabled]="!r.enabled">
              <div class="row">
                <label class="toggle">
                  <input type="checkbox" [checked]="r.enabled" (change)="toggle$(r.id)" />
                </label>
                <div class="info">
                  <strong>{{ r.label || description(r) }}</strong>
                  <small>
                    {{ kindLabel(r.kind) }} ·
                    <span [class.warn]="r.severity === 'warn'" [class.block]="r.severity === 'block'">
                      {{ severityLabel(r.severity) }}
                    </span>
                    @if (r.note) { · {{ r.note }} }
                  </small>
                </div>
                <button type="button" class="ghost danger" (click)="remove(r.id)">
                  {{ 'policy.remove' | transloco }}
                </button>
              </div>
            </li>
          }
        </ul>
      }

      <form class="form" (submit)="add($event)" novalidate>
        <header>
          <h4>{{ 'policy.add.title' | transloco }}</h4>
        </header>
        <div class="grid">
          <label>
            <span>{{ 'policy.add.kind' | transloco }}</span>
            <select [(ngModel)]="draft.kind" name="kind" (change)="onKindChange()">
              <option value="block-package">{{ kindLabel('block-package') }}</option>
              <option value="block-scope">{{ kindLabel('block-scope') }}</option>
              <option value="min-version">{{ kindLabel('min-version') }}</option>
              <option value="max-version">{{ kindLabel('max-version') }}</option>
              <option value="pin-version">{{ kindLabel('pin-version') }}</option>
              <option value="block-license">{{ kindLabel('block-license') }}</option>
              <option value="block-deprecated">{{ kindLabel('block-deprecated') }}</option>
              <option value="require-scope">{{ kindLabel('require-scope') }}</option>
            </select>
          </label>

          @if (needsPackagePattern()) {
            <label>
              <span>{{ patternLabel() }}</span>
              <input
                type="text"
                [(ngModel)]="draft.pattern"
                name="pattern"
                [placeholder]="patternPlaceholder()"
              />
            </label>
          }

          @if (needsVersion()) {
            <label>
              <span>{{ 'policy.add.version' | transloco }}</span>
              <input
                type="text"
                [(ngModel)]="draft.version"
                name="version"
                [placeholder]="versionPlaceholder()"
              />
            </label>
          }

          @if (draft.kind === 'block-license') {
            <label>
              <span>{{ 'policy.add.license' | transloco }}</span>
              <input
                type="text"
                [(ngModel)]="draft.license"
                name="license"
                placeholder="GPL-3.0 or GPL*"
              />
            </label>
          }

          @if (draft.kind === 'require-scope') {
            <label class="full">
              <span>{{ 'policy.add.scopes' | transloco }}</span>
              <input
                type="text"
                [(ngModel)]="draft.scopes"
                name="scopes"
                placeholder="@acme, @internal"
              />
            </label>
          }

          <label>
            <span>{{ 'policy.add.severity' | transloco }}</span>
            <select [(ngModel)]="draft.severity" name="severity">
              <option value="block">{{ 'policy.severity.block' | transloco }}</option>
              <option value="warn">{{ 'policy.severity.warn' | transloco }}</option>
            </select>
          </label>

          <label class="full">
            <span>{{ 'policy.add.label' | transloco }}</span>
            <input type="text" [(ngModel)]="draft.label" name="label" />
          </label>

          <label class="full">
            <span>{{ 'policy.add.note' | transloco }}</span>
            <input type="text" [(ngModel)]="draft.note" name="note" />
          </label>
        </div>
        <div class="actions">
          <button type="submit" class="primary">{{ 'policy.add.cta' | transloco }}</button>
        </div>
      </form>

      <details class="io">
        <summary>{{ 'policy.io.title' | transloco }}</summary>
        <p class="muted">{{ 'policy.io.lede' | transloco }}</p>
        <textarea [(ngModel)]="ioBlob" name="io" spellcheck="false"></textarea>
        <div class="actions">
          <button type="button" class="ghost" (click)="exportRules()">
            {{ 'policy.io.export' | transloco }}
          </button>
          <button type="button" class="primary" (click)="importRules()">
            {{ 'policy.io.import' | transloco }}
          </button>
          @if (rules().length) {
            <button type="button" class="ghost danger" (click)="clearAll()">
              {{ 'policy.io.clear' | transloco }}
            </button>
          }
        </div>
      </details>
    </details>
  `,
  styles: [`
    :host { display: block; margin-bottom: 1rem; }
    .policy {
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 12px;
      background: var(--surface-1, #fff);
      padding: 0.85rem 1rem;
    }
    summary { cursor: pointer; display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
    summary .title { font-weight: 600; font-size: 0.95rem; }
    summary .meta { color: var(--fg-dim, #64748b); font-size: 0.8rem; }
    .lede { color: var(--fg-dim, #64748b); font-size: 0.85rem; margin: 0.5rem 0 0.85rem; }
    .rules { list-style: none; padding: 0; margin: 0 0 0.85rem; display: flex; flex-direction: column; gap: 0.4rem; }
    .rules li {
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 8px;
      padding: 0.5rem 0.7rem;
      background: var(--surface-1, #fff);
    }
    .rules li.disabled { opacity: 0.55; }
    .row { display: flex; gap: 0.6rem; align-items: center; }
    .row .info { flex: 1 1 auto; min-width: 0; }
    .row strong { display: block; font-size: 0.9rem; }
    .row small { color: var(--fg-dim, #64748b); font-size: 0.78rem; }
    .row small .warn { color: #b45309; font-weight: 600; }
    .row small .block { color: #b91c1c; font-weight: 600; }
    .toggle { display: grid; place-items: center; }
    .form {
      border-top: 1px dashed var(--border, #e5e7eb);
      padding-top: 0.85rem;
      margin-bottom: 0.85rem;
    }
    .form header h4 { margin: 0 0 0.6rem; font-size: 0.9rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 0.5rem 0.7rem; }
    .grid label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.8rem; color: var(--fg-dim, #64748b); }
    .grid label.full { grid-column: 1 / -1; }
    .grid input, .grid select {
      padding: 0.35rem 0.5rem;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 6px;
      font: inherit;
      font-size: 0.82rem;
    }
    .actions { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-top: 0.6rem; }
    button { font: inherit; cursor: pointer; }
    button.primary {
      padding: 0.4rem 0.9rem; border-radius: 6px; border: none;
      background: var(--accent, #2563eb); color: #fff; font-weight: 600; font-size: 0.82rem;
    }
    button.ghost {
      padding: 0.4rem 0.9rem; border-radius: 6px;
      background: transparent; border: 1px solid var(--border, #e5e7eb);
      font-size: 0.82rem;
    }
    button.ghost.danger { color: #dc2626; border-color: color-mix(in srgb, #dc2626 30%, var(--border, #e5e7eb)); }
    .io { margin-top: 0.85rem; padding-top: 0.85rem; border-top: 1px dashed var(--border, #e5e7eb); }
    .io summary { font-weight: 600; font-size: 0.85rem; color: var(--fg-dim, #64748b); }
    .io textarea {
      width: 100%; min-height: 8rem; margin-top: 0.5rem;
      padding: 0.5rem; font: 0.78rem ui-monospace, Menlo, Consolas, monospace;
      border: 1px solid var(--border, #e5e7eb);
      border-radius: 8px; resize: vertical;
    }
    .muted { color: var(--fg-dim, #64748b); font-size: 0.82rem; margin: 0.4rem 0 0; }
  `]
})
export class PolicyConfigComponent {
  private readonly policy = inject(PolicyService);
  private readonly toast = inject(ToastService);

  readonly rules = this.policy.rules;
  readonly enabled = this.policy.enabledCount;
  readonly open = signal(false);

  // Draft is a plain object so ngModel two-way binding works natively.
  draft: DraftRule = { ...EMPTY_DRAFT };
  ioBlob = '';

  toggle(ev: Event): void {
    ev.preventDefault();
    this.open.update((v) => !v);
  }

  onKindChange(): void {
    // Reset fields that aren't relevant to the new kind so we don't carry
    // stale values into the wrong rule shape.
    if (this.draft.kind === 'block-deprecated') {
      this.draft.pattern = '';
      this.draft.version = '';
    }
    if (this.draft.kind !== 'block-license') {
      this.draft.license = '';
    }
    if (this.draft.kind !== 'require-scope') {
      this.draft.scopes = '';
    }
  }

  needsPackagePattern(): boolean {
    return ['block-package', 'block-scope', 'min-version', 'max-version', 'pin-version'].includes(
      this.draft.kind
    );
  }

  needsVersion(): boolean {
    return ['min-version', 'max-version', 'pin-version'].includes(this.draft.kind);
  }

  patternLabel(): string {
    if (this.draft.kind === 'block-scope') return 'Scope (e.g. @bad)';
    return 'Package (e.g. lodash, @acme/*)';
  }

  patternPlaceholder(): string {
    if (this.draft.kind === 'block-scope') return '@example';
    return 'lodash or @acme/*';
  }

  versionPlaceholder(): string {
    if (this.draft.kind === 'pin-version') return '^7.5.0 or 7.x';
    return '7.5.0';
  }

  kindLabel(k: PolicyKind): string {
    switch (k) {
      case 'block-package': return 'Block package';
      case 'block-scope': return 'Block scope';
      case 'min-version': return 'Minimum version';
      case 'max-version': return 'Maximum version';
      case 'pin-version': return 'Pinned range';
      case 'block-license': return 'Block license';
      case 'block-deprecated': return 'Block deprecated';
      case 'require-scope': return 'Require approved scopes';
    }
  }

  severityLabel(s: PolicySeverity): string {
    return s === 'block' ? 'Block' : 'Warn';
  }

  description(r: PolicyRule): string {
    return this.policy.describe(r);
  }

  toggle$(id: string): void {
    this.policy.toggle(id);
  }

  remove(id: string): void {
    this.policy.remove(id);
  }

  add(ev: Event): void {
    ev.preventDefault();
    const d = this.draft;
    if (this.needsPackagePattern() && !d.pattern.trim()) {
      this.toast.error('Pattern is required for this rule kind.');
      return;
    }
    if (this.needsVersion() && !d.version.trim()) {
      this.toast.error('Version is required for this rule kind.');
      return;
    }
    if (d.kind === 'block-license' && !d.license.trim()) {
      this.toast.error('License is required.');
      return;
    }
    if (d.kind === 'require-scope' && !d.scopes.trim()) {
      this.toast.error('At least one scope is required.');
      return;
    }
    this.policy.add({
      kind: d.kind,
      label: d.label.trim(),
      pattern: d.pattern.trim() || undefined,
      version: d.version.trim() || undefined,
      license: d.license.trim() || undefined,
      scopes: d.kind === 'require-scope'
        ? d.scopes.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined,
      note: d.note.trim() || undefined,
      severity: d.severity,
      enabled: true
    });
    this.toast.success('Policy rule added.');
    this.draft = { ...EMPTY_DRAFT };
  }

  exportRules(): void {
    this.ioBlob = this.policy.exportJson();
    this.toast.success('Rules exported below — copy to share.');
  }

  importRules(): void {
    const n = this.policy.importJson(this.ioBlob.trim());
    if (n) {
      this.toast.success(`Imported ${n} rule${n === 1 ? '' : 's'}.`);
      this.ioBlob = '';
    } else {
      this.toast.error('Could not parse JSON. Expected an array of policy rules.');
    }
  }

  clearAll(): void {
    if (confirm('Remove all policy rules?')) {
      this.policy.clearAll();
      this.toast.success('All rules cleared.');
    }
  }
}
