import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@librepool/shared/types.js';
import type { CompletionOptions, KeyValidationResult } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';

export const NOUS_BASE_URL = 'https://inference-api.nousresearch.com/v1';

const upstreamError = (message: string) => Object.assign(new Error(`Nous Portal ${message}`), { status: 502 });
function checkModel(requested: string, returned: unknown): void {
  if (returned !== requested) throw upstreamError('returned a different or missing model identity');
}

/**
 * Free routes are the `:free`-suffixed ids. The free roster CHURNS — live GET
 * /v1/models on 2026-11-08 returned 396 models, 4 free (solar-mini4,
 * step-3.7-flash, longcat-2.5, beam-1.0), while 2026-10-15 listed 7 free ids
 * including laguna and ling — so the guard is a suffix rule, not a frozen
 * list; the signed catalog is the source of routable ids. Paid routes would
 * bill the account, so they are rejected before any fetch.
 */
export function isNousFreeModelId(modelId: string): boolean {
  return modelId.endsWith(':free');
}
function requireFree(modelId: string): void {
  if (!isNousFreeModelId(modelId)) {
    throw Object.assign(new Error('Nous Portal requires a verified free model route (a :free-suffixed id)'), { status: 400 });
  }
}

/** https://portal.nousresearch.com/api-docs — OpenAI-compatible inference API.
 * Free plan is $0 for :free models only: 50 RPM / 500,000 TPM, no published
 * monthly token cap; a portal key is required (a keyless chat call returns 402
 * even though the public catalog is readable). /v1/models is public, so there
 * is no key-validation endpoint that can check a credential without spending
 * quota (KiosAPI pattern: supportsKeyValidation=false; the first served
 * request establishes credential health). Hermes 4 returns reasoning in
 * `reasoning_content`, which the base class already folds when content is
 * empty. Catalog-only: no bundled rows or automatic discovery that bypasses
 * tiers. */
export class NousProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'nous', name: 'Nous Portal', baseUrl: NOUS_BASE_URL });
  }

  override get supportsKeyValidation(): boolean { return false; }
  override async validateKey(_apiKey: string): Promise<KeyValidationResult> {
    // /models is public. Do not consume free-tier quota for a health probe;
    // the first actual served request establishes credential health.
    throw new Error('Nous Portal has no documented free credential-validation endpoint; key validity is unknown (no quota spent)');
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
