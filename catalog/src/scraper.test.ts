import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyScrapeToSeed,
  hashModelList,
  probeServing,
  runScraper,
  ScraperStateStore,
  StubScraper,
  todayStamp,
  todayVersion,
} from './scraper.ts';
import type { CatalogScraper, ScrapeReport, VerificationResult } from './scraper.ts';
import { checkRobotsTxt, isPathAllowed, parseRobotsTxt, RobotsDisallowedError } from './scrapers/robots.ts';
import { OpenAICompatibleScraper } from './scrapers/openai-compatible.ts';
import type { ModelListEntry } from './scrapers/openai-compatible.ts';
import { isAihubmixScrapableModel } from './scrapers/aihubmix.ts';
import { isNousScrapableModel } from './scrapers/nous.ts';
import { isLlmtrFreeModel } from './scrapers/llmtr.ts';
import { AirforceScraper, isAirforceFreeChatModel } from './scrapers/airforce.ts';
import { REGISTRY, registeredPlatforms, seedPlatforms, unregisteredSeedPlatforms } from './scrapers/index.ts';
import type { SeedCatalog } from './types.ts';

// ---------- mock fetch ----------

interface MockResponseSpec {
  status: number;
  json?: unknown;
  text?: string;
}

type FetchFn = (url: string | URL, init?: unknown) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

