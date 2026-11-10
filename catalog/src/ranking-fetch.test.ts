import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CatalogStore, loadSeed } from './catalog-store.ts';
import {
  AA_DAILY_LIMIT,
  BENCHLM_MONTHLY_LIMIT,
  RankingFetchError,
  budgetStatus,
  emptyBudget,
  fetchAa,
  fetchBenchlm,
  fetchFromCache,
  loadBudget,
  loadLivebenchSnapshot,
  loadModelMap,
  mergeBenchmarks,
  parseAaResponse,
  parseBenchlmResponse,
  parseLivebenchSnapshot,
  recordUsage,
  resolveModel,
  saveBudget,
  validateModelMapTargets,
  type FetchFn,
  type MinimalResponse,
  type ModelMap,
} from './ranking-fetch.ts';
import type { BenchmarkInputs, SeedCatalog } from './types.ts';

const FETCHED_AT = '2026-11-08T00:00:00.000Z';
const NOW_MS = Date.parse(FETCHED_AT);

const TEST_MAP: ModelMap = {
  version: 'test',
  aa: {
    'Llama 3.3 70B Instruct': ['groq:llama-3.3-70b-versatile', 'openrouter:meta-llama/llama-3.3-70b-instruct:free'],
    'llama-3-1-8b-instruct': 'groq:llama-3.1-8b-instant',
  },
  benchlm: {
    'Llama 3.3 70B Instruct': 'groq:llama-3.3-70b-versatile',
    'Llama 3.1 8B Instruct': 'groq:llama-3.1-8b-instant',
  },
  livebench: {
    'DeepSeek V4.1 Flash': ['zro:deepseek-v4.1-flash', 'tokenharbor:deepseek-v4.1-flash:free'],
  },
};

/** Minimal stub Response. `headers` is a plain record. */
function stubResponse(status: number, body: unknown, headers: Record<string, string> = {}): MinimalResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    json: async () => JSON.parse(text) as unknown,
    text: async () => text,
  };
}

function stubFetch(res: MinimalResponse, seen: { url?: string; headers?: unknown }): FetchFn {
  return (async (url: string, init?: Record<string, unknown>) => {
    seen.url = url;
    seen.headers = init?.headers;
    return res;
  }) as FetchFn;
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ranking-fetch-test-'));
}

const AA_FIXTURE = {
  tier: 'free',
  intelligence_index_version: 5,
  pagination: { page: 1, page_size: 2, total_pages: 1, has_more: false },
  data: [
    {
      id: 'llama-3-3-70b',
      name: 'Llama 3.3 70B Instruct',
      slug: 'llama-3-3-70b-instruct',
      evaluations: { artificial_analysis_intelligence_index: 45 },
    },
    {
      id: 'llama-3-1-8b',
      name: 'Llama 3.1 8B Instruct',
      slug: 'llama-3-1-8b-instruct',
      evaluations: { artificial_analysis_intelligence_index: 30 },
    },
    {
      id: 'unmapped',
      name: 'Unmapped Model',
      slug: 'unmapped-model',
      evaluations: { artificial_analysis_intelligence_index: 30 },
    },
    {
      id: 'noscores',
      name: 'No Score Model',
      slug: 'no-score-model',
      evaluations: {},
    },
  ],
};

// ---------------------------------------------------------------------------
// AA parsing
// ---------------------------------------------------------------------------

test('AA: parses the documented envelope, maps by display name, unmatched stays unmatched', () => {
  const r = parseAaResponse(AA_FIXTURE, TEST_MAP, FETCHED_AT);
  assert.equal(r.version, 'aa-v5');
  assert.equal(r.rawCount, 4);
  assert.equal(r.scores.get('groq:llama-3.3-70b-versatile')?.aa, 45);
  assert.equal(r.scores.get('openrouter:meta-llama/llama-3.3-70b-instruct:free')?.aa, 45);
  assert.equal(r.scores.get('groq:llama-3.3-70b-versatile')?.sourceDate, FETCHED_AT);
  assert.equal(r.matchedCount, 3);
  assert.deepEqual(r.unmatched, ['unmapped-model']);
  assert.deepEqual(r.unscored, ['no-score-model']);
  assert.equal(r.partial, false);
});

