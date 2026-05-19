import { AngularNodeAppEngine, createNodeRequestHandler, isMainModule, writeResponseToNodeResponse } from '@angular/ssr/node';
import express from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerPrProxy } from './server/pr-proxy.js';
import { registerRegistryCache } from './server/registry-cache.js';
import { registerReleaseWebhook } from './server/release-webhook.js';
import { registerEmailNotify } from './server/email-notify.js';
import { registerCodemodRunner } from './server/codemod-runner.js';
import { registerAiProxy } from './server/ai-proxy.js';

const serverDistFolder = dirname(fileURLToPath(import.meta.url));
const browserDistFolder = resolve(serverDistFolder, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine();

// JSON body parsing for any /api/* endpoints we mount below. The static
// asset and SSR handlers ignore the parsed body, so this is safe to install
// globally.
app.use(express.json({ limit: '256kb' }));

// Server-side PR proxy (feature #83). The browser hands us a description of
// the PR; we use a server-held GitHub App token to actually open it. This
// keeps user PATs out of the browser entirely.
registerPrProxy(app);

// Server-side packument cache (feature #85) and release webhook (feature #86).
registerRegistryCache(app);
registerReleaseWebhook(app);

// Email notification endpoint (feature #92) — for the digest notifier.
registerEmailNotify(app);

// Server-side codemod runner (feature #100) — applies registered codemods
// to source files and returns patched results plus a unified diff.
registerCodemodRunner(app);

// Server-side AI proxy — forwards Groq chat-completion requests with the
// server-held GROQ_API_KEY so the browser default "click Compare and it
// works" flow doesn't require any user-pasted credentials. Strict input
// validation + per-IP rate limiting prevent this from becoming a free
// LLM tunnel for the open internet.
registerAiProxy(app);

app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false
  })
);

app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) => (response ? writeResponseToNodeResponse(response, res) : next()))
    .catch(next);
});

if (isMainModule(import.meta.url)) {
  const port = process.env['PORT'] ?? 4000;
  app.listen(port, () => {
    console.log(`Node Express server listening on http://localhost:${port}`);
  });
}

export const reqHandler = createNodeRequestHandler(app);
