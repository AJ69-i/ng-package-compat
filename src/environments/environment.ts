/**
 * Runtime environment config.
 *
 * Three storage backends are wired in. Roles per the project's split:
 *
 *   - Supabase (PostgreSQL) — relational core: policies, snapshots,
 *     favorites, teams, org policy templates. RLS-protected.
 *   - Firebase (Firestore) — identity hub: Gmail auth + linked OAuth
 *     identities (GitHub/GitLab/BitBucket/Azure), real-time presence,
 *     live notification queue. Mirrors the LinkedIn workspace flow.
 *   - Appwrite — secure vault: user preferences, custom configs, log
 *     archives, profile assets, backup metadata.
 *
 * All three keys here are publishable / anon — safe to ship to the browser.
 * Server-only secrets (service-role keys, server-held GitHub PATs, email
 * provider keys) are read from process.env on the SSR server only.
 */
export const environment = {
  production: false,

  // ----- Sentry: error tracking -----
  // DSN is publishable — designed for client-side use and rate-limited
  // server-side. Sample rates kept low in dev to avoid noise; the
  // production environment file overrides with realistic values.
  sentry: {
    dsn: 'https://2920373e4b85c37ed9bde1a041e5efd0@o4511385078398976.ingest.us.sentry.io/4511385093341184',
    environment: 'development',
    tracesSampleRate: 0,
    // Disabled in dev to keep the console clean; the production
    // environment file flips this to true.
    enabled: false
  },

  // ----- Supabase: relational core -----
  supabase: {
    url: 'https://avelpygzbqljglehurjo.supabase.co',
    /** Publishable / anon key — safe in the browser. */
    anonKey: 'sb_publishable_gU041JcZQYiYGzAm4rveRg_eqy2FmAa'
  },

  // ----- Firebase: identity hub + real-time -----
  firebase: {
    apiKey: 'AIzaSyBBnKGdbXuBz-vB4D8xpjfd728HtiHmqo8',
    authDomain: 'ng-package-compat.firebaseapp.com',
    projectId: 'ng-package-compat',
    storageBucket: 'ng-package-compat.firebasestorage.app',
    messagingSenderId: '1075779391735',
    appId: '1:1075779391735:web:2cd65aff582fa82ed483f2',
    measurementId: 'G-NM2P5B4CL2'
  },

  // ----- Appwrite: secure vault for prefs/configs/logs -----
  appwrite: {
    endpoint: 'https://fra.cloud.appwrite.io/v1',
    projectId: '69ecdd090037c20e762b',
    projectName: 'ng-package-compat',
    /**
     * Database + collection ids. These are placeholders the user creates
     * once in the Appwrite console; if any are missing the AppwriteService
     * degrades gracefully (read/write becomes a no-op).
     */
    databaseId: 'ngpc',
    collections: {
      preferences: 'preferences',
      logs: 'logs',
      backups: 'backups'
    }
  }
};
