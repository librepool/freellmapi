/**
 * Scraper contract + scheduler support for the per-provider scrapers.
 *
 * Pipeline (unchanged from the original contract):
 *  - Poll the provider's model list, preferring an official model-list API
 *    over page scraping; respect robots.txt and the provider's ToS.
 *  - Hash/diff change detection: hash the normalized model list; only
 *    changed lists go to verification.
 *  - Verification before catalog entry: a detected model is verified (live
 *    probe against the provider) before it enters the catalog.
 *  - Every verified addition is stamped with catalog_version + effective_date
 *    (= premiumSince: the day it enters the live tier; the free tier sees it
 *    15 days later via the snapshot rule in snapshot.ts).
 *
 * What this file adds for a real scheduler (this phase):
 *  - `ScraperStateStore`: per-platform state (lastHash + lastCheckedAt +
 *    lastModelIds — the ids are needed to compute added/removed on the next
 *    poll) persisted to `catalog/data/scraper-state.json`. That file is
 *    runtime state, NOT source: it must be git-ignored (see
 *    catalog/docs/scrapers.md for the exact lines — the file is not yet in
 *    .gitignore at the time of writing).
 *  - `ScrapeReport`: the per-platform, per-run record — added/removed ids,
 *    list hash, checkedAt, and the verification level of every addition.
 *    A run that polls nothing (robots-disallowed, stub, error) still emits
 *    a report with `status` saying so; absence of a report means the run
 *    never happened, never "no change".
 *  - Verification levels, labelled honestly: `list-verified` (the id appears
 *    in the provider's live model list) vs `serving-verified` (a real chat
 *    call with a provider key succeeded). A 1-token serving probe needs a
 *    provider key, which this service does not hold — `probeServing` exists
 *    for an operator who supplies a key explicitly, and nothing in this
 *    module ever claims a serving probe it did not run.
 *  - Stamping / apply rules: a verified addition gets
 *    `premiumSince = today` (the UTC date, midnight) and enters the live
 *    tier immediately; the free tier sees it 15 days later via the existing
 *    snapshot rule. A removed model is REPORTED and never silently deleted
 *    from the seed — removals need an operator decision (a model can vanish
 *    from a list during an outage, a rename, or a real retirement).
 *
 * No API keys: no key value may appear in code, config, state, or reports.
 * `probeServing` takes its key as an explicit function argument only.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { RobotsDisallowedError } from './scrapers/robots.ts';
import type { CatalogModel, SeedCatalog } from './types.ts';

export { RobotsDisallowedError, SCRAPER_USER_AGENT } from './scrapers/robots.ts';
export type { RobotsCheckResult, RobotsRules } from './scrapers/robots.ts';
export { checkRobotsTxt, isPathAllowed, parseRobotsTxt } from './scrapers/robots.ts';

export type ScraperKind = 'official-api' | 'page' | 'feed';

export interface ScraperSource {
  platform: string;
  /** Model-list endpoint or page URL. */
  listUrl: string;
  kind: ScraperKind;
  /** Poll interval in ms. 0 means "not scheduled" (stub entries). */
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

/**
 * How a candidate model id was verified. `unverified` means the check was
 * attempted and the id was NOT confirmed — never present it as verified.
 */
export type VerificationLevel = 'list-verified' | 'serving-verified' | 'unverified';

export interface VerificationResult {
  modelId: string;
  level: VerificationLevel;
  checkedAt: string;
  /** What was actually observed, e.g. "present in live /v1/models list". */
  detail: string;
}

export type ScrapeStatus = 'changed' | 'unchanged' | 'skipped' | 'error';

export interface ScrapeReport {
  platform: string;
  listUrl: string | null;
  kind: ScraperKind;
  /** 'changed' | 'unchanged' | 'skipped' (robots/stub) | 'error' (fetch failed). */
  status: ScrapeStatus;
  checkedAt: string;
  /** SHA-256 of the normalized free-model list from this poll (null if no poll). */
  listHash: string | null;
  previousHash: string | null;
  addedModelIds: string[];
  removedModelIds: string[];
  /** One entry per added id (verified or not — check `level`). */
  verification: VerificationResult[];
  /** Why a poll was skipped (robots.txt, stub, no prior baseline note). */
  skippedReason?: string;
  /** Fetch/parse failure message (status 'error'). */
  error?: string;
  /** Operator-readable observations, e.g. upstream outage counts. */
  notes?: string[];
}

