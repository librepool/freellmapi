import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionChunk } from '@librepool/shared/types.js';
import { MixlayerProvider, isMixlayerFreeModelId, MIXLAYER_FREE_MODEL } from '../../providers/mixlayer.js';
import { initDb, getDb } from '../../db/index.js';
import { detectPlatform } from '../../lib/key-parser.js';
import { BUILTIN_DISCOVERY_PLATFORMS } from '../../services/builtin-model-discovery.js';
import { isBuiltinDiscoveryEligible } from '../../services/builtin-model-discovery.js';

// NOTE: register() in providers/index.ts is coordinator wiring (shared file,
// not touched by this change), so these tests use `new MixlayerProvider()`
// directly instead of getProvider('mixlayer'); after wiring, getProvider
// returns the same singleton and the tests may be switched to that form.

const model = MIXLAYER_FREE_MODEL;
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const completion = (returned = model) => ({
  id: 'mixlayer-test', object: 'chat.completion', created: 1, model: returned,
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
});
const frame = (delta: Record<string, unknown>, returned = model, finish: string | null = null) => ({
  id: 'mixlayer-test', object: 'chat.completion.chunk', created: 1, model: returned,
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const stream = (...events: unknown[]) => new Response(
  events.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n',
  { headers: { 'Content-Type': 'text/event-stream' } },
);

beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

describe('Mixlayer provider', () => {
  it('reports its platform literal and leaves model discovery to the signed catalog', () => {
    const provider = new MixlayerProvider();
    expect(provider).toBeInstanceOf(MixlayerProvider);
    expect(provider.platform).toBe('mixlayer');
    expect(getDb().prepare("SELECT COUNT(*) n FROM models WHERE platform='mixlayer'").get()).toEqual({ n: 0 });
    expect(isBuiltinDiscoveryEligible(getDb(), 'mixlayer')).toBe(false);
    expect(BUILTIN_DISCOVERY_PLATFORMS).not.toContain('mixlayer');
    // No key prefix is published — keys are opaque, do not guess one.
    expect(detectPlatform('MIXLAYER_')).toBeNull();
  });

  it('guards free routes on the -free suffix, not a frozen list', () => {
    expect(isMixlayerFreeModelId('qwen/qwen3.5-4b-free')).toBe(true);
    expect(isMixlayerFreeModelId('qwen/qwen3.5-8b-free')).toBe(true);
    expect(isMixlayerFreeModelId('qwen/qwen3.5-4b')).toBe(false);
    expect(isMixlayerFreeModelId('deepseek-ai/DeepSeek-V4-Flash')).toBe(false);
  });

  it('validates a key against GET /v1/models, which requires one', async () => {
    const provider = new MixlayerProvider();
    expect(provider.supportsKeyValidation).toBe(true);
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ object: 'list', data: [{ id: model }] }));
    await expect(provider.validateKey('mixlayer-test')).resolves.toBe(true);
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { message: 'Invalid or missing API key' } }, 401));
    await expect(provider.validateKey('mixlayer-bad')).resolves.toMatchObject({ valid: false });
  });

  it('rejects paid routes before any fetch', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion()));
    await expect(new MixlayerProvider().chatCompletion('mixlayer-test', [], 'qwen/qwen3.5-4b'))
      .rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves auth, exact model, options, usage and routing attribution', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion()));
    const response = await new MixlayerProvider().chatCompletion('mixlayer-test',
      [{ role: 'user', content: 'OK' }], model, { max_tokens: 128, temperature: 0.2 });
    expect(fetch.mock.calls[0][0]).toBe('https://mixlayer.ai/v1/chat/completions');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer mixlayer-test');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model, max_tokens: 128, temperature: 0.2 });
    expect(response.choices[0].message.content).toBe('OK');
    expect(response.usage).toEqual(completion().usage);
    expect(response._routed_via).toEqual({ platform: 'mixlayer', model });
  });

  it('streams content with the requested model', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(
      frame({ content: 'OK' }),
      frame({}, model, 'stop'),
    ));
    const chunks: ChatCompletionChunk[] = [];
    for await (const chunk of new MixlayerProvider().streamChatCompletion('mixlayer-test', [], model)) chunks.push(chunk);
    expect(chunks).toHaveLength(2);
    expect(chunks.every(c => c.model === model)).toBe(true);
    expect(chunks[0].choices[0].delta.content).toBe('OK');
  });

  it.each(['other-model', undefined])('rejects mismatched or missing completion model (%s)', async returnedModel => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ ...completion(), model: returnedModel }));
    await expect(new MixlayerProvider().chatCompletion('mixlayer-test', [], model)).rejects.toMatchObject({ status: 502 });
  });

  it('rejects a substituted stream before yielding its content', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(frame({ content: 'OK' }, 'other-model')));
    const s = new MixlayerProvider().streamChatCompletion('mixlayer-test', [], model);
    await expect(s.next()).rejects.toMatchObject({ status: 502 });
  });

  it.each([402, 429, 503])('preserves upstream quota status and backoff without retry (%s)', async status => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: 'quota' }, status, { 'Retry-After': '15' }));
    await expect(new MixlayerProvider().chatCompletion('mixlayer-test', [], model)).rejects.toMatchObject({ status, retryAfterMs: 15_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
