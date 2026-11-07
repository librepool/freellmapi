/**
 * Catalog store — the feed service's source of truth.
 *
 * The feed's catalog lives in ITS OWN seed data (CATALOG_SEED_PATH, default
 * data/seed-catalog.json), populated by scrapers + curation in later phases.
 * It is NOT a single router's SQLite file: export-catalog.ts can produce a
 * compatible document from a router DB, but the feed service never reads a
 * router DB at runtime.
 *
 * Snapshot cadence: the monthly (15-day-lagged) document is regenerated
 * whenever the live catalog version changes AND at least once every 24h
 * (models age into the free tier daily, not just on version bumps). The
 * monthly minimum is a floor; regenerating on version change is the rule.
 */
import fs from 'node:fs';
import type { Catalog, SeedCatalog } from './types.ts';
import { applyBenchmarkRanks } from './ranking.ts';
import { buildLiveDocument, buildMonthlySnapshot } from './snapshot.ts';

export const MIN_CATALOG_VERSION = '2026.06.07';
const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function loadSeed(seedPath: string): SeedCatalog {
  const raw = fs.readFileSync(seedPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') throw new Error(`seed catalog at ${seedPath} is not an object`);
  const seed = parsed as SeedCatalog;
  if (typeof seed.version !== 'string') throw new Error(`seed catalog at ${seedPath} has no version`);
  if (seed.version < MIN_CATALOG_VERSION) {
    throw new Error(`seed catalog version ${seed.version} is below MIN_CATALOG_VERSION ${MIN_CATALOG_VERSION} — the router would ignore it`);
  }
  if (!Array.isArray(seed.models) || !Array.isArray(seed.quirks)) {
    throw new Error(`seed catalog at ${seedPath} needs models[] and quirks[]`);
  }
  return seed;
}

export class CatalogStore {
  private seed: SeedCatalog;
  private monthlyCache: { builtAtMs: number; version: string; doc: Catalog } | null = null;

  constructor(seed: SeedCatalog) {
    this.seed = seed;
  }

  get version(): string {
    return this.seed.version;
  }

  /** Replace the live catalog (e.g. after a scraper run) and drop the
   *  cached monthly snapshot so it rebuilds on next use. */
  replaceSeed(seed: SeedCatalog): void {
    this.seed = seed;
    this.monthlyCache = null;
  }

  /** The live catalog with benchmark ranks folded in but feed-internal
   *  fields (chat-model premiumSince, benchmarks) still present. This is
   *  what the monthly snapshot is filtered from — the served live document
   *  strips those fields, so filtering must happen BEFORE stripping. */
  private internalLive(nowMs: number = Date.now()): Catalog {
    const ranked = applyBenchmarkRanks(this.seed.models);
    return {
      ...(this.seed as Catalog),
      generatedAt: new Date(nowMs).toISOString(),
      tier: 'live',
      models: ranked,
    };
  }

  /** The live document: benchmark ranks folded into intelligenceRank,
   *  feed-internal fields stripped, signed at serve time. */
  liveDocument(nowMs: number = Date.now()): Catalog {
    const internal = this.internalLive(nowMs);
    return buildLiveDocument(internal, internal.models, nowMs);
  }

  /** The monthly document: the catalog as of 15 days ago. Regenerated when
   *  the live version changed or the cached snapshot is older than 24h. */
  monthlyDocument(nowMs: number = Date.now()): Catalog {
    const live = this.internalLive(nowMs);
    if (
      this.monthlyCache &&
      this.monthlyCache.version === live.version &&
      nowMs - this.monthlyCache.builtAtMs < SNAPSHOT_MAX_AGE_MS
    ) {
      return this.monthlyCache.doc;
    }
    const doc = buildMonthlySnapshot(live, nowMs);
    this.monthlyCache = { builtAtMs: nowMs, version: live.version, doc };
    return doc;
  }
}