function mockFetch(routes: Record<string, MockResponseSpec>): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchFn = async (url) => {
    const u = String(url);
    calls.push(u);
    const spec = routes[u];
    if (!spec) {
      return { ok: false, status: 404, json: async () => null, text: async () => '' };
    }
    return {
      ok: spec.status >= 200 && spec.status < 300,
      status: spec.status,
      json: async () => spec.json ?? null,
      text: async () => spec.text ?? '',
    };
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const ROBOTS_ALLOW_ALL = 'User-agent: *\nAllow: /\n';
const ROBOTS_DISALLOW_V1 = 'User-agent: *\nAllow: /\n\n# API endpoints not indexed\nDisallow: /v1/\n';

// ---------- hashModelList ----------

test('hashModelList: order-independent, stable, and sensitive to membership', () => {
  const a = hashModelList(['b-free', 'a-free', 'c:free']);
  const b = hashModelList(['a-free', 'c:free', 'b-free']);
  assert.equal(a, b);
  assert.equal(a.length, 64);
  assert.notEqual(a, hashModelList(['a-free', 'c:free']));
  assert.notEqual(a, hashModelList(['a-free', 'b-free', 'c:free', 'd-free']));
});

// ---------- robots.txt ----------

test('robots parser: AIHubMix/LLMTR/Airforce shape disallows /v1/models, allows /', () => {
  const rules = parseRobotsTxt(ROBOTS_DISALLOW_V1);
  assert.equal(isPathAllowed('/v1/models', rules), false);
  assert.equal(isPathAllowed('/v1/chat/completions', rules), false);
  assert.equal(isPathAllowed('/', rules), true);
  assert.equal(isPathAllowed('/models', rules), true);
});

test('robots parser: a group naming our user-agent wins over User-agent: *', () => {
  const text = 'User-agent: LibrePool-scraper\nAllow: /\n\nUser-agent: *\nDisallow: /v1/\n';
  const rules = parseRobotsTxt(text);
  assert.equal(isPathAllowed('/v1/models', rules), true);
});

test('robots parser: Allow longer than Disallow re-allows that path', () => {
  const rules = parseRobotsTxt('User-agent: *\nDisallow: /v1/\nAllow: /v1/models\n');
  assert.equal(isPathAllowed('/v1/models', rules), true);
  assert.equal(isPathAllowed('/v1/other', rules), false);
});

test('robots parser: empty Disallow and missing file mean allowed', () => {
  assert.equal(isPathAllowed('/v1/models', parseRobotsTxt('User-agent: *\nDisallow:\n')), true);
  assert.equal(isPathAllowed('/v1/models', parseRobotsTxt('')), true);
});

test('checkRobotsTxt: 404 (no file, like Nous) is allowed; disallow text blocks; fetch failure fails closed', async () => {
  const { fetchImpl } = mockFetch({ 'https://example.com/robots.txt': { status: 404 } });
  assert.equal((await checkRobotsTxt('https://example.com/v1/models', fetchImpl)).allowed, true);

  const blocked = mockFetch({ 'https://example.com/robots.txt': { status: 200, text: ROBOTS_DISALLOW_V1 } });
  const r2 = await checkRobotsTxt('https://example.com/v1/models', blocked.fetchImpl);
  assert.equal(r2.allowed, false);
  assert.match(r2.reason, /Disallow: \/v1\//);

  const failing = (async () => { throw new Error('boom'); }) as unknown as typeof fetch;
  const r3 = await checkRobotsTxt('https://example.com/v1/models', failing);
  assert.equal(r3.allowed, false);
  assert.match(r3.reason, /fetch failed/);
});

// ---------- concrete free-id filters (shapes from the live 2026-11-08 probes) ----------

test('aihubmix filter: -free/:free suffix, classifier excluded', () => {
  const yes = (id: string) => isAihubmixScrapableModel({ id });
  assert.equal(yes('coding-glm-5.3-free'), true);
  assert.equal(yes('meta-llama/llama-3.1-8b-instruct:free'), true);
  assert.equal(yes('nemotron-3.5-content-safety-free'), false); // classifier, not chat
  assert.equal(yes('gpt-4.1'), false);
  assert.equal(yes('qwen3.5-27b'), false);
});

test('nous filter: :free suffix only', () => {
  const yes = (id: string) => isNousScrapableModel({ id });
  assert.equal(yes('upstage/solar-mini4:free'), true);
  assert.equal(yes('meituan/longcat-2.5:free'), true);
  assert.equal(yes('upstage/solar-mini4'), false);
  assert.equal(yes('qwen3.5-27b-free'), false);
});

test('llmtr filter: zero prompt+completion pricing AND CHAT_COMPLETIONS', () => {
  const entry = (id: string, pricing: unknown, ops: unknown): ModelListEntry =>
    ({ id, pricing, supported_operations: ops }) as ModelListEntry;
  assert.equal(isLlmtrFreeModel(entry('nvidia/nemotron-3-ultra-550b-a55b', { prompt: '0', completion: '0' }, ['CHAT_COMPLETIONS'])), true);
  assert.equal(isLlmtrFreeModel(entry('agnes/agnes-3.0-flash', { prompt: '0', completion: '0', input_cache_read: '0' }, ['CHAT_COMPLETIONS'])), true);
  // Paid route: nonzero pricing.
  assert.equal(isLlmtrFreeModel(entry('openai/gpt-5.4', { prompt: '0.000002', completion: '0.00001' }, ['CHAT_COMPLETIONS'])), false);
  // Zero-priced but not chat (embeddings) — excluded from the chat list.
  assert.equal(isLlmtrFreeModel(entry('liquid/lfm-2.5-embedding-350m-free', { prompt: '0', completion: '0' }, ['EMBEDDINGS'])), false);
  // No pricing at all — unclear, excluded (conservative).
  assert.equal(isLlmtrFreeModel(entry('x/y', undefined, ['CHAT_COMPLETIONS'])), false);
});

test('airforce filter: tier free AND supports_chat; prices are not the signal', () => {
  const entry = (id: string, tier: unknown, chat: unknown, status = 'operational'): ModelListEntry =>
    ({ id, tier, supports_chat: chat, status }) as unknown as ModelListEntry;
  // kimi-k2.7-code lists 58/240 per M tokens yet is free-tier.
  assert.equal(isAirforceFreeChatModel(entry('kimi-k2.7-code', 'free', true)), true);
  assert.equal(isAirforceFreeChatModel(entry('llama-instant', 'free', true)), true);
  assert.equal(isAirforceFreeChatModel(entry('suno-v5.5', 'free', false)), false); // audio, not chat
  assert.equal(isAirforceFreeChatModel(entry('gpt-oss-120b', 'paid', true)), false);
  const scraper = new AirforceScraper({ robotsCheck: false, fetchImpl: async () => { throw new Error('unused'); } });
  const notesForList = (scraper as unknown as {
    notesForList: (entries: ModelListEntry[], freeIds: string[]) => string[];
  }).notesForList;
  assert.deepEqual(
    notesForList(
      [entry('a', 'free', true, 'operational'), entry('b', 'free', true, 'major_outage'), entry('c', 'paid', true, 'operational')],
      ['a', 'b'],
    ),
    ['Airforce free chat: 1/2 operational, 1 reporting non-operational status (e.g. major_outage)'],
  );
});

// ---------- OpenAICompatibleScraper with mocked fetch ----------

function listFetch(list: ModelListEntry[], robotsText: string = ROBOTS_ALLOW_ALL) {
  return mockFetch({
    'https://example.com/robots.txt': { status: 200, text: robotsText },
    'https://example.com/v1/models': { status: 200, json: { data: list } },
  });
}

test('generic scraper: poll diffs against previous ids, null when unchanged, verifies from cache', async () => {
  const list: ModelListEntry[] = [{ id: 'a-free' }, { id: 'b-paid' }, { id: 'c:free' }];
  const { fetchImpl, calls } = listFetch(list);
  const scraper = new OpenAICompatibleScraper({
    platform: 'demo', baseUrl: 'https://example.com/v1',
    freeFilter: (e) => e.id.endsWith('-free') || e.id.endsWith(':free'),
    fetchImpl,
  });

  const first = await scraper.poll(null, []);
  assert.ok(first);
  assert.deepEqual(first.addedModelIds, ['a-free', 'c:free']);
  assert.deepEqual(first.removedModelIds, []);
  assert.equal(first.listHash, hashModelList(['a-free', 'c:free']));

  // Unchanged: same hash → null, and no second models fetch (cache).
  const modelsCallsBefore = calls.filter((u) => u.endsWith('/models')).length;
  assert.equal(await scraper.poll(first.listHash, ['a-free', 'c:free']), null);
  assert.equal(calls.filter((u) => u.endsWith('/models')).length, modelsCallsBefore);

  // verify() reuses the cached list — no extra fetch.
  assert.equal(await scraper.verify('a-free'), true);
  assert.equal(await scraper.verify('b-paid'), false);
  const v = await scraper.verifyDetailed('c:free');
  assert.equal(v.level, 'list-verified');
  assert.equal((await scraper.verifyDetailed('b-paid')).level, 'unverified');
  assert.equal(calls.filter((u) => u.endsWith('/models')).length, modelsCallsBefore);
});

test('generic scraper: poll reports removals against previous ids', async () => {
  const { fetchImpl } = listFetch([{ id: 'a-free' }, { id: 'd-free' }]);
  const scraper = new OpenAICompatibleScraper({
    platform: 'demo', baseUrl: 'https://example.com/v1',
    freeFilter: (e) => e.id.endsWith('-free'),
    fetchImpl,
  });
  const change = await scraper.poll('old-hash', ['a-free', 'gone-free']);
  assert.ok(change);
  assert.deepEqual(change.addedModelIds, ['d-free']);
  assert.deepEqual(change.removedModelIds, ['gone-free']);
});

test('generic scraper: accepts a bare-array list (Typhoon shape) as well as {data: [...]}', async () => {
  const { fetchImpl } = mockFetch({
    'https://example.com/robots.txt': { status: 200, text: ROBOTS_ALLOW_ALL },
    // Bare array, no "data" wrapper.
    'https://example.com/v1/models': { status: 200, json: [{ id: 'typhoon-v2.5-30b-a3b-instruct' }, { id: 'typhoon-ocr' }] },
  });
  const scraper = new OpenAICompatibleScraper({
    platform: 'demo', baseUrl: 'https://example.com/v1',
    freeFilter: (e) => e.id === 'typhoon-v2.5-30b-a3b-instruct',
    fetchImpl,
  });
  const change = await scraper.poll(null, []);
  assert.ok(change);
  assert.deepEqual(change.addedModelIds, ['typhoon-v2.5-30b-a3b-instruct']);
});

test('generic scraper: robots-disallowed list throws RobotsDisallowedError; HTTP failure throws', async () => {
  const blocked = listFetch([{ id: 'a-free' }], ROBOTS_DISALLOW_V1);
  const scraper = new OpenAICompatibleScraper({
    platform: 'demo', baseUrl: 'https://example.com/v1',
    freeFilter: () => true, fetchImpl: blocked.fetchImpl,
  });
  await assert.rejects(() => scraper.poll(null, []), (err: unknown) => err instanceof RobotsDisallowedError);

  const failing = mockFetch({
    'https://example.com/robots.txt': { status: 200, text: ROBOTS_ALLOW_ALL },
    'https://example.com/v1/models': { status: 500, json: { error: 'x' } },
  });
  const scraper2 = new OpenAICompatibleScraper({
    platform: 'demo', baseUrl: 'https://example.com/v1',
    freeFilter: () => true, fetchImpl: failing.fetchImpl,
  });
  await assert.rejects(() => scraper2.poll(null, []), /HTTP 500/);

  const malformed = mockFetch({
    'https://example.com/robots.txt': { status: 200, text: ROBOTS_ALLOW_ALL },
    'https://example.com/v1/models': { status: 200, json: { models: [] } },
  });
  const scraper3 = new OpenAICompatibleScraper({
    platform: 'demo', baseUrl: 'https://example.com/v1',
    freeFilter: () => true, fetchImpl: malformed.fetchImpl,
  });
  await assert.rejects(() => scraper3.poll(null, []), /no usable "data" array/);
});

// ---------- ScraperStateStore ----------

test('ScraperStateStore: round-trips per-platform state; missing/corrupt file starts empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-state-'));
  const file = path.join(dir, 'scraper-state.json');
  const store = new ScraperStateStore(file);
  assert.equal(store.get('nous'), null);
  store.set('nous', { lastHash: 'abc', lastCheckedAt: '2026-11-08T00:00:00.000Z', lastModelIds: ['x:free'] });
  store.save();

  const reloaded = new ScraperStateStore(file);
  assert.deepEqual(reloaded.get('nous'), { lastHash: 'abc', lastCheckedAt: '2026-11-08T00:00:00.000Z', lastModelIds: ['x:free'] });
  assert.deepEqual(reloaded.platforms(), ['nous']);

  fs.writeFileSync(file, '{not json', 'utf8');
  assert.equal(new ScraperStateStore(file).get('nous'), null); // corrupt → empty, no throw
});

