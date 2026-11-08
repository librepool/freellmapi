import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionChunk } from '@librepool/shared/types.js';
import { LlmkiwiProvider } from '../../providers/llmkiwi.js';
import { initDb, getDb } from '../../db/index.js';
import { getProvider } from '../../providers/index.js';
import { AUTH_JSON_PROVIDER_MAP, detectPlatform, parseKeysFromFile } from '../../lib/key-parser.js';
import { BUILTIN_DISCOVERY_PLATFORMS } from '../../services/builtin-model-discovery.js';
import { isBuiltinDiscoveryEligible } from '../../services/builtin-model-discovery.js';

const model = 'minimax-m3';
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const completion = (returned = model) => ({
  id: 'llmkiwi-test', object: 'chat.completion', created: 1, model: returned,
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
});
const frame = (delta: Record<string, unknown>, returned = model, finish: string | null = null) => ({
  id: 'llmkiwi-test', object: 'chat.completion.chunk', created: 1, model: returned,
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const stream = (...events: unknown[]) => new Response(
  events.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n',
  { headers: { 'Content-Type': 'text/event-stream' } },
);

beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

describe('LLM.kiwi provider', () => {
  it('registers, imports keys and leaves model discovery to the signed catalog', () => {
    expect(getProvider('llmkiwi')).toBeInstanceOf(LlmkiwiProvider);
    expect(getDb().prepare("SELECT COUNT(*) n FROM models WHERE platform='llmkiwi'").get()).toEqual({ n: 0 });
    expect(isBuiltinDiscoveryEligible(getDb(), 'llmkiwi')).toBe(false);
    expect(BUILTIN_DISCOVERY_PLATFORMS).not.toContain('llmkiwi');
    expect(detectPlatform('LLM_KIWI_')).toBe('llmkiwi');
    expect(AUTH_JSON_PROVIDER_MAP.llmkiwi).toBe('llmkiwi');
    expect(AUTH_JSON_PROVIDER_MAP['llm.kiwi']).toBe('llmkiwi');
    expect(parseKeysFromFile('LLM_KIWI_API_KEY=sk_kiwi_test-not-a-real-key', 'keys.env').keys[0].platform).toBe('llmkiwi');
  });

  it('validates via a minimal chat call: /v1/models is public and cannot check a key', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce(json(completion('auto')));
    await expect(new LlmkiwiProvider().validateKey('sk_kiwi_test')).resolves.toBe(true);
    expect(fetch.mock.calls[0][0]).toBe('https://api.llm.kiwi/v1/chat/completions');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer sk_kiwi_test');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model: 'auto', max_tokens: 1, stream: false });
  });

  it('reports an invalid key from the validation call', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(json({ error: { code: 'invalid_api_key', message: 'Invalid or revoked API key.' } }, 401));
    await expect(new LlmkiwiProvider().validateKey('sk_kiwi_bad')).resolves.toMatchObject({ valid: false });
  });

  it('rejects models outside the live public catalog before any fetch', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion()));
    await expect(new LlmkiwiProvider().chatCompletion('sk_kiwi_test', [], 'hrllm'))
      .rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves auth, exact model, options, usage and routing attribution', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion()));
    const response = await getProvider('llmkiwi')!.chatCompletion('sk_kiwi_test',
      [{ role: 'user', content: 'OK' }], model, { max_tokens: 128, temperature: 0.2 });
    expect(fetch.mock.calls[0][0]).toBe('https://api.llm.kiwi/v1/chat/completions');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer sk_kiwi_test');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model, max_tokens: 128, temperature: 0.2 });
    expect(response.choices[0].message.content).toBe('OK');
    expect(response.usage).toEqual(completion().usage);
    expect(response._routed_via).toEqual({ platform: 'llmkiwi', model });
  });

  it('streams content with the requested model', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(
      frame({ content: 'OK' }),
      frame({}, model, 'stop'),
    ));
    const chunks: ChatCompletionChunk[] = [];
    for await (const chunk of getProvider('llmkiwi')!.streamChatCompletion('sk_kiwi_test', [], model)) chunks.push(chunk);
    expect(chunks).toHaveLength(2);
    expect(chunks.every(c => c.model === model)).toBe(true);
    expect(chunks[0].choices[0].delta.content).toBe('OK');
  });

  it('lets the auto router answer with a different underlying model id', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json(completion('some-upstream-model')));
    const response = await getProvider('llmkiwi')!.chatCompletion('sk_kiwi_test', [], 'auto');
    expect(response.choices[0].message.content).toBe('OK');
  });

  it.each(['other-model', undefined])('rejects mismatched or missing completion model (%s)', async returnedModel => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ ...completion(), model: returnedModel }));
    await expect(getProvider('llmkiwi')!.chatCompletion('sk_kiwi_test', [], model)).rejects.toMatchObject({ status: 502 });
  });

  it('rejects a substituted stream before yielding its content', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(frame({ content: 'OK' }, 'other-model')));
    const s = getProvider('llmkiwi')!.streamChatCompletion('sk_kiwi_test', [], model);
    await expect(s.next()).rejects.toMatchObject({ status: 502 });
  });

  it.each([402, 429, 503])('preserves upstream quota status and backoff without retry (%s)', async status => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: 'quota' }, status, { 'Retry-After': '15' }));
    await expect(new LlmkiwiProvider().chatCompletion('sk_kiwi_test', [], model)).rejects.toMatchObject({ status, retryAfterMs: 15_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
