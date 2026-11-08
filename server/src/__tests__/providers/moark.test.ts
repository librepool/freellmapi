import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionChunk } from '@librepool/shared/types.js';
import { MoarkProvider, MOARK_FREE_MODELS } from '../../providers/moark.js';
import { initDb, getDb } from '../../db/index.js';
import { detectPlatform } from '../../lib/key-parser.js';
import { BUILTIN_DISCOVERY_PLATFORMS } from '../../services/builtin-model-discovery.js';
import { isBuiltinDiscoveryEligible } from '../../services/builtin-model-discovery.js';

// NOTE: register() in providers/index.ts is coordinator wiring (shared file,
// not touched by this change), so these tests use `new MoarkProvider()`
// directly instead of getProvider('moark'); after wiring, getProvider
// returns the same singleton and the tests may be switched to that form.

const model = 'deepseek-v4-flash-0731';
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const completion = (returned = model) => ({
  id: 'moark-test', object: 'chat.completion', created: 1, model: returned,
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
});
const frame = (delta: Record<string, unknown>, returned = model, finish: string | null = null) => ({
  id: 'moark-test', object: 'chat.completion.chunk', created: 1, model: returned,
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const stream = (...events: unknown[]) => new Response(
  events.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n',
  { headers: { 'Content-Type': 'text/event-stream' } },
);

beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

describe('Moark (Gitee AI) provider', () => {
  it('reports its platform literal and leaves model discovery to the signed catalog', () => {
    const provider = new MoarkProvider();
    expect(provider).toBeInstanceOf(MoarkProvider);
    expect(provider.platform).toBe('moark');
    expect(MOARK_FREE_MODELS).toEqual(['deepseek-v4-flash-0731']);
    expect(getDb().prepare("SELECT COUNT(*) n FROM models WHERE platform='moark'").get()).toEqual({ n: 0 });
    expect(isBuiltinDiscoveryEligible(getDb(), 'moark')).toBe(false);
    expect(BUILTIN_DISCOVERY_PLATFORMS).not.toContain('moark');
    // No key prefix is published — tokens are opaque, do not guess one.
    expect(detectPlatform('MOARK_')).toBeNull();
  });

  it('has no key-validation endpoint: the public /v1/models cannot check a credential', async () => {
    expect(new MoarkProvider().supportsKeyValidation).toBe(false);
    await expect(new MoarkProvider().validateKey('moark-test')).rejects.toThrow(/no documented free credential-validation endpoint/);
  });

  it('rejects unconfirmed models before any fetch', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion()));
    // In the live /v1/models list but not a confirmed featured model: the
    // free experience token's coverage of it is unverified, so refuse it
    // rather than burning one of the 100 daily calls on a 400.
    await expect(new MoarkProvider().chatCompletion('moark-test', [], 'GLM-5.3'))
      .rejects.toMatchObject({ status: 400 });
    await expect(new MoarkProvider().chatCompletion('moark-test', [], 'qwen3.8-27b'))
      .rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves auth, exact model, options, usage and routing attribution', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion()));
    const response = await new MoarkProvider().chatCompletion('moark-test',
      [{ role: 'user', content: 'OK' }], model, { max_tokens: 128, temperature: 0.2 });
    expect(fetch.mock.calls[0][0]).toBe('https://api.moark.com/v1/chat/completions');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer moark-test');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model, max_tokens: 128, temperature: 0.2 });
    expect(response.choices[0].message.content).toBe('OK');
    expect(response.usage).toEqual(completion().usage);
    expect(response._routed_via).toEqual({ platform: 'moark', model });
  });

  it('streams content with the requested model', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(
      frame({ content: 'OK' }),
      frame({}, model, 'stop'),
    ));
    const chunks: ChatCompletionChunk[] = [];
    for await (const chunk of new MoarkProvider().streamChatCompletion('moark-test', [], model)) chunks.push(chunk);
    expect(chunks).toHaveLength(2);
    expect(chunks.every(c => c.model === model)).toBe(true);
    expect(chunks[0].choices[0].delta.content).toBe('OK');
  });

  it.each(['other-model', undefined])('rejects mismatched or missing completion model (%s)', async returnedModel => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ ...completion(), model: returnedModel }));
    await expect(new MoarkProvider().chatCompletion('moark-test', [], model)).rejects.toMatchObject({ status: 502 });
  });

  it('rejects a substituted stream before yielding its content', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(frame({ content: 'OK' }, 'other-model')));
    const s = new MoarkProvider().streamChatCompletion('moark-test', [], model);
    await expect(s.next()).rejects.toMatchObject({ status: 502 });
  });

  it.each([400, 402, 429, 503])('preserves upstream quota status and backoff without retry (%s)', async status => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: 'quota' }, status, { 'Retry-After': '15' }));
    await expect(new MoarkProvider().chatCompletion('moark-test', [], model)).rejects.toMatchObject({ status, retryAfterMs: 15_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
