import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionChunk } from '@librepool/shared/types.js';
import { GonkaProvider } from '../../providers/gonka.js';
import { initDb, getDb } from '../../db/index.js';
import { getProvider } from '../../providers/index.js';
import { AUTH_JSON_PROVIDER_MAP, detectPlatform, parseKeysFromFile } from '../../lib/key-parser.js';
import { BUILTIN_DISCOVERY_PLATFORMS } from '../../services/builtin-model-discovery.js';
import { isBuiltinDiscoveryEligible } from '../../services/builtin-model-discovery.js';

const model = 'deepseek-ai/DeepSeek-V4-Flash-0731';
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const completion = (returned = model) => ({
  id: 'gonka-test', object: 'chat.completion', created: 1, model: returned,
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK', reasoning: 'thinking' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
});
const frame = (delta: Record<string, unknown>, returned = model, finish: string | null = null) => ({
  id: 'gonka-test', object: 'chat.completion.chunk', created: 1, model: returned,
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const stream = (...events: unknown[]) => new Response(
  events.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n',
  { headers: { 'Content-Type': 'text/event-stream' } },
);

beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

describe('Gonka Broker provider', () => {
  it('registers, imports keys and leaves model discovery to the signed catalog', () => {
    expect(getProvider('gonka')).toBeInstanceOf(GonkaProvider);
    expect(getDb().prepare("SELECT COUNT(*) n FROM models WHERE platform='gonka'").get()).toEqual({ n: 0 });
    expect(isBuiltinDiscoveryEligible(getDb(), 'gonka')).toBe(false);
    expect(BUILTIN_DISCOVERY_PLATFORMS).not.toContain('gonka');
    expect(detectPlatform('GONKA_')).toBe('gonka');
    expect(AUTH_JSON_PROVIDER_MAP.gonka).toBe('gonka');
    expect(parseKeysFromFile('GONKA_API_KEY=gnk-prx-test-not-a-real-key', 'keys.env').keys[0].platform).toBe('gonka');
  });

  it('validates via GET /test-auth, the endpoint that returns key status', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce(json({ status: 'ok', rate_limit: {} }));
    await expect(new GonkaProvider().validateKey('gnk-prx-test')).resolves.toBe(true);
    expect(fetch.mock.calls[0][0]).toBe('https://proxy.gonkabroker.com/v1/test-auth');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer gnk-prx-test');
  });

  it('reports an invalid key from /test-auth', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(json({ error: { message: 'Invalid API key' } }, 401));
    await expect(new GonkaProvider().validateKey('gnk-prx-bad')).resolves.toMatchObject({ valid: false });
  });

  it('preserves auth, exact model, options, usage and routing attribution', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion()));
    const response = await getProvider('gonka')!.chatCompletion('gnk-prx-test',
      [{ role: 'user', content: 'OK' }], model, { max_tokens: 128, temperature: 0.2 });
    expect(fetch.mock.calls[0][0]).toBe('https://proxy.gonkabroker.com/v1/chat/completions');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer gnk-prx-test');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model, max_tokens: 128, temperature: 0.2 });
    expect(response.choices[0].message.content).toBe('OK');
    expect(response.usage).toEqual(completion().usage);
    expect(response._routed_via).toEqual({ platform: 'gonka', model });
  });

  it('maps the dedicated reasoning field onto reasoning_content', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json(completion()));
    const response = await getProvider('gonka')!.chatCompletion('gnk-prx-test', [], model);
    expect(response.choices[0].message.reasoning_content).toBe('thinking');
    expect((response.choices[0].message as Record<string, unknown>).reasoning).toBeUndefined();
  });

  it('streams reasoning deltas as reasoning_content with the requested model', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(
      frame({ reasoning: 'thinking' }),
      frame({ content: 'OK' }),
      frame({}, model, 'stop'),
    ));
    const chunks: ChatCompletionChunk[] = [];
    for await (const chunk of getProvider('gonka')!.streamChatCompletion('gnk-prx-test', [], model)) chunks.push(chunk);
    expect(chunks).toHaveLength(3);
    expect(chunks.every(c => c.model === model)).toBe(true);
    expect(chunks[0].choices[0].delta.reasoning_content).toBe('thinking');
    expect(chunks[1].choices[0].delta.content).toBe('OK');
  });

  it.each(['other-model', undefined])('rejects mismatched or missing completion model (%s)', async returnedModel => {
    // Override after the spread: passing undefined to the helper would hit
    // its default parameter, and JSON.stringify drops the undefined key, so
    // the `undefined` case is the missing-identity case.
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ ...completion(), model: returnedModel }));
    await expect(getProvider('gonka')!.chatCompletion('gnk-prx-test', [], model)).rejects.toMatchObject({ status: 502 });
  });

  it('rejects a substituted stream before yielding its content', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(frame({ content: 'OK' }, 'other-model')));
    const s = getProvider('gonka')!.streamChatCompletion('gnk-prx-test', [], model);
    await expect(s.next()).rejects.toMatchObject({ status: 502 });
  });

  it.each([402, 429, 503])('preserves upstream quota status and backoff without retry (%s)', async status => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: 'quota' }, status, { 'Retry-After': '15' }));
    await expect(new GonkaProvider().chatCompletion('gnk-prx-test', [], model)).rejects.toMatchObject({ status, retryAfterMs: 15_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