test('AA: accepts the index as a nested { value } object', () => {
  const r = parseAaResponse(
    {
      intelligence_index_version: 5,
      data: [
        { slug: 'llama-3-3-70b-instruct', name: 'Llama 3.3 70B Instruct', evaluations: { artificial_analysis_intelligence_index: { value: 50 } } },
      ],
    },
    TEST_MAP,
    FETCHED_AT,
  );
  assert.equal(r.scores.get('groq:llama-3.3-70b-versatile')?.aa, 50);
});

test('AA: performance_v3 rows still parse (Dec 10 2026 migration) — performance fields are never read', () => {
  const r = parseAaResponse(
    {
      intelligence_index_version: 5,
      data: [
        {
          slug: 'llama-3-3-70b-instruct',
          name: 'Llama 3.3 70B Instruct',
          evaluations: { artificial_analysis_intelligence_index: 45 },
          // Post-migration shape: performance_v3 present, legacy performance emptied.
          performance_v3: { output_speed: 120, time_to_first_token: 0.4 },
          performance: {},
        },
        {
          slug: 'llama-3-1-8b-instruct',
          name: 'Llama 3.1 8B Instruct',
          evaluations: { artificial_analysis_intelligence_index: 30 },
          performance: null,
        },
      ],
    },
    TEST_MAP,
    FETCHED_AT,
  );
  assert.equal(r.scores.get('groq:llama-3.3-70b-versatile')?.aa, 45);
  assert.equal(r.scores.get('groq:llama-3.1-8b-instant')?.aa, 30);
  assert.equal(r.matchedCount, 3);
  assert.deepEqual(r.unscored, []);
});

test('AA: version mismatch (v4) refuses to parse — never mix versions', () => {
  assert.throws(
    () => parseAaResponse({ intelligence_index_version: 4, data: [] }, TEST_MAP, FETCHED_AT),
    (err: unknown) => err instanceof RankingFetchError && err.code === 'version_mismatch',
  );
});

test('AA: malformed payloads throw malformed_payload', () => {
  assert.throws(() => parseAaResponse(null, TEST_MAP, FETCHED_AT), /not a JSON object/);
  assert.throws(() => parseAaResponse({ data: 'nope' }, TEST_MAP, FETCHED_AT), /no `data` array/);
});

test('AA: non-numeric score is unscored, never 0', () => {
  const r = parseAaResponse(
    { intelligence_index_version: 5, data: [{ slug: 'llama-3-3-70b-instruct', name: 'Llama 3.3 70B Instruct', evaluations: { artificial_analysis_intelligence_index: 'high' } }] },
    TEST_MAP,
    FETCHED_AT,
  );
  assert.equal(r.scores.size, 0);
  assert.deepEqual(r.unscored, ['llama-3-3-70b-instruct']);
});

test('AA: has_more flags the result partial (one request per run)', () => {
  const r = parseAaResponse(
    { intelligence_index_version: 5, pagination: { page: 1, has_more: true }, data: [] },
    TEST_MAP,
    FETCHED_AT,
  );
  assert.equal(r.partial, true);
});

// ---------------------------------------------------------------------------
// BenchLM parsing
// ---------------------------------------------------------------------------

const BENCHLM_FIXTURE = {
  data: [
    { model: 'Llama 3.3 70B Instruct', score: 70, evidence: 'Supported', scoring_date: '2026-11-07' },
    { model: 'Llama 3.1 8B Instruct', score: 60, evidence: 'Estimated', scoring_date: '2026-11-07' },
    { model: 'Unmapped Model', score: 55, evidence: 'Supported' },
    { model: 'No Score Model', evidence: 'Supported' },
  ],
};

test('BenchLM: parses rows, maps evidence labels to benchlmQuality', () => {
  const r = parseBenchlmResponse(BENCHLM_FIXTURE, TEST_MAP, FETCHED_AT);
  assert.equal(r.version, 'benchlm-v5.8');
  assert.equal(r.rawCount, 4);
  assert.deepEqual(r.scores.get('groq:llama-3.3-70b-versatile'), {
    benchlm: 70,
    benchlmQuality: 'supported',
    sourceDate: FETCHED_AT,
  });
  assert.deepEqual(r.scores.get('groq:llama-3.1-8b-instant'), {
    benchlm: 60,
    benchlmQuality: 'estimated',
    sourceDate: FETCHED_AT,
  });
  assert.deepEqual(r.unmatched, ['Unmapped Model']);
  assert.deepEqual(r.unscored, ['No Score Model']);
});

