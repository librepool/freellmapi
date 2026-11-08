import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@librepool/shared/types.js';
import type { CompletionOptions } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';

export const TOKENHARBOR_BASE_URL = 'https://tokenharbor.ai/v1';

const upstreamError = (message: string) => Object.assign(new Error(`Token Harbor ${message}`), { status: 502 });
function checkModel(requested: string, returned: unknown): void {
  if (returned !== requested) throw upstreamError('returned a different or missing model identity');
}

/**
 * Free routes are the `:free`-suffixed ids. The free roster ROTATES — the
 * vendor's own Models page (free category, read 2026-11-08) lists only
 * deepseek-v4.1-flash:free and mimo-v2.6-flash:free, while deepseek-v4-flash
 * and mimo-v2.5 were dropped 2026-09-22, mimo-v2.6-flash was added
 * 2026-10-06, and claude-haiku-5.5:free (blogged 2026-10-09) is already gone
 * from the live page — so the guard is a suffix rule, not a frozen list; the
 * signed catalog is the source of routable ids. Paid routes would bill the
 * wallet, so they are rejected before any fetch. Zero price alone does NOT
 * mean free: `th-orchestra` reports $0 in the catalog but answers 402 on a
 * real call — only the `:free` suffix is trusted.
 */
export function isTokenHarborFreeModelId(modelId: string): boolean {
  return modelId.endsWith(':free');
}
function requireFree(modelId: string): void {
  if (!isTokenHarborFreeModelId(modelId)) {
    throw Object.assign(new Error('Token Harbor requires a verified free model route (a :free-suffixed id)'), { status: 400 });
  }
}

/** https://tokenharbor.ai/docs/getting-started/quickstart — OpenAI-compatible
 * gateway (Token Harbor PTE. LTD., Singapore). Free plan is $0, no card: a
 * rolling 7-day list-price value allowance (amount unpublished per account)
 * shared across the `:free` routes, 60 req/min and 1,800 req/hour per account.
 * The `:free` routes must be switched on in the dashboard first, and while
 * enabled their prompts may be retained for diagnostics / product
 * improvement. Keys are `thk_live_…` (Universal Key) from
 * tokenharbor.ai/dashboard/api-keys. TH-Rudder is Webchat-only (official
 * FAQ) — it has no API model id and is not seeded. GET /v1/models requires a
 * key (401 invalid_api_key without one, verified live 2026-11-08), so the
 * base class's default key validation applies. Catalog-only: no bundled rows
 * or automatic discovery that bypasses tiers. */
export class TokenHarborProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'tokenharbor', name: 'Token Harbor', baseUrl: TOKENHARBOR_BASE_URL });
  }

  override async chatCompletion(apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): Promise<ChatCompletionResponse> {
    requireFree(modelId);
    const response = await super.chatCompletion(apiKey, messages, modelId, options, quotaContext);
    checkModel(modelId, response.model);
    return response;
  }

  override async *streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): AsyncGenerator<ChatCompletionChunk> {
    requireFree(modelId);
    for await (const chunk of super.streamChatCompletion(apiKey, messages, modelId, options, quotaContext)) {
      // Usage-only chunks (the final chunk carries usage) may omit `model`;
      // check identity only when the upstream names one.
      if (typeof chunk.model === 'string' && chunk.model.length > 0) checkModel(modelId, chunk.model);
      yield chunk;
    }
  }
}
