import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionChunk } from '@librepool/shared/types.js';
import { ArliProvider, ARLI_FREE_MODEL } from '../../providers/arli.js';
import { initDb, getDb } from '../../db/index.js';
import { getProvider } from '../../providers/index.js';
import { AUTH_JSON_PROVIDER_MAP, detectPlatform, parseKeysFromFile } from '../../lib/key-parser.js';
import { BUILTIN_DISCOVERY_PLATFORMS } from '../../services/builtin-model-discovery.js';
import { isBuiltinDiscoveryEligible } from '../../services/builtin-model-discovery.js';

const model = ARLI_FREE_MODEL;
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const completion = (returned = model) => ({
  id: 'arli-test', object: 'chat.completion', created: 1, model: returned,
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
});
const frame = (delta: Record<string, unknown>, returned = model, finish: string | null = null) => ({
  id: 'arli-test', object: 'chat.completion.chunk', created: 1, model: returned,
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const stream = (...events: unknown[]) => new Response(
  events.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n',
  { headers: { 'Content-Type': 'text/event-stream' } },
);

beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

describe('Arli AI provider', () => {
  it('registers, imports keys and leaves model discovery to the signed catalog', () => {
    expect(getProvider('arli')).toBeInstanceOf(ArliProvider);
    expect(getDb().prepare("SELECT COUNT(*) n FROM models WHERE platform='arli'").get()).toEqual({ n: 0 });
    expect(isBuiltinDiscoveryEligible(getDb(), 'arli')).toBe(false);
    expect(BUILTIN_DISCOVERY_PLATFORMS).not.toContain('arli');
    expect(detectPlatform('ARLIAI_')).toBe('arli');
    expect(detectPlatform('ARLI_AI_')).toBe('arli');
    expect(AUTH_JSON_PROVIDER_MAP.arli).toBe('arli');
    expect(parseKeysFromFile('ARLIAI_API_KEY=arli-test-not-a-real-key', 'keys.env').keys[0].platform).toBe('arli');
  });

  it('validates via GET /v1/models, which requires a Bearer key', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce(json({ object: 'list', data: [] }));
    await expect(new ArliProvider().validateKey('arli-test')).resolves.toBe(true);
    expect(fetch.mock.calls[0][0]).toBe('https://api.arliai.com/v1/models');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer arli-test');
  });

  it('reports an invalid key from /v1/models', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(json({ message: 'Authorization header missing or invalid' }, 401));
    await expect(new ArliProvider().validateKey('arli-bad')).resolves.toMatchObject({ valid: false });
  });

  it('rejects trial models before any fetch: only the permanent free model is served', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion()));
    await expect(new ArliProvider().chatCompletion('arli-test', [], 'Qwen3.8-27B'))
      .rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves auth, exact model, options, usage and routing attribution', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion()));
    const response = await getProvider('arli')!.chatCompletion('arli-test',
      [{ role: 'user', content: 'OK' }], model, { max_tokens: 128, temperature: 0.2 });
    expect(fetch.mock.calls[0][0]).toBe('https://api.arliai.com/v1/chat/completions');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer arli-test');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model, max_tokens: 128, temperature: 0.2 });
    expect(response.choices[0].message.content).toBe('OK');
    expect(response.usage).toEqual(completion().usage);
    expect(response._routed_via).toEqual({ platform: 'arli', model });
  });

  it('streams content with the requested model', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(
      frame({ content: 'OK' }),
      frame({}, model, 'stop'),
    ));
    const chunks: ChatCompletionChunk[] = [];
    for await (const chunk of getProvider('arli')!.streamChatCompletion('arli-test', [], model)) chunks.push(chunk);
    expect(chunks).toHaveLength(2);
    expect(chunks.every(c => c.model === model)).toBe(true);
    expect(chunks[0].choices[0].delta.content).toBe('OK');
  });

  it.each(['other-model', undefined])('rejects mismatched or missing completion model (%s)', async returnedModel => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ ...completion(), model: returnedModel }));
    await expect(getProvider('arli')!.chatCompletion('arli-test', [], model)).rejects.toMatchObject({ status: 502 });
  });

  it('rejects a substituted stream before yielding its content', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(frame({ content: 'OK' }, 'other-model')));
    const s = getProvider('arli')!.streamChatCompletion('arli-test', [], model);
    await expect(s.next()).rejects.toMatchObject({ status: 502 });
  });

  it.each([402, 429, 503])('preserves upstream quota status and backoff without retry (%s)', async status => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: 'quota' }, status, { 'Retry-After': '15' }));
    await expect(new ArliProvider().chatCompletion('arli-test', [], model)).rejects.toMatchObject({ status, retryAfterMs: 15_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