export interface CatalogScraper {
  readonly source: ScraperSource;
  /**
   * Poll once. Returns null when the list is unchanged (same hash).
   * `lastModelIds` is the previous free-model list (from scraper state or
   * the seed catalog on a first run); without it, added = the whole list
   * and removed = [] — pass it whenever state exists.
   * May throw RobotsDisallowedError (robots.txt forbids the list URL) or
   * an Error on fetch/parse failure; the scheduler records those as a
   * report with status 'skipped' / 'error', never as "unchanged".
   */
  poll(lastHash: string | null, lastModelIds?: string[]): Promise<ScrapeChange | null>;
  /** Verify a candidate model id against the provider before catalog entry. */
  verify(modelId: string): Promise<boolean>;
  /**
   * Verify with the level attached. Defaults to the `verify()` result
   * labelled 'list-verified' / 'unverified'; scrapers that can do more
   * (an operator-supplied serving probe) override it.
   */
  verifyDetailed?(modelId: string): Promise<VerificationResult>;
  /**
   * Operator-readable notes from the most recent poll (e.g. upstream
   * outage counts). Empty when no poll has run. Optional; the scheduler
   * appends these to the report when present.
   */
  notes?(): string[];
}

/** Per-platform scheduler state, persisted by ScraperStateStore. */
export interface ScraperStateEntry {
  lastHash: string | null;
  lastCheckedAt: string | null;
  /** Free-model ids from the last successful poll (needed for added/removed). */
  lastModelIds: string[];
}

export class ScraperStateStore {
  private readonly filePath: string;
  private state: Record<string, ScraperStateEntry>;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.state = {};
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const [platform, entry] of Object.entries(parsed as Record<string, unknown>)) {
          if (entry && typeof entry === 'object') {
            const e = entry as Partial<ScraperStateEntry>;
            this.state[platform] = {
              lastHash: typeof e.lastHash === 'string' ? e.lastHash : null,
              lastCheckedAt: typeof e.lastCheckedAt === 'string' ? e.lastCheckedAt : null,
              lastModelIds: Array.isArray(e.lastModelIds) ? e.lastModelIds.filter((x): x is string => typeof x === 'string') : [],
            };
          }
        }
      }
    } catch (err) {
      // Missing or unreadable state file: start empty. A corrupt file is
      // also treated as empty (the next poll rebuilds state from the seed
      // baseline) rather than crashing the run — but say so loudly.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[scraper-state] ignoring unreadable state file ${filePath}: ${(err as Error).message}`);
      }
    }
  }

  get(platform: string): ScraperStateEntry | null {
    return this.state[platform] ?? null;
  }

  set(platform: string, entry: ScraperStateEntry): void {
    this.state[platform] = entry;
  }

  /** All platforms with stored state. */
  platforms(): string[] {
    return Object.keys(this.state).sort();
  }

  save(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2) + '\n', 'utf8');
  }
}

