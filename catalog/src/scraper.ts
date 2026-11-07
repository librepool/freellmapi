/**
 * Scraper interface — placeholder only (per-provider scrapers are a later
 * phase; do NOT build them here).
 *
 * Contract for a future per-provider scraper:
 *  - Poll the provider's model list, preferring an official model-list API
 *    over page scraping; respect robots.txt and the provider's ToS.
 *  - Hash/diff change detection: hash the normalized model list; only
 *    changed lists go to verification.
 *  - Verification before catalog entry: a detected model is verified (live
 *    probe against the provider) before it enters the catalog.
 *  - Every verified addition is stamped with catalog_version + effective_date
 *    (= premiumSince: the day it enters the live tier; the free tier sees it
 *    15 days later via the snapshot rule in snapshot.ts).
 */
import crypto from 'node:crypto';

export type ScraperKind = 'official-api' | 'page' | 'feed';

export interface ScraperSource {
  platform: string;
  /** Model-list endpoint or page URL. */
  listUrl: string;
  kind: ScraperKind;
  /** Poll interval in ms. */
  intervalMs: number;
}

export interface ScrapeChange {
  platform: string;
  /** SHA-256 of the normalized model list, for hash/diff detection. */
  listHash: string;
  addedModelIds: string[];
  removedModelIds: string[];
  checkedAt: string;
}

export interface CatalogScraper {
  readonly source: ScraperSource;
  /** Poll once. Returns null when the list is unchanged (same hash). */
  poll(lastHash: string | null): Promise<ScrapeChange | null>;
  /** Verify a candidate model id against the provider before catalog entry. */
  verify(modelId: string): Promise<boolean>;
}

export function hashModelList(modelIds: string[]): string {
  const normalized = [...modelIds].sort().join('\n');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Stub scraper: always reports "no change". It exists so the scheduler shape
 * (poll → diff → verify → stamp) can be tested and wired before any real
 * per-provider scraper lands. Replace per platform in the later phase.
 */
export class StubScraper implements CatalogScraper {
  readonly source: ScraperSource;

  constructor(source: ScraperSource) {
    this.source = source;
  }

  async poll(_lastHash: string | null): Promise<ScrapeChange | null> {
    // No live polling yet: the feed's catalog comes from the seed data.
    return null;
  }

  async verify(_modelId: string): Promise<boolean> {
    // Nothing to verify until a real scraper detects a candidate.
    return false;
  }
}