test('BenchLM: accepts the alternate envelope/row spellings defensively', () => {
  const r = parseBenchlmResponse(
    { rankings: [{ model_name: 'Llama 3.3 70B Instruct', final_score: 71, evidence_label: 'supported' }] },
    TEST_MAP,
    FETCHED_AT,
  );
  assert.equal(r.scores.get('groq:llama-3.3-70b-versatile')?.benchlm, 71);
  assert.equal(r.scores.get('groq:llama-3.3-70b-versatile')?.benchlmQuality, 'supported');
});

test('BenchLM: malformed payload throws', () => {
  assert.throws(() => parseBenchlmResponse({ nope: true }, TEST_MAP, FETCHED_AT), /no row array/);
  assert.throws(() => parseBenchlmResponse('text', TEST_MAP, FETCHED_AT), /no row array/);
});

// ---------------------------------------------------------------------------
// LiveBench snapshot import (no API)
// ---------------------------------------------------------------------------

test('LiveBench: parses a snapshot file, maps to several catalog rows', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'livebench.json');
  fs.writeFileSync(
    file,
    JSON.stringify([{ model: 'DeepSeek V4.1 Flash', score: 79.2, date: '2026-10-25' }]),
  );
  const r = loadLivebenchSnapshot(file, TEST_MAP, FETCHED_AT)!;
  assert.equal(r.version, 'livebench-2.0');
  assert.equal(r.scores.get('zro:deepseek-v4.1-flash')?.livebench, 79.2);
  assert.equal(r.scores.get('tokenharbor:deepseek-v4.1-flash:free')?.livebench, 79.2);
  // Row date wins over the fetch date when present.
  assert.equal(r.scores.get('zro:deepseek-v4.1-flash')?.sourceDate, '2026-10-25');
});

test('LiveBench: absent file returns null (missing = null, never 0)', () => {
  const r = loadLivebenchSnapshot(path.join(tmpDir(), 'does-not-exist.json'), TEST_MAP, FETCHED_AT);
  assert.equal(r, null);
});

test('LiveBench: malformed rows throw — a bad row is never silently skipped', () => {
  assert.throws(
    () => parseLivebenchSnapshot([{ model: 'DeepSeek V4.1 Flash', score: '79.2' }], TEST_MAP, FETCHED_AT),
    /no finite 0–100 "score"/,
  );
  assert.throws(
    () => parseLivebenchSnapshot([{ score: 79.2 }], TEST_MAP, FETCHED_AT),
    /no string "model"/,
  );
  assert.throws(() => parseLivebenchSnapshot({ model: 'x' }, TEST_MAP, FETCHED_AT), /must be a JSON array/);
});

// ---------------------------------------------------------------------------
// Model map: exact matches only
// ---------------------------------------------------------------------------

test('model map: exact match only — slug, name, case, near-misses', () => {
  // Slug key present in the map wins.
  assert.deepEqual(resolveModel(TEST_MAP, 'aa', ['llama-3-1-8b-instruct']), ['groq:llama-3.1-8b-instant']);
  // Display-name key wins when the slug is absent from the map.
  assert.deepEqual(resolveModel(TEST_MAP, 'aa', ['llama-3-3-70b-instruct', 'Llama 3.3 70B Instruct']), [
    'groq:llama-3.3-70b-versatile',
    'openrouter:meta-llama/llama-3.3-70b-instruct:free',
  ]);
  // No fuzzy matching: wrong case, partial name, and slug-without-key all miss.
  assert.deepEqual(resolveModel(TEST_MAP, 'aa', ['llama 3.3 70b instruct']), []);
  assert.deepEqual(resolveModel(TEST_MAP, 'aa', ['Llama 3.3 70B']), []);
  assert.deepEqual(resolveModel(TEST_MAP, 'aa', ['llama-3-3-70b-instruct']), []);
});

test('shipped model map loads and every target exists in the real seed catalog', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const map = loadModelMap(path.join(root, 'data', 'ranking-model-map.json'));
  const seed = loadSeed(path.join(root, 'data', 'seed-catalog.json'));
  const keys = new Set(seed.models.map((m) => `${m.platform}:${m.modelId}`));
  assert.deepEqual(validateModelMapTargets(map, keys), []);
  // The seeded LiveBench entries are the published 2.0 names.
  assert.deepEqual(resolveModel(map, 'livebench', ['DeepSeek V4.1 Flash']), [
    'zro:deepseek-v4.1-flash',
    'tokenharbor:deepseek-v4.1-flash:free',
  ]);
});

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

