import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMonthlySnapshot, FREE_LAG_MS, isFreeVisible } from './snapshot.ts';
import type { Catalog } from './types.ts';

const NOW = Date.parse('2026-11-07T00:00:00.000Z');
// 15-day cutoff at NOW is 2026-10-23T00:00:00Z.
assert.equal(FREE_LAG_MS, 15 * 24 * 60 * 60 * 1000);

test('isFreeVisible: absent premiumSince is always free', () => {
  assert.equal(isFreeVisible(undefined, NOW), true);
  assert.equal(isFreeVisible(null, NOW), true);
});

test('isFreeVisible: exactly 15 days old is free, one second younger is not', () => {
  assert.equal(isFreeVisible('2026-10-23T00:00:00.000Z', NOW), true);
  assert.equal(isFreeVisible('2026-10-23T00:00:01.000Z', NOW), false);
  assert.equal(isFreeVisible('2026-11-06T00:00:00.000Z', NOW), false);
});

test('isFreeVisible: unreadable stamp fails open (already-listed entry stays)', () => {
  assert.equal(isFreeVisible('not-a-date', NOW), true);
});

function liveDoc(): Catalog {
  const limits = { rpm: null, rpd: null, tpm: null, tpd: null };
  return {
    version: '2026.11.06',
    generatedAt: '2026-11-06T00:00:00.000Z',
    tier: 'live',
    models: [
      { platform: 'groq', modelId: 'old-chat', displayName: 'Old', intelligenceRank: 100, speedRank: 1, sizeLabel: 'Small', limits, monthlyTokenBudget: null, contextWindow: null, enabled: true, supportsVision: false, supportsTools: true, premiumSince: '2026-09-01T00:00:00.000Z' },
      { platform: 'groq', modelId: 'new-chat', displayName: 'New', intelligenceRank: 100, speedRank: 1, sizeLabel: 'Small', limits, monthlyTokenBudget: null, contextWindow: null, enabled: true, supportsVision: false, supportsTools: true, premiumSince: '2026-11-05T00:00:00.000Z' },
      { platform: 'mistral', modelId: 'grandfathered', displayName: 'Grandfathered', intelligenceRank: 100, speedRank: 1, sizeLabel: 'Small', limits, monthlyTokenBudget: null, contextWindow: null, enabled: true, supportsVision: false, supportsTools: true },
    ],
    embeddings: [
      { family: 'f', platform: 'google', modelId: 'old-emb', displayName: 'Old Emb', dimensions: 768, maxInputTokens: null, priority: 1, enabled: true, quotaLabel: '', premiumSince: '2026-09-01T00:00:00.000Z' },
      { family: 'f', platform: 'google', modelId: 'new-emb', displayName: 'New Emb', dimensions: 768, maxInputTokens: null, priority: 2, enabled: true, quotaLabel: '', premiumSince: '2026-11-02T00:00:00.000Z' },
    ],
    transcriptionModels: [
      { platform: 'mistral', modelId: 'old-stt', displayName: 'Old STT', priority: 1, enabled: true, premiumSince: '2026-10-10T00:00:00.000Z' },
      { platform: 'groq', modelId: 'new-stt', displayName: 'New STT', priority: 2, enabled: true, premiumSince: '2026-11-03T00:00:00.000Z' },
    ],
    videoModels: [
      { platform: 'pollinations', modelId: 'old-video', displayName: 'Old Video', priority: 1, enabled: true, premiumSince: '2026-10-20T00:00:00.000Z' },
    ],
    searchEngines: [
      { platform: 'tavily', engineId: 'old-search', displayName: 'Old Search', priority: 1, enabled: true, premiumSince: '2026-09-01T00:00:00.000Z' },
      { platform: 'exa', engineId: 'new-search', displayName: 'New Search', priority: 2, enabled: true, premiumSince: '2026-11-04T00:00:00.000Z' },
    ],
    decisionModels: [
      { platform: 'cloudflare', modelId: 'old-decision', displayName: 'Old Decision', priority: 1, enabled: true, premiumSince: '2026-10-05T00:00:00.000Z' },
      { platform: 'cloudflare', modelId: 'new-decision', displayName: 'New Decision', priority: 2, enabled: true, premiumSince: '2026-11-06T00:00:00.000Z' },
    ],
    quirks: [],
  };
}

test('monthly snapshot keeps only entries 15+ days old, in every section', () => {
  const monthly = buildMonthlySnapshot(liveDoc(), NOW);
  assert.equal(monthly.tier, 'monthly');
  assert.equal(monthly.version, '2026.11.06');
  assert.deepEqual(monthly.models.map((m) => m.modelId).sort(), ['grandfathered', 'old-chat']);
  assert.deepEqual((monthly.embeddings ?? []).map((m) => m.modelId), ['old-emb']);
  assert.deepEqual((monthly.transcriptionModels ?? []).map((m) => m.modelId), ['old-stt']);
  assert.deepEqual((monthly.videoModels ?? []).map((m) => m.modelId), ['old-video']);
  assert.deepEqual((monthly.searchEngines ?? []).map((m) => m.engineId), ['old-search']);
  assert.deepEqual((monthly.decisionModels ?? []).map((m) => m.modelId), ['old-decision']);
});

test('monthly snapshot coerces a null monthlyTokenBudget to empty string', () => {
  const monthly = buildMonthlySnapshot(liveDoc(), NOW);
  // The router's models.monthly_token_budget is TEXT NOT NULL DEFAULT '' —
  // a null budget in the served document would fail the whole sync.
  for (const m of monthly.models) {
    assert.equal(typeof m.monthlyTokenBudget, 'string');
  }
  assert.equal(monthly.models.find((m) => m.modelId === 'old-chat')!.monthlyTokenBudget, '');
});

test('monthly snapshot names live-only platforms in managedPlatforms', () => {
  const monthly = buildMonthlySnapshot(liveDoc(), NOW);
  // groq (new-chat, new-stt), google (new-emb), exa (new-search),
  // cloudflare (new-decision) still have live-only rows; mistral/tavily/
  // pollinations do not.
  assert.deepEqual(monthly.managedPlatforms, ['cloudflare', 'exa', 'google', 'groq']);
});

test('monthly snapshot strips feed-internal fields from chat models', () => {
  const doc = liveDoc();
  doc.models[0].benchmarks = { aa: 50, livebench: 50, benchlm: 50 };
  const monthly = buildMonthlySnapshot(doc, NOW);
  const old = monthly.models.find((m) => m.modelId === 'old-chat')!;
  assert.equal('premiumSince' in old, false);
  assert.equal('benchmarks' in old, false);
  // Search/decision entries keep premiumSince (the router stores it).
  assert.equal(monthly.searchEngines![0].premiumSince, '2026-09-01T00:00:00.000Z');
  assert.equal(monthly.decisionModels![0].premiumSince, '2026-10-05T00:00:00.000Z');
});
