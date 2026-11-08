/**
 * Api.Airforce scraper — official public `GET https://api.airforce/v1/models`.
 *
 * The list is a whole marketplace (790 ids live 2026-11-08: chat, image,
 * audio, TTS, embeddings, rerankers), so two filters apply: the entry must
 * be a chat route (`supports_chat === true`) AND carry the free tier
 * (`tier === "free"`). The list's price fields are NOT the free signal —
 * free-tier entries still carry list prices (e.g. kimi-k2.7-code lists
 * 58/240 per million tokens). Live probe 2026-11-08: 29 `tier: "free"`
 * entries, 26 of them chat (3 are Suno audio models, excluded here).
 *
 * The list also carries a `status` field, surfaced as a report note:
 * on 2026-11-08 only 3 of the 26 free chat models reported
 * `operational` (llama-instant, mistral-large-4, kimi-k2.7-code); the
 * other 23 reported `major_outage`, including the seeded glm-4.7-flash.
 * A listed-but-down model is still a catalog candidate (outages pass),
 * but an operator should not treat "26 free chat models" as "26 working
 * lanes" on a day like that.
 *
 * ToS / robots (live 2026-11-08): api.airforce/robots.txt says
 * `User-agent: *` / `Disallow: /v1/` (the comment says the block targets
 * indexing waste — "backend API endpoints, not content pages" — and the
 * file explicitly allows AI crawlers on other paths). The scraper
 * therefore SKIPS every poll by default (see robots.ts). Rate limit to
 * respect when polling is re-enabled: 1 request/minute/account (adapter
 * comment; a 429 carries Retry-After).
 */
import { OpenAICompatibleScraper } from './openai-compatible.ts';
import type { ModelListEntry, OpenAICompatibleScraperOptions } from './openai-compatible.ts';

export const AIRFORCE_BASE_URL = 'https://api.airforce/v1';

export function isAirforceFreeChatModel(entry: ModelListEntry): boolean {
  return entry.tier === 'free' && entry.supports_chat === true;
}

export class AirforceScraper extends OpenAICompatibleScraper {
  constructor(opts: Partial<OpenAICompatibleScraperOptions> = {}) {
    super({
      platform: 'airforce',
      name: 'Api.Airforce',
      baseUrl: AIRFORCE_BASE_URL,
      freeFilter: isAirforceFreeChatModel,
      intervalMs: 6 * 60 * 60 * 1000,
      ...opts,
    });
  }

  protected override notesForList(entries: ModelListEntry[], freeIds: string[]): string[] {
    const free = entries.filter((e) => freeIds.includes(e.id));
    const operational = free.filter((e) => e.status === 'operational').length;
    const outage = free.filter((e) => typeof e.status === 'string' && e.status !== 'operational').length;
    if (free.length === 0) return [];
    return [
      `Airforce free chat: ${operational}/${free.length} operational` +
        (outage > 0 ? `, ${outage} reporting non-operational status (e.g. major_outage)` : ''),
    ];
  }
}