test('budget: AA 100/day fixed window — exhausted refuses, expired window resets', () => {
  const state = emptyBudget(NOW_MS);
  state.aa = { used: 100, windowStartMs: NOW_MS - 60 * 60 * 1000 };
  const status = budgetStatus(state, 'aa', NOW_MS);
  assert.equal(status.allowed, false);
  assert.equal(status.remaining, 0);
  assert.equal(status.used, 100);
  assert.equal(status.limit, AA_DAILY_LIMIT);

  const old = emptyBudget(NOW_MS);
  old.aa = { used: 100, windowStartMs: NOW_MS - 25 * 60 * 60 * 1000 };
  assert.equal(budgetStatus(old, 'aa', NOW_MS).allowed, true);
  assert.equal(budgetStatus(old, 'aa', NOW_MS).used, 0);
  recordUsage(old, 'aa', NOW_MS);
  assert.equal(old.aa.used, 1);
  assert.equal(old.aa.windowStartMs, NOW_MS);
});

test('budget: BenchLM 250/month UTC calendar month — exhausted refuses, new month resets', () => {
  const state = emptyBudget(NOW_MS);
  state.benchlm = { used: 250, month: '2026-11' };
  assert.equal(budgetStatus(state, 'benchlm', NOW_MS).allowed, false);
  assert.equal(budgetStatus(state, 'benchlm', NOW_MS).limit, BENCHLM_MONTHLY_LIMIT);

  const old = emptyBudget(NOW_MS);
  old.benchlm = { used: 250, month: '2026-10' };
  assert.equal(budgetStatus(old, 'benchlm', NOW_MS).allowed, true);
  recordUsage(old, 'benchlm', NOW_MS);
  assert.equal(old.benchlm.used, 1);
  assert.equal(old.benchlm.month, '2026-11');
});

test('budget: persists to disk and reloads', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'budget.json');
  const state = emptyBudget(NOW_MS);
  recordUsage(state, 'aa', NOW_MS, 3);
  saveBudget(file, state);
  const reloaded = loadBudget(file, NOW_MS);
  assert.equal(reloaded.aa.used, 3);
  assert.equal(reloaded.aa.windowStartMs, NOW_MS);
});

test('budget: corrupt budget file fails loudly instead of granting quota', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'budget.json');
  fs.writeFileSync(file, '{not json');
  assert.throws(() => loadBudget(file, NOW_MS), /not valid JSON/);
});

// ---------------------------------------------------------------------------
// Live clients with mocked fetch
// ---------------------------------------------------------------------------

test('AA client: success uses the /free endpoint with x-api-key and records 1 usage', async () => {
  const dir = tmpDir();
  const budgetPath = path.join(dir, 'budget.json');
  const cachePath = path.join(dir, 'cache-aa.json');
  const seen: { url?: string; headers?: unknown } = {};
  const r = await fetchAa('test-key', TEST_MAP, {
    fetchFn: stubFetch(stubResponse(200, AA_FIXTURE), seen),
    budgetPath,
    cachePath,
    nowMs: NOW_MS,
  });
  assert.equal(seen.url, 'https://artificialanalysis.ai/api/v2/language/models/free?page=1');
  assert.equal((seen.headers as Record<string, string>)['x-api-key'], 'test-key');
  assert.equal(r.scores.get('groq:llama-3.3-70b-versatile')?.aa, 45);
  assert.equal(loadBudget(budgetPath, NOW_MS).aa.used, 1);
  // Raw snapshot cached with its fetch date.
  const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { fetchedAt: string; payload: unknown };
  assert.equal(cached.fetchedAt, FETCHED_AT);
  assert.equal((cached.payload as typeof AA_FIXTURE).tier, 'free');
});

test('AA client: budget exhaustion refuses WITHOUT calling fetch', async () => {
  const dir = tmpDir();
  const budgetPath = path.join(dir, 'budget.json');
  const state = emptyBudget(NOW_MS);
  state.aa = { used: 100, windowStartMs: NOW_MS };
  saveBudget(budgetPath, state);
  let called = false;
  const fetchFn: FetchFn = (async () => {
    called = true;
    return stubResponse(200, AA_FIXTURE);
  }) as FetchFn;
  await assert.rejects(
    () => fetchAa('test-key', TEST_MAP, { fetchFn, budgetPath, nowMs: NOW_MS }),
    (err: unknown) => err instanceof RankingFetchError && err.code === 'budget_exhausted',
  );
  assert.equal(called, false);
  assert.equal(loadBudget(budgetPath, NOW_MS).aa.used, 100);
});

