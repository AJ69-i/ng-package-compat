import { ExportService } from './export.service';
import { VersionCompatibility } from '../models/npm-package.model';

describe('ExportService', () => {
  let svc: ExportService;

  beforeEach(() => { svc = new ExportService(); });

  /** Defaults for the fields no test in this file actually inspects. */
  const baseExtras = {
    isPrerelease: false,
    hasTypes: false,
    license: null,
    unpackedSize: null,
    peerDependencies: {},
    dependencies: {},
    nodeEngine: null
  };

  const sample: VersionCompatibility[] = [
    {
      version: '1.0.0',
      publishedAt: new Date('2023-01-01T00:00:00Z'),
      isLatest: true,
      isDeprecated: false,
      angularPeerRange: '^16.0.0',
      supportedAngularMajors: [16],
      supportsAny: false,
      detectionSource: 'peer',
      ...baseExtras
    },
    {
      version: '2.0.0, special',
      publishedAt: null,
      isLatest: false,
      isDeprecated: true,
      deprecationMessage: 'old',
      angularPeerRange: null,
      supportedAngularMajors: [],
      supportsAny: true,
      detectionSource: 'none',
      ...baseExtras
    }
  ];

  it('produces valid JSON', () => {
    const json = svc.toJson(sample);
    const parsed = JSON.parse(json);
    expect(parsed.length).toBe(2);
    expect(parsed[0].version).toBe('1.0.0');
  });

  it('escapes commas inside CSV fields', () => {
    const csv = svc.toCsv(sample);
    expect(csv.split('\n')[0]).toContain('version');
    expect(csv).toContain('"2.0.0, special"');
  });

  it('handles empty arrays', () => {
    const csv = svc.toCsv([]);
    expect(csv.split('\n').length).toBe(1); // headers only
    expect(svc.toJson([])).toBe('[]');
  });
});
