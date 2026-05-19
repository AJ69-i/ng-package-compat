/**
 * Production environment config — same backend project ids, with the
 * `production: true` flag so logging / dev features can opt out.
 */
export const environment = {
  production: true,

  // ----- Sentry: error tracking -----
  // 0.1 (10%) trace sample rate is the standard recommendation for
  // free-tier Sentry — captures enough to see latency outliers without
  // exhausting the monthly transaction quota. Bump if you have a paid
  // plan and want richer perf data.
  sentry: {
    dsn: 'https://2920373e4b85c37ed9bde1a041e5efd0@o4511385078398976.ingest.us.sentry.io/4511385093341184',
    environment: 'production',
    tracesSampleRate: 0.1,
    enabled: true
  },

  supabase: {
    url: 'https://avelpygzbqljglehurjo.supabase.co',
    anonKey: 'sb_publishable_gU041JcZQYiYGzAm4rveRg_eqy2FmAa'
  },

  firebase: {
    apiKey: 'AIzaSyBBnKGdbXuBz-vB4D8xpjfd728HtiHmqo8',
    authDomain: 'ng-package-compat.firebaseapp.com',
    projectId: 'ng-package-compat',
    storageBucket: 'ng-package-compat.firebasestorage.app',
    messagingSenderId: '1075779391735',
    appId: '1:1075779391735:web:2cd65aff582fa82ed483f2',
    measurementId: 'G-NM2P5B4CL2'
  },

  appwrite: {
    endpoint: 'https://fra.cloud.appwrite.io/v1',
    projectId: '69ecdd090037c20e762b',
    projectName: 'ng-package-compat',
    databaseId: 'ngpc',
    collections: {
      preferences: 'preferences',
      logs: 'logs',
      backups: 'backups'
    }
  }
};
