import { Injectable } from '@angular/core';
import { ReportEntry, VersionCompatibility } from '../models/npm-package.model';

/**
 * Ticket types we know how to emit — kept narrow on purpose; organizations can
 * remap these on import if their workflow uses custom issue types.
 */
export type JiraIssueType = 'Task' | 'Bug' | 'Story';

/** One row in the Jira-bulk-import CSV we generate. */
export interface JiraTicketRow {
  summary: string;
  description: string;
  priority: 'Highest' | 'High' | 'Medium' | 'Low';
  issueType: JiraIssueType;
  labels: string;
}

@Injectable({ providedIn: 'root' })
export class ExportService {
  toJson(rows: VersionCompatibility[]): string {
    return JSON.stringify(rows, null, 2);
  }

  toCsv(rows: VersionCompatibility[]): string {
    const headers = [
      'version',
      'publishedAt',
      'isLatest',
      'isDeprecated',
      'angularPeerRange',
      'supportedAngularMajors',
      'detectionSource'
    ];
    const lines = [headers.join(',')];
    for (const r of rows) {
      lines.push([
        this.esc(r.version),
        this.esc(r.publishedAt ? r.publishedAt.toISOString() : ''),
        r.isLatest,
        r.isDeprecated,
        this.esc(r.angularPeerRange ?? ''),
        this.esc(r.supportedAngularMajors.join('|')),
        r.detectionSource
      ].join(','));
    }
    return lines.join('\n');
  }

  download(name: string, content: string, mime: string): void {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /**
   * Build a Jira-compatible bulk-import CSV from the compatibility report.
   *
   * Why this matters for enterprise teams:
   *   - Migration work is almost always tracked in Jira, not in spreadsheets.
   *   - Typing 120 tickets by hand is error-prone and demoralizing.
   *   - This takes the full dependency report → one paste into
   *     `Jira → System → External System Import → CSV` and every affected
   *     package lands as a ticket with a meaningful title, rationale, and
   *     priority derived from the compat status.
   *
   * Column mapping we ship (matches the default Jira CSV import wizard):
   *   Summary, Description, Priority, Issue Type, Labels
   *
   * Users can remap additional columns (Epic Link, Assignee, etc.) inside
   * Jira itself during the import dry-run.
   */
  toJiraBulkCsv(
    entries: ReportEntry[],
    opts: { projectKey?: string; targetAngular?: number; labelBase?: string } = {}
  ): string {
    const label = (opts.labelBase ?? 'ng-upgrade').replace(/\s+/g, '-').toLowerCase();
    const target = opts.targetAngular ? `Angular ${opts.targetAngular}` : 'target Angular';

    const headers = ['Summary', 'Description', 'Priority', 'Issue Type', 'Labels'];
    const lines = [headers.join(',')];

    for (const e of entries) {
      if (e.status === 'safe' && !e.deprecation?.npmDeprecated) continue; // skip no-op rows
      const row = this.toJiraRow(e, target, label);
      lines.push(
        [
          this.esc(row.summary),
          this.esc(row.description),
          this.esc(row.priority),
          this.esc(row.issueType),
          this.esc(row.labels)
        ].join(',')
      );
    }
    return lines.join('\n');
  }

  private toJiraRow(e: ReportEntry, target: string, labelBase: string): JiraTicketRow {
    const deprecated = !!e.deprecation?.npmDeprecated;
    const priority: JiraTicketRow['priority'] =
      e.status === 'conflict' || deprecated ? 'High' :
      e.status === 'warning' ? 'Medium' :
      e.status === 'unknown' ? 'Low' : 'Low';

    const issueType: JiraIssueType = deprecated ? 'Bug' : 'Task';

    const summary = deprecated
      ? `Replace deprecated ${e.name} before ${target}`
      : e.status === 'conflict'
      ? `Upgrade ${e.name} for ${target} (blocking)`
      : e.status === 'warning'
      ? `Review ${e.name} for ${target}`
      : `Verify ${e.name} on ${target}`;

    const descParts: string[] = [];
    descParts.push(`Package: ${e.name}`);
    if (e.currentRange || e.currentVersion) {
      descParts.push(`Current: ${e.currentRange ?? e.currentVersion ?? 'unknown'}`);
    }
    if (e.recommendedForTarget?.version) {
      descParts.push(`Recommended for ${target}: ${e.recommendedForTarget.version}`);
    }
    if (e.note) descParts.push(`Notes: ${e.note}`);
    if (deprecated && e.deprecation?.reason) {
      descParts.push(`Deprecation reason: ${e.deprecation.reason}`);
    }
    if (deprecated && e.deprecation?.alternatives?.length) {
      descParts.push(
        'Alternatives: ' + e.deprecation.alternatives.map((a) => a.name).join(', ')
      );
    }
    if (e.installSpec) descParts.push(`Install: npm i ${e.installSpec}`);
    if (e.breakingChanges?.length) {
      descParts.push(
        'Breaking changes to review:\n' +
          e.breakingChanges.map((b) => `- ${b.title}: ${b.detail}`).join('\n')
      );
    }

    const labels = [labelBase, `status-${e.status}`];
    if (deprecated) labels.push('deprecated');
    if (e.ngUpdateAware) labels.push('ng-update');

    return {
      summary,
      description: descParts.join('\n'),
      priority,
      issueType,
      labels: labels.join(' ')
    };
  }

  private esc(v: string | number | boolean): string {
    const s = String(v ?? '');
    if (s.includes('"') || s.includes(',') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }
}
