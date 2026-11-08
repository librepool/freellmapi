import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionChunk } from '@librepool/shared/types.js';
import { ZroProvider, isZroFreeModelId, canonicalZroModelId } from '../../providers/zro.js';
import { initDb, getDb } from '../../db/index.js';
import { getProvider } from '../../providers/index.js';
import { AUTH_JSON_PROVIDER_MAP, detectPlatform, parseKeysFromFile } from '../../lib/key-parser.js';
import { BUILTIN_DISCOVERY_PLATFORMS } from '../../services/builtin-model-discovery.js';
import { isBuiltinDiscoveryEligible } from '../../services/builtin-model-discovery.js';

const model = 'deepseek-v4.1-flash';
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const completion = (returned = model) => ({
  id: 'zro-test', object: 'chat.completion', created: 1, model: returned,
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
});
const frame = (delta: Record<string, unknown>, returned = model, finish: string | null = null) => ({
  id: 'zro-test', object: 'chat.completion.chunk', created: 1, model: returned,
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const stream = (...events: unknown[]) => new Response(
  events.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n',
  { headers: { 'Content-Type': 'text/event-stream' } },
);

beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

describe('Zro provider', () => {
  it('registers, imports keys and leaves model discovery to the signed catalog', () => {
    expect(getProvider('zro')).toBeInstanceOf(ZroProvider);
    expect(getDb().prepare("SELECT COUNT(*) n FROM models WHERE platform='zro'").get()).toEqual({ n: 0 });
    expect(isBuiltinDiscoveryEligible(getDb(), 'zro')).toBe(false);
    expect(BUILTIN_DISCOVERY_PLATFORMS).not.toContain('zro');
    // Keys start with the generic `sk-` (shared with OpenAI/MegaNova), so
    // there is no key-prefix detection; `ZRO_` matches the documented
    // `ZRO_API_KEY` env var instead.
    expect(detectPlatform('ZRO_')).toBe('zro');
    expect(detectPlatform('SK-')).toBeNull();
    expect(AUTH_JSON_PROVIDER_MAP.zro).toBe('zro');
    expect(AUTH_JSON_PROVIDER_MAP.moonmath).toBe('zro');
    expect(parseKeysFromFile('ZRO_API_KEY=zro-test-not-a-real-key', 'keys.env').keys[0].platform).toBe('zro');
  });

  it('guards the two named Free-plan models, including the zro/ alias', () => {
    expect(isZroFreeModelId('deepseek-v4.1-flash')).toBe(true);
    expect(isZroFreeModelId('glm-5.3-flash')).toBe(true);
    expect(isZroFreeModelId('zro/deepseek-v4.1-flash')).toBe(true);
    expect(isZroFreeModelId('zro/glm-5.3-flash')).toBe(true);
    expect(canonicalZroModelId('zro/glm-5.3-flash')).toBe('glm-5.3-flash');
    expect(canonicalZroModelId('glm-5.3-flash')).toBe('glm-5.3-flash');
    expect(isZroFreeModelId('glm-5.3')).toBe(false);
    expect(isZroFreeModelId('dolly1-security')).toBe(false);
    expect(isZroFreeModelId('dolly2-security')).toBe(false);
    expect(isZroFreeModelId('abyss1')).toBe(false);
    expect(isZroFreeModelId('auto')).toBe(false);
  });

  it('validates a key against the key-gated /v1/models (default validation)', async () => {
    expect(getProvider('zro')!.supportsKeyValidation).toBe(true);
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ data: [] }));
    await expect(new ZroProvider().validateKey('zro-test')).resolves.toBe(true);
  });

  it('rejects paid routes before any fetch', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion()));
    await expect(new ZroProvider().chatCompletion('zro-test', [], 'glm-5.3'))
      .rejects.toMatchObject({ status: 400 });
    await expect(new ZroProvider().chatCompletion('zro-test', [], 'auto'))
      .rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves auth, exact model, options, usage and routing attribution', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion()));
    const response = await getProvider('zro')!.chatCompletion('zro-test',
      [{ role: 'user', content: 'OK' }], model, { max_tokens: 128, temperature: 0.2 });
    expect(fetch.mock.calls[0][0]).toBe('https://zro.moonmath.ai/v1/chat/completions');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer zro-test');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model, max_tokens: 128, temperature: 0.2 });
    expect(response.choices[0].message.content).toBe('OK');
    expect(response.usage).toEqual(completion().usage);
    expect(response._routed_via).toEqual({ platform: 'zro', model });
  });

  it('streams content with the requested model', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(
      frame({ content: 'OK' }),
      frame({}, model, 'stop'),
    ));
    const chunks: ChatCompletionChunk[] = [];
    for await (const chunk of getProvider('zro')!.streamChatCompletion('zro-test', [], model)) chunks.push(chunk);
    expect(chunks).toHaveLength(2);
    expect(chunks.every(c => c.model === model)).toBe(true);
    expect(chunks[0].choices[0].delta.content).toBe('OK');
  });

  it('accepts the canonical id when the request used the zro/ alias', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json(completion('glm-5.3-flash')));
    const response = await new ZroProvider().chatCompletion('zro-test', [], 'zro/glm-5.3-flash');
    expect(response.choices[0].message.content).toBe('OK');
  });

  it.each(['other-model', undefined])('rejects mismatched or missing completion model (%s)', async returnedModel => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ ...completion(), model: returnedModel }));
    await expect(new ZroProvider().chatCompletion('zro-test', [], model)).rejects.toMatchObject({ status: 502 });
  });

  it('rejects a substituted stream before yielding its content', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(frame({ content: 'OK' }, 'other-model')));
    const s = getProvider('zro')!.streamChatCompletion('zro-test', [], model);
    await expect(s.next()).rejects.toMatchObject({ status: 502 });
  });

  it.each([402, 429, 503])('preserves upstream quota status and backoff without retry (%s)', async status => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: 'quota' }, status, { 'Retry-After': '15' }));
    await expect(new ZroProvider().chatCompletion('zro-test', [], model)).rejects.toMatchObject({ status, retryAfterMs: 15_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