export function hashModelList(modelIds: string[]): string {
  const normalized = [...modelIds].sort().join('\n');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/** UTC midnight ISO stamp for `premiumSince` — the day the model enters live. */
export function todayStamp(nowMs: number = Date.now()): string {
  const d = new Date(nowMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T00:00:00.000Z`;
}

/** Catalog version for today: `YYYY.MM.DD` (must stay ≥ MIN_CATALOG_VERSION). */
export function todayVersion(nowMs: number = Date.now()): string {
  const d = new Date(nowMs);
  return `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Run one scraper once and build its report.
 *
 * `knownIds` is the baseline when no state exists yet — the seed catalog's
 * ids for this platform — so the first run diffs the live list against the
 * catalog instead of reporting the whole roster as "added". State is NOT
 * written here; the caller owns the store.
 *
 * Verification: every added id is checked with `verifyDetailed()` (or
 * `verify()`), labelled 'list-verified' when it appears in the live list.
 * Nothing here performs a serving probe — that needs an operator key.
 */
export async function runScraper(
  scraper: CatalogScraper,
  prior: ScraperStateEntry | null,
  knownIds: string[],
  nowMs: number = Date.now(),
): Promise<ScrapeReport> {
  const checkedAt = new Date(nowMs).toISOString();
  const base = {
    platform: scraper.source.platform,
    listUrl: scraper.source.listUrl,
    kind: scraper.source.kind,
    checkedAt,
    previousHash: prior?.lastHash ?? null,
  };
  const previousIds = prior ? prior.lastModelIds : knownIds;
  let change: ScrapeChange | null;
  try {
    change = await scraper.poll(prior?.lastHash ?? null, previousIds);
  } catch (err) {
    if (err instanceof RobotsDisallowedError) {
      return {
        ...base, status: 'skipped', listHash: prior?.lastHash ?? null,
        addedModelIds: [], removedModelIds: [], verification: [],
        skippedReason: err.message,
      };
    }
    return {
      ...base, status: 'error', listHash: prior?.lastHash ?? null,
      addedModelIds: [], removedModelIds: [], verification: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (change === null) {
    return {
      ...base, status: 'unchanged',
      listHash: prior?.lastHash ?? null,
      addedModelIds: [], removedModelIds: [], verification: [],
      notes: prior === null ? ['first run: no prior state; baseline is the seed catalog'] : undefined,
    };
  }
  const verification: VerificationResult[] = [];
  for (const modelId of change.addedModelIds) {
    if (typeof scraper.verifyDetailed === 'function') {
      verification.push(await scraper.verifyDetailed(modelId));
    } else {
      const ok = await scraper.verify(modelId);
      verification.push({
        modelId,
        level: ok ? 'list-verified' : 'unverified',
        checkedAt: new Date().toISOString(),
        detail: ok ? 'present in live model list' : 'NOT present in live model list on re-check',
      });
    }
  }
  const extraNotes = typeof scraper.notes === 'function' ? scraper.notes() : [];
  const notes = [
    ...(prior === null ? ['first run: diff is live list vs seed catalog baseline'] : []),
    ...extraNotes,
  ];
  return {
    ...base,
    status: 'changed',
    listHash: change.listHash,
    addedModelIds: change.addedModelIds,
    removedModelIds: change.removedModelIds,
    verification,
    notes: notes.length > 0 ? notes : undefined,
  };
}

/**
 * A 1-token serving probe: POST a minimal chat completion and confirm the
 * provider answers for this model id. OPERATOR-ONLY — the key is an explicit
 * argument; this module never reads a key from env, config, or state, and
 * the scheduler never calls this. Returns 'serving-verified' only when the
 * call succeeds; any failure is 'unverified' with the status in `detail`
 * (a 402/401/429 is not proof the model does not exist — it is proof the
 * probe could not confirm it).
 */
export async function probeServing(
  baseUrl: string,
  modelId: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerificationResult> {
  const checkedAt = new Date().toISOString();
  if (!apiKey) {
    return { modelId, level: 'unverified', checkedAt, detail: 'no provider key supplied — serving probe not attempted' };
  }
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'LibrePool-scraper/1.0',
      },
      body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      return { modelId, level: 'unverified', checkedAt, detail: `serving probe HTTP ${res.status} — not confirmed (key/quota/model may all be at fault)` };
    }
    const body = (await res.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string } }> } | null;
    if (body && Array.isArray(body.choices) && body.choices.length > 0) {
      return { modelId, level: 'serving-verified', checkedAt, detail: '1-token chat completion succeeded' };
    }
    return { modelId, level: 'unverified', checkedAt, detail: 'serving probe returned 2xx but no choices — not confirmed' };
  } catch (err) {
    return { modelId, level: 'unverified', checkedAt, detail: `serving probe failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Default row for a scraper-added chat model. The scraper knows the id and
 * the platform, not the model's quality, speed, context window, or limits —
 * so it stamps the same neutral defaults the seed rows use (rank 500,
 * speed 5, Medium) and leaves limits/context null for operator curation.
 * `enabled: true` because the model was verified present in the live list.
 */
export function defaultScrapedModel(platform: string, modelId: string, premiumSince: string): CatalogModel {
  return {
    platform,
    modelId,
    displayName: modelId,
    intelligenceRank: 500,
    speedRank: 5,
    sizeLabel: 'Medium',
    limits: { rpm: null, rpd: null, tpm: null, tpd: null },
    monthlyTokenBudget: null,
    contextWindow: null,
    enabled: true,
    supportsVision: false,
    supportsTools: false,
    premiumSince,
  };
}

export interface ApplyResult {
  /** The new seed (a copy; the input is not mutated). */
  seed: SeedCatalog;
  added: { platform: string; modelId: string }[];
  /** Additions refused: already in the seed, or not list-verified. */
  skipped: { platform: string; modelId: string; reason: string }[];
  /** Removals are never applied — they are listed here for the operator. */
  removedReported: { platform: string; modelId: string }[];
}

/**
 * Apply verified additions to a seed catalog (the `--apply` path).
 * Rules: only 'list-verified' (or 'serving-verified') additions are added;
 * ids already in the seed are skipped; `premiumSince` is stamped today, so
 * the model enters the live tier immediately and the free tier 15 days
 * later; the catalog version is bumped to today's YYYY.MM.DD when anything
 * was added; removed ids are NEVER deleted — they are returned in
 * `removedReported` for an operator to decide (outage vs retirement).
 */
export function applyScrapeToSeed(seed: SeedCatalog, reports: ScrapeReport[], nowMs: number = Date.now()): ApplyResult {
  const next: SeedCatalog = JSON.parse(JSON.stringify(seed)) as SeedCatalog;
  const stamp = todayStamp(nowMs);
  const added: ApplyResult['added'] = [];
  const skipped: ApplyResult['skipped'] = [];
  const removedReported: ApplyResult['removedReported'] = [];
  const verifiedByPlatform = new Map<string, Map<string, VerificationLevel>>();

  for (const report of reports) {
    for (const modelId of report.removedModelIds) {
      removedReported.push({ platform: report.platform, modelId });
    }
    const byId = new Map<string, VerificationLevel>();
    for (const v of report.verification) byId.set(v.modelId, v.level);
    verifiedByPlatform.set(report.platform, byId);
  }

  const existing = new Set(next.models.map((m) => `${m.platform}:${m.modelId}`));
  for (const report of reports) {
    if (report.status !== 'changed') continue;
    const levels = verifiedByPlatform.get(report.platform) ?? new Map();
    for (const modelId of report.addedModelIds) {
      const key = `${report.platform}:${modelId}`;
      if (existing.has(key)) {
        skipped.push({ platform: report.platform, modelId, reason: 'already in seed catalog' });
        continue;
      }
      const level = levels.get(modelId);
      if (level !== 'list-verified' && level !== 'serving-verified') {
        skipped.push({ platform: report.platform, modelId, reason: `not verified (level: ${level ?? 'none'})` });
        continue;
      }
      next.models.push(defaultScrapedModel(report.platform, modelId, stamp));
      existing.add(key);
      added.push({ platform: report.platform, modelId });
    }
  }
  if (added.length > 0) next.version = todayVersion(nowMs);
  return { seed: next, added, skipped, removedReported };
}

/**
 * Stub scraper: always reports "no change". It exists so the scheduler shape
 * (poll → diff → verify → stamp) can be tested and wired before any real
 * per-provider scraper lands. In the registry it is also the explicit
 * placeholder for platforms with no usable list endpoint (see
 * catalog/src/scrapers/index.ts — each stub entry carries its reason).
 */
export class StubScraper implements CatalogScraper {
  readonly source: ScraperSource;

  constructor(source: ScraperSource) {
    this.source = source;
  }

  async poll(_lastHash: string | null, _lastModelIds?: string[]): Promise<ScrapeChange | null> {
    // No live polling yet: the feed's catalog comes from the seed data.
    return null;
  }

  async verify(_modelId: string): Promise<boolean> {
    // Nothing to verify until a real scraper detects a candidate.
    return false;
  }

  async verifyDetailed(modelId: string): Promise<VerificationResult> {
    return {
      modelId,
      level: 'unverified',
      checkedAt: new Date().toISOString(),
      detail: 'stub scraper: no list endpoint, nothing verified',
    };
  }
}
