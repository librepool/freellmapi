import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { EMBEDDING_PLATFORMS, runEmbeddings } from '../../services/embeddings.js';
import { applyCatalog } from '../../services/catalog-sync.js';

const model = 'BAAI/bge-m3';
const dimensions = 1024;
const json = (body: unknown) => new Response(JSON.stringify(body));
function seed() {
  const db = getDb(), secret = encrypt('gonka-test-key');
  db.prepare("INSERT INTO api_keys (platform,label,encrypted_key,iv,auth_tag,status,enabled) VALUES ('gonka','test',?,?,?,'healthy',1)").run(secret.encrypted, secret.iv, secret.authTag);
  const result = applyCatalog(db, { version: '2099.01.01', generatedAt: new Date().toISOString(), tier: 'live', models: [], quirks: [],
    embeddings: [{ platform: 'gonka', modelId: model, family: 'gonka-bge-m3', displayName: 'BGE-M3', dimensions, maxInputTokens: 8192, priority: 1, enabled: true, quotaLabel: '' }] });
  expect(result.skippedUnknownPlatform).toBe(0);
}
const embeddingResponse = (returned = model, dims = dimensions) => json({ model: returned,
  data: [{ index: 1, embedding: Array(dims).fill(0.2) }, { index: 0, embedding: Array(dims).fill(0.1) }],
  usage: { prompt_tokens: 4 } });

describe('Gonka catalog-managed embeddings', () => {
  beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
  afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

  it('routes BAAI/bge-m3 with float vectors, sorted input order and usage', async () => {
    seed();
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(embeddingResponse());
    const result = await runEmbeddings('gonka-bge-m3', ['first', 'second']);
    expect(EMBEDDING_PLATFORMS.has('gonka')).toBe(true);
    expect(fetch.mock.calls[0][0]).toBe('https://proxy.gonkabroker.com/v1/embeddings');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer gonka-test-key');
    // Gonka rejects a `dimensions` parameter with 400: the body carries none.
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ model, input: ['first', 'second'] });
    expect(result).toMatchObject({ platform: 'gonka', modelId: model, dimensions, inputTokens: 4 });
    expect(result.vectors.map(v => v[0])).toEqual([0.1, 0.2]);
  });

  it('rejects an explicit dimensions override before any fetch', async () => {
    seed();
    const fetch = vi.spyOn(global, 'fetch');
    // runEmbeddings wraps the provider's 400 in its aggregate 502, so assert
    // on the cause (the message) plus the absence of any network call.
    await expect(runEmbeddings('gonka-bge-m3', ['hello'], 512))
      .rejects.toThrow(/does not support an embedding dimension override/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { model: 'wrong', data: [{ index: 0, embedding: [0.1, 0.2] }] },
    { data: [{ index: 0, embedding: [0.1, 0.2] }] },
    { model, data: [{ index: 0, embedding: [0.1] }] },
    { model, data: [{ index: 0, embedding: [0.1, null] }] },
    { model, data: [{ index: 1, embedding: [0.1, 0.2] }] },
  ])('rejects model substitution, invalid dimensions and malformed vectors', async body => {
    seed();
    vi.spyOn(global, 'fetch').mockResolvedValue(json(body));
    await expect(runEmbeddings('gonka-bge-m3', ['hello'])).rejects.toMatchObject({ status: 502 });
  });

  it('preserves rate-limit retry hints', async () => {
    seed();
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('Rate limited', { status: 429, headers: { 'Retry-After': '20' } }));
    await expect(runEmbeddings('gonka-bge-m3', ['hello'])).rejects.toMatchObject({ status: 429, retryAfterMs: 20_000 });
  });
});