// ---------- runScraper ----------

function fakeScraper(outcome: { change?: { listHash: string; added: string[]; removed: string[] } | null; error?: Error }): CatalogScraper {
  return {
    source: { platform: 'demo', listUrl: 'https://example.com/v1/models', kind: 'official-api', intervalMs: 1000 },
    async poll() {
      if (outcome.error) throw outcome.error;
      if (outcome.change === null || outcome.change === undefined) return null;
      return {
        platform: 'demo', listHash: outcome.change.listHash,
        addedModelIds: outcome.change.added, removedModelIds: outcome.change.removed,
        checkedAt: '2026-11-08T00:00:00.000Z',
      };
    },
    async verify(modelId: string) { return modelId === 'new-free'; },
  };
}

test('runScraper: unchanged, changed+verified, robots-skipped, error', async () => {
  const unchanged = await runScraper(fakeScraper({ change: null }), { lastHash: 'h', lastCheckedAt: 'x', lastModelIds: [] }, []);
  assert.equal(unchanged.status, 'unchanged');
  assert.deepEqual(unchanged.addedModelIds, []);

  const changed = await runScraper(
    fakeScraper({ change: { listHash: 'h2', added: ['new-free', 'ghost-free'], removed: ['old-free'] } }),
    { lastHash: 'h', lastCheckedAt: 'x', lastModelIds: ['old-free'] },
    ['old-free'],
  );
  assert.equal(changed.status, 'changed');
  assert.deepEqual(changed.addedModelIds, ['new-free', 'ghost-free']);
  assert.deepEqual(changed.removedModelIds, ['old-free']);
  const levels = new Map(changed.verification.map((v) => [v.modelId, v.level]));
  assert.equal(levels.get('new-free'), 'list-verified');
  assert.equal(levels.get('ghost-free'), 'unverified');

  const skipped = await runScraper(
    fakeScraper({ error: new RobotsDisallowedError('https://example.com/v1/models', 'https://example.com/robots.txt', 'Disallow: /v1/') }),
    null, [],
  );
  assert.equal(skipped.status, 'skipped');
  assert.match(skipped.skippedReason ?? '', /robots\.txt disallows/);

  const errored = await runScraper(fakeScraper({ error: new Error('GET failed') }), null, []);
  assert.equal(errored.status, 'error');
  assert.equal(errored.error, 'GET failed');
});

