import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionChunk } from '@librepool/shared/types.js';
import { AIHubMixProvider, isAihubmixFreeModelId } from '../../providers/aihubmix.js';
import { initDb, getDb } from '../../db/index.js';
import { getProvider } from '../../providers/index.js';
import { AUTH_JSON_PROVIDER_MAP, detectPlatform, parseKeysFromFile } from '../../lib/key-parser.js';
import { BUILTIN_DISCOVERY_PLATFORMS } from '../../services/builtin-model-discovery.js';
import { isBuiltinDiscoveryEligible } from '../../services/builtin-model-discovery.js';

const model = 'glm-4.7-flash-free';
const colonModel = 'meta-llama/llama-3.1-8b-instruct:free';
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const completion = (returned = model) => ({
  id: 'aihubmix-test', object: 'chat.completion', created: 1, model: returned,
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
});
const frame = (content: string, returned = model, finish: string | null = null) => ({
  id: 'aihubmix-test', object: 'chat.completion.chunk', created: 1, model: returned,
  choices: [{ index: 0, delta: { content }, finish_reason: finish }],
});
const stream = (...events: unknown[]) => new Response(
  events.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n',
  { headers: { 'Content-Type': 'text/event-stream' } },
);

beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

describe('AIHubMix provider', () => {
  it('registers, imports keys and leaves model discovery to the signed catalog', () => {
    expect(getProvider('aihubmix')).toBeInstanceOf(AIHubMixProvider);
    expect(getDb().prepare("SELECT COUNT(*) n FROM models WHERE platform='aihubmix'").get()).toEqual({ n: 0 });
    expect(isBuiltinDiscoveryEligible(getDb(), 'aihubmix')).toBe(false);
    expect(BUILTIN_DISCOVERY_PLATFORMS).not.toContain('aihubmix');
    expect(detectPlatform('AIHUBMIX_')).toBe('aihubmix');
    expect(AUTH_JSON_PROVIDER_MAP.aihubmix).toBe('aihubmix');
    expect(parseKeysFromFile('AIHUBMIX_API_KEY=aihubmix-test-not-a-real-key', 'keys.env').keys[0].platform).toBe('aihubmix');
  });

  it('does not burn quota or mistake the public roster for credential validation', async () => {
    const fetch = vi.spyOn(global, 'fetch');
    const p = new AIHubMixProvider();
    expect(p.supportsKeyValidation).toBe(false);
    await expect(p.validateKey('test')).rejects.toThrow('unknown');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([model, colonModel])('accepts the free-suffixed route %s in both modes', async requested => {
    const fetch = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(json(completion(requested)))
      .mockResolvedValueOnce(stream(frame('OK', requested), frame('', requested, 'stop')));
    const p = new AIHubMixProvider();
    expect(isAihubmixFreeModelId(requested)).toBe(true);
    expect((await p.chatCompletion('test-key', [], requested, { max_tokens: 32 })).model).toBe(requested);
    const chunks: ChatCompletionChunk[] = [];
    for await (const chunk of p.streamChatCompletion('test-key', [], requested)) chunks.push(chunk);
    expect(chunks).toHaveLength(2);
    expect(chunks.every(c => c.model === requested)).toBe(true);
    expect(fetch.mock.calls[0][0]).toBe('https://aihubmix.com/v1/chat/completions');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer test-key');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model: requested, max_tokens: 32 });
  });

  it.each(['gpt-4.1', 'qwen3.8-max', 'glm-4.7-flash', ''])('rejects non-free route %s before any fetch', async paid => {
    const fetch = vi.spyOn(global, 'fetch');
    const p = new AIHubMixProvider();
    expect(isAihubmixFreeModelId(paid)).toBe(false);
    await expect(p.chatCompletion('test-key', [], paid)).rejects.toMatchObject({ status: 400 });
    await expect(p.streamChatCompletion('test-key', [], paid).next()).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['other-model', undefined])('rejects mismatched or missing completion model (%s)', async returnedModel => {
    // Override after the spread: passing undefined to the helper would hit
    // its default parameter, and JSON.stringify drops the undefined key, so
    // the `undefined` case is the missing-identity case.
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ ...completion(), model: returnedModel }));
    await expect(getProvider('aihubmix')!.chatCompletion('test-key', [], model)).rejects.toMatchObject({ status: 502 });
  });

  it('rejects a substituted stream before yielding its content', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(frame('OK', 'other-model')));
    const s = getProvider('aihubmix')!.streamChatCompletion('test-key', [], model);
    await expect(s.next()).rejects.toMatchObject({ status: 502 });
  });

  it.each([402, 429])('preserves upstream quota status and backoff without retry (%s)', async status => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: 'quota' }, status, { 'Retry-After': '30' }));
    await expect(new AIHubMixProvider().chatCompletion('test-key', [], model)).rejects.toMatchObject({ status, retryAfterMs: 30_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
