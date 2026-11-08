import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionChunk } from '@librepool/shared/types.js';
import { MeganovaProvider, MEGANOVA_FREE_MODELS } from '../../providers/meganova.js';
import { initDb, getDb } from '../../db/index.js';
import { getProvider } from '../../providers/index.js';
import { AUTH_JSON_PROVIDER_MAP, detectPlatform, parseKeysFromFile } from '../../lib/key-parser.js';
import { BUILTIN_DISCOVERY_PLATFORMS } from '../../services/builtin-model-discovery.js';
import { isBuiltinDiscoveryEligible } from '../../services/builtin-model-discovery.js';

const model = 'meganova-ai/manta-mini-1.0';
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const completion = (returned = model) => ({
  id: 'meganova-test', object: 'chat.completion', created: 1, model: returned,
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
});
const frame = (delta: Record<string, unknown>, returned = model, finish: string | null = null) => ({
  id: 'meganova-test', object: 'chat.completion.chunk', created: 1, model: returned,
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const stream = (...events: unknown[]) => new Response(
  events.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n',
  { headers: { 'Content-Type': 'text/event-stream' } },
);

beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

describe('MegaNova AI provider', () => {
  it('registers, imports keys and leaves model discovery to the signed catalog', () => {
    expect(getProvider('meganova')).toBeInstanceOf(MeganovaProvider);
    expect(getDb().prepare("SELECT COUNT(*) n FROM models WHERE platform='meganova'").get()).toEqual({ n: 0 });
    expect(isBuiltinDiscoveryEligible(getDb(), 'meganova')).toBe(false);
    expect(BUILTIN_DISCOVERY_PLATFORMS).not.toContain('meganova');
    expect(detectPlatform('MEGANOVA_')).toBe('meganova');
    expect(AUTH_JSON_PROVIDER_MAP.meganova).toBe('meganova');
    expect(parseKeysFromFile('MEGANOVA_API_KEY=sk-test-not-a-real-key', 'keys.env').keys[0].platform).toBe('meganova');
    expect(MEGANOVA_FREE_MODELS).toHaveLength(8);
  });

  it('validates via a minimal chat call: /v1/models is public and cannot check a key', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce(json(completion()));
    await expect(new MeganovaProvider().validateKey('sk-test')).resolves.toBe(true);
    expect(fetch.mock.calls[0][0]).toBe('https://api.meganova.ai/v1/chat/completions');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer sk-test');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model: 'meganova-ai/manta-mini-1.0', max_tokens: 1, stream: false });
  });

  it('reports an invalid key from the validation call', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(json({ error: { message: 'Unable to find token in records.' } }, 401));
    await expect(new MeganovaProvider().validateKey('sk-bad')).resolves.toMatchObject({ valid: false });
  });

  it('rejects deposit-gated Tier 2 models before any fetch', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion()));
    await expect(new MeganovaProvider().chatCompletion('sk-test', [], 'meganova-ai/manta-pro-1.0'))
      .rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves auth, exact model, options, usage and routing attribution', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion()));
    const response = await getProvider('meganova')!.chatCompletion('sk-test',
      [{ role: 'user', content: 'OK' }], model, { max_tokens: 128, temperature: 0.2 });
    expect(fetch.mock.calls[0][0]).toBe('https://api.meganova.ai/v1/chat/completions');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer sk-test');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model, max_tokens: 128, temperature: 0.2 });
    expect(response.choices[0].message.content).toBe('OK');
    expect(response.usage).toEqual(completion().usage);
    expect(response._routed_via).toEqual({ platform: 'meganova', model });
  });

  it('streams content with the requested model', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(
      frame({ content: 'OK' }),
      frame({}, model, 'stop'),
    ));
    const chunks: ChatCompletionChunk[] = [];
    for await (const chunk of getProvider('meganova')!.streamChatCompletion('sk-test', [], model)) chunks.push(chunk);
    expect(chunks).toHaveLength(2);
    expect(chunks.every(c => c.model === model)).toBe(true);
    expect(chunks[0].choices[0].delta.content).toBe('OK');
  });

  it.each(['other-model', undefined])('rejects mismatched or missing completion model (%s)', async returnedModel => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ ...completion(), model: returnedModel }));
    await expect(getProvider('meganova')!.chatCompletion('sk-test', [], model)).rejects.toMatchObject({ status: 502 });
  });

  it('rejects a substituted stream before yielding its content', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(frame({ content: 'OK' }, 'other-model')));
    const s = getProvider('meganova')!.streamChatCompletion('sk-test', [], model);
    await expect(s.next()).rejects.toMatchObject({ status: 502 });
  });

  it.each([402, 429, 503])('preserves upstream quota status and backoff without retry (%s)', async status => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: 'quota' }, status, { 'Retry-After': '15' }));
    await expect(new MeganovaProvider().chatCompletion('sk-test', [], model)).rejects.toMatchObject({ status, retryAfterMs: 15_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
