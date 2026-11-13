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
      { id: 'auto-router', allowed_models: ['acme/alpha:free', 'acme/beta:free'] },
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
      { id: 'auto-router', allowed_models: ['acme/alpha:free', 'acme/beta:free'] },
    ]);
    expect(chunks.length).toBeGreaterThan(0);
  });
});