test('AA client: 401 is unauthorized; the (consumed) request is still counted', async () => {
  const dir = tmpDir();
  const budgetPath = path.join(dir, 'budget.json');
  await assert.rejects(
    () =>
      fetchAa('bad-key', TEST_MAP, {
        fetchFn: stubFetch(stubResponse(401, { error: 'bad key' }), {}),
        budgetPath,
        nowMs: NOW_MS,
      }),
    (err: unknown) => err instanceof RankingFetchError && err.code === 'unauthorized' && err.status === 401,
  );
  assert.equal(loadBudget(budgetPath, NOW_MS).aa.used, 1);
});

test('AA client: 429 surfaces retry-after; 403 is forbidden', async () => {
  const dir = tmpDir();
  await assert.rejects(
    () =>
      fetchAa('k', TEST_MAP, {
        fetchFn: stubFetch(stubResponse(429, { error: 'slow down' }, { 'Retry-After': '120' }), {}),
        budgetPath: path.join(dir, 'b.json'),
        nowMs: NOW_MS,
      }),
    (err: unknown) =>
      err instanceof RankingFetchError && err.code === 'rate_limited' && err.retryAfterSeconds === 120,
  );
  await assert.rejects(
    () =>
      fetchAa('k', TEST_MAP, {
        fetchFn: stubFetch(stubResponse(403, { error: 'tier' }), {}),
        budgetPath: path.join(dir, 'b2.json'),
        nowMs: NOW_MS,
      }),
    (err: unknown) => err instanceof RankingFetchError && err.code === 'forbidden',
  );
});

test('AA client: network error is not counted against the budget', async () => {
  const dir = tmpDir();
  const budgetPath = path.join(dir, 'budget.json');
  const fetchFn: FetchFn = (async () => {
    throw new Error('socket hang up');
  }) as FetchFn;
  await assert.rejects(
    () => fetchAa('k', TEST_MAP, { fetchFn, budgetPath, nowMs: NOW_MS }),
    (err: unknown) => err instanceof RankingFetchError && err.code === 'network_error',
  );
  assert.equal(loadBudget(budgetPath, NOW_MS).aa.used, 0);
});

test('AA client: missing key throws before any budget or network use', async () => {
  await assert.rejects(
    () => fetchAa('', TEST_MAP, { budgetPath: path.join(tmpDir(), 'b.json'), nowMs: NOW_MS }),
    (err: unknown) => err instanceof RankingFetchError && err.code === 'missing_key',
  );
});

test('BenchLM client: success uses Bearer auth on the Overall surface and records 1 read', async () => {
  const dir = tmpDir();
  const budgetPath = path.join(dir, 'budget.json');
  const seen: { url?: string; headers?: unknown } = {};
  const r = await fetchBenchlm('test-key', TEST_MAP, {
    fetchFn: stubFetch(stubResponse(200, BENCHLM_FIXTURE), seen),
    budgetPath,
    cachePath: path.join(dir, 'cache-benchlm.json'),
    nowMs: NOW_MS,
  });
  assert.equal(seen.url, 'https://data.benchlm.ai/v1/rankings/current?surface=overall&limit=250');
  assert.equal((seen.headers as Record<string, string>).Authorization, 'Bearer test-key');
  assert.equal(r.scores.get('groq:llama-3.3-70b-versatile')?.benchlm, 70);
  assert.equal(loadBudget(budgetPath, NOW_MS).benchlm.used, 1);
});

