import {
  Injectable,
  PLATFORM_ID,
  inject,
  signal
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { environment } from '../../environments/environment';
import { SupabaseService } from './supabase.service';

// Type-only imports get stripped at build time, so we keep strong typing
// without paying the bundle cost. The runtime SDK is loaded lazily on
// first use of any Firestore method (see `ensureInitialized`).
import type { FirebaseApp } from 'firebase/app';
import type { Firestore } from 'firebase/firestore';

type Unsubscribe = () => void;
type FirestoreApi = typeof import('firebase/firestore');

/**
 * Firebase as a *storage backend only* — used for Firestore real-time
 * notifications. Auth is handled entirely by Supabase.
 *
 * Lazy-loading: the Firebase SDKs (~150 KB of JS) are *not* shipped in
 * the main app bundle. They're loaded on first use via dynamic import,
 * which means the sign-in page never pays for them. Most users will
 * never trigger this code path; only signed-in users on pages that
 * subscribe to live notifications will incur the cost — once, cached
 * by the service worker thereafter.
 *
 * Authentication note: the browser does not authenticate to Firebase
 * Auth. Firestore security rules either allow public reads (server-only
 * writes) or accept a custom Firebase token minted server-side from the
 * Supabase JWT. We pass the Supabase user.id explicitly when subscribing.
 */
@Injectable({ providedIn: 'root' })
export class FirebaseService {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly supabase = inject(SupabaseService);

  private _app: FirebaseApp | null = null;
  private _db: Firestore | null = null;
  private _firestoreApi: FirestoreApi | null = null;
  private _initPromise: Promise<void> | null = null;

  readonly ready = signal(false);

  /**
   * Lazily load the Firebase SDK and initialize the app. Idempotent —
   * concurrent calls share a single promise. SSR is a no-op.
   */
  private async ensureInitialized(): Promise<void> {
    if (!isPlatformBrowser(this.platformId)) {
      this.ready.set(true);
      return;
    }
    if (this._app) return;
    if (!this._initPromise) {
      this._initPromise = (async () => {
        try {
          const [{ initializeApp }, firestore] = await Promise.all([
            import('firebase/app'),
            import('firebase/firestore')
          ]);
          this._app = initializeApp(environment.firebase);
          this._db = firestore.getFirestore(this._app);
          this._firestoreApi = firestore;
          this.ready.set(true);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[firebase] lazy init failed:', e);
          this.ready.set(true);
        }
      })();
    }
    await this._initPromise;
  }

  /**
   * Subscribe to live notifications for a Supabase user. Pass the
   * `supabase.user()?.id` as the `uid`. Returns a Promise that resolves
   * to an unsubscribe function — the Promise reflects the lazy SDK load.
   */
  async subscribeToNotifications(
    uid: string,
    onNotification: (n: { id: string; payload: unknown; createdAt: string }) => void
  ): Promise<Unsubscribe> {
    await this.ensureInitialized();
    if (!this._db || !uid || !this._firestoreApi) return () => undefined;
    const { collection, query, where, onSnapshot } = this._firestoreApi;
    const q = query(
      collection(this._db, 'notifications'),
      where('uid', '==', uid)
    );
    return onSnapshot(q, (snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const data = change.doc.data() as Record<string, unknown>;
          onNotification({
            id: change.doc.id,
            payload: data,
            createdAt: (data['createdAt'] as string) ?? ''
          });
        }
      });
    });
  }

  /** Convenience: subscribe using the *current* Supabase user. */
  async subscribeToMyNotifications(
    onNotification: (n: { id: string; payload: unknown; createdAt: string }) => void
  ): Promise<Unsubscribe> {
    const uid = this.supabase.user()?.id;
    if (!uid) return () => undefined;
    return this.subscribeToNotifications(uid, onNotification);
  }

  /**
   * Raw Firestore handle for advanced consumers. Triggers the lazy load
   * on first access. Returns null on SSR or before init.
   */
  async db(): Promise<Firestore> {
    await this.ensureInitialized();
    if (!this._db) throw new Error('Firestore not available.');
    return this._db;
  }
}
