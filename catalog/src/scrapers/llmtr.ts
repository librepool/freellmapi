/**
 * LLMTR scraper — official public `GET https://llmtr.com/v1/models`.
 *
 * The public roster mixes free, paid, promo, and BYOK-only rows, so there
 * is NO suffix rule here (the adapter comment is explicit: only the signed
 * catalog supplies model rows). The free signal is in the entry itself:
 * a chat route is free when its `pricing` is zero for both prompt and
 * completion AND it supports `CHAT_COMPLETIONS`. Live probe 2026-11-08:
 * 399 listed ids, 16 zero-priced chat routes (the 5 seeded ids among
 * them), plus 1 zero-priced embeddings route
 * (`liquid/lfm-2.5-embedding-350m-free`) which the CHAT_COMPLETIONS
 * requirement correctly excludes from the chat list.
 *
 * ToS / robots (live 2026-11-08): llmtr.com/robots.txt says
 * `User-agent: *` / `Disallow: /v1/` (and `/api/`, `/dashboard`), so the
 * scraper SKIPS every poll by default (see robots.ts). The file explicitly
 * invites machine readers to `/llms.txt` and `/llms-full.txt` instead —
 * a future alternative source for this provider, not implemented here.
 * LLMTR also refuses automated key-validation probes outright (adapter:
 * #1390) — never probe keys here; serving verification is an operator
 * step with their own key and a real chat call.
 */
import { OpenAICompatibleScraper } from './openai-compatible.ts';
import type { ModelListEntry, OpenAICompatibleScraperOptions } from './openai-compatible.ts';

export const LLMTR_BASE_URL = 'https://llmtr.com/v1';

function isZeroPrice(pricing: unknown): boolean {
  if (!pricing || typeof pricing !== 'object') return false;
  const p = pricing as { prompt?: unknown; completion?: unknown };
  return Number(p.prompt) === 0 && Number(p.completion) === 0;
}

export function isLlmtrFreeModel(entry: ModelListEntry): boolean {
  const ops = (entry as { supported_operations?: unknown }).supported_operations;
  return (
    isZeroPrice((entry as { pricing?: unknown }).pricing) &&
    Array.isArray(ops) &&
    ops.includes('CHAT_COMPLETIONS')
  );
}

export class LlmtrScraper extends OpenAICompatibleScraper {
  constructor(opts: Partial<OpenAICompatibleScraperOptions> = {}) {
    super({
      platform: 'llmtr',
      name: 'LLMTR',
      baseUrl: LLMTR_BASE_URL,
      freeFilter: isLlmtrFreeModel,
      intervalMs: 6 * 60 * 60 * 1000,
      ...opts,
    });
  }
}
