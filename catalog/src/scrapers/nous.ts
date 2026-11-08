/**
 * Nous Portal scraper — official public
 * `GET https://inference-api.nousresearch.com/v1/models`.
 *
 * Free routes are the `:free`-suffixed ids (same suffix rule as the router
 * adapter, server/src/providers/nous.ts). The free roster churns — live
 * probe 2026-11-08 returned 393 models, 4 free (solar-mini4,
 * step-3.7-flash, longcat-2.5, beam-1.0); the 2026-10-15 roster listed 7 —
 * so the filter is the suffix rule, not a frozen list.
 *
 * ToS / robots (live 2026-11-08): inference-api.nousresearch.com serves
 * no robots.txt (404), so the poll is allowed and this is the one concrete
 * scraper that runs live on the default schedule. Free plan is $0 for
 * :free models only: 50 RPM / 500,000 TPM, no published monthly token cap;
 * a portal key is required to chat (a keyless chat call returns 402 even
 * though the public catalog is readable) — so list-verified is the only
 * verification the scheduler can produce here; serving verification is an
 * operator step with a portal key.
 */
import { OpenAICompatibleScraper } from './openai-compatible.ts';
import type { ModelListEntry, OpenAICompatibleScraperOptions } from './openai-compatible.ts';

export const NOUS_BASE_URL = 'https://inference-api.nousresearch.com/v1';

export function isNousFreeModelId(modelId: string): boolean {
  return modelId.endsWith(':free');
}

export function isNousScrapableModel(entry: ModelListEntry): boolean {
  return isNousFreeModelId(entry.id);
}

export class NousScraper extends OpenAICompatibleScraper {
  constructor(opts: Partial<OpenAICompatibleScraperOptions> = {}) {
    super({
      platform: 'nous',
      name: 'Nous Portal',
      baseUrl: NOUS_BASE_URL,
      freeFilter: isNousScrapableModel,
      intervalMs: 6 * 60 * 60 * 1000,
      ...opts,
    });
  }
}
