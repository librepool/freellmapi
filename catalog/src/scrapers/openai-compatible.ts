/**
 * OpenAI-compatible model-list scraper — the reusable base for every
 * provider that exposes `GET {baseUrl}/models` returning
 * `{ "data": [{ "id": "…" , … }] }`.
 *
 * One poll per platform per run, never a flood: the fetched list is cached
 * in memory (5 minutes), so the verification re-check after a poll reuses
 * the same fetch instead of hitting the provider again. Each concrete
 * provider is a thin subclass that only supplies its free-id filter (and,
 * where the list carries extra signal, a `notesForList` hook).
 *
 * Politeness, in order, on every poll:
 *  1. Fetch `<origin>/robots.txt`; if the list path is disallowed, throw
 *     RobotsDisallowedError and poll nothing (see scrapers/robots.ts).
 *  2. One GET on `{baseUrl}/models` with the LibrePool scraper User-Agent
 *     and a 20s timeout. No key is sent: only public list endpoints are
 *     scraped; an endpoint that 401s without a key is a stub, not a
 *     credential to go and fetch.
 *  3. Parse ids, apply the provider's free-id filter, hash the sorted
 *     free list, diff against the previous ids.
 *
 * The free-id filter receives the WHOLE list entry, not just the id —
 * several providers mark "free" in a field, not the id (LLMTR: zero
 * pricing; Airforce: `tier: "free"`), and a filter that only sees ids
 * cannot express those rules. Filters must be conservative: when the
 * free/paid boundary is unclear for an id, exclude it — a missed model is
 * a lost lane, a wrongly-included paid model is a billing incident.
 */
import { checkRobotsTxt, RobotsDisallowedError, SCRAPER_USER_AGENT } from './robots.ts';
import { hashModelList } from '../scraper.ts';
import type { CatalogScraper, ScrapeChange, ScraperSource, VerificationResult } from '../scraper.ts';

/** One entry of an OpenAI-style `/v1/models` response. */
export interface ModelListEntry {
  id: string;
  [key: string]: unknown;
}

export interface OpenAICompatibleScraperOptions {
  platform: string;
  /** Display name, for reports only. */
  name?: string;
  /** Base URL WITHOUT a trailing slash, e.g. `https://api.example.com/v1`. */
  baseUrl: string;
  /**
   * True when this list entry is a free route the catalog may serve.
   * Receives the whole entry (id + pricing/tier/operations fields).
   * Conservative by design: unclear → false.
   */
  freeFilter: (entry: ModelListEntry) => boolean;
  /** Poll interval in ms (default 24h; churn-prone providers use 6h). */
  intervalMs?: number;
  /** Test seam: injectable fetch. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Test seam: set false to skip the robots.txt fetch (unit tests inject
   * robots behaviour explicitly instead). Production always checks.
   */
  robotsCheck?: boolean;
  timeoutMs?: number;
}

const LIST_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 20_000;

export class OpenAICompatibleScraper implements CatalogScraper {
  readonly source: ScraperSource;
  protected readonly baseUrl: string;
  protected readonly freeFilter: (entry: ModelListEntry) => boolean;
  protected readonly fetchImpl: typeof fetch;
  protected readonly robotsCheck: boolean;
  protected readonly timeoutMs: number;

  /** Last fetched list (free ids + raw entries), reused by verify(). */
  private cachedList: { entries: ModelListEntry[]; freeIds: string[]; fetchedAtMs: number } | null = null;

  constructor(opts: OpenAICompatibleScraperOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.freeFilter = opts.freeFilter;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.robotsCheck = opts.robotsCheck ?? true;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.source = {
      platform: opts.platform,
      listUrl: `${this.baseUrl}/models`,
      kind: 'official-api',
      intervalMs: opts.intervalMs ?? 24 * 60 * 60 * 1000,
    };
  }

  /**
   * Extra operator-readable notes derived from the raw list entries, e.g.
   * how many free models report an outage. Default: none. Subclasses
   * override when the list carries status signal worth surfacing.
   */
  protected notesForList(_entries: ModelListEntry[], _freeIds: string[]): string[] {
    return [];
  }

  /** Fetch the list (robots-checked, cached 5 min) and return free ids. */
  async fetchFreeList(): Promise<{ entries: ModelListEntry[]; freeIds: string[] }> {
    const now = Date.now();
    if (this.cachedList && now - this.cachedList.fetchedAtMs < LIST_CACHE_TTL_MS) {
      return { entries: this.cachedList.entries, freeIds: this.cachedList.freeIds };
    }
    if (this.robotsCheck) {
      const robots = await checkRobotsTxt(this.source.listUrl, this.fetchImpl);
      if (!robots.allowed) {
        const robotsUrl = `${new URL(this.source.listUrl).origin}/robots.txt`;
        throw new RobotsDisallowedError(this.source.listUrl, robotsUrl, robots.reason);
      }
    }
    const res = await this.fetchImpl(this.source.listUrl, {
      headers: { Accept: 'application/json', 'User-Agent': SCRAPER_USER_AGENT },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`GET ${this.source.listUrl} returned HTTP ${res.status}`);
    }
    const body = (await res.json().catch(() => null)) as { data?: unknown } | unknown[] | null;
    // Most providers return `{ "data": [{ "id": … }] }`; Typhoon returns a
    // bare array `[{ "id": … }]` instead. Both shapes are accepted.
    const data = Array.isArray(body) ? body : body?.data;
    if (!Array.isArray(data)) {
      throw new Error(`GET ${this.source.listUrl} returned no usable "data" array`);
    }
    const entries: ModelListEntry[] = [];
    for (const item of data) {
      if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
        entries.push(item as ModelListEntry);
      }
    }
    const freeIds = entries.filter(this.freeFilter).map((e) => e.id).sort();
    this.cachedList = { entries, freeIds, fetchedAtMs: now };
    return { entries, freeIds };
  }

  async poll(lastHash: string | null, lastModelIds: string[] = []): Promise<ScrapeChange | null> {
    const { freeIds } = await this.fetchFreeList();
    const listHash = hashModelList(freeIds);
    if (lastHash !== null && listHash === lastHash) return null;
    const prev = new Set(lastModelIds);
    const curr = new Set(freeIds);
    return {
      platform: this.source.platform,
      listHash,
      addedModelIds: freeIds.filter((id) => !prev.has(id)),
      removedModelIds: lastModelIds.filter((id) => !curr.has(id)),
      checkedAt: new Date().toISOString(),
    };
  }

  async verify(modelId: string): Promise<boolean> {
    const { freeIds } = await this.fetchFreeList();
    return freeIds.includes(modelId);
  }

  async verifyDetailed(modelId: string): Promise<VerificationResult> {
    const ok = await this.verify(modelId);
    return {
      modelId,
      level: ok ? 'list-verified' : 'unverified',
      checkedAt: new Date().toISOString(),
      detail: ok
        ? `present in live ${this.source.listUrl} free list`
        : `NOT present in live ${this.source.listUrl} free list on re-check`,
    };
  }

  /** Notes for the current cached list (empty until a poll has run). */
  notes(): string[] {
    if (!this.cachedList) return [];
    return this.notesForList(this.cachedList.entries, this.cachedList.freeIds);
  }
}
