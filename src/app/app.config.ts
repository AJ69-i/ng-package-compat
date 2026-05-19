import {
  ApplicationConfig,
  ErrorHandler,
  inject,
  isDevMode,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection
} from '@angular/core';
import { provideClientHydration, withEventReplay } from '@angular/platform-browser';
import { provideHttpClient, withFetch, withInterceptorsFromDi } from '@angular/common/http';
import { provideRouter, Router, TitleStrategy, withComponentInputBinding, withInMemoryScrolling, withViewTransitions } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import * as Sentry from '@sentry/angular';

import { routes } from './app.routes';
import { provideAppTransloco } from './i18n/transloco.providers';
import { AppTitleStrategy } from './services/title.strategy';
import { environment } from '../environments/environment';

/**
 * Sentry providers — only injected when sentry.enabled is true so that
 * dev sessions don't ship a fake ErrorHandler that swallows the
 * normal-console-error path. In production these wire up:
 *
 *   - `createErrorHandler`: captures every uncaught exception that
 *     Angular surfaces through ErrorHandler, attaches the route + zone
 *     context, and forwards to Sentry. Calls through to the default
 *     console.error after so DevTools still shows the trace.
 *   - `TraceService` + `APP_INITIALIZER`: hooks router navigation so
 *     Sentry performance traces are scoped per route. Necessary for
 *     tracesSampleRate to actually capture transactions.
 */
const sentryProviders = environment.sentry?.enabled
  ? [
      {
        provide: ErrorHandler,
        useValue: Sentry.createErrorHandler()
      },
      {
        provide: Sentry.TraceService,
        deps: [Router]
      },
      // App initializer that touches TraceService so its constructor
      // runs and subscribes to router events. Sentry 10.x dropped the
      // helper `Sentry.provideAppInitializer()` that earlier versions
      // exposed; the canonical replacement is an Angular
      // provideAppInitializer that inject()s TraceService directly.
      provideAppInitializer(() => {
        inject(Sentry.TraceService);
      })
    ]
  : [];

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideClientHydration(withEventReplay()),
    provideHttpClient(withFetch(), withInterceptorsFromDi()),
    provideRouter(
      routes,
      withComponentInputBinding(),
      withViewTransitions(),
      withInMemoryScrolling({ scrollPositionRestoration: 'enabled', anchorScrolling: 'enabled' })
    ),
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000'
    }),
    provideAnimationsAsync(),
    provideAppTransloco(),
    { provide: TitleStrategy, useClass: AppTitleStrategy },
    ...sentryProviders
  ]
};