test('runScraper: first run diffs the live list against the seed baseline', async () => {
  const { fetchImpl } = listFetch([{ id: 'seed-free' }, { id: 'brand-new-free' }]);
  const scraper = new OpenAICompatibleScraper({
    platform: 'demo', baseUrl: 'https://example.com/v1',
    freeFilter: (e) => e.id.endsWith('-free'),
    fetchImpl,
  });
  const report = await runScraper(scraper, null, ['seed-free']);
  assert.equal(report.status, 'changed');
  assert.deepEqual(report.addedModelIds, ['brand-new-free']);
  assert.deepEqual(report.removedModelIds, []);
  assert.ok(report.notes?.some((n) => n.includes('seed catalog baseline')));
});

// ---------- stamping / apply ----------

test('todayStamp/todayVersion use the UTC date', () => {
  const ms = Date.parse('2026-11-08T23:30:00-08:00'); // 2026-11-09 UTC
  assert.equal(todayStamp(ms), '2026-11-09T00:00:00.000Z');
  assert.equal(todayVersion(ms), '2026.11.09');
});

function testSeed(): SeedCatalog {
  return {
    version: '2026.11.08',
    models: [
      { platform: 'nous', modelId: 'upstage/solar-mini4:free', displayName: 'Solar', intelligenceRank: 500, speedRank: 5, sizeLabel: 'Medium', limits: { rpm: 50, rpd: null, tpm: 500000, tpd: null }, monthlyTokenBudget: null, contextWindow: null, enabled: true, supportsVision: false, supportsTools: true, premiumSince: '2026-11-08T00:00:00.000Z' },
    ],
    quirks: [],
  };
}

