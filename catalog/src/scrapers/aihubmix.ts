/**
 * AIHubMix scraper — official public `GET https://aihubmix.com/v1/models`.
 *
 * Free routes are the `-free` / `:free`-suffixed ids (same suffix rule as
 * the router adapter, server/src/providers/aihubmix.ts). The free roster
 * churns — live probe 2026-11-08 returned 662 models, 42 free — so the
 * filter is the suffix rule, not a frozen list.
 *
 * One id is EXCLUDED from the free list even though it matches the suffix:
 * `nemotron-3.5-content-safety-free` is a content-safety classifier, not a
 * chat model — the seed deliberately left it out, and serving it as chat
 * would be wrong. If AIHubMix ever ships a real chat route under that id,
 * remove it from the exclusion with a note.
 *
 * ToS / robots (live 2026-11-08): aihubmix.com/robots.txt says
 * `User-agent: *` / `Disallow: /v1/` (API endpoints are not indexed). The
 * scraper therefore SKIPS every poll by default (see robots.ts) and this
 * class is exercised by the manual build-time probe, not by the scheduler,
 * until an operator records a documented exception. Free pool: 1M
 * tokens/day shared across the free routes after a one-time ≥$1 top-up
 * that stays as balance; 100 req/day, 5–10 req/min (adapter comment).
 */
import { OpenAICompatibleScraper } from './openai-compatible.ts';
import type { ModelListEntry, OpenAICompatibleScraperOptions } from './openai-compatible.ts';

export const AIHUBMIX_BASE_URL = 'https://aihubmix.com/v1';

/** Content-safety classifier, not a chat model — never a catalog row. */
export const AIHUBMIX_EXCLUDED_IDS: ReadonlySet<string> = new Set([
  'nemotron-3.5-content-safety-free',
]);

export function isAihubmixFreeModelId(modelId: string): boolean {
  return modelId.endsWith('-free') || modelId.endsWith(':free');
}

export function isAihubmixScrapableModel(entry: ModelListEntry): boolean {
  return isAihubmixFreeModelId(entry.id) && !AIHUBMIX_EXCLUDED_IDS.has(entry.id);
}

export class AihubmixScraper extends OpenAICompatibleScraper {
  constructor(opts: Partial<OpenAICompatibleScraperOptions> = {}) {
    super({
      platform: 'aihubmix',
      name: 'AIHubMix',
      baseUrl: AIHUBMIX_BASE_URL,
      freeFilter: isAihubmixScrapableModel,
      intervalMs: 6 * 60 * 60 * 1000,
      ...opts,
    });
  }
}
