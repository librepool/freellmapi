import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@librepool/shared/types.js';
import type { CompletionOptions } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';

export const GONKA_BASE_URL = 'https://proxy.gonkabroker.com/v1';
export const GONKA_TEST_AUTH_URL = `${GONKA_BASE_URL}/test-auth`;

const upstreamError = (message: string) => Object.assign(new Error(`Gonka Broker ${message}`), { status: 502 });
function checkModel(requested: string, returned: unknown): void {
  if (returned !== requested) throw upstreamError('returned a different or missing model identity');
}

/**
 * Gonka returns a reasoning model's thinking in a dedicated `reasoning` field,
 * never inside `content` (docs.gonkabroker.com/reference/api-compatibility/,
 * "Where the reasoning arrives": non-streaming `choices[0].message.reasoning`,
 * streaming `choices[].delta.reasoning` before the content deltas). The base
 * class already folds `reasoning` into `content` when content is empty; this
 * moves it onto the shared `reasoning_content` field the router reads, so the
 * thinking trace stays visible when an answer is present too.
 */
function moveReasoning(message: { reasoning?: unknown; reasoning_content?: unknown }): void {
  if (typeof message.reasoning === 'string' && message.reasoning.length > 0 &&
      typeof message.reasoning_content !== 'string') {
    message.reasoning_content = message.reasoning;
  }
  delete (message as Record<string, unknown>).reasoning;
}

/** https://docs.gonkabroker.com/reference/api-compatibility/ — OpenAI-compatible
 * proxy. Free tier: >=1M tokens/month, resetting on the 1st; no card, phone
 * verification on signup. GET /test-auth returns key status and the current
 * rate limit, so it is the key-validation endpoint. Reasoning models bill
 * thinking as output tokens. Generative models 404 on /embeddings and
 * embedding models 404 on the chat endpoints. Catalog-only: no bundled rows
 * or automatic discovery that bypasses tiers. */
export class GonkaProvider extends OpenAICompatProvider {
  constructor() {
    // Reasoning models (GLM-5.3-Flash thinks longer on json_schema requests)
    // can take well past the 15s default before first byte; 90s matches
    // KiosAPI's allowance for the same shape of slow reasoning upstream.
    super({ platform: 'gonka', name: 'Gonka Broker', baseUrl: GONKA_BASE_URL,
      validateUrl: GONKA_TEST_AUTH_URL, timeoutMs: 90_000 });
  }

  override async chatCompletion(apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): Promise<ChatCompletionResponse> {
    const response = await super.chatCompletion(apiKey, messages, modelId, options, quotaContext);
    checkModel(modelId, response.model);
    for (const choice of response.choices ?? []) {
      if (choice.message) moveReasoning(choice.message as { reasoning?: unknown; reasoning_content?: unknown });
    }
    return response;
  }

  override async *streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): AsyncGenerator<ChatCompletionChunk> {
    for await (const chunk of super.streamChatCompletion(apiKey, messages, modelId, options, quotaContext)) {
      // Usage-only chunks (the final chunk carries usage) may omit `model`;
      // check identity only when the upstream names one.
      if (typeof chunk.model === 'string' && chunk.model.length > 0) checkModel(modelId, chunk.model);
      for (const choice of chunk.choices ?? []) {
        if (choice.delta) moveReasoning(choice.delta as { reasoning?: unknown; reasoning_content?: unknown });
      }
      yield { ...chunk, model: modelId };
    }
  }
}
