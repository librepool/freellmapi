import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionChunk } from '@librepool/shared/types.js';
import { WatsonxProvider, watsonxCredentials, WATSONX_IAM_URL } from '../../providers/watsonx.js';
import { initDb, getDb } from '../../db/index.js';
import { getProvider } from '../../providers/index.js';
import { AUTH_JSON_PROVIDER_MAP, detectPlatform, parseKeysFromFile } from '../../lib/key-parser.js';
import { BUILTIN_DISCOVERY_PLATFORMS } from '../../services/builtin-model-discovery.js';
import { isBuiltinDiscoveryEligible } from '../../services/builtin-model-discovery.js';

const projectId = '11111111-2222-3333-4444-555555555555';
const apiKey = 'ibm-api-key-test-not-a-real-key';
const credential = `${projectId}:${apiKey}`;
const model = 'meta-llama/llama-3-1-8b-instruct';
const chatUrl = 'https://us-south.ml.cloud.ibm.com/ml/v1/text/chat?version=2024-10-07';
const streamUrl = 'https://us-south.ml.cloud.ibm.com/ml/v1/text/chat_stream?version=2024-10-07';

const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const iam = (token = 'iam-token-1') => json({ access_token: token, token_type: 'Bearer', expires_in: 3600 });
const completionBody = (returnedModel: unknown = model, content: unknown = 'OK') => ({
  id: 'watsonx-test', model_id: returnedModel, model: returnedModel, created: 1,
  choices: [{ index: 0, message: { role: 'assistant', content, reasoning_content: 'thinking' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
});
const completion = (returnedModel?: unknown, content?: unknown) => json(completionBody(returnedModel, content));
const sseFrame = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: 'watsonx-test', object: 'chat.completion.chunk', created: 1, model_id: model,
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const stream = (...events: unknown[]) => new Response(
  events.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n',
  { headers: { 'Content-Type': 'text/event-stream' } },
);

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  delete process.env.WATSONX_URL;
  initDb(':memory:');
});
afterEach(() => { vi.restoreAllMocks(); delete process.env.WATSONX_URL; getDb().close(); });

describe('IBM watsonx.ai provider', () => {
  it('registers, imports keys and leaves model discovery to the signed catalog', () => {
    expect(getProvider('watsonx')).toBeInstanceOf(WatsonxProvider);
    expect(getDb().prepare("SELECT COUNT(*) n FROM models WHERE platform='watsonx'").get()).toEqual({ n: 0 });
    expect(isBuiltinDiscoveryEligible(getDb(), 'watsonx')).toBe(false);
    expect(BUILTIN_DISCOVERY_PLATFORMS).not.toContain('watsonx');
    expect(detectPlatform('WATSONX_')).toBe('watsonx');
    expect(AUTH_JSON_PROVIDER_MAP.watsonx).toBe('watsonx');
    const parsed = parseKeysFromFile(`WATSONX_PROJECT_ID=${projectId}\nWATSONX_APIKEY=${apiKey}`, 'keys.env');
    expect(parsed.keys[0].platform).toBe('watsonx');
    expect(parsed.keys[0].rawKey).toBe(`WATSONX_APIKEY=${credential}`);
    // Region/auth metadata is never imported as a credential.
    expect(parseKeysFromFile('WATSONX_URL=https://eu-de.ml.cloud.ibm.com', 'keys.env').keys).toHaveLength(0);
    expect(parseKeysFromFile(`WATSONX_PROJECT_ID=${projectId}`, 'keys.env').keys).toHaveLength(0);
  });

  it('parses the project_id:api_key composite credential', () => {
    expect(watsonxCredentials(credential)).toEqual({ projectId, apiKey });
    expect(() => watsonxCredentials('no-colon')).toThrow(/project_id:api_key/);
    expect(() => watsonxCredentials(`${projectId}:`)).toThrow(/project_id:api_key/);
    expect(() => watsonxCredentials(`:${apiKey}`)).toThrow(/project_id:api_key/);
  });

  it('rejects a malformed credential before any fetch', async () => {
    const fetch = vi.spyOn(global, 'fetch');
    await expect(new WatsonxProvider().chatCompletion('no-colon', [], model)).rejects.toMatchObject({ status: 401 });
    await expect(new WatsonxProvider().validateKey('no-colon')).resolves.toMatchObject({ valid: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('validates the API key with one IAM exchange and no chat call', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce(iam());
    await expect(new WatsonxProvider().validateKey(credential)).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(WATSONX_IAM_URL);
    expect(fetch.mock.calls[0][1]?.method).toBe('POST');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('content-type')).toContain('application/x-www-form-urlencoded');
    const body = String(fetch.mock.calls[0][1]?.body);
    expect(body).toContain('grant_type=urn%3Aibm%3Aparams%3Aoauth%3Agrant-type%3Aapikey');
    expect(body).toContain(`apikey=${encodeURIComponent(apiKey)}`);
  });

  it('reports a rejected API key as invalid and other IAM failures as inconclusive', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(json({ error: 'invalid apikey' }, 400));
    await expect(new WatsonxProvider().validateKey(credential)).resolves.toMatchObject({ valid: false });
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(json({ error: 'boom' }, 500));
    await expect(new WatsonxProvider().validateKey(credential)).rejects.toMatchObject({ status: 500 });
  });

  it('exchanges the IAM token once and reuses it across calls', async () => {
    const fetch = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(iam())
      .mockResolvedValueOnce(completion())
      .mockResolvedValueOnce(completion());
    const p = new WatsonxProvider();
    await p.chatCompletion(credential, [], model);
    await p.chatCompletion(credential, [], model);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0][0]).toBe(WATSONX_IAM_URL);
    expect(new Headers(fetch.mock.calls[1][1]?.headers).get('authorization')).toBe('Bearer iam-token-1');
    expect(new Headers(fetch.mock.calls[2][1]?.headers).get('authorization')).toBe('Bearer iam-token-1');
  });

  it('preserves auth, native request shape, usage and routing attribution', async () => {
    const fetch = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(iam())
      .mockResolvedValueOnce(completion());
    const response = await getProvider('watsonx')!.chatCompletion(credential,
      [{ role: 'user', content: 'OK' }], model, { max_tokens: 128, temperature: 0.2 });
    expect(fetch.mock.calls[1][0]).toBe(chatUrl);
    expect(new Headers(fetch.mock.calls[1][1]?.headers).get('authorization')).toBe('Bearer iam-token-1');
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toMatchObject({
      model_id: model, project_id: projectId, max_completion_tokens: 128, temperature: 0.2,
      messages: [{ role: 'user', content: 'OK' }],
    });
    expect(response.model).toBe(model);
    expect(response.choices[0].message.content).toBe('OK');
    expect(response.choices[0].message.reasoning_content).toBe('thinking');
    expect(response.usage).toEqual({ prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });
    expect(response._routed_via).toEqual({ platform: 'watsonx', model });
  });

  it('accepts a tool-call response with null content', async () => {
    const toolCall = json({
      id: 'watsonx-test', model_id: model, created: 1,
      choices: [{ index: 0, message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] },
        finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    });
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(iam())
      .mockResolvedValueOnce(toolCall);
    const response = await new WatsonxProvider().chatCompletion(credential, [], model);
    expect(response.choices[0].finish_reason).toBe('tool_calls');
    expect(response.choices[0].message.tool_calls).toHaveLength(1);
  });

  it.each(['other-model', undefined])('rejects mismatched or missing model identity (%s)', async returnedModel => {
    // Override after the spread: passing undefined to the helper would hit
    // its default parameter, and JSON.stringify drops the undefined keys, so
    // the `undefined` case is the missing-identity case.
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(iam())
      .mockResolvedValueOnce(json({ ...completionBody(), model_id: returnedModel, model: returnedModel }));
    await expect(new WatsonxProvider().chatCompletion(credential, [], model)).rejects.toMatchObject({ status: 502 });
  });

  it('rejects an empty completion with no content, tools or reasoning', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(iam())
      .mockResolvedValueOnce(json({
        id: 'watsonx-test', model_id: model, created: 1,
        choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
      }));
    await expect(new WatsonxProvider().chatCompletion(credential, [], model)).rejects.toMatchObject({ status: 502 });
  });

  it('streams via chat_stream, normalizing model_id and reasoning deltas', async () => {
    const fetch = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(iam())
      .mockResolvedValueOnce(stream(
        sseFrame({ role: 'assistant' }),
        sseFrame({ reasoning: 'thinking' }),
        sseFrame({ content: 'OK' }, 'stop'),
      ));
    const chunks: ChatCompletionChunk[] = [];
    for await (const chunk of new WatsonxProvider().streamChatCompletion(credential, [], model)) chunks.push(chunk);
    expect(fetch.mock.calls[1][0]).toBe(streamUrl);
    expect(chunks).toHaveLength(3);
    expect(chunks.every(c => c.model === model)).toBe(true);
    expect(chunks[1].choices[0].delta.reasoning_content).toBe('thinking');
    expect(chunks[2].choices[0].delta.content).toBe('OK');
  });

  it('retries once on a stale-token 401 with a fresh IAM token', async () => {
    const fetch = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(iam('iam-token-1'))
      .mockResolvedValueOnce(json({ error: 'expired' }, 401))
      .mockResolvedValueOnce(iam('iam-token-2'))
      .mockResolvedValueOnce(completion());
    const response = await new WatsonxProvider().chatCompletion(credential, [], model);
    expect(response.choices[0].message.content).toBe('OK');
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(new Headers(fetch.mock.calls[1][1]?.headers).get('authorization')).toBe('Bearer iam-token-1');
    expect(new Headers(fetch.mock.calls[3][1]?.headers).get('authorization')).toBe('Bearer iam-token-2');
  });

  it('honors WATSONX_URL for the region, stripping a trailing slash', async () => {
    process.env.WATSONX_URL = 'https://eu-de.ml.cloud.ibm.com/';
    const fetch = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(iam())
      .mockResolvedValueOnce(completion());
    await new WatsonxProvider().chatCompletion(credential, [], model);
    expect(fetch.mock.calls[1][0]).toBe('https://eu-de.ml.cloud.ibm.com/ml/v1/text/chat?version=2024-10-07');
  });

  it('fails fast on a malformed WATSONX_URL without spending an IAM exchange', async () => {
    process.env.WATSONX_URL = 'http://not-https.example.com';
    const fetch = vi.spyOn(global, 'fetch');
    await expect(new WatsonxProvider().chatCompletion(credential, [], model)).rejects.toMatchObject({ status: 500 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
