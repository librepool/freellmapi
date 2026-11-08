import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionChunk } from '@librepool/shared/types.js';
import { TokenHarborProvider, isTokenHarborFreeModelId } from '../../providers/tokenharbor.js';
import { initDb, getDb } from '../../db/index.js';
import { getProvider } from '../../providers/index.js';
import { AUTH_JSON_PROVIDER_MAP, detectPlatform, parseKeysFromFile } from '../../lib/key-parser.js';
import { BUILTIN_DISCOVERY_PLATFORMS } from '../../services/builtin-model-discovery.js';
import { isBuiltinDiscoveryEligible } from '../../services/builtin-model-discovery.js';

const model = 'deepseek-v4.1-flash:free';
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const completion = (returned = model) => ({
  id: 'tokenharbor-test', object: 'chat.completion', created: 1, model: returned,
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
});
const frame = (delta: Record<string, unknown>, returned = model, finish: string | null = null) => ({
  id: 'tokenharbor-test', object: 'chat.completion.chunk', created: 1, model: returned,
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const stream = (...events: unknown[]) => new Response(
  events.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n',
  { headers: { 'Content-Type': 'text/event-stream' } },
);

beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

describe('Token Harbor provider', () => {
  // Wiring contract for the coordinator: platform literal, key prefix and
  // auth-JSON map live in shared files (shared/types.ts,
  // server/src/lib/key-parser.ts, server/src/providers/index.ts) that this
  // batch does not edit. This test passes once those are wired; the
  // behavioral tests below run standalone against the adapter class.
  it('registers, imports keys and leaves model discovery to the signed catalog', () => {
    expect(getProvider('tokenharbor')).toBeInstanceOf(TokenHarborProvider);
    expect(getDb().prepare("SELECT COUNT(*) n FROM models WHERE platform='tokenharbor'").get()).toEqual({ n: 0 });
    expect(isBuiltinDiscoveryEligible(getDb(), 'tokenharbor')).toBe(false);
    expect(BUILTIN_DISCOVERY_PLATFORMS).not.toContain('tokenharbor');
    expect(detectPlatform('TOKEN_HARBOR_')).toBe('tokenharbor');
    expect(detectPlatform('THK_LIVE_')).toBe('tokenharbor');
    expect(AUTH_JSON_PROVIDER_MAP.tokenharbor).toBe('tokenharbor');
    expect(AUTH_JSON_PROVIDER_MAP['token-harbor']).toBe('tokenharbor');
    expect(parseKeysFromFile('TOKEN_HARBOR_API_KEY=thk_live_test-not-a-real-key', 'keys.env').keys[0].platform).toBe('tokenharbor');
  });

  it('guards free routes on the :free suffix, not a frozen list', () => {
    expect(isTokenHarborFreeModelId('deepseek-v4.1-flash:free')).toBe(true);
    expect(isTokenHarborFreeModelId('mimo-v2.6-flash:free')).toBe(true);
    expect(isTokenHarborFreeModelId('deepseek-v4.1-flash')).toBe(false);
    expect(isTokenHarborFreeModelId('claude-opus-5.5')).toBe(false);
    // Zero price alone does not mean free: th-orchestra reports $0 but 402s.
    expect(isTokenHarborFreeModelId('th-orchestra')).toBe(false);
  });

  it('validates a key against GET /v1/models, which requires auth', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce(json({ data: [] }));
    await expect(new TokenHarborProvider().validateKey('thk_live_test')).resolves.toBe(true);
    expect(fetch.mock.calls[0][0]).toBe('https://tokenharbor.ai/v1/models');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer thk_live_test');
  });

  it('reports an invalid key from the validation call', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(json({ error: { message: 'No valid API key found.', type: 'invalid_api_key', code: 'invalid_api_key' } }, 401));
    await expect(new TokenHarborProvider().validateKey('thk_live_bad')).resolves.toMatchObject({ valid: false });
  });

  it('rejects paid routes before any fetch', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion()));
    await expect(new TokenHarborProvider().chatCompletion('thk_live_test', [], 'deepseek-v4.1-flash'))
      .rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves auth, exact model, options, usage and routing attribution', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion()));
    const response = await new TokenHarborProvider().chatCompletion('thk_live_test',
      [{ role: 'user', content: 'OK' }], model, { max_tokens: 128, temperature: 0.2 });
    expect(fetch.mock.calls[0][0]).toBe('https://tokenharbor.ai/v1/chat/completions');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer thk_live_test');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model, max_tokens: 128, temperature: 0.2 });
    expect(response.choices[0].message.content).toBe('OK');
    expect(response.usage).toEqual(completion().usage);
    expect(response._routed_via).toEqual({ platform: 'tokenharbor', model });
  });

  it('streams content with the requested model', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(
      frame({ content: 'OK' }),
      frame({}, model, 'stop'),
    ));
    const chunks: ChatCompletionChunk[] = [];
    for await (const chunk of new TokenHarborProvider().streamChatCompletion('thk_live_test', [], model)) chunks.push(chunk);
    expect(chunks).toHaveLength(2);
    expect(chunks.every(c => c.model === model)).toBe(true);
    expect(chunks[0].choices[0].delta.content).toBe('OK');
  });

  it.each(['other-model', undefined])('rejects mismatched or missing completion model (%s)', async returnedModel => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ ...completion(), model: returnedModel }));
    await expect(new TokenHarborProvider().chatCompletion('thk_live_test', [], model)).rejects.toMatchObject({ status: 502 });
  });

  it('rejects a substituted stream before yielding its content', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(frame({ content: 'OK' }, 'other-model')));
    const s = new TokenHarborProvider().streamChatCompletion('thk_live_test', [], model);
    await expect(s.next()).rejects.toMatchObject({ status: 502 });
  });

  it.each([402, 429, 503])('preserves upstream quota status and backoff without retry (%s)', async status => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: 'quota' }, status, { 'Retry-After': '15' }));
    await expect(new TokenHarborProvider().chatCompletion('thk_live_test', [], model)).rejects.toMatchObject({ status, retryAfterMs: 15_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