function report(platform: string, added: string[], removed: string[], ver: VerificationResult[]): ScrapeReport {
  return {
    platform, listUrl: `https://example.com/v1/models`, kind: 'official-api', status: 'changed',
    checkedAt: '2026-11-09T00:00:00.000Z', listHash: 'h2', previousHash: 'h1',
    addedModelIds: added, removedModelIds: removed, verification: ver,
  };
}

test('applyScrapeToSeed: adds verified with today stamp + version bump; never deletes removals', () => {
  const seed = testSeed();
  const nowMs = Date.parse('2026-11-09T12:00:00.000Z');
  const result = applyScrapeToSeed(seed, [
    report('nous', ['stepfun/step-3.7-flash:free', 'unverified-free', 'upstage/solar-mini4:free'], ['upstage/solar-mini4:free'], [
      { modelId: 'stepfun/step-3.7-flash:free', level: 'list-verified', checkedAt: '2026-11-09T00:00:00.000Z', detail: 'x' },
      { modelId: 'unverified-free', level: 'unverified', checkedAt: '2026-11-09T00:00:00.000Z', detail: 'x' },
    ]),
  ], nowMs);

  assert.deepEqual(result.added, [{ platform: 'nous', modelId: 'stepfun/step-3.7-flash:free' }]);
  assert.deepEqual(result.skipped.map((s) => s.modelId).sort(), ['unverified-free', 'upstage/solar-mini4:free']);
  assert.deepEqual(result.removedReported, [{ platform: 'nous', modelId: 'upstage/solar-mini4:free' }]);
  // The "removed" model is still in the seed — removals are reported, never deleted.
  assert.ok(result.seed.models.some((m) => m.modelId === 'upstage/solar-mini4:free'));
  const addedRow = result.seed.models.find((m) => m.modelId === 'stepfun/step-3.7-flash:free');
  assert.equal(addedRow?.premiumSince, '2026-11-09T00:00:00.000Z');
  assert.equal(addedRow?.intelligenceRank, 500);
  assert.equal(result.seed.version, '2026.11.09');
  // Input untouched.
  assert.equal(seed.models.length, 1);
  assert.equal(seed.version, '2026.11.08');
});

