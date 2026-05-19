import { ApplicationConfig, mergeApplicationConfig } from '@angular/core';
import { RenderMode, ServerRoute, provideServerRendering, withRoutes } from '@angular/ssr';
import { appConfig } from './app.config';

/**
 * Server-side route declarations. Angular 21 requires an explicit `renderMode`
 * per route. Everything prerenders except the drill-down routes that depend
 * on URL params we can't enumerate.
 */
const serverRoutes: ServerRoute[] = [
  { path: '', renderMode: RenderMode.Prerender },
  { path: 'compare', renderMode: RenderMode.Prerender },
  { path: 'history', renderMode: RenderMode.Prerender },
  { path: 'upgrade', renderMode: RenderMode.Prerender },
  { path: 'about', renderMode: RenderMode.Prerender },
  { path: 'dependencies/:pkg/:version', renderMode: RenderMode.Server },
  { path: 'diff/:pkg', renderMode: RenderMode.Server },
  { path: '**', renderMode: RenderMode.Server }
];

const serverOnly: ApplicationConfig = {
  providers: [provideServerRendering(withRoutes(serverRoutes))]
};

export const serverConfig = mergeApplicationConfig(appConfig, serverOnly);
