/**
 * Server-side PR proxy (feature #83).
 *
 * Why this exists:
 *   The browser-side PR generator works by handing the user's GitHub PAT
 *   into the browser and POSTing to the GitHub API. Security-conscious
 *   teams refuse to give a web app a PAT that can write to their repos.
 *
 *   This proxy moves the PAT to the server, behind a GitHub App or a
 *   long-lived shop token. The browser only sends the description of the
 *   change — branch name, commit message, package.json patch, PR body —
 *   and gets back the new PR URL.
 *
 *   The server enforces a strict allow-list on owners and a strict shape
 *   on the request body so this endpoint can't be turned into a generic
 *   GitHub-API tunnel.
 *
 * Configuration (env vars on the server):
 *   GITHUB_PR_TOKEN          — required, a GitHub PAT or installation token
 *                              with `repo` scope.
 *   GITHUB_PR_OWNERS_ALLOW   — comma-separated list of repo owners this
 *                              proxy is allowed to write to. If unset, the
 *                              proxy refuses every request.
 *   GITHUB_API_BASE          — optional, defaults to https://api.github.com
 *                              (set this for GitHub Enterprise).
 */

import type { Express, Request, Response } from 'express';

interface PrRequest {
  fullName: string; // "owner/repo"
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
  commitMessage: string;
  /** package.json contents, base64-encoded. */
  packageJsonBase64: string;
}

interface GitHubError extends Error {
  status?: number;
}

const GITHUB_API_BASE = (
  process.env['GITHUB_API_BASE'] ?? 'https://api.github.com'
).replace(/\/+$/, '');

function getToken(): string | null {
  const t = process.env['GITHUB_PR_TOKEN'];
  return t && t.length > 0 ? t : null;
}

function getOwnersAllowList(): Set<string> {
  const raw = process.env['GITHUB_PR_OWNERS_ALLOW'] ?? '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function validateBody(body: unknown): PrRequest | string {
  if (!body || typeof body !== 'object') return 'request body must be an object';
  const b = body as Record<string, unknown>;
  const required = [
    'fullName',
    'baseBranch',
    'headBranch',
    'title',
    'body',
    'commitMessage',
    'packageJsonBase64'
  ];
  for (const k of required) {
    if (typeof b[k] !== 'string' || (b[k] as string).length === 0) {
      return `field ${k} must be a non-empty string`;
    }
  }
  // Strict shape on full name.
  const fullName = b['fullName'] as string;
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(fullName)) {
    return 'fullName must look like "owner/repo"';
  }
  // Branch names: GitHub allows a lot, but we keep this conservative.
  const branchRe = /^[A-Za-z0-9._/-]+$/;
  if (!branchRe.test(b['baseBranch'] as string)) return 'baseBranch is invalid';
  if (!branchRe.test(b['headBranch'] as string)) return 'headBranch is invalid';
  if ((b['title'] as string).length > 255) return 'title is too long';
  if ((b['body'] as string).length > 65536) return 'body is too long';
  // Quick sanity on the patch payload — must be valid base64 of valid JSON.
  let decoded: string;
  try {
    decoded = Buffer.from(b['packageJsonBase64'] as string, 'base64').toString(
      'utf8'
    );
    JSON.parse(decoded);
  } catch {
    return 'packageJsonBase64 must be base64 of valid JSON';
  }
  if (decoded.length > 1024 * 1024) return 'package.json too large';
  return b as unknown as PrRequest;
}

async function gh(
  token: string,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${GITHUB_API_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'ng-package-compat/pr-proxy',
      ...(init.headers ?? {})
    }
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* some responses are empty */
  }
  return { status: res.status, json };
}

async function openPr(token: string, req: PrRequest): Promise<{ url: string; number: number }> {
  const [owner, repo] = req.fullName.split('/');

  // 1. Get the base ref's SHA.
  const baseRef = await gh(
    token,
    `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(req.baseBranch)}`
  );
  if (baseRef.status >= 400) {
    throw withStatus(`base branch lookup failed: ${baseRef.json?.message ?? baseRef.status}`, baseRef.status);
  }
  const baseSha = baseRef.json?.object?.sha as string;

  // 2. Create the head branch (idempotent: 422 means it already exists).
  const refRes = await gh(token, `/repos/${owner}/${repo}/git/refs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ref: `refs/heads/${req.headBranch}`,
      sha: baseSha
    })
  });
  if (refRes.status >= 400 && refRes.status !== 422) {
    throw withStatus(`branch create failed: ${refRes.json?.message ?? refRes.status}`, refRes.status);
  }

  // 3. Get current package.json sha on the head branch (so we can update).
  const fileRes = await gh(
    token,
    `/repos/${owner}/${repo}/contents/package.json?ref=${encodeURIComponent(req.headBranch)}`
  );
  if (fileRes.status >= 400) {
    throw withStatus(`package.json lookup failed: ${fileRes.json?.message ?? fileRes.status}`, fileRes.status);
  }
  const fileSha = fileRes.json?.sha as string;

  // 4. PUT updated package.json on the head branch.
  const putRes = await gh(token, `/repos/${owner}/${repo}/contents/package.json`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: req.commitMessage,
      content: req.packageJsonBase64,
      sha: fileSha,
      branch: req.headBranch
    })
  });
  if (putRes.status >= 400) {
    throw withStatus(`package.json update failed: ${putRes.json?.message ?? putRes.status}`, putRes.status);
  }

  // 5. Open the pull request.
  const prRes = await gh(token, `/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: req.title,
      body: req.body,
      head: req.headBranch,
      base: req.baseBranch,
      maintainer_can_modify: true
    })
  });
  if (prRes.status >= 400) {
    throw withStatus(`PR create failed: ${prRes.json?.message ?? prRes.status}`, prRes.status);
  }
  return { url: prRes.json.html_url as string, number: prRes.json.number as number };
}

function withStatus(message: string, status?: number): GitHubError {
  const err = new Error(message) as GitHubError;
  err.status = status;
  return err;
}

export function registerPrProxy(app: Express): void {
  app.post('/api/pr', async (req: Request, res: Response) => {
    const token = getToken();
    if (!token) {
      res.status(503).json({
        error:
          'PR proxy is not configured. Set GITHUB_PR_TOKEN on the server to enable it.'
      });
      return;
    }
    const allow = getOwnersAllowList();
    if (allow.size === 0) {
      res.status(503).json({
        error:
          'PR proxy has no allow-list. Set GITHUB_PR_OWNERS_ALLOW to a comma-separated list of repo owners.'
      });
      return;
    }

    const validated = validateBody(req.body);
    if (typeof validated === 'string') {
      res.status(400).json({ error: validated });
      return;
    }

    const owner = validated.fullName.split('/')[0].toLowerCase();
    if (!allow.has(owner)) {
      res
        .status(403)
        .json({ error: `owner ${owner} is not in the proxy's allow-list.` });
      return;
    }

    try {
      const { url, number } = await openPr(token, validated);
      res.status(200).json({ url, number });
    } catch (e) {
      const err = e as GitHubError;
      res.status(err.status && err.status < 600 ? err.status : 500).json({
        error: err.message ?? 'PR creation failed'
      });
    }
  });

  // Tiny health probe so deployments can verify the proxy is reachable.
  app.get('/api/pr/health', (_req: Request, res: Response) => {
    res.json({
      configured: !!getToken(),
      ownersAllowed: Array.from(getOwnersAllowList()),
      apiBase: GITHUB_API_BASE
    });
  });
}
