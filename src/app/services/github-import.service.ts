import { Injectable } from '@angular/core';

/**
 * Parsed coordinates of a `github.com` URL — good enough to build the raw URL.
 *
 * We support every common shape users paste:
 *   - https://github.com/org/repo
 *   - https://github.com/org/repo.git
 *   - https://github.com/org/repo/tree/main
 *   - https://github.com/org/repo/blob/main/package.json
 *   - https://github.com/org/repo/blob/main/apps/admin/package.json
 *   - git@github.com:org/repo.git
 *   - org/repo                (shorthand)
 */
export interface GitHubCoords {
  owner: string;
  repo: string;
  /** Branch/tag/sha — defaults to `main`, then falls back to `master`. */
  ref: string;
  /** Path inside the repo; defaults to `package.json` at the root. */
  path: string;
}

export interface GitHubImportResult {
  /** The package.json raw text (ready for the existing PackageJsonParserService). */
  raw: string;
  /** The coordinates we actually fetched from (branch may have been auto-resolved). */
  resolved: GitHubCoords;
  /** Full `raw.githubusercontent.com` URL that served the file. */
  rawUrl: string;
}

/**
 * Pull a `package.json` directly from GitHub — no git clone, no CORS proxy.
 *
 * Why this is a killer feature for enterprise Angular migrations:
 *   - Architects don't always have a repo on disk; they do have a URL.
 *   - Hiring managers vet 10 open-source libs a day — they need a URL paste box.
 *   - Most repos live in github.com, so a first-class GitHub importer gets
 *     the user from "link to repo" to "full compatibility report" in 2 clicks.
 *
 * Implementation notes:
 *   - Uses `raw.githubusercontent.com` which is CORS-friendly and needs no auth
 *     for public repos.
 *   - If `main` 404s we try `master`; after that we surface a clear error so
 *     the user can paste `/tree/<branch>/...` explicitly.
 *   - Private repos would need a PAT — out of scope for the free tier, but the
 *     service is shaped so an optional `token` can be added later.
 */
@Injectable({ providedIn: 'root' })
export class GitHubImportService {
  private readonly rawBase = 'https://raw.githubusercontent.com';

  /**
   * Parse any github.com URL (or `org/repo` shorthand) into coordinates.
   * Throws a human-readable error if the input is not recognizable.
   */
  parseUrl(input: string): GitHubCoords {
    const trimmed = (input ?? '').trim();
    if (!trimmed) throw new Error('Empty URL.');

    // Shorthand: `org/repo` or `org/repo/path/to/package.json`
    if (/^[\w.-]+\/[\w.-]+(\/.+)?$/.test(trimmed) && !trimmed.includes('://') && !trimmed.startsWith('git@')) {
      const parts = trimmed.split('/').filter(Boolean);
      const [owner, repo, ...rest] = parts;
      return {
        owner,
        repo: this.stripGit(repo),
        ref: 'main',
        path: rest.length ? this.joinPath(rest) : 'package.json'
      };
    }

    // SSH: git@github.com:org/repo.git
    const sshMatch = trimmed.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (sshMatch) {
      return { owner: sshMatch[1], repo: sshMatch[2], ref: 'main', path: 'package.json' };
    }

    // HTTPS URL
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error('That does not look like a valid URL.');
    }

    if (!/github\.com$/i.test(url.hostname)) {
      throw new Error('Only github.com URLs are supported right now.');
    }

    const segs = url.pathname.split('/').filter(Boolean);
    if (segs.length < 2) throw new Error('URL must include an owner and repository.');

    const owner = segs[0];
    const repo = this.stripGit(segs[1]);

    // Variants: /org/repo, /org/repo/tree/<ref>/<path...>, /org/repo/blob/<ref>/<path...>
    let ref = 'main';
    let path = 'package.json';

    const marker = segs[2];
    if (marker === 'tree' || marker === 'blob') {
      ref = segs[3] ?? 'main';
      const rest = segs.slice(4);
      if (rest.length) path = this.joinPath(rest);
      // If user pointed at a folder, append package.json
      if (!path.endsWith('package.json')) {
        if (!path.endsWith('/')) path += '/';
        path += 'package.json';
      }
    }

    return { owner, repo, ref, path };
  }

  /** Fetch the raw package.json; falls back from `main` to `master`. */
  async fetchFromUrl(input: string): Promise<GitHubImportResult> {
    const coords = this.parseUrl(input);
    const firstTry = await this.tryFetch(coords);
    if (firstTry.ok) {
      return { raw: firstTry.raw!, resolved: coords, rawUrl: firstTry.rawUrl };
    }

    // Auto-fallback: if user didn't specify a ref, try master before giving up.
    if (coords.ref === 'main') {
      const fallback = { ...coords, ref: 'master' };
      const secondTry = await this.tryFetch(fallback);
      if (secondTry.ok) {
        return { raw: secondTry.raw!, resolved: fallback, rawUrl: secondTry.rawUrl };
      }
    }

    throw new Error(
      `Could not fetch ${coords.path} from ${coords.owner}/${coords.repo}@${coords.ref}. ` +
      `Double-check the URL, the branch name, and that the repo is public.`
    );
  }

  private async tryFetch(c: GitHubCoords): Promise<{ ok: boolean; raw?: string; rawUrl: string }> {
    const rawUrl = `${this.rawBase}/${c.owner}/${c.repo}/${c.ref}/${c.path}`;
    try {
      const res = await fetch(rawUrl, { headers: { accept: 'application/json, text/plain, */*' } });
      if (!res.ok) return { ok: false, rawUrl };
      const text = await res.text();
      // Guard against HTML redirect pages or login walls
      const trimmed = text.trimStart();
      if (trimmed.startsWith('<')) return { ok: false, rawUrl };
      return { ok: true, raw: text, rawUrl };
    } catch {
      return { ok: false, rawUrl };
    }
  }

  private stripGit(s: string): string {
    return s.replace(/\.git$/i, '');
  }

  private joinPath(parts: string[]): string {
    return parts.map((p) => decodeURIComponent(p)).join('/');
  }
}
