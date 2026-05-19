import { EnvironmentProviders, isDevMode, makeEnvironmentProviders } from '@angular/core';
import { provideTransloco, TranslocoConfig } from '@jsverse/transloco';
import { AppTranslocoLoader } from './transloco-loader';

export const SUPPORTED_LANGS = [
  { code: 'en', label: 'English', dir: 'ltr' as const },
  { code: 'ar', label: 'العربية', dir: 'rtl' as const },
  { code: 'fr', label: 'Français', dir: 'ltr' as const },
  { code: 'es', label: 'Español', dir: 'ltr' as const }
];

export const TRANSLOCO_CONFIG: Partial<TranslocoConfig> = {
  availableLangs: SUPPORTED_LANGS.map((l) => l.code),
  defaultLang: 'en',
  fallbackLang: 'en',
  reRenderOnLangChange: true,
  prodMode: !isDevMode()
};

/**
 * Central provider factory — gives the app Transloco with our JSON loader.
 *
 * `provideTransloco()` returns an array of `EnvironmentProviders`, so we
 * wrap it in `makeEnvironmentProviders` to fit Angular's provider array type.
 */
export function provideAppTransloco(): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideTransloco({
      config: TRANSLOCO_CONFIG,
      loader: AppTranslocoLoader
    })
  ]);
}
