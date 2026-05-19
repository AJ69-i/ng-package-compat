import { BootstrapContext, bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';
import { serverConfig } from './app/app.config.server';

/**
 * Angular 21 SSR requires the framework-provided `BootstrapContext` to be
 * forwarded into `bootstrapApplication` so the platform is created on the
 * server. Without `context`, Angular throws `NG0401: Missing Platform`.
 */
const bootstrap = (context: BootstrapContext) =>
  bootstrapApplication(AppComponent, serverConfig, context);

export default bootstrap;
