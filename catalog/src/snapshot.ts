/**
 * The 15-day free snapshot.
 *
 * LibrePool's free tier is the catalog as of 15 days ago: a model, engine, or
 * registry entry is included in the monthly document iff its `premiumSince`
 * is absent (grandfathered / always-free) or ≤ now − 15 days. This is the
 * feed-side enforcement — the router has no gate for chat models; it simply
 * receives what its tier provides (the only router-side 15-day values are
 * display-only `freeFrom` computations for search engines).
 *
 * Sections without a router-side premiumSince field (embeddings,
 * transcription, video) carry it feed-internally and are filtered the same
 * way; the field is stripped before serving. `managedPlatforms` in the
 * monthly document names platforms that still have live-only rows (still
 * inside their Premium window), so the router knows the catalog manages
 * them even with zero rows in this tier.
 */
import type { Catalog } from './types.ts';

export const FREE_LAG_MS = 15 * 24 * 60 * 60 * 1000;

export function isFreeVisible(premiumSince: string | undefined | null, nowMs: number = Date.now()): boolean {
  if (!premiumSince) return true;
  const since = Date.parse(premiumSince);
  if (Number.isNaN(since)) return true; // unreadable stamp: fail open, it is already listed
  return since + FREE_LAG_MS <= nowMs;
}

/** Strip feed-internal fields from one entry (premiumSince on chat models
 *  and embeddings/transcription/video, benchmarks on chat models). Search and
 *  decision entries KEEP premiumSince — the router stores it in meta_json.
 *  A null monthlyTokenBudget is coerced to '' — the router's models table
 *  declares the column TEXT NOT NULL DEFAULT '', so a null budget would
 *  fail the whole sync transaction. */
export function stripInternal<T extends object>(entry: T, keepPremiumSince: boolean): T {
  const out: Record<string, unknown> = {};
  Object.assign(out, entry);
  if (!keepPremiumSince) delete out.premiumSince;
  delete out.benchmarks;
  if (out.monthlyTokenBudget === null) out.monthlyTokenBudget = '';
  return out as T;
}

export function buildMonthlySnapshot(live: Catalog, nowMs: number = Date.now()): Catalog {
  const visible = (p?: string): boolean => isFreeVisible(p, nowMs);
  const monthlyModels = live.models.filter((m) => visible(m.premiumSince));
  const embeddings = live.embeddings?.filter((m) => visible(m.premiumSince));
  const transcriptionModels = live.transcriptionModels?.filter((m) => visible(m.premiumSince));
  const videoModels = live.videoModels?.filter((m) => visible(m.premiumSince));
  const searchEngines = live.searchEngines?.filter((m) => visible(m.premiumSince));
  const decisionModels = live.decisionModels?.filter((m) => visible(m.premiumSince));

  // Platforms with live-only rows are still managed by the catalog — name
  // them so the monthly tier carries the fact without leaking the rows.
  const managed = new Set(live.managedPlatforms ?? []);
  const countVisible = (platform: string, list: Array<{ platform: string }> | undefined): number =>
    (list ?? []).filter((m) => m.platform === platform).length;
  const allPlatforms = new Set([
    ...live.models.map((m) => m.platform),
    ...(live.embeddings ?? []).map((m) => m.platform),
    ...(live.transcriptionModels ?? []).map((m) => m.platform),
    ...(live.videoModels ?? []).map((m) => m.platform),
    ...(live.searchEngines ?? []).map((m) => m.platform),
    ...(live.decisionModels ?? []).map((m) => m.platform),
  ]);
  for (const p of allPlatforms) {
    const liveCount =
      countVisible(p, live.models) +
      countVisible(p, live.embeddings) +
      countVisible(p, live.transcriptionModels) +
      countVisible(p, live.videoModels) +
      countVisible(p, live.searchEngines) +
      countVisible(p, live.decisionModels);
    const monthlyCount =
      countVisible(p, monthlyModels) +
      countVisible(p, embeddings) +
      countVisible(p, transcriptionModels) +
      countVisible(p, videoModels) +
      countVisible(p, searchEngines) +
      countVisible(p, decisionModels);
    if (liveCount > monthlyCount) managed.add(p);
  }

  return {
    version: live.version,
    generatedAt: new Date(nowMs).toISOString(),
    tier: 'monthly',
    models: monthlyModels.map((m) => stripInternal(m, false)),
    ...(embeddings ? { embeddings: embeddings.map((m) => stripInternal(m, false)) } : {}),
    ...(transcriptionModels ? { transcriptionModels: transcriptionModels.map((m) => stripInternal(m, false)) } : {}),
    ...(videoModels ? { videoModels: videoModels.map((m) => stripInternal(m, false)) } : {}),
    ...(searchEngines ? { searchEngines } : {}),
    ...(decisionModels ? { decisionModels } : {}),
    managedPlatforms: [...managed].sort(),
    quirks: live.quirks,
  };
}

/** The live document as served: ranking folded in, feed-internal fields
 *  stripped, tier set. Search/decision entries keep premiumSince. */
export function buildLiveDocument(live: Catalog, rankedModels: Catalog['models'], nowMs: number = Date.now()): Catalog {
  return {
    version: live.version,
    generatedAt: new Date(nowMs).toISOString(),
    tier: 'live',
    models: rankedModels.map((m) => stripInternal(m, false)),
    ...(live.embeddings ? { embeddings: live.embeddings.map((m) => stripInternal(m, false)) } : {}),
    ...(live.transcriptionModels ? { transcriptionModels: live.transcriptionModels.map((m) => stripInternal(m, false)) } : {}),
    ...(live.videoModels ? { videoModels: live.videoModels.map((m) => stripInternal(m, false)) } : {}),
    ...(live.searchEngines ? { searchEngines: live.searchEngines } : {}),
    ...(live.decisionModels ? { decisionModels: live.decisionModels } : {}),
    ...(live.managedPlatforms ? { managedPlatforms: [...live.managedPlatforms].sort() } : {}),
    quirks: live.quirks,
  };
}
