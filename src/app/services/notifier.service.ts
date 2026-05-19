import { Injectable, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { ProjectDigest } from './monitor.service';

/**
 * Notifier hub (features #90, #91, #92, #93).
 *
 * Holds outbound integration configuration and dispatches monitor digests
 * to each enabled channel. All channels are *opt-in* — the user must enable
 * a channel and provide its endpoint (Slack/Teams webhook URL, recipient
 * email, push subscription) before anything is sent.
 *
 * Storage:
 *   - Webhook URLs and email recipients live in localStorage (`ngpc.notifiers.v1`).
 *   - Push subscriptions live with the service worker (PushManager API);
 *     we keep only a "registered" flag locally.
 *
 * Server-side dependencies:
 *   - `/api/notify/email` — must be implemented on the SSR server when the
 *     email channel is used. Sending HTTPS POST to Slack/Teams webhooks works
 *     directly from the browser thanks to their CORS-permissive endpoints.
 */

export type ChannelKind = 'slack' | 'teams' | 'email' | 'push';

export interface NotifierConfig {
  slackWebhookUrl: string | null;
  teamsWebhookUrl: string | null;
  emailTo: string | null;
  pushEnabled: boolean;
}

const DEFAULT_CONFIG: NotifierConfig = {
  slackWebhookUrl: null,
  teamsWebhookUrl: null,
  emailTo: null,
  pushEnabled: false
};

const STORAGE_KEY = 'ngpc.notifiers.v1';

@Injectable({ providedIn: 'root' })
export class NotifierService {
  private readonly platformId = inject(PLATFORM_ID);

  readonly config = signal<NotifierConfig>(this.load());

  readonly enabledChannels = computed<ChannelKind[]>(() => {
    const c = this.config();
    const out: ChannelKind[] = [];
    if (c.slackWebhookUrl) out.push('slack');
    if (c.teamsWebhookUrl) out.push('teams');
    if (c.emailTo) out.push('email');
    if (c.pushEnabled) out.push('push');
    return out;
  });

  setSlackUrl(url: string | null): void {
    this.config.update((c) => ({ ...c, slackWebhookUrl: url || null }));
    this.persist();
  }

  setTeamsUrl(url: string | null): void {
    this.config.update((c) => ({ ...c, teamsWebhookUrl: url || null }));
    this.persist();
  }

  setEmailTo(to: string | null): void {
    this.config.update((c) => ({ ...c, emailTo: to || null }));
    this.persist();
  }

  setPushEnabled(enabled: boolean): void {
    this.config.update((c) => ({ ...c, pushEnabled: enabled }));
    this.persist();
  }

  /**
   * Send a digest to every enabled channel. Returns a per-channel result
   * map so the UI can show "✅ Slack, ⚠ Email rate-limited" feedback.
   */
  async dispatch(digest: ProjectDigest): Promise<Record<ChannelKind, boolean>> {
    const c = this.config();
    const results: Record<ChannelKind, boolean> = {
      slack: false,
      teams: false,
      email: false,
      push: false
    };
    const tasks: Promise<unknown>[] = [];
    if (c.slackWebhookUrl) {
      tasks.push(
        this.postSlack(c.slackWebhookUrl, digest)
          .then(() => (results.slack = true))
          .catch(() => (results.slack = false))
      );
    }
    if (c.teamsWebhookUrl) {
      tasks.push(
        this.postTeams(c.teamsWebhookUrl, digest)
          .then(() => (results.teams = true))
          .catch(() => (results.teams = false))
      );
    }
    if (c.emailTo) {
      tasks.push(
        this.postEmail(c.emailTo, digest)
          .then(() => (results.email = true))
          .catch(() => (results.email = false))
      );
    }
    if (c.pushEnabled) {
      tasks.push(
        this.postPush(digest)
          .then(() => (results.push = true))
          .catch(() => (results.push = false))
      );
    }
    await Promise.all(tasks);
    return results;
  }

  // ---------- channel implementations ----------

  private async postSlack(url: string, digest: ProjectDigest): Promise<void> {
    const summary =
      digest.changes.length === 0
        ? `:white_check_mark: *${digest.label}* — no changes since last check.`
        : `:bell: *${digest.label}* — ${digest.changes.length} change(s) since last check (health ${digest.prevHealthScore} → ${digest.currentHealthScore}).`;
    const lines = digest.changes
      .slice(0, 8)
      .map((c) => `• \`${c.package}\` — ${c.kind}`);
    const payload = {
      text: summary,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: summary } },
        ...(lines.length
          ? [
              {
                type: 'section',
                text: { type: 'mrkdwn', text: lines.join('\n') }
              }
            ]
          : [])
      ]
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`Slack webhook returned ${res.status}`);
  }

  private async postTeams(url: string, digest: ProjectDigest): Promise<void> {
    // Teams supports adaptive cards via incoming webhooks. We send a slimmed
    // MessageCard for compatibility with classic webhooks.
    const themeColor =
      digest.healthDelta < 0 ? 'b91c1c' : digest.healthDelta > 0 ? '15803d' : '64748b';
    const facts = digest.changes
      .slice(0, 8)
      .map((c) => ({ name: c.package, value: c.kind }));
    const payload = {
      '@type': 'MessageCard',
      '@context': 'https://schema.org/extensions',
      summary: `${digest.label} — ${digest.changes.length} changes`,
      themeColor,
      title: `${digest.label} — Angular dependency digest`,
      text: `Health ${digest.prevHealthScore} → **${digest.currentHealthScore}**`,
      sections: [{ facts }]
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`Teams webhook returned ${res.status}`);
  }

  private async postEmail(to: string, digest: ProjectDigest): Promise<void> {
    // Server-side endpoint required (feature #92) — see /api/notify/email.
    const res = await fetch('/api/notify/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to, digest })
    });
    if (!res.ok) throw new Error(`Email send failed: ${res.status}`);
  }

  private async postPush(digest: ProjectDigest): Promise<void> {
    // Push notifications are ultimately delivered by the service worker —
    // here we just trigger a self-notification via the SW for local digests.
    if (!isPlatformBrowser(this.platformId)) return;
    if (!('serviceWorker' in navigator) || !('Notification' in window)) {
      throw new Error('Push notifications not supported in this browser.');
    }
    if (Notification.permission !== 'granted') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('Notification permission denied.');
    }
    const reg = await navigator.serviceWorker.ready;
    // `renotify` is a real Notification option (Web Notifications spec) but
    // the bundled TS lib's NotificationOptions doesn't include it on every
    // target. Cast through `Record<string, unknown>` to keep the wire shape
    // intact without losing type safety on the rest of the call.
    const opts: NotificationOptions & Record<string, unknown> = {
      body:
        digest.changes
          .slice(0, 3)
          .map((c) => `${c.package} (${c.kind})`)
          .join(' · ') || 'No changes since last check.',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-72.png',
      tag: `digest-${digest.projectKey}`,
      renotify: true
    };
    await reg.showNotification(`${digest.label} — ${digest.changes.length} changes`, opts);
  }

  // ---------- persistence ----------

  private load(): NotifierConfig {
    if (!isPlatformBrowser(this.platformId)) return { ...DEFAULT_CONFIG };
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_CONFIG };
      return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<NotifierConfig>) };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  private persist(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.config()));
    } catch {
      /* quota / private mode — ignore */
    }
  }
}