test('BenchLM client: budget exhaustion refuses without calling fetch; 401/429 handled', async () => {
  const dir = tmpDir();
  const budgetPath = path.join(dir, 'budget.json');
  const state = emptyBudget(NOW_MS);
  state.benchlm = { used: 250, month: '2026-11' };
  saveBudget(budgetPath, state);
  let called = false;
  const fetchFn: FetchFn = (async () => {
    called = true;
    return stubResponse(200, BENCHLM_FIXTURE);
  }) as FetchFn;
  await assert.rejects(
    () => fetchBenchlm('k', TEST_MAP, { fetchFn, budgetPath, nowMs: NOW_MS }),
    (err: unknown) => err instanceof RankingFetchError && err.code === 'budget_exhausted',
  );
  assert.equal(called, false);

  await assert.rejects(
    () =>
      fetchBenchlm('bad', TEST_MAP, {
        fetchFn: stubFetch(stubResponse(401, { error: 'bad key' }), {}),
        budgetPath: path.join(dir, 'b2.json'),
        nowMs: NOW_MS,
      }),
    (err: unknown) => err instanceof RankingFetchError && err.code === 'unauthorized',
  );
  await assert.rejects(
    () =>
      fetchBenchlm('k', TEST_MAP, {
        fetchFn: stubFetch(stubResponse(429, { error: 'slow' }), {}),
        budgetPath: path.join(dir, 'b3.json'),
        nowMs: NOW_MS,
      }),
    (err: unknown) => err instanceof RankingFetchError && err.code === 'rate_limited',
  );
});

test('cache: fetchFromCache replays a cached snapshot with no network or budget use', () => {
  const dir = tmpDir();
  const cachePath = path.join(dir, 'cache.json');
  fs.writeFileSync(cachePath, JSON.stringify({ source: 'aa', fetchedAt: FETCHED_AT, payload: AA_FIXTURE }));
  const r = fetchFromCache('aa', cachePath, TEST_MAP)!;
  assert.equal(r.fromCache, true);
  assert.equal(r.scores.get('groq:llama-3.3-70b-versatile')?.aa, 45);
  assert.equal(fetchFromCache('aa', path.join(dir, 'missing.json'), TEST_MAP), null);
});

// ---------------------------------------------------------------------------
// Merge + the served-document invariant
// ---------------------------------------------------------------------------

function fixtureSeed(): SeedCatalog {
  const limits = { rpm: null, rpd: null, tpm: null, tpd: null };
  return {
    version: '2026.11.10',
    models: [
      {
        platform: 'groq',
        modelId: 'llama-3.3-70b-versatile',
        displayName: 'Llama 3.3 70B Versatile',
        intelligenceRank: 120,
        speedRank: 2,
        sizeLabel: 'Large',
        limits,
        monthlyTokenBudget: null,
        contextWindow: 131072,
        enabled: true,
        supportsVision: false,
        supportsTools: true,
        premiumSince: '2026-09-01T00:00:00.000Z',
        benchmarks: { aa: 45, benchlm: 70, benchlmQuality: 'supported', livebench: 55, sourceDate: '2026-11-06T00:00:00.000Z' },
      },
      {
        platform: 'groq',
        modelId: 'llama-3.1-8b-instant',
        displayName: 'Llama 3.1 8B Instant',
        intelligenceRank: 300,
        speedRank: 1,
        sizeLabel: 'Small',
        limits,
        monthlyTokenBudget: null,
        contextWindow: 131072,
        enabled: true,
        supportsVision: false,
        supportsTools: true,
        premiumSince: '2026-10-01T00:00:00.000Z',
      },
      {
        platform: 'pollinations',
        modelId: 'flux',
        displayName: 'FLUX.1 [schnell]',
        intelligenceRank: 1,
        speedRank: 1,
        sizeLabel: 'Large',
        limits,
        monthlyTokenBudget: null,
        contextWindow: null,
        enabled: true,
        supportsVision: false,
        supportsTools: false,
        modality: 'image',
        premiumSince: '2026-09-01T00:00:00.000Z',
      },
    ],
    quirks: [],
  };
}

