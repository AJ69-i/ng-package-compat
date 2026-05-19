import { Injectable, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { CompatibilityReport, ReportEntry } from '../models/npm-package.model';

/**
 * A snapshot is a tiny lossy projection of a CompatibilityReport — just enough
 * to diff "what's different from last time" without storing the whole report
 * (which can be 50–100 KB of JSON per project).
 *
 * Stored by `projectKey` (full repo name from the handoff, or a hash if the
 * project was uploaded directly).
 */
export interface ReportSnapshot {
  projectKey: string;
  /** Display name surfaced in the digest UI. */
  label: string;
  /** Angular major used as the analysis target. */
  targetAngularMajor: number;
  /** Health score at the time of capture. */
  healthScore: number;
  /** Per-package facts we care about diffing. */
  packages: Record<
    string,
    {
      currentVersion: string | null;
      recommendedVersion: string | null;
      status: ReportEntry['status'];
      deprecated: boolean;
    }
  >;
  /** Epoch ms. */
  capturedAt: number;
}

/**
 * One row of the diff between two snapshots — stable enough to render inline.
 */
export type DigestChange =
  | { kind: 'added'; package: string; status: ReportEntry['status']; recommendedVersion: string | null }
  | { kind: 'removed'; package: string }
  | { kind: 'status-changed'; package: string; from: ReportEntry['status']; to: ReportEntry['status'] }
  | { kind: 'recommended-changed'; package: string; from: string | null; to: string | null }
  | { kind: 'deprecated'; package: string }
  | { kind: 'undeprecated'; package: string };

export interface ProjectDigest {
  projectKey: string;
  label: string;
  capturedAt: number;
  prevCapturedAt: number;
  prevHealthScore: number;
  currentHealthScore: number;
  healthDelta: number;
  changes: DigestChange[];
}

const STORAGE_KEY = 'ngpc.snapshots.v1';
const PREFS_KEY = 'ngpc.monitor.v1';

interface MonitorPrefs {
  /** When true, auto-recapture every `intervalMinutes` while the app is open. */
  autoEnabled: boolean;
  /** Minutes between re-captures; capped at 60 in the UI. */
  intervalMinutes: number;
}

const DEFAULT_PREFS: MonitorPrefs = { autoEnabled: false, intervalMinutes: 30 };

/**
 * Continuous-monitoring service.
 *
 * Why: enterprise teams want to know "the upgrade we approved last sprint
 * is still safe — and here are the 3 packages that gained new compat
 * advice since then." Capture-on-build + a stored history-of-snapshots
 * lets us render a digest without ever needing a server.
 *
 * SSR-safe (storage is gated by isPlatformBrowser).
 */
@Injectable({ providedIn: 'root' })
export class MonitorService {
  private readonly platformId = inject(PLATFORM_ID);

  /** Map of projectKey -> latest snapshot. */
  readonly snapshots = signal<Record<string, ReportSnapshot>>({});

  /** Recent digests, computed lazily; keyed by projectKey. */
  readonly latestDigests = signal<Record<string, ProjectDigest>>({});

  readonly prefs = signal<MonitorPrefs>({ ...DEFAULT_PREFS });

  /** Total number of monitored projects (for nav badges, etc). */
  readonly trackedCount = computed(() => Object.keys(this.snapshots()).length);

  /** Sum of changes across the last digest of every project. */
  readonly pendingChangeCount = computed(() => {
    let n = 0;
    const digests = this.latestDigests();
    for (const k in digests) n += digests[k].changes.length;
    return n;
  });

  constructor() {
    if (isPlatformBrowser(this.platformId)) {
      this.load();
    }
  }

  /**
   * Replace the entire snapshot map. Used by SupabaseSyncService on PULL.
   */
  replaceSnapshots(map: Record<string, ReportSnapshot>): void {
    this.snapshots.set({ ...map });
    this.persist();
  }

  /**
   * Capture a snapshot of the current report. If a previous snapshot exists
   * for this `projectKey`, also computes a digest and stores it.
   */
  capture(report: CompatibilityReport, projectKey: string, label: string): ProjectDigest | null {
    const next = this.toSnapshot(report, projectKey, label);
    const prev = this.snapshots()[projectKey] ?? null;

    // Always update the stored snapshot.
    this.snapshots.update((m) => ({ ...m, [projectKey]: next }));

    let digest: ProjectDigest | null = null;
    if (prev) {
      const changes = this.diff(prev, next);
      digest = {
        projectKey,
        label,
        capturedAt: next.capturedAt,
        prevCapturedAt: prev.capturedAt,
        prevHealthScore: prev.healthScore,
        currentHealthScore: next.healthScore,
        healthDelta: next.healthScore - prev.healthScore,
        changes
      };
      this.latestDigests.update((m) => ({ ...m, [projectKey]: digest! }));
    }
    this.persist();
    return digest;
  }

  /** Read the most recent snapshot for a project (null if none yet). */
  getSnapshot(projectKey: string): ReportSnapshot | null {
    return this.snapshots()[projectKey] ?? null;
  }

  /** Read the most recent digest, if any. */
  getDigest(projectKey: string): ProjectDigest | null {
    return this.latestDigests()[projectKey] ?? null;
  }

  /** Remove a project from monitoring entirely. */
  forget(projectKey: string): void {
    this.snapshots.update((m) => {
      const { [projectKey]: _, ...rest } = m;
      return rest;
    });
    this.latestDigests.update((m) => {
      const { [projectKey]: _, ...rest } = m;
      return rest;
    });
    this.persist();
  }

  clearAll(): void {
    this.snapshots.set({});
    this.latestDigests.set({});
    this.persist();
  }

  setPrefs(patch: Partial<MonitorPrefs>): void {
    const next = { ...this.prefs(), ...patch };
    if (next.intervalMinutes < 5) next.intervalMinutes = 5;
    if (next.intervalMinutes > 60) next.intervalMinutes = 60;
    this.prefs.set(next);
    this.persistPrefs();
  }

  /** Stable-key derivation for a project. */
  static keyFor(label: string): string {
    return label.trim().toLowerCase();
  }

  // ---------- Internals ----------

  private toSnapshot(
    report: CompatibilityReport,
    projectKey: string,
    label: string
  ): ReportSnapshot {
    const packages: ReportSnapshot['packages'] = {};
    for (const e of report.entries) {
      packages[e.name] = {
        currentVersion: e.currentVersion,
        recommendedVersion: e.recommendedForTarget?.version ?? null,
        status: e.status,
        deprecated: !!e.deprecation
      };
    }
    return {
      projectKey,
      label,
      targetAngularMajor: report.targetAngularMajor,
      healthScore: report.health.score,
      packages,
      capturedAt: Date.now()
    };
  }

  private diff(prev: ReportSnapshot, next: ReportSnapshot): DigestChange[] {
    const out: DigestChange[] = [];
    const prevNames = new Set(Object.keys(prev.packages));
    const nextNames = new Set(Object.keys(next.packages));

    for (const name of nextNames) {
      const n = next.packages[name];
      if (!prevNames.has(name)) {
        out.push({
          kind: 'added',
          package: name,
          status: n.status,
          recommendedVersion: n.recommendedVersion
        });
        continue;
      }
      const p = prev.packages[name];
      if (p.status !== n.status) {
        out.push({ kind: 'status-changed', package: name, from: p.status, to: n.status });
      }
      if (p.recommendedVersion !== n.recommendedVersion) {
        out.push({
          kind: 'recommended-changed',
          package: name,
          from: p.recommendedVersion,
          to: n.recommendedVersion
        });
      }
      if (!p.deprecated && n.deprecated) {
        out.push({ kind: 'deprecated', package: name });
      }
      if (p.deprecated && !n.deprecated) {
        out.push({ kind: 'undeprecated', package: name });
      }
    }

    for (const name of prevNames) {
      if (!nextNames.has(name)) {
        out.push({ kind: 'removed', package: name });
      }
    }

    return out;
  }

  private persist(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    try {
      const blob = JSON.stringify({
        snapshots: this.snapshots(),
        digests: this.latestDigests()
      });
      localStorage.setItem(STORAGE_KEY, blob);
    } catch {
      /* localStorage exhausted — accept loss; this is recoverable. */
    }
  }

  private persistPrefs(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs()));
    } catch {
      /* ignore */
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          if (parsed.snapshots) this.snapshots.set(parsed.snapshots);
          if (parsed.digests) this.latestDigests.set(parsed.digests);
        }
      }
    } catch {
      /* ignore corrupt blob */
    }
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this.prefs.set({ ...DEFAULT_PREFS, ...parsed });
        }
      }
    } catch {
      /* ignore */
    }
  }
}
