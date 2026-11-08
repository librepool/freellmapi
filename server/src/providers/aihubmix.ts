import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@librepool/shared/types.js';
import type { CompletionOptions, KeyValidationResult } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';

export const AIHUBMIX_BASE_URL = 'https://aihubmix.com/v1';

const upstreamError = (message: string) => Object.assign(new Error(`AIHubMix ${message}`), { status: 502 });
function checkModel(requested: string, returned: unknown): void {
  if (returned !== requested) throw upstreamError('returned a different or missing model identity');
}

/**
 * Free routes are the `-free` / `:free`-suffixed ids. The free roster CHURNS
 * — live GET /v1/models on 2026-11-08 returned 662 models, 42 free, and two
 * ids named in the first spec draft (gpt-4.1-free, gemini-3-flash-preview-free)
 * were already gone within hours — so the guard is a suffix rule, not a frozen
 * list; the signed catalog is the source of routable ids. Paid routes would
 * bill the top-up balance, so they are rejected before any fetch.
 */
export function isAihubmixFreeModelId(modelId: string): boolean {
  return modelId.endsWith('-free') || modelId.endsWith(':free');
}
function requireFree(modelId: string): void {
  if (!isAihubmixFreeModelId(modelId)) {
    throw Object.assign(new Error('AIHubMix requires a verified free model route (a -free or :free-suffixed id)'), { status: 400 });
  }
}

/** https://docs.aihubmix.com/en — OpenAI-compatible gateway. Free pool is 1M
 * tokens/day shared across the free routes after a one-time >=$1 top-up that
 * stays as balance; 100 req/day, 5-10 req/min. /v1/models is public, so there
 * is no key-validation endpoint that can check a credential without spending
 * quota (KiosAPI pattern: supportsKeyValidation=false; the first served
 * request establishes credential health). Catalog-only: no bundled rows or
 * automatic discovery that bypasses tiers. */
export class AIHubMixProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'aihubmix', name: 'AIHubMix', baseUrl: AIHUBMIX_BASE_URL });
  }

  override get supportsKeyValidation(): boolean { return false; }
  override async validateKey(_apiKey: string): Promise<KeyValidationResult> {
    // /models is public. Do not consume free-pool quota for a health probe;
    // the first actual served request establishes credential health.
    throw new Error('AIHubMix has no documented free credential-validation endpoint; key validity is unknown (no quota spent)');
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