test('merge: seed round-trips unchanged except benchmarks/sourceDate; other sources preserved', () => {
  const seed = fixtureSeed();
  const before = JSON.parse(JSON.stringify(seed)) as SeedCatalog;
  const aa = parseAaResponse(AA_FIXTURE, TEST_MAP, FETCHED_AT);
  const benchlm = parseBenchlmResponse(BENCHLM_FIXTURE, TEST_MAP, FETCHED_AT);
  const { seed: merged, changed } = mergeBenchmarks(seed, [aa, benchlm]);

  // Only the two groq rows change; the image model is untouched.
  assert.deepEqual(changed.sort(), ['groq:llama-3.1-8b-instant', 'groq:llama-3.3-70b-versatile']);
  const untouched = merged.models.find((m) => m.modelId === 'flux')!;
  assert.deepEqual(untouched, before.models.find((m) => m.modelId === 'flux')!);

  // 3.3-70b: AA 45 (same) + BenchLM 70 (same) — values unchanged, but the
  // sourceDate moves to the newer fetch, so it counts as changed.
  const best = merged.models.find((m) => m.modelId === 'llama-3.3-70b-versatile')!;
  assert.deepEqual(best.benchmarks, {
    aa: 45,
    benchlm: 70,
    benchlmQuality: 'supported',
    livebench: 55,
    sourceDate: FETCHED_AT,
  });
  // 3.1-8b: fresh AA (slug key) + BenchLM; no prior benchmarks to preserve.
  const small = merged.models.find((m) => m.modelId === 'llama-3.1-8b-instant')!;
  assert.deepEqual(small.benchmarks, {
    aa: 30,
    benchlm: 60,
    benchlmQuality: 'estimated',
    sourceDate: FETCHED_AT,
  });
  // Every non-benchmark field is identical to before.
  for (const m of merged.models) {
    const orig = before.models.find((x) => x.modelId === m.modelId)!;
    const { benchmarks: _a, ...rest } = m;
    const { benchmarks: _b, ...origRest } = orig;
    assert.deepEqual(rest, origRest);
  }
  // The input seed was not mutated.
  assert.deepEqual(seed, before);
});

test('merge: an older incoming sourceDate never rewinds a newer stored date', () => {
  const seed = fixtureSeed();
  const oldFetch: BenchmarkInputs = { aa: 46, sourceDate: '2026-11-01T00:00:00.000Z' };
  const { seed: merged } = mergeBenchmarks(seed, [
    {
      source: 'aa',
      fetchedAt: '2026-11-01T00:00:00.000Z',
      version: 'aa-v5',
      scores: new Map([['groq:llama-3.3-70b-versatile', oldFetch]]),
      unmatched: [],
      unscored: [],
      rawCount: 1,
      matchedCount: 1,
      partial: false,
    },
  ]);
  const m = merged.models.find((x) => x.modelId === 'llama-3.3-70b-versatile')!;
  assert.equal(m.benchmarks?.aa, 46);
  assert.equal(m.benchmarks?.sourceDate, '2026-11-06T00:00:00.000Z');
});

test('merge: identical values produce no change (idempotent re-run)', () => {
  const seed = fixtureSeed();
  const same: BenchmarkInputs = {
    aa: 45,
    benchlm: 70,
    benchlmQuality: 'supported',
    livebench: 55,
    sourceDate: '2026-11-06T00:00:00.000Z',
  };
  const { changed } = mergeBenchmarks(seed, [
    {
      source: 'aa',
      fetchedAt: '2026-11-06T00:00:00.000Z',
      version: 'aa-v5',
      scores: new Map([['groq:llama-3.3-70b-versatile', same]]),
      unmatched: [],
      unscored: [],
      rawCount: 1,
      matchedCount: 1,
      partial: false,
    },
  ]);
  assert.deepEqual(changed, []);
});

test('served documents contain no benchmarks field after a merge (hard invariant)', () => {
  const seed = fixtureSeed();
  const aa = parseAaResponse(AA_FIXTURE, TEST_MAP, FETCHED_AT);
  const benchlm = parseBenchlmResponse(BENCHLM_FIXTURE, TEST_MAP, FETCHED_AT);
  const livebench = parseLivebenchSnapshot(
    [{ model: 'DeepSeek V4.1 Flash', score: 79.2, date: '2026-10-25' }],
    TEST_MAP,
    FETCHED_AT,
  );
  const { seed: merged } = mergeBenchmarks(seed, [aa, benchlm, livebench]);
  const store = new CatalogStore(merged);
  const liveJson = JSON.stringify(store.liveDocument(Date.parse('2026-11-08T00:00:00.000Z')));
  const monthlyJson = JSON.stringify(store.monthlyDocument(Date.parse('2026-11-08T00:00:00.000Z')));
  for (const json of [liveJson, monthlyJson]) {
    assert.equal(json.includes('benchmarks'), false);
    assert.equal(json.includes('"aa"'), false);
    assert.equal(json.includes('"livebench"'), false);
    assert.equal(json.includes('"benchlm"'), false);
  }
  // …and the aggregate still folded in: the scored model moved off its seed rank.
  const live = store.liveDocument(Date.parse('2026-11-08T00:00:00.000Z'));
  const ranked = live.models.find((m) => m.modelId === 'llama-3.3-70b-versatile')!;
  assert.notEqual(ranked.intelligenceRank, 120);
});
