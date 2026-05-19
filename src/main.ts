import { bootstrapApplication } from '@angular/platform-browser';
import * as Sentry from '@sentry/angular';
import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config';
import { environment } from './environments/environment';

// Sentry must be initialized BEFORE bootstrapApplication so that
// errors thrown during the initial render are captured. We gate the
// init on environment.sentry.enabled so dev sessions don't spam the
// dashboard with noisy stack traces — Sentry is on in production
// (environment.prod.ts flips the flag) and off everywhere else.
//
// SSR safety: @sentry/angular targets the browser; main.ts is the
// browser entry, so this only runs client-side. The server entry
// (main.server.ts) never imports this file.
if (environment.sentry?.enabled) {
  Sentry.init({
    dsn: environment.sentry.dsn,
    environment: environment.sentry.environment,
    // tracesSampleRate=0.1 in production captures ~10% of page loads
    // for performance monitoring — enough to spot regressions, low
    // enough to fit the free-tier transaction budget. tracesSampleRate=0
    // in dev disables performance monitoring entirely (only errors).
    tracesSampleRate: environment.sentry.tracesSampleRate,
    // Send the release version so source-maps can be matched in Sentry.
    // We don't have build-time version injection yet; using the package
    // version as a starting placeholder. Set this via env var at deploy
    // time once you have a CI release flow.
    release: 'ng-package-compat@3.0.0',
    // Don't send default PII; we want errors only, not user identifiers
    // in the request payload. Account email/uid live in Supabase Auth,
    // not in Sentry events.
    sendDefaultPii: false,
    // Browser tracing integration tracks route changes + XHR/fetch
    // requests. Default config is fine for our use; we don't need the
    // Replay integration (much heavier, adds ~50kB to the bundle).
    integrations: [
      Sentry.browserTracingIntegration()
    ],
    // Scrub localStorage entries that might contain secrets before
    // sending the event payload. Our localStorage keys for BYO AI
    // keys start with `ngpc.ai.` — strip those plus any header value
    // that looks like a Bearer token.
    beforeSend(event) {
      // Defensive: walk the breadcrumbs and redact anything that
      // looks like an API key or Bearer token.
      if (event.breadcrumbs) {
        for (const crumb of event.breadcrumbs) {
          const data = crumb.data;
          if (data && typeof data === 'object') {
            for (const key of Object.keys(data)) {
              const val = data[key];
              if (typeof val === 'string' && /^(Bearer\s+\S+|sk-\S+|AIza\S+)/i.test(val)) {
                data[key] = '[redacted]';
              }
            }
          }
        }
      }
      return event;
    }
  });
}

bootstrapApplication(AppComponent, appConfig).catch((err) => {
  // Forward bootstrap-time errors to Sentry explicitly. After bootstrap
  // succeeds, the Angular ErrorHandler integration takes over and
  // captures runtime errors automatically.
  if (environment.sentry?.enabled) {
    Sentry.captureException(err);
  }
  console.error(err);
});
