import { Injectable } from '@angular/core';
import { BreakingChange } from '../models/npm-package.model';

export type AiProvider = 'claude' | 'chatgpt' | 'gemini';

/**
 * Builds deep links that send the user to their preferred AI tool with a
 * fully composed migration prompt pre-loaded into the new chat.
 *
 * This keeps our bundle small (no SDK, no API key) while giving users
 * instant "Ask AI" hand-offs from any breaking-change row.
 */
@Injectable({ providedIn: 'root' })
export class AiCopilotService {
  prompt(packageName: string, change: BreakingChange, targetNg: number): string {
    return (
      `I'm upgrading an Angular ${targetNg} project. ` +
      `The package \`${packageName}\` introduces this breaking change: ` +
      `"${change.title}" (${change.detail}). ` +
      `${change.link ? `Docs: ${change.link}. ` : ''}` +
      `Please show me a before/after code example covering the migration, ` +
      `and point out any test or DI considerations.`
    );
  }

  url(provider: AiProvider, prompt: string): string {
    const q = encodeURIComponent(prompt);
    switch (provider) {
      case 'claude': return `https://claude.ai/new?q=${q}`;
      case 'gemini': return `https://gemini.google.com/app?q=${q}`;
      case 'chatgpt':
      default:       return `https://chat.openai.com/?model=gpt-4&q=${q}`;
    }
  }
}
