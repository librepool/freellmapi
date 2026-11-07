import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateOne,
  aggregateSnapshot,
  applyBenchmarkRanks,
  confidenceFor,
  proxyFromSiblings,
  toIntelligenceRank,
} from './ranking.ts';
import type { BenchmarkInputs } from './types.ts';

const RANGES = {
  aa: { min: 0, max: 60 },
  livebench: { min: 0, max: 86 },
  benchlm: { min: 0, max: 89 },
};

test('all three sources at max normalize to 1.0 with High confidence', () => {
  const r = aggregateOne({ aa: 60, livebench: 86, benchlm: 89 }, RANGES);
  assert.equal(r.score, 1);
  assert.equal(r.confidence, 'High');
  assert.deepEqual(r.sources, ['aa', 'livebench', 'benchlm']);
});

test('all three sources at min normalize to 0 with High confidence', () => {
  const r = aggregateOne({ aa: 0, livebench: 0, benchlm: 0 }, RANGES);
  assert.equal(r.score, 0);
  assert.equal(r.confidence, 'High');
});

test('missing sources are null, never 0: weights renormalize', () => {
  // AA only, mid-range: (0.45 * 0.5) / 0.45 = 0.5 — not dragged down by absent sources.
  const r = aggregateOne({ aa: 30 }, RANGES);
  assert.equal(r.score, 0.5);
  assert.equal(r.confidence, 'Low');
  // AA + LiveBench at max, no BenchLM: (0.45 + 0.30) / 0.75 = 1.
  const r2 = aggregateOne({ aa: 60, livebench: 86 }, RANGES);
  assert.equal(r2.score, 1);
  assert.equal(r2.confidence, 'High');
});

test('weights are AA 45 / LiveBench 30 / BenchLM 25', () => {
  // aa=60 (norm 1), livebench=0 (norm 0), benchlm=0 (norm 0) → 0.45.
  const r = aggregateOne({ aa: 60, livebench: 0, benchlm: 0 }, RANGES);
  assert.equal(r.score, 0.45);
});

test('no sources = Unranked with null score', () => {
  const r = aggregateOne({}, RANGES);
  assert.equal(r.score, null);
  assert.equal(r.confidence, 'Unranked');
  assert.deepEqual(r.sources, []);
});

test('confidence matrix', () => {
  const inputs: BenchmarkInputs = {};
  assert.equal(confidenceFor(inputs, []), 'Unranked');
  assert.equal(confidenceFor(inputs, ['aa', 'livebench']), 'High');
  assert.equal(confidenceFor(inputs, ['aa', 'benchlm']), 'Medium');
  assert.equal(confidenceFor(inputs, ['livebench', 'benchlm']), 'Medium');
  assert.equal(confidenceFor(inputs, ['aa']), 'Low');
  assert.equal(confidenceFor({ benchlmQuality: 'supported' }, ['benchlm']), 'Medium');
  assert.equal(confidenceFor({ benchlmQuality: 'estimated' }, ['benchlm']), 'Low');
});

test('stale source data decays confidence one level', () => {
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  const r = aggregateOne({ aa: 60, livebench: 86, benchlm: 89, sourceDate: old }, RANGES);
  assert.equal(r.confidence, 'Medium'); // High decayed one level
  const fresh = new Date().toISOString();
  assert.equal(aggregateOne({ aa: 60, livebench: 86, benchlm: 89, sourceDate: fresh }, RANGES).confidence, 'High');
});

test('per-source min-max normalization is per snapshot, not raw averages', () => {
  const snap = aggregateSnapshot([
    { key: 'a', benchmarks: { aa: 60, livebench: 86, benchlm: 89 } },
    { key: 'b', benchmarks: { aa: 0, livebench: 0, benchlm: 0 } },
    { key: 'c', benchmarks: { aa: 30 } },
  ]);
  assert.equal(snap.get('a')!.score, 1);
  assert.equal(snap.get('b')!.score, 0);
  assert.equal(snap.get('c')!.score, 0.5);
});

test('same-family proxy inherits the LOWEST scored sibling, Low confidence', () => {
  const best = { score: 0.9, confidence: 'High' as const, sources: ['aa' as const, 'livebench' as const] };
  const worst = { score: 0.2, confidence: 'High' as const, sources: ['aa' as const, 'livebench' as const] };
  const p = proxyFromSiblings([best, worst]);
  assert.equal(p!.score, 0.2);
  assert.equal(p!.confidence, 'Low');
  assert.equal(p!.proxy, true);
  assert.equal(proxyFromSiblings([{ score: null, confidence: 'Unranked', sources: [] }]), null);
});

test('toIntelligenceRank maps 1 → 1 (best), 0 → 1000 (worst)', () => {
  assert.equal(toIntelligenceRank(1), 1);
  assert.equal(toIntelligenceRank(0), 1000);
  assert.equal(toIntelligenceRank(0.5), 501);
});

test('applyBenchmarkRanks folds the aggregate in and strips per-source scores', () => {
  const limits = { rpm: null, rpd: null, tpm: null, tpd: null };
  const models = [
    { platform: 'groq', modelId: 'best', displayName: 'Best', intelligenceRank: 500, speedRank: 1, sizeLabel: 'Small', limits, monthlyTokenBudget: null, contextWindow: null, enabled: true, supportsVision: false, supportsTools: true, premiumSince: '2026-09-01T00:00:00.000Z', benchmarks: { aa: 60, livebench: 86, benchlm: 89 } },
    { platform: 'groq', modelId: 'worst', displayName: 'Worst', intelligenceRank: 500, speedRank: 1, sizeLabel: 'Small', limits, monthlyTokenBudget: null, contextWindow: null, enabled: true, supportsVision: false, supportsTools: true, premiumSince: '2026-09-01T00:00:00.000Z', benchmarks: { aa: 0, livebench: 0, benchlm: 0 } },
    { platform: 'groq', modelId: 'unranked', displayName: 'Unranked', intelligenceRank: 777, speedRank: 1, sizeLabel: 'Small', limits, monthlyTokenBudget: null, contextWindow: null, enabled: true, supportsVision: false, supportsTools: true, premiumSince: '2026-09-01T00:00:00.000Z' },
  ];
  const ranked = applyBenchmarkRanks(models);
  assert.equal(ranked.find((m) => m.modelId === 'best')!.intelligenceRank, 1);
  assert.equal(ranked.find((m) => m.modelId === 'worst')!.intelligenceRank, 1000);
  // Unranked keeps its seed rank — never promoted above a scored model.
  assert.equal(ranked.find((m) => m.modelId === 'unranked')!.intelligenceRank, 777);
  // HARD RULE: no per-source scores anywhere in the served JSON.
  const json = JSON.stringify(ranked);
  assert.equal(json.includes('benchmarks'), false);
  assert.equal(json.includes('"aa"'), false);
  assert.equal(json.includes('"livebench"'), false);
  assert.equal(json.includes('"benchlm"'), false);
});
