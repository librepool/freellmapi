import { createHash } from 'node:crypto';
import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage, Platform } from '@librepool/shared/types.js';
import { BaseProvider, providerHttpError, type CompletionOptions, type KeyValidationResult } from './base.js';
import { contentToString } from '../lib/content.js';
import { providerTimeoutMs } from '../lib/provider-timeout.js';
import { resolveMaxTokens } from '../lib/sampling-params.js';
import { recordQuotaObservationsFromResponse, type QuotaObservationContext } from '../services/provider-quota.js';

/** IBM Cloud IAM token endpoint: an IBM Cloud API key is exchanged for a
 * bearer token here, then the token (not the API key) calls watsonx.ai. */
export const WATSONX_IAM_URL = 'https://iam.cloud.ibm.com/identity/token';
/** Default region (Dallas). Overridable per install via WATSONX_URL, the
 * LiteLLM convention (eu-de, eu-gb and jp-tok are the other watsonx regions). */
export const WATSONX_DEFAULT_BASE_URL = 'https://us-south.ml.cloud.ibm.com';
export const WATSONX_BASE_URL_ENV = 'WATSONX_URL';
/** Pinned watsonx.ai API version (?version=... on every call). */
export const WATSONX_API_VERSION = '2024-10-07';

const upstreamError = (message: string) => Object.assign(new Error(`watsonx.ai ${message}`), { status: 502 });

export interface WatsonxCredentials { projectId: string; apiKey: string; }

/** The UI collects two fields; the encrypted credential stores both, in the
 * same composite form JamAI uses (project_id:PAT). Export/import format:
 * WATSONX_KEY=<project_id>:<ibm_cloud_api_key>; a WATSONX_PROJECT_ID env var
 * beside WATSONX_APIKEY composes the same form (see lib/key-parser.ts).
 * Never put either part in a URL. */
export function watsonxCredentials(credential: string): WatsonxCredentials {
  const trimmed = credential.trim();
  const sep = trimmed.indexOf(':');
  if (sep <= 0 || sep === trimmed.length - 1) {
    throw Object.assign(new Error('watsonx.ai requires a project ID and IBM Cloud API key in project_id:api_key form'), { status: 401 });
  }
  const projectId = trimmed.slice(0, sep);
  const apiKey = trimmed.slice(sep + 1);
  if (/\s/.test(projectId) || /\s/.test(apiKey)) {
    throw Object.assign(new Error('watsonx.ai requires a project ID and IBM Cloud API key in project_id:api_key form'), { status: 401 });
  }
  return { projectId, apiKey };
}

/** Region base URL for this install. Read at request time so a WATSONX_URL
 * change takes effect without a restart. */
export function watsonxBaseUrl(): string {
  const raw = process.env[WATSONX_BASE_URL_ENV]?.trim();
  if (!raw) return WATSONX_DEFAULT_BASE_URL;
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/.*)?$/.test(raw)) {
    throw Object.assign(new Error('WATSONX_URL is set but is not a valid https:// region URL'), { status: 500 });
  }
  return raw.replace(/\/+$/, '');
}

interface IamToken { accessToken: string; expiresAtMs: number; }

/** Native watsonx.ai text-chat response shape (IBM Cloud API docs, "Text
 * Chat", read 2026-11-08): OpenAI-like choices/usage, but the model identity
 * arrives as `model_id` (with `model` as a duplicate) and reasoning as
 * `reasoning_content` (include_reasoning defaults to true). */
interface WatsonxChatResponse {
  id?: unknown;
  model_id?: unknown;
  model?: unknown;
  created?: unknown;
  choices?: Array<{
    index?: unknown;
    message?: {
      role?: unknown;
      content?: unknown;
      reasoning_content?: unknown;
      reasoning?: unknown;
      tool_calls?: ChatCompletionResponse['choices'][number]['message']['tool_calls'];
    };
    finish_reason?: unknown;
  }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
}

function asNonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** IBM watsonx.ai — custom adapter (IAM auth + project_id + native
 * /ml/v1/text/chat). Built from the official docs (IBM Cloud API docs, "Text
 * Chat" / "Text Chat Stream", and LiteLLM's watsonx provider page), read
 * 2026-11-08. NOT live-probed: no IBM Cloud account was available, so the
 * request/response shapes below are the documented ones and the seeded model
 * ids' Lite-plan availability is unverified — the first live call must confirm
 * both. Free tier (Lite): 300K foundation-model tokens/month, 20 CUH/month,
 * 2 req/sec; a card is held for identity verification but Lite never bills.
 * Catalog-only: no bundled rows or automatic discovery that bypasses tiers. */
export class WatsonxProvider extends BaseProvider {
  readonly platform: Platform = 'watsonx';
  readonly name = 'IBM watsonx.ai';

  /** IAM tokens, keyed by SHA-256 of the API key (the raw key is never a map
   * key). Tokens live 1 hour; the 60s margin keeps a token from expiring
   * mid-request. */
  private readonly iamCache = new Map<string, IamToken>();
  /** In-flight exchanges, so concurrent callers sharing one key send one
   * exchange instead of one each. */
  private readonly iamInflight = new Map<string, Promise<IamToken>>();

  private clearIamToken(apiKey: string): void {
    this.iamCache.delete(createHash('sha256').update(apiKey).digest('hex'));
  }

  private async exchangeIamToken(apiKey: string): Promise<IamToken> {
    const res = await this.fetchWithTimeout(WATSONX_IAM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: `grant_type=${encodeURIComponent('urn:ibm:params:oauth:grant-type:apikey')}&apikey=${encodeURIComponent(apiKey)}`,
    }, providerTimeoutMs(this.platform, 30_000), { timeoutBounds: 'request' });
    if (!res.ok) {
      if ([400, 401, 403].includes(res.status)) {
        throw Object.assign(new Error('IBM Cloud rejected the watsonx.ai API key'), { status: 401 });
      }
      throw providerHttpError(res, `watsonx.ai IAM token exchange failed (HTTP ${res.status})`);
    }
    const data = await res.json().catch(() => null) as { access_token?: unknown; expires_in?: unknown } | null;
    if (typeof data?.access_token !== 'string' || data.access_token.length === 0) {
      throw providerHttpError(res, 'watsonx.ai IAM token exchange returned no access token');
    }
    const expiresIn = typeof data?.expires_in === 'number' && Number.isFinite(data.expires_in) && data.expires_in > 0
      ? data.expires_in : 3600;
    return { accessToken: data.access_token, expiresAtMs: Date.now() + expiresIn * 1000 };
  }

  /** Cached IAM token for this API key, exchanging once when missing or
   * about to expire. */
  private async iamToken(apiKey: string): Promise<string> {
    const cacheKey = createHash('sha256').update(apiKey).digest('hex');
    const cached = this.iamCache.get(cacheKey);
    if (cached && cached.expiresAtMs - Date.now() > 60_000) return cached.accessToken;
    const inFlight = this.iamInflight.get(cacheKey);
    if (inFlight) return (await inFlight).accessToken;
    const exchange = this.exchangeIamToken(apiKey);
    this.iamInflight.set(cacheKey, exchange);
    try {
      const token = await exchange;
      this.iamCache.set(cacheKey, token);
      return token.accessToken;
    } finally {
      if (this.iamInflight.get(cacheKey) === exchange) this.iamInflight.delete(cacheKey);
    }
  }

  private body(projectId: string, messages: ChatMessage[], modelId: string,
    options: CompletionOptions | undefined, stream: boolean): Record<string, unknown> {
    const toolChoice = options?.tool_choice;
    return {
      model_id: modelId,
      project_id: projectId,
      // watsonx message content is a string; flatten any structured parts.
      // Never replay router-only reasoning, signatures or routing fields.
      messages: messages.map(({ role, content, name, tool_calls, tool_call_id }) => ({
        role,
        content: contentToString(content),
        ...(name ? { name } : {}),
        ...(tool_calls ? { tool_calls } : {}),
        ...(tool_call_id ? { tool_call_id } : {}),
      })),
      ...(stream ? { stream: true } : {}),
      max_completion_tokens: resolveMaxTokens(this.platform, options?.max_tokens, options?.contextBudget),
      temperature: options?.temperature,
      top_p: options?.top_p,
      stop: typeof options?.stop === 'string' ? [options.stop] : options?.stop,
      presence_penalty: options?.presence_penalty,
      frequency_penalty: options?.frequency_penalty,
      logit_bias: options?.logit_bias,
      seed: options?.seed,
      reasoning_effort: options?.reasoning_effort,
      tools: options?.tools,
      // watsonx takes a string choice as `tool_choice_option` and a pinned
      // function as `tool_choice`; never send both.
      ...(typeof toolChoice === 'string'
        ? { tool_choice_option: toolChoice }
        : toolChoice ? { tool_choice: toolChoice } : {}),
      ...(options?.response_format ? { response_format: options.response_format } : {}),
    };
  }

  private async request(creds: WatsonxCredentials, baseUrl: string, token: string, messages: ChatMessage[], modelId: string,
    options: CompletionOptions | undefined, stream: boolean, quotaContext?: QuotaObservationContext): Promise<Response> {
    const path = stream ? '/ml/v1/text/chat_stream' : '/ml/v1/text/chat';
    const res = await this.fetchWithTimeout(`${baseUrl}${path}?version=${WATSONX_API_VERSION}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(this.body(creds.projectId, messages, modelId, options, stream)),
    }, options?.timeoutMs ?? providerTimeoutMs(this.platform, 60_000),
    { signal: options?.signal, timeoutBounds: stream ? 'headers' : 'request' });
    recordQuotaObservationsFromResponse(res, {
      ...quotaContext, platform: this.platform,
      endpoint: stream ? 'text/chat_stream' : 'text/chat', modelId,
    });
    if (!res.ok) throw providerHttpError(res, `watsonx.ai API error (HTTP ${res.status})`);
    return res;
  }

  /** One chat request, retrying once on a 401 with a fresh IAM token: a 401
   * can mean the cached token expired or was revoked server-side before its
   * expiry. An IAM failure itself (bad API key) throws once and is never
   * retried; a 401 from a wrong project_id fails the same way on the retry. */
  private async requestWithIamRetry(credential: string, messages: ChatMessage[], modelId: string,
    options: CompletionOptions | undefined, stream: boolean, quotaContext?: QuotaObservationContext): Promise<Response> {
    const creds = watsonxCredentials(credential);
    // Resolve the region up front so a misconfigured WATSONX_URL fails fast
    // instead of spending an IAM exchange first.
    const baseUrl = watsonxBaseUrl();
    const token = await this.iamToken(creds.apiKey);
    try {
      return await this.request(creds, baseUrl, token, messages, modelId, options, stream, quotaContext);
    } catch (err) {
      if ((err as { status?: unknown })?.status !== 401) throw err;
      this.clearIamToken(creds.apiKey);
      const fresh = await this.iamToken(creds.apiKey);
      return this.request(creds, baseUrl, fresh, messages, modelId, options, stream, quotaContext);
    }
  }

  /** Validates the IBM Cloud API key only (one IAM exchange, no quota spent).
   * The project_id is not checked here — it is validated by the first chat
   * call, which 401s/404s on an unknown project. */
  async validateKey(credential: string, _quotaContext?: QuotaObservationContext): Promise<KeyValidationResult> {
    let creds: WatsonxCredentials;
    try {
      creds = watsonxCredentials(credential);
    } catch {
      return { valid: false, error: 'watsonx.ai requires a project ID and IBM Cloud API key in project_id:api_key form' };
    }
    try {
      await this.iamToken(creds.apiKey);
      return true;
    } catch (err) {
      if ((err as { status?: unknown })?.status === 401) {
        return { valid: false, error: 'IBM Cloud rejected the watsonx.ai API key' };
      }
      throw err;
    }
  }

  async chatCompletion(credential: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): Promise<ChatCompletionResponse> {
    const res = await this.requestWithIamRetry(credential, messages, modelId, options, false, quotaContext);
    const data = await res.json() as WatsonxChatResponse;
    const returnedModel = data?.model_id ?? data?.model;
    if (returnedModel !== modelId) throw upstreamError('returned a different or missing model identity');
    const choice = data?.choices?.[0];
    const message = choice?.message;
    if (!message) throw upstreamError('returned an invalid or empty completion');
    // A tool-call response carries content: null; only a response with no
    // content, no tool calls and no reasoning is an empty completion.
    const content = typeof message.content === 'string' ? message.content : '';
    const reasoning = typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0
      ? message.reasoning_content
      : typeof message.reasoning === 'string' && message.reasoning.length > 0 ? message.reasoning : undefined;
    if (!content.length && !message.tool_calls?.length && !reasoning) {
      throw upstreamError('returned an invalid or empty completion');
    }
    const usage = data?.usage;
    return {
      id: typeof data?.id === 'string' && data.id ? data.id : this.makeId(),
      object: 'chat.completion',
      created: typeof data?.created === 'number' ? data.created : Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
        },
        finish_reason: typeof choice?.finish_reason === 'string' && choice.finish_reason ? choice.finish_reason : 'stop',
      }],
      usage: {
        prompt_tokens: asNonNegativeInt(usage?.prompt_tokens),
        completion_tokens: asNonNegativeInt(usage?.completion_tokens),
        total_tokens: asNonNegativeInt(usage?.total_tokens),
      },
      _routed_via: { platform: this.platform, model: modelId },
    };
  }

  async *streamChatCompletion(credential: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): AsyncGenerator<ChatCompletionChunk> {
    const res = await this.requestWithIamRetry(credential, messages, modelId, options, true, quotaContext);
    for await (const chunk of this.readSseStream(res, { firstByteTimeoutMs: options?.timeoutMs ?? providerTimeoutMs(this.platform, 60_000) })) {
      // watsonx stream events carry `model_id` (with `model` as a duplicate);
      // normalize to the requested model and reject a substituted identity.
      const raw = chunk as ChatCompletionChunk & { model_id?: unknown };
      const returnedModel = raw.model_id ?? raw.model;
      if (typeof returnedModel === 'string' && returnedModel.length > 0 && returnedModel !== modelId) {
        throw upstreamError('returned a different or missing model identity');
      }
      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta as { reasoning?: unknown; reasoning_content?: unknown } | undefined;
        if (delta && typeof delta.reasoning === 'string' && delta.reasoning.length > 0 &&
            typeof delta.reasoning_content !== 'string') {
          delta.reasoning_content = delta.reasoning;
        }
        if (delta) delete (delta as Record<string, unknown>).reasoning;
      }
      const { model_id: _modelId, ...rest } = raw;
      yield { ...rest, model: modelId };
    }
  }
}
