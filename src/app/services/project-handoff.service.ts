import { Injectable, signal } from '@angular/core';
import { ParsedPackageJson } from '../models/npm-package.model';
import { NormalizedRepo } from './provider-repo.service';

/**
 * One-shot handoff between the workspace / projects page and the upgrade page.
 *
 * Why not query params? `package.json` content is way too large for a URL.
 * We could base64+gzip it, but that's user-hostile to debug. A single in-memory
 * holder is simpler and safer (no leak through browser history / share links).
 *
 * In addition to the parsed package.json the upgrade page needs to render the
 * report, we carry the *full* `NormalizedRepo` descriptor so downstream
 * widgets (PR preview, monitor) can use it without re-asking the user for
 * info they already supplied during the scan.
 *
 * Lifecycle: the source page calls `set()` then navigates to /upgrade. The
 * upgrade page's constructor calls `consume()` once, which clears it.
 */
@Injectable({ providedIn: 'root' })
export class ProjectHandoffService {
  private readonly _payload = signal<{
    parsed: ParsedPackageJson;
    sourceLabel: string;
    /** Full repo descriptor when the handoff came from a code-host scan. */
    repo: NormalizedRepo | null;
  } | null>(null);

  readonly payload = this._payload.asReadonly();

  set(parsed: ParsedPackageJson, sourceLabel: string, repo?: NormalizedRepo | null): void {
    this._payload.set({ parsed, sourceLabel, repo: repo ?? null });
  }

  /** Return the payload and clear it. */
  consume(): { parsed: ParsedPackageJson; sourceLabel: string; repo: NormalizedRepo | null } | null {
    const v = this._payload();
    this._payload.set(null);
    return v;
  }
}
