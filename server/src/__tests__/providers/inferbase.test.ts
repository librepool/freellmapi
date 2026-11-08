import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionChunk } from '@librepool/shared/types.js';
import { InferbaseProvider } from '../../providers/inferbase.js';
import { initDb, getDb } from '../../db/index.js';

// `auto` is Inferbase's router, not a model: the upstream answers with
// whichever model it picked per request, so the identity check is skipped
// for it (same pattern as llmkiwi.ts). Explicit catalog ids stay pinned.

const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const completion = (requested: string, returned: string) => ({
  id: 'inferbase-test', object: 'chat.completion', created: 1, model: returned,
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
});
const frame = (delta: Record<string, unknown>, returned: string, finish: string | null = null) => ({
  id: 'inferbase-test', object: 'chat.completion.chunk', created: 1, model: returned,
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const stream = (...events: unknown[]) => new Response(
  events.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n',
  { headers: { 'Content-Type': 'text/event-stream' } },
);

beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

describe('Inferbase provider — auto router identity', () => {
  it('accepts the routed model id when the request used auto', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json(completion('auto', 'deepseek-v4-flash-0731')));
    const response = await new InferbaseProvider().chatCompletion('inferbase-test',
      [{ role: 'user', content: 'OK' }], 'auto');
    expect(response.choices[0].message.content).toBe('OK');
    expect(response._routed_via).toEqual({ platform: 'inferbase', model: 'auto' });
  });

  it('accepts the routed model id in auto streams', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(stream(
      frame({ content: 'OK' }, 'deepseek-v4-flash-0731'),
      frame({}, 'deepseek-v4-flash-0731', 'stop'),
    ));
    const chunks: ChatCompletionChunk[] = [];
    for await (const chunk of new InferbaseProvider().streamChatCompletion('inferbase-test', [], 'auto')) chunks.push(chunk);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].choices[0].delta.content).toBe('OK');
  });

  it('still pins explicit catalog ids', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json(completion('deepseek-v4-flash-0731', 'other-model')));
    await expect(new InferbaseProvider().chatCompletion('inferbase-test', [], 'deepseek-v4-flash-0731'))
      .rejects.toMatchObject({ status: 502 });
  });
});
