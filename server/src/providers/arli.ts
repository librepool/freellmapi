import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@librepool/shared/types.js';
import type { CompletionOptions } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';

export const ARLI_BASE_URL = 'https://api.arliai.com/v1';

/** The one permanently free model. Every other Arli model is a 5-request /
 * 2-day trial on free accounts (pricing page + docs/textgen, read 2026-11-08),
 * not a routing lane, so it is not seeded and the adapter refuses it. */
export const ARLI_FREE_MODEL = 'Qwen3.5-27B-Derestricted';

const upstreamError = (message: string) => Object.assign(new Error(`Arli AI ${message}`), { status: 502 });
function checkModel(requested: string, returned: unknown): void {
  if (returned !== requested) throw upstreamError('returned a different or missing model identity');
}
function requireFree(modelId: string): void {
  if (modelId !== ARLI_FREE_MODEL) {
    throw Object.assign(new Error('Arli AI free tier serves only Qwen3.5-27B-Derestricted; other models are a 5-request / 2-day trial on free accounts'), { status: 400 });
  }
}

/** https://www.arliai.com/docs/textgen — OpenAI-compatible API (vLLM backend).
 * Free plan is $0, no card: Qwen3.5-27B-Derestricted only, max 12K context
 * (the model natively advertises 262K), 1 request at a time, delayed
 * responses. GET /v1/models requires a Bearer key (401 without one, verified
 * live 2026-11-08), so the base class's default validation (GET /models)
 * checks a credential. No key prefix is published — keys are opaque; do not
 * guess one. The catalog is dominated by "derestricted" (uncensored)
 * fine-tunes; only the one permanently free model is seeded. Catalog-only: no
 * bundled rows or automatic discovery that bypasses tiers. */
export class ArliProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'arli', name: 'Arli AI', baseUrl: ARLI_BASE_URL });
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
