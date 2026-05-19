import { BundleDeltaSummaryComponent } from './bundle-delta-summary.component';
import type { ReportEntry } from '../../models/npm-package.model';

/**
 * Unit tests for the pure aggregation logic on BundleDeltaSummaryComponent.
 * The component itself is purely visual; the static `aggregate` is the part
 * that has to be right, so that's what we test.
 */
describe('BundleDeltaSummaryComponent.aggregate', () => {
  const mk = (
    name: string,
    delta: number | null,
    pct: number | null = null
  ): Partial<ReportEntry> => ({
    name,
    bundleDelta:
      delta == null
        ? null
        : {
            currentGzip: 1000,
            recommendedGzip: 1000 + delta,
            deltaBytes: delta,
            deltaPercent: pct
          }
  });

  it('reports flat when nothing has data', () => {
    const view = BundleDeltaSummaryComponent.aggregate([]);
    expect(view.totalDeltaBytes).toBe(0);
    expect(view.netDirection).toBe('flat');
    expect(view.countWithData).toBe(0);
    expect(view.countMissingData).toBe(0);
  });

  it('counts entries without bundle data as "missing"', () => {
    const view = BundleDeltaSummaryComponent.aggregate([
      mk('a', null) as ReportEntry,
      mk('b', null) as ReportEntry
    ]);
    expect(view.countMissingData).toBe(2);
    expect(view.countWithData).toBe(0);
  });

  it('flags net growth when total > 1 KB', () => {
    const view = BundleDeltaSummaryComponent.aggregate([
      mk('big', 4096) as ReportEntry,
      mk('tiny-shrink', -100) as ReportEntry
    ]);
    expect(view.netDirection).toBe('grows');
    expect(view.totalDeltaBytes).toBe(4096 - 100);
  });

  it('flags net shrink when total < -1 KB', () => {
    const view = BundleDeltaSummaryComponent.aggregate([
      mk('shrinker', -8192) as ReportEntry
    ]);
    expect(view.netDirection).toBe('shrinks');
    expect(view.shrinkersTotalBytes).toBe(-8192);
  });

  it('returns flat for tiny net deltas', () => {
    const view = BundleDeltaSummaryComponent.aggregate([
      mk('a', 200) as ReportEntry,
      mk('b', -300) as ReportEntry
    ]);
    expect(view.netDirection).toBe('flat');
  });

  it('top growers and shrinkers are capped at 5 and sorted', () => {
    const entries: ReportEntry[] = [];
    for (let i = 0; i < 8; i++) entries.push(mk(`grow-${i}`, (i + 1) * 1024) as ReportEntry);
    for (let i = 0; i < 8; i++) entries.push(mk(`shrink-${i}`, -((i + 1) * 1024)) as ReportEntry);

    const view = BundleDeltaSummaryComponent.aggregate(entries);
    expect(view.topGrowers.length).toBe(5);
    expect(view.topShrinkers.length).toBe(5);
    // Should be in DESC order by delta for growers, ASC for shrinkers.
    expect(view.topGrowers[0].deltaBytes).toBeGreaterThanOrEqual(
      view.topGrowers[1].deltaBytes
    );
    expect(view.topShrinkers[0].deltaBytes).toBeLessThanOrEqual(
      view.topShrinkers[1].deltaBytes
    );
  });

  it('grower share is 1.0 when only growers, 0.0 when only shrinkers', () => {
    const onlyGrow = BundleDeltaSummaryComponent.aggregate([
      mk('g1', 2048) as ReportEntry
    ]);
    expect(onlyGrow.growerShare).toBe(1);
    const onlyShrink = BundleDeltaSummaryComponent.aggregate([
      mk('s1', -2048) as ReportEntry
    ]);
    expect(onlyShrink.growerShare).toBe(0);
  });
});
