import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionChunk } from '@librepool/shared/types.js';
import { SenseNovaProvider } from '../../providers/sensenova.js';
import { initDb, getDb } from '../../db/index.js';
import { getProvider } from '../../providers/index.js';
import { AUTH_JSON_PROVIDER_MAP, detectPlatform, parseKeysFromFile } from '../../lib/key-parser.js';
import { BUILTIN_DISCOVERY_PLATFORMS } from '../../services/builtin-model-discovery.js';
import { isBuiltinDiscoveryEligible } from '../../services/builtin-model-discovery.js';

const model = 'sensenova-6.8-flash-lite';
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const completion = (returned = model) => ({
  id: 'sensenova-test', object: 'chat.completion', created: 1, model: returned,
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
});
const frame = (delta: Record<string, unknown>, returned = model, finish: string | null = null) => ({
  id: 'sensenova-test', object: 'chat.completion.chunk', created: 1, model: returned,
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const stream = (...events: unknown[]) => new Response(
  events.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n',
  { headers: { 'Content-Type': 'text/event-stream' } },
);

beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

describe('SenseNova provider', () => {
  // Wiring contract for the coordinator: platform literal, key prefix and
  // auth-JSON map live in shared files (shared/types.ts,
  // server/src/lib/key-parser.ts, server/src/providers/index.ts) that this
  // batch does not edit. This test passes once those are wired; the
  // behavioral tests below run standalone against the adapter class.
  it('registers, imports keys and leaves model discovery to the signed catalog', () => {
    expect(getProvider('sensenova')).toBeInstanceOf(SenseNovaProvider);
    expect(getDb().prepare("SELECT COUNT(*) n FROM models WHERE platform='sensenova'").get()).toEqual({ n: 0 });
    expect(isBuiltinDiscoveryEligible(getDb(), 'sensenova')).toBe(false);
    expect(BUILTIN_DISCOVERY_PLATFORMS).not.toContain('sensenova');
    expect(detectPlatform('SENSENOVA_')).toBe('sensenova');
    expect(AUTH_JSON_PROVIDER_MAP.sensenova).toBe('sensenova');
    expect(parseKeysFromFile('SENSENOVA_API_KEY=sk-test-not-a-real-key', 'keys.env').keys[0].platform).toBe('sensenova');
  });

  it('validates a key against GET /v1/models, which requires auth', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce(json({ data: [] }));
    await expect(new SenseNovaProvider().validateKey('sk-test')).resolves.toBe(true);
    expect(fetch.mock.calls[0][0]).toBe('https://token.sensenova.ai/v1/models');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer sk-test');
  });

  it('reports an invalid key from the validation call', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(json({ error: { code: 16, message: 'Authorization Not Found' } }, 401));
    await expect(new SenseNovaProvider().validateKey('sk-bad')).resolves.toMatchObject({ valid: false });
  });

  it('preserves auth, exact model, options, usage and routing attribution', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion()));
    const response = await new SenseNovaProvider().chatCompletion('sk-test',
      [{ role: 'user', content: 'OK' }], model, { max_tokens: 128, temperature: 0.2 });
    expect(fetch.mock.calls[0][0]).toBe('https://token.sensenova.ai/v1/chat/completions');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer sk-test');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model, max_tokens: 128, temperature: 0.2 });
    expect(response.choices[0].message.content).toBe('OK');
    expect(response.usage).toEqual(completion().usage);
    expect(response._routed_via).toEqual({ platform: 'sensenova', model });
  });

  it('streams content with the requested model', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(
      frame({ content: 'OK' }),
      frame({}, model, 'stop'),
    ));
    const chunks: ChatCompletionChunk[] = [];
    for await (const chunk of new SenseNovaProvider().streamChatCompletion('sk-test', [], model)) chunks.push(chunk);
    expect(chunks).toHaveLength(2);
    expect(chunks.every(c => c.model === model)).toBe(true);
    expect(chunks[0].choices[0].delta.content).toBe('OK');
  });

  it.each(['other-model', undefined])('rejects mismatched or missing completion model (%s)', async returnedModel => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ ...completion(), model: returnedModel }));
    await expect(new SenseNovaProvider().chatCompletion('sk-test', [], model)).rejects.toMatchObject({ status: 502 });
  });

  it('rejects a substituted stream before yielding its content', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(frame({ content: 'OK' }, 'other-model')));
    const s = new SenseNovaProvider().streamChatCompletion('sk-test', [], model);
    await expect(s.next()).rejects.toMatchObject({ status: 502 });
  });

  it.each([402, 429, 503])('preserves upstream quota status and backoff without retry (%s)', async status => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: 'quota' }, status, { 'Retry-After': '15' }));
    await expect(new SenseNovaProvider().chatCompletion('sk-test', [], model)).rejects.toMatchObject({ status, retryAfterMs: 15_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
