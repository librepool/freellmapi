/**
 * Benchmarked ranking — feed-side aggregate folded into intelligenceRank.
 *
 * Sources (never mix versions): Artificial Analysis Intelligence Index v5,
 * LiveBench 2.0 Overall, BenchLM BenchAlign v5.8 Overall.
 *
 * Rules (feature-parity audit §(c)2):
 *  - Per-source min-max normalization PER SNAPSHOT (raw scores are not
 *    comparable: AA tops out ~60, BenchLM ~89, LiveBench ~86).
 *  - Weights: AA 45% / LiveBench 30% / BenchLM 25%. BenchLM is a
 *    meta-aggregator that ingests AA + LiveBench-family data, so it is
 *    deliberately the smallest weight (double-counting guard).
 *  - Missing = null, never 0; weights renormalize over available sources.
 *  - 0 sources = Unranked: served only in cheapest/best-effort tiers, never
 *    promoted above a scored model on quality grounds (the router keeps its
 *    seed intelligenceRank for such models).
 *  - Confidence: High = all 3 sources, or AA + LiveBench; Medium = AA +
 *    BenchLM, or LiveBench + BenchLM, or BenchLM Supported-only (2-source
 *    cases without AA+LiveBench); Low = a single source, or BenchLM
 *    Estimated-only. Stale source data (>30 days) decays confidence one
 *    level. Same-family proxy: inherit the LOWEST scored sibling, marked
 *    proxy, Low confidence — never the best sibling.
 *
 * HARD RULE: the feed carries ONLY the aggregate rank in intelligenceRank.
 * Per-source AA / BenchLM / LiveBench scores must NEVER enter the catalog
 * JSON. `stripBenchmarks` / `applyBenchmarkRanks` enforce this: the served
 * document contains no `benchmarks` field anywhere.
 */
import type { BenchmarkInputs, CatalogModel } from './types.ts';

export type Confidence = 'High' | 'Medium' | 'Low' | 'Unranked';

export const RANK_WEIGHTS = { aa: 0.45, livebench: 0.3, benchlm: 0.25 } as const;

export const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export interface AggregateResult {
  /** Weighted normalized aggregate, 0..1, or null when no source scored it. */
  score: number | null;
  confidence: Confidence;
  /** Sources that contributed (after the missing=null rule). */
  sources: Array<'aa' | 'livebench' | 'benchlm'>;
  /** True when this rank was inherited from a same-family sibling. */
  proxy?: boolean;
}

type SourceKey = 'aa' | 'livebench' | 'benchlm';

function minMax(values: number[]): { min: number; max: number } | null {
  if (values.length === 0) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
}

function normalize(value: number, range: { min: number; max: number }): number {
  if (range.max === range.min) return 1; // single distinct value: top of its range
  return (value - range.min) / (range.max - range.min);
}

function decayOneLevel(c: Confidence): Confidence {
  if (c === 'High') return 'Medium';
  if (c === 'Medium') return 'Low';
  return c;
}

export function confidenceFor(inputs: BenchmarkInputs, sources: SourceKey[]): Confidence {
  const has = (s: SourceKey): boolean => sources.includes(s);
  let c: Confidence;
  if (sources.length === 0) {
    c = 'Unranked';
  } else if (sources.length === 3 || (has('aa') && has('livebench'))) {
    c = 'High';
  } else if (sources.length === 2) {
    c = 'Medium';
  } else if (has('benchlm') && inputs.benchlmQuality === 'estimated') {
    c = 'Low';
  } else if (has('benchlm') && inputs.benchlmQuality === 'supported') {
    c = 'Medium';
  } else {
    c = 'Low';
  }
  // Stale source data decays confidence one level (never below Low, and
  // Unranked stays Unranked).
  if (c !== 'Unranked' && c !== 'Low' && inputs.sourceDate) {
    const age = Date.now() - Date.parse(inputs.sourceDate);
    if (Number.isFinite(age) && age > STALE_AFTER_MS) c = decayOneLevel(c);
  }
  return c;
}

/**
 * Aggregate one model's benchmark inputs against a snapshot's per-source
 * ranges. `ranges` come from the whole snapshot (see aggregateSnapshot).
 */
