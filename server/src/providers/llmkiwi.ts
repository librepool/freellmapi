import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@librepool/shared/types.js';
import { providerHttpError, type CompletionOptions, type KeyValidationResult } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { providerTimeoutMs } from '../lib/provider-timeout.js';
import { recordQuotaObservationsFromResponse, type QuotaObservationContext } from '../services/provider-quota.js';

export const LLMKIWI_BASE_URL = 'https://api.llm.kiwi/v1';

/** Live GET /v1/models 2026-11-08 (pulled 3x, identical): the whole service is
 * currently free with no paid model tier, so every listed id is a free route.
 * `hrllm` is described in the docs but absent from the live list — do not seed
 * it until it reappears. `auto` is a router: the upstream may answer with a
 * different underlying model id, so the identity check is skipped for it. */
export const LLMKIWI_FREE_MODELS = [
  'auto',
  'minimax-m3',
  'minimax-m2.5',
  'nemotron-3-ultra',
  'nemotron-3-super',
] as const;
const FREE_MODELS = new Set<string>(LLMKIWI_FREE_MODELS);

const upstreamError = (message: string) => Object.assign(new Error(`LLM.kiwi ${message}`), { status: 502 });
function checkModel(requested: string, returned: unknown): void {
  // `auto` routes to whichever model the gateway picks per request; a
  // different returned id is the product working, not a substitution.
  if (requested === 'auto') return;
  if (returned !== requested) throw upstreamError('returned a different or missing model identity');
}
function requireFree(modelId: string): void {
  if (!FREE_MODELS.has(modelId)) {
    throw Object.assign(new Error('LLM.kiwi free tier serves only the models in its live public catalog'), { status: 400 });
  }
}

/** https://docs.llm.kiwi — OpenAI-compatible chat API. Free plan is €0, no
 * card (Google/GitHub OAuth sign-in, 3 active keys); no numeric quota is
 * published anywhere in the official docs, so there is no token figure to add
 * to the floor — a rate-limited uncapped lane, never summed. Keys begin
 * `sk_kiwi_` (official quickstart). GET /v1/models is public and succeeds
 * without a key, so it cannot validate one: validateKey sends a minimal chat
 * call (model `auto`, max_tokens 1), the only validation path the provider
 * offers. Tool calling is not documented — do not assume it. Catalog-only: no
 * bundled rows or automatic discovery that bypasses tiers. */
export class LlmkiwiProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'llmkiwi', name: 'LLM.kiwi', baseUrl: LLMKIWI_BASE_URL });
  }

  override async validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<KeyValidationResult> {
    // No dedicated validation endpoint; GET /v1/models answers without a key.
    // A minimal chat call is the only check: 200 = valid (costs 1 request),
    // 401 invalid_api_key = invalid. Anything else is inconclusive.
    const res = await this.fetchWithTimeout(`${LLMKIWI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'key validation' }], max_tokens: 1, stream: false }),
    }, providerTimeoutMs(this.platform, 30_000), { timeoutBounds: 'request' });
    recordQuotaObservationsFromResponse(res, { ...quotaContext, platform: this.platform, endpoint: 'key-validation' });
    if (res.status === 200) return true;
    if (res.status === 401 || res.status === 403) return this.validationResult(res);
    throw providerHttpError(res, 'LLM.kiwi key validation is temporarily inconclusive');
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
