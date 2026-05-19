import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

export type AiProviderId = 'openai' | 'anthropic' | 'gemini';

export interface AiProviderInfo {
  id: AiProviderId;
  label: string;
  defaultModel: string;
  endpoint: string;
  /** How to send the key — provider-specific header conventions. */
  authStyle: 'bearer' | 'x-api-key' | 'query';
  /** Where to link users so they can generate / revoke a key. */
  dashboardUrl: string;
}

export interface AiCredential {
  provider: AiProviderId;
  apiKey: string;
  model?: string;
  /** Last time the user validated the key — for "stale key" nudges. */
  verifiedAt?: number;
}

export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiAskParams {
  messages: AiChatMessage[];
  /** Optional context blob we inject into the system prompt (e.g. report.json). */
  context?: string;
  /** Override model (advanced users). */
  model?: string;
  /** Controlled randomness — default 0.2 so it stays on-task. */
  temperature?: number;
}

export const AI_PROVIDERS: Record<AiProviderId, AiProviderInfo> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    authStyle: 'bearer',
    dashboardUrl: 'https://platform.openai.com/api-keys'
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    defaultModel: 'claude-haiku-4-5-20251001',
    endpoint: 'https://api.anthropic.com/v1/messages',
    authStyle: 'x-api-key',
    dashboardUrl: 'https://console.anthropic.com/settings/keys'
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    defaultModel: 'gemini-1.5-flash',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
    authStyle: 'query',
    dashboardUrl: 'https://aistudio.google.com/app/apikey'
  }
};

const STORAGE_KEY = 'ngpc.ai.credential.v1';

/**
 * Bring-Your-Own-Key AI migration assistant.
 *
 * The whole project ships as a static Angular app — there is no backend to
 * proxy LLM calls through. Instead, users paste their own OpenAI / Anthropic /
 * Gemini key. The key is stored in `localStorage`, never leaves the browser,
 * and is sent **directly** to the provider's API from the browser.
 *
 * Trade-offs (documented for the sales doc):
 *   - Pro: zero server cost, zero legal exposure for Anthropic-scale auth
 *   - Pro: enterprises can use their procurement-blessed API key
 *   - Con: the vendor endpoints must support CORS. OpenAI does for chat
 *          completions; Anthropic requires the `anthropic-dangerous-direct-browser-access`
 *          header (opt-in); Gemini does via REST.
 *   - Con: users must trust the browser to hold their key — so we keep the
 *          UI clear about where the key is stored and how to delete it.
 *
 * The service is deliberately provider-agnostic at the public surface: the
 * UI calls `ask(params)` and gets back a plain string. Internally we shape
 * requests per provider.
 */
@Injectable({ providedIn: 'root' })
export class AiAssistantService {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  readonly credential = signal<AiCredential | null>(this.load());
  readonly lastError = signal<string | null>(null);
  readonly inFlight = signal<boolean>(false);

  providers(): AiProviderInfo[] {
    return Object.values(AI_PROVIDERS);
  }

  saveCredential(cred: AiCredential): void {
    const cleaned: AiCredential = {
      provider: cred.provider,
      apiKey: cred.apiKey.trim(),
      model: cred.model?.trim() || AI_PROVIDERS[cred.provider].defaultModel,
      verifiedAt: cred.verifiedAt ?? Date.now()
    };
    this.credential.set(cleaned);
    this.persist(cleaned);
  }

  clearCredential(): void {
    this.credential.set(null);
    if (!this.isBrowser) return;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  isConfigured(): boolean {
    const c = this.credential();
    return !!c && !!c.apiKey;
  }

  /**
   * Send a chat-style request to the user's chosen provider.
   *
   * Returns the model's final string reply (already concatenated).
   */
  async ask(params: AiAskParams): Promise<string> {
    const cred = this.credential();
    if (!cred) throw new Error('No AI provider configured. Paste your key in Settings.');

    const provider = AI_PROVIDERS[cred.provider];
    const model = params.model ?? cred.model ?? provider.defaultModel;
    const temperature = params.temperature ?? 0.2;

    const systemExtra = params.context
      ? `You are an expert Angular migration assistant. Use this analysis report as ground truth and prefer it over your training knowledge when they disagree:\n\n${params.context}`
      : 'You are an expert Angular migration assistant.';

    const messages: AiChatMessage[] = [
      { role: 'system', content: systemExtra },
      ...params.messages
    ];

    this.inFlight.set(true);
    this.lastError.set(null);

    try {
      switch (cred.provider) {
        case 'openai':
          return await this.askOpenAi(cred.apiKey, model, messages, temperature);
        case 'anthropic':
          return await this.askAnthropic(cred.apiKey, model, messages, temperature);
        case 'gemini':
          return await this.askGemini(cred.apiKey, model, messages, temperature);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.lastError.set(msg);
      throw e;
    } finally {
      this.inFlight.set(false);
    }
  }

  /** Quick "ping" with 1 tiny message — used by the Settings panel verify button. */
  async verify(): Promise<boolean> {
    try {
      const reply = await this.ask({
        messages: [{ role: 'user', content: 'Reply with the single word: OK.' }],
        temperature: 0
      });
      return /ok/i.test(reply);
    } catch {
      return false;
    }
  }

  private async askOpenAi(
    apiKey: string,
    model: string,
    messages: AiChatMessage[],
    temperature: number
  ): Promise<string> {
    const res = await fetch(AI_PROVIDERS.openai.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, messages, temperature })
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await safeText(res)}`);
    const data = await res.json();
    return data?.choices?.[0]?.message?.content ?? '';
  }

  private async askAnthropic(
    apiKey: string,
    model: string,
    messages: AiChatMessage[],
    temperature: number
  ): Promise<string> {
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const rest = messages.filter((m) => m.role !== 'system');
    const res = await fetch(AI_PROVIDERS.anthropic.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model,
        system,
        max_tokens: 1024,
        temperature,
        messages: rest.map((m) => ({ role: m.role, content: m.content }))
      })
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await safeText(res)}`);
    const data = await res.json();
    const blocks: Array<{ type: string; text?: string }> = data?.content ?? [];
    return blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  }

  private async askGemini(
    apiKey: string,
    model: string,
    messages: AiChatMessage[],
    temperature: number
  ): Promise<string> {
    const endpoint = AI_PROVIDERS.gemini.endpoint.replace('{model}', model) + `?key=${encodeURIComponent(apiKey)}`;
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const systemInstruction = messages.find((m) => m.role === 'system');
    const body = {
      systemInstruction: systemInstruction
        ? { role: 'user', parts: [{ text: systemInstruction.content }] }
        : undefined,
      generationConfig: { temperature },
      contents
    };
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${await safeText(res)}`);
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? '';
  }

  private load(): AiCredential | null {
    if (!this.isBrowser) return null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as AiCredential) : null;
    } catch {
      return null;
    }
  }

  private persist(cred: AiCredential): void {
    if (!this.isBrowser) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cred));
    } catch {
      /* quota / privacy mode — silently ignore */
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 400);
  } catch {
    return res.statusText;
  }
}
