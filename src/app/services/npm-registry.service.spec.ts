import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { NpmRegistryService } from './npm-registry.service';
import { RegistryConfigService } from './registry-config.service';

describe('NpmRegistryService', () => {
  let svc: NpmRegistryService;
  let http: HttpTestingController;

  beforeEach(() => {
    // Wipe any persisted bindings from prior tests so each spec starts at the
    // default public registry.
    try { localStorage.removeItem('ngpc.registries.v1'); } catch { /* ignore */ }

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        NpmRegistryService,
        RegistryConfigService
      ]
    });
    svc = TestBed.inject(NpmRegistryService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('builds the public-registry URL for an unscoped package', (done) => {
    svc.fetchPackage('rxjs').subscribe(() => done());
    const req = http.expectOne('https://registry.npmjs.org/rxjs');
    expect(req.request.method).toBe('GET');
    req.flush({ name: 'rxjs', versions: {} });
  });

  it('URL-encodes scoped package names like npm does (slash stays unencoded)', (done) => {
    svc.fetchPackage('@angular/core').subscribe(() => done());
    // npm hits @angular%2Fcore — the slash in the scope is encoded.
    const req = http.expectOne('https://registry.npmjs.org/@angular%2Fcore');
    expect(req.request.method).toBe('GET');
    req.flush({ name: '@angular/core', versions: {} });
  });

  it('routes scoped packages to a configured private registry with bearer token', (done) => {
    const cfg = TestBed.inject(RegistryConfigService);
    cfg.addBinding({
      scope: '@acme',
      url: 'https://npm.acme.co',
      token: 'secret-abc',
      label: 'ACME private'
    });

    svc.fetchPackage('@acme/widget').subscribe(() => done());
    const req = http.expectOne('https://npm.acme.co/@acme%2Fwidget');
    expect(req.request.headers.get('Authorization')).toBe('Bearer secret-abc');
    req.flush({ name: '@acme/widget', versions: {} });
  });

  it('does not retry on 404', (done) => {
    svc.fetchPackage('does-not-exist').subscribe({
      next: () => fail('should have errored'),
      error: (err) => {
        expect(err.status).toBe(404);
        done();
      }
    });
    const req = http.expectOne('https://registry.npmjs.org/does-not-exist');
    req.flush('not found', { status: 404, statusText: 'Not Found' });
    // Verify NO follow-up retry request was made.
    http.expectNone('https://registry.npmjs.org/does-not-exist');
  });

  it('does not retry on 401 / 403 (auth issues — no rate-limit waste)', (done) => {
    svc.fetchPackage('private-pkg').subscribe({
      next: () => fail('should have errored'),
      error: (err) => {
        expect([401, 403]).toContain(err.status);
        done();
      }
    });
    const req = http.expectOne('https://registry.npmjs.org/private-pkg');
    req.flush('forbidden', { status: 403, statusText: 'Forbidden' });
    http.expectNone('https://registry.npmjs.org/private-pkg');
  });
});
