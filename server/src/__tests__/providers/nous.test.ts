import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionChunk } from '@librepool/shared/types.js';
import { NousProvider, isNousFreeModelId } from '../../providers/nous.js';
import { initDb, getDb } from '../../db/index.js';
import { getProvider } from '../../providers/index.js';
import { AUTH_JSON_PROVIDER_MAP, detectPlatform, parseKeysFromFile } from '../../lib/key-parser.js';
import { BUILTIN_DISCOVERY_PLATFORMS } from '../../services/builtin-model-discovery.js';
import { isBuiltinDiscoveryEligible } from '../../services/builtin-model-discovery.js';

const model = 'stepfun/step-3.7-flash:free';
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const completion = (returned = model) => ({
  id: 'nous-test', object: 'chat.completion', created: 1, model: returned,
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
});
const frame = (delta: Record<string, unknown>, returned = model, finish: string | null = null) => ({
  id: 'nous-test', object: 'chat.completion.chunk', created: 1, model: returned,
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const stream = (...events: unknown[]) => new Response(
  events.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n',
  { headers: { 'Content-Type': 'text/event-stream' } },
);

beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

describe('Nous Portal provider', () => {
  it('registers, imports keys and leaves model discovery to the signed catalog', () => {
    expect(getProvider('nous')).toBeInstanceOf(NousProvider);
    expect(getDb().prepare("SELECT COUNT(*) n FROM models WHERE platform='nous'").get()).toEqual({ n: 0 });
    expect(isBuiltinDiscoveryEligible(getDb(), 'nous')).toBe(false);
    expect(BUILTIN_DISCOVERY_PLATFORMS).not.toContain('nous');
    expect(detectPlatform('NOUS_PORTAL_')).toBe('nous');
    expect(detectPlatform('NOUS_')).toBe('nous');
    expect(AUTH_JSON_PROVIDER_MAP.nous).toBe('nous');
    expect(AUTH_JSON_PROVIDER_MAP.nousportal).toBe('nous');
    expect(parseKeysFromFile('NOUS_PORTAL_API_KEY=nous-test-not-a-real-key', 'keys.env').keys[0].platform).toBe('nous');
  });

  it('guards free routes on the :free suffix, not a frozen list', () => {
    expect(isNousFreeModelId('stepfun/step-3.7-flash:free')).toBe(true);
    expect(isNousFreeModelId('upstage/solar-mini4:free')).toBe(true);
    expect(isNousFreeModelId('Hermes-4-70B')).toBe(false);
    expect(isNousFreeModelId('stepfun/step-3.7-flash')).toBe(false);
  });

  it('has no key-validation endpoint: the public /v1/models cannot check a credential', async () => {
    expect(getProvider('nous')!.supportsKeyValidation).toBe(false);
    await expect(new NousProvider().validateKey('nous-test')).rejects.toThrow(/no documented free credential-validation endpoint/);
  });

  it('rejects paid routes before any fetch', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion()));
    await expect(new NousProvider().chatCompletion('nous-test', [], 'Hermes-4-70B'))
      .rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves auth, exact model, options, usage and routing attribution', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion()));
    const response = await getProvider('nous')!.chatCompletion('nous-test',
      [{ role: 'user', content: 'OK' }], model, { max_tokens: 128, temperature: 0.2 });
    expect(fetch.mock.calls[0][0]).toBe('https://inference-api.nousresearch.com/v1/chat/completions');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer nous-test');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model, max_tokens: 128, temperature: 0.2 });
    expect(response.choices[0].message.content).toBe('OK');
    expect(response.usage).toEqual(completion().usage);
    expect(response._routed_via).toEqual({ platform: 'nous', model });
  });

  it('streams content with the requested model', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(
      frame({ content: 'OK' }),
      frame({}, model, 'stop'),
    ));
    const chunks: ChatCompletionChunk[] = [];
    for await (const chunk of getProvider('nous')!.streamChatCompletion('nous-test', [], model)) chunks.push(chunk);
    expect(chunks).toHaveLength(2);
    expect(chunks.every(c => c.model === model)).toBe(true);
    expect(chunks[0].choices[0].delta.content).toBe('OK');
  });

  it.each(['other-model', undefined])('rejects mismatched or missing completion model (%s)', async returnedModel => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ ...completion(), model: returnedModel }));
    await expect(getProvider('nous')!.chatCompletion('nous-test', [], model)).rejects.toMatchObject({ status: 502 });
  });

  it('rejects a substituted stream before yielding its content', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(frame({ content: 'OK' }, 'other-model')));
    const s = getProvider('nous')!.streamChatCompletion('nous-test', [], model);
    await expect(s.next()).rejects.toMatchObject({ status: 502 });
  });

  it.each([402, 429, 503])('preserves upstream quota status and backoff without retry (%s)', async status => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: 'quota' }, status, { 'Retry-After': '15' }));
    await expect(new NousProvider().chatCompletion('nous-test', [], model)).rejects.toMatchObject({ status, retryAfterMs: 15_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