test('applyScrapeToSeed: nothing added → version untouched', () => {
  const seed = testSeed();
  const result = applyScrapeToSeed(seed, [report('nous', [], [], [])], Date.parse('2026-11-09T00:00:00.000Z'));
  assert.deepEqual(result.added, []);
  assert.equal(result.seed.version, '2026.11.08');
});

// ---------- serving probe ----------

test('probeServing: no key means not attempted (no fetch); mocked success is serving-verified', async () => {
  let calls = 0;
  const counting = (async () => { calls += 1; throw new Error('should not be called'); }) as unknown as typeof fetch;
  const noKey = await probeServing('https://example.com/v1', 'x:free', '', counting);
  assert.equal(noKey.level, 'unverified');
  assert.equal(calls, 0);

  const ok = mockFetch({
    'https://example.com/v1/chat/completions': { status: 200, json: { choices: [{ message: { content: 'hi' } }] } },
  });
  const verified = await probeServing('https://example.com/v1', 'x:free', 'sk-test-key', ok.fetchImpl as unknown as typeof fetch);
  assert.equal(verified.level, 'serving-verified');

  const denied = mockFetch({
    'https://example.com/v1/chat/completions': { status: 401, json: { error: 'bad key' } },
  });
  const unverified = await probeServing('https://example.com/v1', 'x:free', 'sk-bad-key', denied.fetchImpl as unknown as typeof fetch);
  assert.equal(unverified.level, 'unverified');
  assert.match(unverified.detail, /HTTP 401/);
});

// ---------- registry coverage ----------

test('registry: every seed platform is registered; stubs carry a reason; no platform left out', () => {
  const seedPath = new URL('../data/seed-catalog.json', import.meta.url);
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8')) as SeedCatalog;
  const platforms = seedPlatforms(seed);
  assert.deepEqual(unregisteredSeedPlatforms(seed), []);
  assert.equal(platforms.length, 25);
  assert.deepEqual(registeredPlatforms(), platforms);
  for (const p of platforms) {
    const entry = REGISTRY[p];
    assert.ok(entry, `missing registry entry for ${p}`);
    if (entry.kind === 'stub') {
      assert.ok(entry.reason && entry.reason.length > 0, `${p} stub needs a reason`);
      assert.equal(entry.listUrl, null);
      assert.equal(entry.intervalMs, 0);
    } else {
      assert.ok(entry.listUrl?.endsWith('/models'), `${p} needs a /models list URL`);
      assert.ok(entry.intervalMs > 0, `${p} needs a poll interval`);
    }
  }
  const kinds = Object.values(REGISTRY).map((e) => e.kind);
  assert.equal(kinds.filter((k) => k === 'concrete').length, 4);
  assert.equal(kinds.filter((k) => k === 'generic').length, 14);
  assert.equal(kinds.filter((k) => k === 'stub').length, 7);
});

test('registry: stub scrapers always report no change', async () => {
  const groq = REGISTRY.groq.create();
  assert.ok(groq instanceof StubScraper);
  assert.equal(await groq.poll(null, []), null);
  assert.equal(await groq.verify('llama-3.3-70b-versatile'), false);
});
