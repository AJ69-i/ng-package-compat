import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Account, Client, Databases, ID, Query } from 'appwrite';
import { environment } from '../../environments/environment';

/**
 * Appwrite — the "secure vault" for user preferences, custom configurations,
 * profile assets, log archives, and backup metadata.
 *
 * Why it exists alongside Supabase + Firebase:
 *   - Supabase stores relational/auditable state (policies, snapshots).
 *   - Firebase Firestore is the identity hub + real-time channel.
 *   - Appwrite holds slow-changing per-user *settings* and append-only logs
 *     where Postgres rows would be overkill and Firestore reads/writes get
 *     pricey at high frequency.
 *
 * The service is intentionally permissive: missing collections degrade
 * gracefully to no-ops so the app continues working before the user has
 * provisioned the Appwrite database in their console.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface UserPreferences {
  $id?: string;
  uid: string;
  theme: 'light' | 'dark' | 'system';
  accentColor: string;
  fontScale: number;
  reducedMotion: boolean;
  highContrast: boolean;
  colorBlindPalette: boolean;
  language: string;
  packageManager: 'npm' | 'yarn' | 'pnpm' | 'bun';
  updatedAt: string;
}

export interface LogEntry {
  $id?: string;
  uid: string;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
  createdAt: string;
}

@Injectable({ providedIn: 'root' })
export class AppwriteService {
  private readonly platformId = inject(PLATFORM_ID);

  private _client: Client | null = null;
  private _account: Account | null = null;
  private _db: Databases | null = null;

  readonly ready = signal(false);
  readonly lastError = signal<string | null>(null);

  constructor() {
    if (!isPlatformBrowser(this.platformId)) {
      this.ready.set(true);
      return;
    }
    try {
      this._client = new Client()
        .setEndpoint(environment.appwrite.endpoint)
        .setProject(environment.appwrite.projectId);
      this._account = new Account(this._client);
      this._db = new Databases(this._client);
      this.ready.set(true);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[appwrite] init failed:', e);
      this.lastError.set((e as Error).message);
      this.ready.set(true);
    }
  }

  // ---------- Preferences ----------

  /**
   * Fetch the current user's preferences from Appwrite, or null if the
   * preferences collection doesn't exist / the user hasn't saved any yet.
   */
  async getPreferences(uid: string): Promise<UserPreferences | null> {
    if (!this._db) return null;
    try {
      const res = await this._db.listDocuments(
        environment.appwrite.databaseId,
        environment.appwrite.collections.preferences,
        [Query.equal('uid', uid), Query.limit(1)]
      );
      const row = res.documents[0] as Record<string, unknown> | undefined;
      return row ? (row as unknown as UserPreferences) : null;
    } catch (e) {
      this.lastError.set((e as Error).message);
      return null;
    }
  }

  /**
   * Upsert the user's preferences. If a row exists for this uid, we update
   * it; otherwise we insert. Failures are non-fatal.
   */
  async savePreferences(prefs: UserPreferences): Promise<void> {
    if (!this._db) return;
    const existing = await this.getPreferences(prefs.uid);
    const payload = { ...prefs, updatedAt: new Date().toISOString() };
    delete (payload as Record<string, unknown>)['$id'];
    try {
      if (existing?.$id) {
        await this._db.updateDocument(
          environment.appwrite.databaseId,
          environment.appwrite.collections.preferences,
          existing.$id,
          payload
        );
      } else {
        await this._db.createDocument(
          environment.appwrite.databaseId,
          environment.appwrite.collections.preferences,
          ID.unique(),
          payload
        );
      }
    } catch (e) {
      this.lastError.set((e as Error).message);
    }
  }

  // ---------- Logs ----------

  /**
   * Append a structured log entry. Used for diagnostics + audit trail.
   * Drops silently if Appwrite isn't reachable so logging never breaks
   * the calling code.
   */
  async log(entry: Omit<LogEntry, '$id' | 'createdAt'>): Promise<void> {
    if (!this._db) return;
    try {
      await this._db.createDocument(
        environment.appwrite.databaseId,
        environment.appwrite.collections.logs,
        ID.unique(),
        { ...entry, createdAt: new Date().toISOString() }
      );
    } catch {
      /* swallow — logging is best-effort */
    }
  }

  async recentLogs(uid: string, limit = 50): Promise<LogEntry[]> {
    if (!this._db) return [];
    try {
      const res = await this._db.listDocuments(
        environment.appwrite.databaseId,
        environment.appwrite.collections.logs,
        [Query.equal('uid', uid), Query.orderDesc('createdAt'), Query.limit(limit)]
      );
      return res.documents as unknown as LogEntry[];
    } catch {
      return [];
    }
  }

  // ---------- Backups ----------

  /**
   * Stash a JSON blob (e.g. a snapshot of the user's whole local state)
   * for disaster recovery. Backups are append-only.
   */
  async storeBackup(uid: string, label: string, blob: unknown): Promise<string | null> {
    if (!this._db) return null;
    try {
      const doc = await this._db.createDocument(
        environment.appwrite.databaseId,
        environment.appwrite.collections.backups,
        ID.unique(),
        {
          uid,
          label,
          payload: JSON.stringify(blob),
          createdAt: new Date().toISOString()
        }
      );
      return doc.$id;
    } catch (e) {
      this.lastError.set((e as Error).message);
      return null;
    }
  }

  async listBackups(uid: string): Promise<Array<{ id: string; label: string; createdAt: string }>> {
    if (!this._db) return [];
    try {
      const res = await this._db.listDocuments(
        environment.appwrite.databaseId,
        environment.appwrite.collections.backups,
        [Query.equal('uid', uid), Query.orderDesc('createdAt'), Query.limit(20)]
      );
      return res.documents.map((d) => ({
        id: d.$id,
        label: (d as Record<string, unknown>)['label'] as string,
        createdAt: (d as Record<string, unknown>)['createdAt'] as string
      }));
    } catch {
      return [];
    }
  }

  // Expose the underlying SDK for advanced use cases.
  get account(): Account {
    if (!this._account) throw new Error('Appwrite account not available.');
    return this._account;
  }
  get db(): Databases {
    if (!this._db) throw new Error('Appwrite databases not available.');
    return this._db;
  }
}