export function aggregateOne(
  inputs: BenchmarkInputs,
  ranges: Record<SourceKey, { min: number; max: number } | null>,
): AggregateResult {
  const sources: SourceKey[] = [];
  let weighted = 0;
  let weightSum = 0;
  const entries: Array<[SourceKey, number | null]> = [
    ['aa', inputs.aa ?? null],
    ['livebench', inputs.livebench ?? null],
    ['benchlm', inputs.benchlm ?? null],
  ];
  for (const [key, raw] of entries) {
    if (raw === null || raw === undefined) continue;
    const range = ranges[key];
    if (!range) continue;
    sources.push(key);
    weighted += RANK_WEIGHTS[key] * normalize(raw, range);
    weightSum += RANK_WEIGHTS[key];
  }
  if (sources.length === 0 || weightSum === 0) {
    return { score: null, confidence: 'Unranked', sources: [] };
  }
  return { score: weighted / weightSum, confidence: confidenceFor(inputs, sources), sources };
}

/**
 * Aggregate every model in a snapshot. Normalization ranges are computed
 * per source across ALL models that carry that source (the snapshot), not
 * per provider — cross-provider comparability is the point; the
 * within-provider intelligenceRank mapping happens in applyBenchmarkRanks.
 */
export function aggregateSnapshot(
  models: Array<{ key: string; benchmarks?: BenchmarkInputs }>,
): Map<string, AggregateResult> {
  const ranges: Record<SourceKey, { min: number; max: number } | null> = {
    aa: minMax(models.map((m) => m.benchmarks?.aa).filter((v): v is number => typeof v === 'number')),
    livebench: minMax(models.map((m) => m.benchmarks?.livebench).filter((v): v is number => typeof v === 'number')),
    benchlm: minMax(models.map((m) => m.benchmarks?.benchlm).filter((v): v is number => typeof v === 'number')),
  };
  const out = new Map<string, AggregateResult>();
  for (const m of models) {
    out.set(m.key, m.benchmarks ? aggregateOne(m.benchmarks, ranges) : { score: null, confidence: 'Unranked', sources: [] });
  }
  return out;
}

/**
 * Same-family proxy: a model with no benchmark sources inherits the LOWEST
 * scored sibling in its family (same platform + same model family prefix),
 * marked proxy, Low confidence. Never the best sibling.
 */
export function proxyFromSiblings(
  siblings: AggregateResult[],
): AggregateResult | null {
  const scored = siblings.filter((s) => s.score !== null);
  if (scored.length === 0) return null;
  const lowest = scored.reduce((a, b) => (a.score! <= b.score! ? a : b));
  return { score: lowest.score, confidence: 'Low', sources: [...lowest.sources], proxy: true };
}

/** Map a 0..1 aggregate to the router's within-provider intelligenceRank
 *  (1 = best, 1000 = worst). */
export function toIntelligenceRank(score: number): number {
  const clamped = Math.min(1, Math.max(0, score));
  return 1 + Math.round((1 - clamped) * 999);
}

/**
 * Fold benchmark aggregates into intelligenceRank for a catalog's chat
 * models, per provider. Within each platform the aggregates are re-scaled
 * 0..1 (best scored model on that platform = 1) so the rank stays a
 * within-provider rank, matching the router's semantics. Models with no
 * aggregate keep their seed intelligenceRank. The returned models carry NO
 * `benchmarks` field — per-source scores never enter the catalog JSON.
 */
export function applyBenchmarkRanks(models: CatalogModel[]): CatalogModel[] {
  const chatModels = models.filter((m) => (m.modality ?? 'text') === 'text');
  const aggregates = aggregateSnapshot(
    chatModels.map((m) => ({ key: `${m.platform}:${m.modelId}`, benchmarks: m.benchmarks })),
  );
  // Within-provider rescale: best aggregate on the platform maps to 1.
  const bestByPlatform = new Map<string, number>();
  for (const m of chatModels) {
    const agg = aggregates.get(`${m.platform}:${m.modelId}`);
    if (agg?.score !== null && agg?.score !== undefined) {
      bestByPlatform.set(m.platform, Math.max(bestByPlatform.get(m.platform) ?? -Infinity, agg.score));
    }
  }
  return models.map((m) => {
    const { benchmarks: _drop, ...rest } = m;
    if ((m.modality ?? 'text') !== 'text') return rest as CatalogModel;
    const agg = aggregates.get(`${m.platform}:${m.modelId}`);
    if (!agg || agg.score === null) return rest as CatalogModel;
    const best = bestByPlatform.get(m.platform) ?? agg.score;
    const within = best > 0 ? agg.score / best : agg.score;
    return { ...rest, intelligenceRank: toIntelligenceRank(within) };
  });
}
