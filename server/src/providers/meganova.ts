import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@librepool/shared/types.js';
import { providerHttpError, type CompletionOptions, type KeyValidationResult } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { providerTimeoutMs } from '../lib/provider-timeout.js';
import { recordQuotaObservationsFromResponse, type QuotaObservationContext } from '../services/provider-quota.js';

export const MEGANOVA_BASE_URL = 'https://api.meganova.ai/v1';

/** Tier 1 (Explorer) free rows, no card — the quota table in
 * docs.meganova.ai/tiers/tier-1.md is the operative source (50 RPD each,
 * 60 RPM / 200,000 TPM, reset 00:00 UTC). Manta Pro 1.0 and GLM-4.7-Flash are
 * tagged "free" in the live list but get 0 RPD at Tier 1 — they need the $1
 * Tier 2 deposit, so they are NOT in this list and are not seeded. */
export const MEGANOVA_FREE_MODELS = [
  'meganova-ai/manta-mini-1.0',
  'meganova-ai/manta-flash-1.0',
  'Sao10K/L3-8B-Stheno-v3.2',
  'Sao10K/L3-70B-Euryale-v2.1',
  'Steelskull/L3.3-MS-Nevoria-70b',
  'BruhzWater/Sapphira-L3.3-70b-0.1',
  'FallenMerick/MN-Violet-Lotus-12B',
  'mistralai/Mistral-Small-3.2-24B-Instruct-2506',
] as const;
const FREE_MODELS = new Set<string>(MEGANOVA_FREE_MODELS);

const upstreamError = (message: string) => Object.assign(new Error(`MegaNova AI ${message}`), { status: 502 });
function checkModel(requested: string, returned: unknown): void {
  if (returned !== requested) throw upstreamError('returned a different or missing model identity');
}
function requireFree(modelId: string): void {
  if (!FREE_MODELS.has(modelId)) {
    throw Object.assign(new Error('MegaNova AI free tier (Tier 1, no card) serves only its 8 Tier 1 models; Manta Pro and GLM-4.7-Flash need the $1 Tier 2 deposit'), { status: 400 });
  }
}

/** https://docs.meganova.ai — OpenAI-compatible inference API. Free Tier 1 is
 * $0, no card: 50 requests/day per free model, 60 RPM / 200,000 TPM.
 * Inference keys begin `sk-` (live-verified 2026-11-08: the endpoint rejects
 * `ak_` keys outright — those belong to the Platform/billing API, not
 * inference). GET /v1/models is public, so it cannot validate a key:
 * validateKey sends a minimal chat call (Manta Mini, max_tokens 1). ToS
 * Annex A: free modules are "for evaluation and interactive use only" —
 * high-throughput/production use may lead to suspension; flag before routing
 * production traffic here. Catalog-only: no bundled rows or automatic
 * discovery that bypasses tiers. */
export class MeganovaProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'meganova', name: 'MegaNova AI', baseUrl: MEGANOVA_BASE_URL });
  }

  override async validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<KeyValidationResult> {
    // No dedicated validation endpoint; GET /v1/models answers without a key.
    // A minimal chat call is the only check: 200 = valid (costs 1 request
    // against the model's 50/day Tier 1 quota), 401 = invalid. Anything else
    // is inconclusive.
    const res = await this.fetchWithTimeout(`${MEGANOVA_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'meganova-ai/manta-mini-1.0', messages: [{ role: 'user', content: 'key validation' }], max_tokens: 1, stream: false }),
    }, providerTimeoutMs(this.platform, 30_000), { timeoutBounds: 'request' });
    recordQuotaObservationsFromResponse(res, { ...quotaContext, platform: this.platform, endpoint: 'key-validation' });
    if (res.status === 200) return true;
    if (res.status === 401 || res.status === 403) return this.validationResult(res);
    throw providerHttpError(res, 'MegaNova AI key validation is temporarily inconclusive');
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
