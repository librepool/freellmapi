import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@librepool/shared/types.js';
import type { CompletionOptions } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';

export const ZRO_BASE_URL = 'https://zro.moonmath.ai/v1';

/**
 * The Free plan names exactly two models, so the guard is a frozen set —
 * not a suffix rule (there is none) and not a live roster (GET /v1/models
 * needs a key, so the catalog cannot be re-pulled keylessly). Both ids are
 * also served under a `zro/` alias (docs/models); the alias resolves to the
 * same model and pricing, so it is accepted and canonicalised. Everything
 * else on the account is metered: `auto` routes paid tiers (Reasoning goes
 * to glm-5.3), glm-5.3 / dolly1-security / dolly2-security / abyss1 bill
 * per token, and paid routes would bill the account, so they are rejected
 * before any fetch.
 */
const FREE_MODEL_IDS = new Set(['deepseek-v4.1-flash', 'glm-5.3-flash']);
export function canonicalZroModelId(modelId: string): string {
  return modelId.startsWith('zro/') ? modelId.slice(4) : modelId;
}
export function isZroFreeModelId(modelId: string): boolean {
  return FREE_MODEL_IDS.has(canonicalZroModelId(modelId));
}
function requireFree(modelId: string): void {
  if (!isZroFreeModelId(modelId)) {
    throw Object.assign(new Error('Zro requires a verified free model route (deepseek-v4.1-flash or glm-5.3-flash)'), { status: 400 });
  }
}

const upstreamError = (message: string) => Object.assign(new Error(`Zro ${message}`), { status: 502 });
function checkModel(requested: string, returned: unknown): void {
  // The upstream names the canonical id even when the request used the
  // `zro/` alias, so accept either spelling of the same model.
  if (returned !== requested && returned !== canonicalZroModelId(requested)) {
    throw upstreamError('returned a different or missing model identity');
  }
}

/** https://zro.moonmath.ai/docs — OpenAI-compatible inference API.
 * Free plan is $0: daily usage on GLM-5.3 Flash and DeepSeek V4.1 Flash,
 * resetting every calendar day; the allowance amount, pooling scope, reset
 * time and rate limits are NOT published (the dashboard shows a % bar only),
 * so no numeric limit is recorded anywhere — the seed rows carry null
 * limits. An account and API key are required (keys start `sk-`, the same
 * generic prefix as OpenAI/MegaNova, so there is no key-prefix detection;
 * `ZRO_` matches the documented `ZRO_API_KEY` env var instead). The
 * quickstart asks new accounts to subscribe to a plan or add a usage pack,
 * so whether a Free-only account can create a key without a card is
 * unverified — no card requirement is claimed here. GET /v1/models is
 * key-gated (401 without a key, verified live 2026-11-08), so the base
 * class's default key validation applies. Per-key region selection: the
 * two free models are served in different regions (DeepSeek V4.1 Flash in
 * the United States, GLM-5.3 Flash in Europe, per the model pages), and a
 * model not served in any region a key allows fails rather than routing
 * elsewhere. Both Flash models are reasoning models with a default-high
 * reasoning level (DeepSeek can turn it off, GLM cannot); the base class
 * already folds `reasoning_content` when content is empty. Catalog-only:
 * no bundled rows or automatic discovery that bypasses tiers. */
export class ZroProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'zro', name: 'Zro', baseUrl: ZRO_BASE_URL });
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
