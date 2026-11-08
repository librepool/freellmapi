import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@librepool/shared/types.js';
import type { CompletionOptions } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';

export const MIXLAYER_BASE_URL = 'https://mixlayer.ai/v1';

/** The one $0 model documented by the vendor (quickstart + pricing page,
 * read 2026-11-08): Qwen3.5 4B at 131K context, callable without prepaid
 * credit. */
export const MIXLAYER_FREE_MODEL = 'qwen/qwen3.5-4b-free';

const upstreamError = (message: string) => Object.assign(new Error(`Mixlayer ${message}`), { status: 502 });
function checkModel(requested: string, returned: unknown): void {
  if (returned !== requested) throw upstreamError('returned a different or missing model identity');
}

/**
 * Free routes carry the `-free` suffix — the vendor's own marker (the
 * documented free id is `qwen/qwen3.5-4b-free`; the pricing page says
 * "Free models stay free", so the guard is a suffix rule, not a frozen list,
 * and a future $0 id is admitted without a code change; the signed catalog
 * is the source of routable ids). Paid routes would bill the account (or 402
 * on an empty balance), so they are rejected before any fetch.
 */
export function isMixlayerFreeModelId(modelId: string): boolean {
  return modelId.endsWith('-free');
}
function requireFree(modelId: string): void {
  if (!isMixlayerFreeModelId(modelId)) {
    throw Object.assign(new Error('Mixlayer free tier serves only its -free-suffixed $0 models (qwen/qwen3.5-4b-free)'), { status: 400 });
  }
}

/** https://docs.mixlayer.com — OpenAI-compatible inference API. Free tier is
 * $0, no card: the `-free` models need no prepaid credit (paid models return
 * 402 when the balance is empty). No numeric RPM/TPM is published anywhere —
 * limits are per organization and per model, unpublished, so there is no
 * token figure to add to the floor. Keys come from
 * console.mixlayer.com/app/api-keys; no key prefix is published — keys are
 * opaque, do not guess one. GET /v1/models requires a Bearer key (401
 * without one, verified live 2026-11-08 against both mixlayer.ai/v1 and
 * models.mixlayer.ai/v1, which answer identically), so the base class's
 * default validation (GET /models) checks a credential. The model-identity
 * check is unverified against live traffic (no key was available); confirm
 * the upstream echoes the requested id before routing production traffic.
 * Catalog-only: no bundled rows or automatic discovery that bypasses tiers. */
export class MixlayerProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'mixlayer', name: 'Mixlayer', baseUrl: MIXLAYER_BASE_URL });
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
