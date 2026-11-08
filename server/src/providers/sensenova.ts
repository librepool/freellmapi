import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@librepool/shared/types.js';
import type { CompletionOptions } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';

export const SENSENOVA_BASE_URL = 'https://token.sensenova.ai/v1';

const upstreamError = (message: string) => Object.assign(new Error(`SenseNova ${message}`), { status: 502 });
function checkModel(requested: string, returned: unknown): void {
  if (returned !== requested) throw upstreamError('returned a different or missing model identity');
}

/** https://www.sensenova.ai/models and platform.sensenova.ai docs —
 * OpenAI-compatible Token Plan API (SenseTime). Free tier is $0 during the
 * public beta, no card: 1,500 requests per model every rolling 5 hours, up
 * to 20 API keys, on point pools of 60,000 points per rolling 5h and 600,000
 * per rolling 7 days (docs, in force since 2026-09-04). Keys are `sk-` from
 * the platform.sensenova.ai console.
 *
 * BETA CAVEAT: there is no published permanent free tier — paid Lite and Pro
 * tiers are marked "coming soon" with no prices, and the free tier may convert
 * when the beta ends. Treat the adapter as beta-scoped: if paid tiers launch,
 * the catalog must be re-checked before routing paid traffic here.
 *
 * REGIONS: the global endpoint is token.sensenova.ai/v1; the China endpoint
 * token.sensenova.cn/v1 is a separate platform whose keys are NOT
 * interchangeable (and whose catalog is larger — it also serves aggregated
 * DeepSeek / GLM / Kimi models). This adapter is the global endpoint only.
 *
 * NO FREE-ROUTE GUARD: during the beta every model on the global endpoint is
 * $0, so there is no paid route to reject — a suffix rule would only go stale
 * as the roster churns (6.7-flash-lite was listed in List Models on
 * 2026-10-23 after docs said its compatibility routing ended 2026-08;
 * 6.8-flash appeared 2026-11-04). The signed catalog is the source of
 * routable ids. The U1 image models (sensenova-u1-fast, sensenova-u1.5-lite)
 * are NOT chat models — they serve /images/generations and /images/edits
 * only, so they are not seeded as chat rows. GET /v1/models requires a key
 * (401 without one, verified live 2026-11-08 on both .ai and .cn), so the
 * base class's default key validation applies. Catalog-only: no bundled rows
 * or automatic discovery that bypasses tiers. */
export class SenseNovaProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'sensenova', name: 'SenseNova', baseUrl: SENSENOVA_BASE_URL });
  }

  override async chatCompletion(apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): Promise<ChatCompletionResponse> {
    const response = await super.chatCompletion(apiKey, messages, modelId, options, quotaContext);
    checkModel(modelId, response.model);
    return response;
  }

  override async *streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): AsyncGenerator<ChatCompletionChunk> {
    for await (const chunk of super.streamChatCompletion(apiKey, messages, modelId, options, quotaContext)) {
      // Usage-only chunks (the final chunk carries usage) may omit `model`;
      // check identity only when the upstream names one.
      if (typeof chunk.model === 'string' && chunk.model.length > 0) checkModel(modelId, chunk.model);
      yield chunk;
    }
  }
}
