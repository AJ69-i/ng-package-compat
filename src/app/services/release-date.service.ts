import { Injectable } from '@angular/core';
import { NpmRegistryResponse } from '../models/npm-package.model';

/**
 * Result of a timeline analysis for one package.
 */
export interface ReleaseTimeline {
  /** Exact ISO date of the user's current version, if known. */
  currentDate: string | null;
  /** Exact ISO date of the latest published version. */
  latestDate: string | null;
  /** Human phrase describing age of current version, e.g. "14 months ago". */
  currentAgo: string | null;
  /** Human phrase describing age of latest version. */
  latestAgo: string | null;
  /** How many days between current and latest (positive means current is older). */
  gapDays: number | null;
  /** True when the gap is > 180 days — surfaced as "stale" in the UI. */
  stale: boolean;
}

/**
 * Release-date + timeline service.
 *
 * Hydrated once per search/report from the NpmRegistryResponse `time` object.
 * Then individual components can synchronously ask for a timeline via
 * timelineFor(pkg) — no extra network calls.
 *
 * The "how stale is this?" question is pure gold when talking to teams:
 * it turns "please upgrade" into "your version is 14 months behind, and the
 * latest was cut 2 weeks ago" — a concrete urgency signal.
 */
@Injectable({ providedIn: 'root' })
export class ReleaseDateService {
  /** Package name → {version → ISO date string}. */
  private cache = new Map<string, Record<string, string>>();
  /** Package name → current version the user is running, set during parsing. */
  private currentVersions = new Map<string, string>();

  /**
   * Seed cache from a registry response. Call this whenever we successfully
   * fetch a package so subsequent UI queries are synchronous.
   */
  hydrate(packageName: string, response: NpmRegistryResponse | null): void {
    if (!response?.time) return;
    this.cache.set(packageName, { ...response.time });
  }

  /**
   * Remember which version a user is currently on (from package.json). This
   * lets us compute "your version released X months ago" later.
   */
  setCurrent(packageName: string, version: string | null): void {
    if (version) this.currentVersions.set(packageName, version);
  }

  /**
   * Return a timeline summary for the given package, or null if we don't
   * have release data yet (e.g. before the user searched for this package).
   */
  timelineFor(packageName: string): ReleaseTimeline | null {
    const times = this.cache.get(packageName);
    if (!times) return null;

    const latestVersion = this.findLatestVersion(times);
    const latestDate = latestVersion ? times[latestVersion] : null;

    const currentVersion = this.currentVersions.get(packageName) ?? null;
    const currentDate = currentVersion && times[currentVersion] ? times[currentVersion] : null;

    const now = Date.now();
    const latestMs = latestDate ? new Date(latestDate).getTime() : null;
    const currentMs = currentDate ? new Date(currentDate).getTime() : null;

    const latestAgo = latestMs !== null ? this.humanize(now - latestMs) : null;
    const currentAgo = currentMs !== null ? this.humanize(now - currentMs) : null;

    const gapDays =
      currentMs !== null && latestMs !== null
        ? Math.round((latestMs - currentMs) / 86_400_000)
        : null;

    const stale = gapDays !== null ? gapDays > 180 : false;

    return {
      currentDate,
      latestDate,
      currentAgo,
      latestAgo,
      gapDays,
      stale
    };
  }

  /**
   * Public helper for simple "published X ago" chips on version rows.
   */
  ageOf(packageName: string, version: string): string | null {
    const times = this.cache.get(packageName);
    const iso = times?.[version];
    if (!iso) return null;
    const ms = Date.now() - new Date(iso).getTime();
    return this.humanize(ms);
  }

  /**
   * Exact published date for a given version, or null.
   */
  dateOf(packageName: string, version: string): string | null {
    return this.cache.get(packageName)?.[version] ?? null;
  }

  /**
   * Count of packages currently hydrated in memory.
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Return all versions sorted by release date ascending (oldest first).
   */
  timelineOrder(packageName: string): Array<{ version: string; date: string }> {
    const times = this.cache.get(packageName);
    if (!times) return [];
    return Object.entries(times)
      .filter(([k]) => k !== 'created' && k !== 'modified')
      .map(([version, date]) => ({ version, date }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  private findLatestVersion(times: Record<string, string>): string | null {
    // Ignore registry metadata keys.
    const versions = Object.keys(times).filter(
      (k) => k !== 'created' && k !== 'modified'
    );
    if (!versions.length) return null;

    // Find the version whose ISO date is the greatest and does not look
    // like a prerelease / beta. Prefer stable releases when present.
    const stable = versions.filter((v) => !/-/.test(v));
    const pool = stable.length ? stable : versions;
    return pool.reduce((acc, v) => (times[v] > times[acc] ? v : acc), pool[0]);
  }

  /** Turn a millisecond duration into a friendly English phrase. */
  private humanize(ms: number): string {
    const absMs = Math.abs(ms);
    const day = 86_400_000;
    const month = 30 * day;
    const year = 365 * day;

    if (absMs < day) {
      const hours = Math.round(absMs / 3_600_000);
      if (hours < 1) return 'today';
      if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
      return 'yesterday';
    }
    if (absMs < 60 * day) {
      const days = Math.round(absMs / day);
      return `${days} day${days === 1 ? '' : 's'} ago`;
    }
    if (absMs < 2 * year) {
      const months = Math.round(absMs / month);
      return `${months} month${months === 1 ? '' : 's'} ago`;
    }
    const years = Math.round((absMs / year) * 10) / 10;
    return `${years} year${years === 1 ? '' : 's'} ago`;
  }
}
