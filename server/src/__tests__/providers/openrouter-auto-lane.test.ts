// OpenRouter auto lane (provider side): the OpenAI-compat provider adds the
// auto-router plugin restriction ONLY for the openrouter platform dispatching
// to 'openrouter/auto' with a non-empty allow-list hint. Every other shape
// leaves the wire body unchanged.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetchCapture(respond: (body: any) => any): { body: () => any } {
  let captured: any = null;
  vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
    captured = JSON.parse((init as any).body);
    return {
      ok: true,
      json: () => Promise.resolve(respond(captured)),
      headers: new Headers(),
    } as any;
  });
  return { body: () => captured };
}

function chatResponse(model: string): any {
  return {
    id: 'test-id',
    object: 'chat.completion',
    created: 123,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

const LANE_OPTIONS = { openrouterAuto: { allowedModels: ['acme/alpha:free', 'acme/beta:free'] } };

describe('OpenRouter auto lane body fragment', () => {
  it('adds the auto-router plugin for openrouter/auto with an allow-list', async () => {
    const provider = new OpenAICompatProvider({
      platform: 'openrouter',
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    const cap = mockFetchCapture(() => chatResponse('acme/alpha:free'));
    await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'openrouter/auto', LANE_OPTIONS);
    expect(cap.body().model).toBe('openrouter/auto');
    expect(cap.body().plugins).toEqual([
      { id: 'auto-router', allowed_models: ['acme/alpha:free', 'acme/beta:free'], cost_tier: 'low', enabled: true },
    ]);
  });

  it('adds no plugins for a concrete OpenRouter model, even with the hint', async () => {
    const provider = new OpenAICompatProvider({
      platform: 'openrouter',
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    const cap = mockFetchCapture(() => chatResponse('acme/alpha:free'));
    await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'acme/alpha:free', LANE_OPTIONS);
    expect(cap.body().plugins).toBeUndefined();
  });

  it('adds no plugins without the hint', async () => {
    const provider = new OpenAICompatProvider({
      platform: 'openrouter',
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    const cap = mockFetchCapture(() => chatResponse('openrouter/auto'));
    await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'openrouter/auto');
    expect(cap.body().plugins).toBeUndefined();
  });

  it('adds no plugins on other platforms, even with the hint', async () => {
    const provider = new OpenAICompatProvider({
      platform: 'groq',
      name: 'Groq',
      baseUrl: 'https://api.groq.com/openai/v1',
    });
    const cap = mockFetchCapture(() => chatResponse('openrouter/auto'));
    await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'openrouter/auto', LANE_OPTIONS);
    expect(cap.body().plugins).toBeUndefined();
  });

  it('adds the plugin on the streaming path too', async () => {
    const provider = new OpenAICompatProvider({
      platform: 'openrouter',
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    let captured: any = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"acme/alpha:free","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      captured = JSON.parse((init as any).body);
      return { ok: true, body: stream, headers: new Headers() } as any;
    });
    const chunks: any[] = [];
    for await (const chunk of provider.streamChatCompletion('k', [{ role: 'user', content: 'hi' }], 'openrouter/auto', LANE_OPTIONS)) {
      chunks.push(chunk);
    }
    expect(captured.stream).toBe(true);
    expect(captured.plugins).toEqual([
      { id: 'auto-router', allowed_models: ['acme/alpha:free', 'acme/beta:free'], cost_tier: 'low', enabled: true },
    ]);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('logs the model OpenRouter actually picked (non-streaming)', async () => {
    const provider = new OpenAICompatProvider({
      platform: 'openrouter',
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockFetchCapture((body) => chatResponse(body.model === 'openrouter/auto' ? 'acme/alpha:free' : body.model));
    const out = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'openrouter/auto', LANE_OPTIONS);
    expect(out.model).toBe('acme/alpha:free');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[OpenRouter] auto lane picked acme/alpha:free'));
    logSpy.mockRestore();
  });

  it('falls back to the anchor model when the delegated call fails (non-streaming)', async () => {
    const provider = new OpenAICompatProvider({
      platform: 'openrouter',
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    const calls: any[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as any).body);
      calls.push(body);
      if (calls.length === 1) {
        return { ok: false, status: 500, statusText: 'Internal Server Error', json: () => Promise.resolve({ error: { message: 'auto router down' } }), headers: new Headers() } as any;
      }
      return { ok: true, json: () => Promise.resolve(chatResponse('acme/alpha:free')), headers: new Headers() } as any;
    });
    const out = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'openrouter/auto', LANE_OPTIONS);
    expect(calls).toHaveLength(2);
    // First attempt: delegated, with the plugin.
    expect(calls[0].model).toBe('openrouter/auto');
    expect(calls[0].plugins).toEqual([
      { id: 'auto-router', allowed_models: ['acme/alpha:free', 'acme/beta:free'], cost_tier: 'low', enabled: true },
    ]);
    // Fallback: the anchor model, directly, with no plugin.
    expect(calls[1].model).toBe('acme/alpha:free');
    expect(calls[1].plugins).toBeUndefined();
    expect(out.model).toBe('acme/alpha:free');
    expect(out.choices[0].message.content).toBe('hi');
  });

  it('throws when the anchor fallback fails too (non-streaming)', async () => {
    const provider = new OpenAICompatProvider({
      platform: 'openrouter',
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    const calls: any[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      calls.push(JSON.parse((init as any).body));
      return { ok: false, status: 500, statusText: 'Internal Server Error', json: () => Promise.resolve({ error: { message: 'still down' } }), headers: new Headers() } as any;
    });
    await expect(
      provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'openrouter/auto', LANE_OPTIONS),
    ).rejects.toThrow();
    expect(calls).toHaveLength(2);
    expect(calls[0].model).toBe('openrouter/auto');
    expect(calls[1].model).toBe('acme/alpha:free');
  });

  it('falls back to the anchor model when the delegated stream fails before the first chunk', async () => {
    const provider = new OpenAICompatProvider({
      platform: 'openrouter',
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    const calls: any[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as any).body);
      calls.push(body);
      if (calls.length === 1) {
        return { ok: false, status: 502, statusText: 'Bad Gateway', json: () => Promise.resolve({ error: { message: 'bad gateway' } }), headers: new Headers() } as any;
      }
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'acme/alpha:free', choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`));
          controller.close();
        },
      });
      return { ok: true, body: stream, headers: new Headers() } as any;
    });
    const chunks: any[] = [];
    for await (const chunk of provider.streamChatCompletion('k', [{ role: 'user', content: 'hi' }], 'openrouter/auto', LANE_OPTIONS)) {
      chunks.push(chunk);
    }
    expect(calls).toHaveLength(2);
    expect(calls[0].model).toBe('openrouter/auto');
    expect(calls[0].plugins).toBeDefined();
    expect(calls[1].model).toBe('acme/alpha:free');
    expect(calls[1].plugins).toBeUndefined();
    expect(chunks.length).toBeGreaterThan(0);
  });
});
