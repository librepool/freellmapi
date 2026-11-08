import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@librepool/shared/types.js';
import type { CompletionOptions, KeyValidationResult } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';

export const MOARK_BASE_URL = 'https://api.moark.com/v1';

/** The only model id confirmed callable on the free experience token, by
 * both the vendor's own docs (the Claude Code guide uses it in every model
 * slot; docs/integrations/Development-Tools/claude_code, read 2026-11-08)
 * and the independent probe (mvalentsev/awesome-free-ai-coding, verified
 * 2026-11-05). The free token covers "all featured models" (所有精选模型),
 * but the featured roster is published only on the client-rendered model
 * square — no public API marks it — so only this vendor-documented id is
 * seeded; extend this list when more featured ids are confirmed. Models
 * marked "免费" in the square are NOT free: the FAQ says they need a
 * purchased resource package of any amount (FAQ Q1). */
export const MOARK_FREE_MODELS = [
  'deepseek-v4-flash-0731',
] as const;
const FREE_MODELS = new Set<string>(MOARK_FREE_MODELS);

const upstreamError = (message: string) => Object.assign(new Error(`Moark ${message}`), { status: 502 });
function checkModel(requested: string, returned: unknown): void {
  if (returned !== requested) throw upstreamError('returned a different or missing model identity');
}
function requireFree(modelId: string): void {
  if (!FREE_MODELS.has(modelId)) {
    throw Object.assign(new Error('Moark free tier (free experience token, 100 calls/day) serves only its confirmed featured models; models marked "free" in the square need a purchased resource package'), { status: 400 });
  }
}

/** https://moark.com/docs — Gitee's model platform (formerly Gitee AI),
 * OpenAI-compatible API. Free tier is the "free experience access token"
 * (免费体验访问令牌, FAQ Q6): 100 calls/day per user across the featured
 * models, nothing bought; at the cap the API returns 400 "已达到最大当日免费
 * API 使用次数，请购买资源后继续使用 API" (FAQ Q17). Sign-in is through a
 * Gitee account; whether an account can be opened with a phone number from
 * outside mainland China is unverified. No key prefix is published — tokens
 * are opaque, do not guess one. GET /v1/models is public (live probe
 * 2026-11-08: 200, 214 models), so there is no key-validation endpoint
 * (KiosAPI pattern: supportsKeyValidation=false; the first served request
 * establishes credential health). The model-identity check is unverified
 * against live traffic (no key was available); confirm the upstream echoes
 * the requested id before routing production traffic. Catalog-only: no
 * bundled rows or automatic discovery that bypasses tiers. */
export class MoarkProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'moark', name: 'Moark', baseUrl: MOARK_BASE_URL });
  }

  override get supportsKeyValidation(): boolean { return false; }
  override async validateKey(_apiKey: string): Promise<KeyValidationResult> {
    // /models is public. Do not consume the 100/day free allowance for a
    // health probe; the first actual served request establishes credential
    // health.
    throw new Error('Moark has no documented free credential-validation endpoint; key validity is unknown (no quota spent)');
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
