import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { DetectionSource, VersionCompatibility } from '../../models/npm-package.model';
import { CopyOnClickDirective } from '../../directives/copy-on-click.directive';

@Component({
  selector: 'app-versions-table',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, DatePipe, RouterLink, CopyOnClickDirective],
  template: `
    @if ((rows() ?? []).length) {
      <!-- .scroll-table is the global utility (styles.scss) that caps
           height at min(600px, 70vh) and keeps the thead sticky.
           .table-wrap retains the component-specific border + bg
           (a thin border + surface-2 background that distinguishes
           the table block from the panel around it). The classes
           compose cleanly — the existing thead sticky rule is more
           specific and stays in charge of its own background. -->
      <div class="table-wrap scroll-table" role="region" aria-label="Versions">
        <table class="versions" aria-live="polite">
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Published</th>
              <th scope="col">Angular range</th>
              <th scope="col">Compatible Angular</th>
              <th scope="col">Source</th>
              <th scope="col">Size</th>
              <th scope="col">Status</th>
              <th scope="col" class="actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            @for (row of rows(); track row.version) {
              <tr [class.deprecated]="row.isDeprecated" [class.latest]="row.isLatest">
                <td data-label="Version">
                  <strong [appCopyOnClick]="row.version" copyLabel="version">{{ row.version }}</strong>
                  @if (row.isLatest) { <span class="pill pill-latest">latest</span> }
                  @if (row.isPrerelease) { <span class="pill pill-pre">pre</span> }
                  @if (row.hasTypes) { <span class="pill pill-types" title="Ships TypeScript types">TS</span> }
                </td>
                <td data-label="Published">
                  @if (row.publishedAt) {
                    {{ row.publishedAt | date: 'mediumDate' }}
                  } @else {
                    —
                  }
                </td>
                <td data-label="Range">
                  @if (row.angularPeerRange) {
                    <code>{{ row.angularPeerRange }}</code>
                  } @else {
                    <span class="muted">no &#64;angular/* signal</span>
                  }
                </td>
                <td data-label="Compatible Angular">
                  @if (row.supportsAny) {
                    <span class="muted">any</span>
                  } @else if (row.supportedAngularMajors.length) {
                    <span class="pill-group">
                      @for (m of row.supportedAngularMajors; track m) {
                        <span class="pill pill-major">{{ m }}</span>
                      }
                    </span>
                  } @else {
                    <span class="muted">—</span>
                  }
                </td>
                <td data-label="Source">
                  <span
                    [class]="sourceClass(row.detectionSource)"
                    [attr.title]="'Detected via: ' + row.detectionSource"
                  >{{ sourceLabel(row.detectionSource) }}</span>
                </td>
                <td data-label="Size">
                  @if (row.unpackedSize) {
                    <span class="muted">{{ formatBytes(row.unpackedSize) }}</span>
                  } @else {
                    <span class="muted">—</span>
                  }
                </td>
                <td data-label="Status">
                  @if (row.isDeprecated) {
                    <span class="pill pill-deprecated" [title]="row.deprecationMessage || 'Deprecated'">deprecated</span>
                  } @else if (row.isLatest) {
                    <span class="pill pill-latest">latest</span>
                  } @else {
                    <span class="muted">—</span>
                  }
                </td>
                <td data-label="Actions" class="actions">
                  <button
                    type="button"
                    class="copy"
                    (click)="copy.emit(row.version)"
                    [attr.aria-label]="'Copy install command for version ' + row.version"
                  >
                    {{ copiedVersion() === row.version ? 'Copied!' : 'Copy' }}
                  </button>
                  @if (pkgName()) {
                    <a
                      class="link-btn"
                      [routerLink]="['/dependencies', pkgName(), row.version]"
                      title="Show full dependency list"
                    >Deps</a>
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    } @else {
      <p class="empty">No versions match.</p>
    }
  `,
  styleUrls: ['./versions-table.component.scss']
})
export class VersionsTableComponent {
  readonly rows = input<VersionCompatibility[] | null>(null);
  readonly copiedVersion = input<string | null>(null);
  readonly pkgName = input<string | null>(null);
  readonly copy = output<string>();

  sourceLabel(src: DetectionSource): string {
    switch (src) {
      case 'peer': return 'peer';
      case 'dependency': return 'dep';
      case 'devDependency': return 'devDep';
      case 'angular-package-name': return '@angular/*';
      case 'none': default: return '—';
    }
  }

  sourceClass(src: DetectionSource): string {
    switch (src) {
      case 'peer': return 'pill-src pill-src-peer';
      case 'dependency': return 'pill-src pill-src-dep';
      case 'devDependency': return 'pill-src pill-src-dev';
      case 'angular-package-name': return 'pill-src pill-src-name';
      case 'none': default: return 'pill-src pill-src-none';
    }
  }

  formatBytes(n: number): string {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }
}
