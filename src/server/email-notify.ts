/**
 * Email notification endpoint (feature #92).
 *
 * Provider-agnostic: the server reads `EMAIL_PROVIDER` and dispatches to
 * the right backend. Initial supported providers:
 *
 *   - `sendgrid`  — POST https://api.sendgrid.com/v3/mail/send
 *   - `resend`    — POST https://api.resend.com/emails
 *   - `console`   — log only (default; useful for dev / no-config)
 *
 * Required env vars (per provider):
 *   EMAIL_PROVIDER       sendgrid | resend | console (default)
 *   EMAIL_FROM           required for sendgrid/resend
 *   EMAIL_API_KEY        required for sendgrid/resend
 *   EMAIL_RECIPIENTS_ALLOW   optional comma-separated allow-list
 */

import type { Express, Request, Response } from 'express';

interface DigestPayload {
  projectKey: string;
  label: string;
  capturedAt: string;
  prevHealthScore: number;
  currentHealthScore: number;
  healthDelta: number;
  changes: Array<{ name: string; kind: string }>;
}

interface EmailRequest {
  to: string;
  digest: DigestPayload;
}

function isEmail(s: unknown): s is string {
  return typeof s === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) && s.length < 256;
}

function validate(body: unknown): EmailRequest | string {
  if (!body || typeof body !== 'object') return 'json body required';
  const b = body as Record<string, unknown>;
  if (!isEmail(b['to'])) return 'invalid recipient';
  const digest = b['digest'] as Record<string, unknown> | undefined;
  if (!digest || typeof digest['label'] !== 'string') return 'invalid digest';
  return { to: b['to'] as string, digest: digest as unknown as DigestPayload };
}

function renderHtml(d: DigestPayload): string {
  const rows = d.changes
    .slice(0, 30)
    .map((c) => `<tr><td><code>${escapeHtml(c.name)}</code></td><td>${escapeHtml(c.kind)}</td></tr>`)
    .join('');
  const arrow = d.healthDelta > 0 ? '↑' : d.healthDelta < 0 ? '↓' : '·';
  return `<!doctype html>
<html><body style="font-family:Arial,sans-serif;color:#111827;">
  <h2>${escapeHtml(d.label)} — Angular dependency digest</h2>
  <p>Health: ${d.prevHealthScore} → <strong>${d.currentHealthScore}</strong> ${arrow}</p>
  <p>${d.changes.length} change(s) since last check.</p>
  <table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;">
    <thead><tr><th>Package</th><th>Change</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="2"><em>No changes</em></td></tr>'}</tbody>
  </table>
  <p style="color:#64748b;font-size:12px;margin-top:24px;">Sent by ng-package-compat.</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]!);
}

async function sendViaSendgrid(req: EmailRequest): Promise<void> {
  const apiKey = process.env['EMAIL_API_KEY'];
  const from = process.env['EMAIL_FROM'];
  if (!apiKey || !from) throw new Error('EMAIL_API_KEY/EMAIL_FROM not configured');
  const subject = `${req.digest.label} — ${req.digest.changes.length} changes`;
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: req.to }], subject }],
      from: { email: from, name: 'ng-package-compat' },
      content: [{ type: 'text/html', value: renderHtml(req.digest) }]
    })
  });
  if (!res.ok) throw new Error(`sendgrid ${res.status}: ${await res.text()}`);
}

async function sendViaResend(req: EmailRequest): Promise<void> {
  const apiKey = process.env['EMAIL_API_KEY'];
  const from = process.env['EMAIL_FROM'];
  if (!apiKey || !from) throw new Error('EMAIL_API_KEY/EMAIL_FROM not configured');
  const subject = `${req.digest.label} — ${req.digest.changes.length} changes`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to: [req.to],
      subject,
      html: renderHtml(req.digest)
    })
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${await res.text()}`);
}

export function registerEmailNotify(app: Express): void {
  app.post('/api/notify/email', async (req: Request, res: Response) => {
    const validated = validate(req.body);
    if (typeof validated === 'string') {
      res.status(400).json({ error: validated });
      return;
    }
    const allowRaw = process.env['EMAIL_RECIPIENTS_ALLOW'] ?? '';
    if (allowRaw.length > 0) {
      const allow = new Set(
        allowRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
      );
      if (!allow.has(validated.to.toLowerCase())) {
        res.status(403).json({ error: 'recipient not in allow-list' });
        return;
      }
    }

    const provider = (process.env['EMAIL_PROVIDER'] ?? 'console').toLowerCase();
    try {
      if (provider === 'sendgrid') await sendViaSendgrid(validated);
      else if (provider === 'resend') await sendViaResend(validated);
      else {
        // Default: log so dev mode produces visible output without keys.
        // eslint-disable-next-line no-console
        console.log(
          `[email/console] would send to ${validated.to}: ${validated.digest.label} (${validated.digest.changes.length} changes)`
        );
      }
      res.status(202).json({ provider, accepted: true });
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });
}
