/**
 * Ranking ingestion — fetch clients for the benchmark sources that feed
 * `src/ranking.ts` (the pure aggregate; this file never touches it).
 *
 * Sources, versions, endpoints — verified against the providers' own public
 * docs 2026-11-08 (see README "Ranking" section for links):
 *
 *  - Artificial Analysis, Intelligence Index v5 (current v5.0.1):
 *      GET https://artificialanalysis.ai/api/v2/language/models/free
 *      Auth: `x-api-key: <key>` (LIBREPOOL_RANKING_AA_KEY).
 *      Free tier: 100 requests per fixed 24-hour window starting at the
 *      first request; 401 = bad key, 403 = tier does not cover the endpoint,
 *      429 carries `Retry-After`. Response envelope: `{ tier,
 *      intelligence_index_version, pagination: { page, page_size,
 *      total_pages, has_more }, data: [...] }`, each row carrying `id`,
 *      `name`, `slug` and `evaluations` (headline indices incl. the
 *      Intelligence Index). The non-free list endpoint
 *      `/api/v2/language/models` is Pro+ only — the free key MUST use the
 *      `/free` sibling. Full docs: https://artificialanalysis.ai/data-api/docs
 *      and https://artificialanalysis.ai/data-api/docs/reference
 *    CAVEAT (unverified from public docs): the reference page lists the
 *    `evaluations` object but its text extraction does not expose the exact
 *    sub-field name for the Intelligence Index score. The parser therefore
 *    accepts `evaluations.artificial_analysis_intelligence_index` as a
 *    number OR as `{ value | score }`, plus a top-level field of the same
 *    name, and counts rows with no parseable score as unscored (never 0).
 *    Confirm the field name against the first live response (the CLI
 *    reports unscored rows); if AA renames it, fix the parser here.
 *    AA Free data is for internal use only — scores are folded into
 *    intelligenceRank and NEVER redistributed (see ranking.ts hard rule).
 *
 *  - BenchLM, BenchAlign v5.8 Overall:
 *      GET https://data.benchlm.ai/v1/rankings/current?surface=overall
 *      Auth: `Authorization: Bearer <key>` (LIBREPOOL_RANKING_BENCHLM_KEY).
 *      Free tier: 250 reads/month, 30 req/min, current data + 30 days
 *      history. Docs: https://benchlm.ai/data/access (example in the docs
 *      uses `?surface=coding`; the query table lists Overall, Agentic,
 *      Coding and Knowledge surfaces — `surface=overall` is the Overall
 *      lane and is the value this code uses, but it is NOT verbatim in the
 *      docs, so if the API rejects it, try `surface=coding` first and
 *      check the docs). BenchLM outputs are CC BY-NC 4.0 (website dataset
 *      and Data-service outputs); paid plans cover queries/internal
 *      analysis only, not commercial display/redistribution — same
 *      internal-use-only handling as AA.
 *    CAVEAT (unverified from public docs): the docs describe the ranking
 *    rows ("final scores, published ranks, evidence labels, scoring date,
 *    methodology version") but publish no REST response schema. The parser
 *    therefore accepts several envelope/row shapes (see
 *    parseBenchlmResponse) and counts unparseable rows as unscored.
 *
 *  - LiveBench 2.0 Overall: NO hosted API (confirmed: machine access is
 *    the open repo / Hugging Face datasets, github.com/LiveBench/LiveBench).
 *    There is deliberately no API client here. The operator drops a
 *    snapshot file at `catalog/data/livebench.json` (see
 *    parseLivebenchSnapshot / loadLivebenchSnapshot for the shape) and the
 *    fetch job merges it the same way. Absent file = LiveBench missing for
 *    that run (missing = null, never 0).
 *
 * Model-id matching is the hard part and is deliberately dumb: exact
 * matches only, via `catalog/data/ranking-model-map.json`
 * (source-model-id → catalog-model-id, `platform:modelId`, one source row
 * may map to several catalog rows when providers serve the same base
 * model). No fuzzy matching, no substring guessing — an unmatched source
 * row leaves its catalog models Unranked, never 0.
 *
 * Budgets: one request per source per run (AA page 1 only; if
 * `pagination.has_more` the result is flagged partial and the operator is
 * warned — do NOT silently burn quota paging). Usage counters persist in
 * `catalog/data/catalog.ranking-budget.json`, which IS git-ignored via the
 * `catalog/data/catalog.*.json` rule in .gitignore (verified with
 * `git check-ignore`). Raw source snapshots are cached the same way
 * (`catalog.ranking-cache-<source>.json`, also git-ignored) with their
 * fetch date as `sourceDate`. Never put a real API key in code, config, or
 * a report; keys come from the environment only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchmarkInputs, SeedCatalog } from './types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_ROOT = path.resolve(__dirname, '..');

/** Default on-disk paths (all under catalog/, resolved from this file so
 *  they work regardless of the caller's working directory). */
export function defaultPaths(): {
  map: string;
  budget: string;
  livebench: string;
  cacheAa: string;
  cacheBenchlm: string;
} {
  return {
    map: path.join(CATALOG_ROOT, 'data', 'ranking-model-map.json'),
    budget: path.join(CATALOG_ROOT, 'data', 'catalog.ranking-budget.json'),
    livebench: path.join(CATALOG_ROOT, 'data', 'livebench.json'),
    cacheAa: path.join(CATALOG_ROOT, 'data', 'catalog.ranking-cache-aa.json'),
    cacheBenchlm: path.join(CATALOG_ROOT, 'data', 'catalog.ranking-cache-benchlm.json'),
  };
}

// ---------------------------------------------------------------------------
// Endpoints, versions, budgets
// ---------------------------------------------------------------------------

export const AA_BASE_URL = 'https://artificialanalysis.ai';
export const AA_MODELS_FREE_PATH = '/api/v2/language/models/free';
export const AA_EXPECTED_INTELLIGENCE_INDEX_MAJOR = 5;
export const AA_DAILY_LIMIT = 100;
export const AA_WINDOW_MS = 24 * 60 * 60 * 1000;

export const BENCHLM_BASE_URL = 'https://data.benchlm.ai';
export const BENCHLM_RANKINGS_PATH = '/v1/rankings/current';
export const BENCHLM_DEFAULT_SURFACE = 'overall';
export const BENCHLM_DEFAULT_LIMIT = 250;
export const BENCHLM_MONTHLY_LIMIT = 250;

export const LIVEBENCH_VERSION = '2.0';

export const ENV_AA_KEY = 'LIBREPOOL_RANKING_AA_KEY';
export const ENV_BENCHLM_KEY = 'LIBREPOOL_RANKING_BENCHLM_KEY';
export const ENV_LIVEBENCH_KEY = 'LIBREPOOL_RANKING_LIVEBENCH_KEY'; // accepted but unused: no LiveBench API exists

export type RankingSource = 'aa' | 'benchlm' | 'livebench';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type FetchErrorCode =
  | 'missing_key'
  | 'budget_exhausted'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'http_error'
  | 'network_error'
  | 'malformed_payload'
  | 'version_mismatch';

export class RankingFetchError extends Error {
  readonly code: FetchErrorCode;
  readonly source: RankingSource;
  readonly status?: number;
  readonly retryAfterSeconds?: number;

  constructor(
    source: RankingSource,
    code: FetchErrorCode,
    message: string,
    opts: { status?: number; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'RankingFetchError';
    this.source = source;
    this.code = code;
    this.status = opts.status;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

// ---------------------------------------------------------------------------
// Model map
// ---------------------------------------------------------------------------

/** Source-model-id (AA slug or display name, BenchLM canonical name,
 *  LiveBench published model name) → catalog model key(s)
 *  (`platform:modelId`). A value may be a single key or an array: several
 *  catalog rows can serve the same base model. */
export interface ModelMap {
  version?: string;
  notes?: string[];
  aa: Record<string, string | string[]>;
  benchlm: Record<string, string | string[]>;
  livebench: Record<string, string | string[]>;
}

export function loadModelMap(mapPath: string): ModelMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(mapPath, 'utf8')) as unknown;
  } catch (err) {
    throw new Error(`cannot read ranking model map at ${mapPath}: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object') throw new Error(`ranking model map at ${mapPath} is not an object`);
  const raw = parsed as Record<string, unknown>;
  const map: ModelMap = { aa: {}, benchlm: {}, livebench: {} };
  if (typeof raw.version === 'string') map.version = raw.version;
  if (Array.isArray(raw.notes)) map.notes = raw.notes.filter((n): n is string => typeof n === 'string');
  for (const source of ['aa', 'benchlm', 'livebench'] as const) {
    const section = raw[source];
    if (section === undefined) continue;
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      throw new Error(`ranking model map at ${mapPath}: "${source}" must be an object`);
    }
    for (const [key, value] of Object.entries(section as Record<string, unknown>)) {
      const targets = Array.isArray(value) ? value : [value];
      for (const t of targets) {
        if (typeof t !== 'string' || !t.includes(':')) {
          throw new Error(
            `ranking model map at ${mapPath}: "${source}"."${key}" must map to catalog key(s) like "platform:modelId", got ${JSON.stringify(t)}`,
          );
        }
      }
      map[source][key] = Array.isArray(value) ? (value as string[]) : (value as string);
    }
  }
  return map;
}

/**
 * Exact-match resolution only. `sourceIds` are tried in order (e.g. AA slug
 * first, then display name); the first key present in the map wins. No
 * case folding, no substring or fuzzy matching — a near-miss is unmatched.
 */
export function resolveModel(map: ModelMap, source: RankingSource, sourceIds: string[]): string[] {
  const section = map[source];
  for (const id of sourceIds) {
    if (typeof id !== 'string' || id.length === 0) continue;
    const hit = section[id];
    if (hit === undefined) continue;
    return Array.isArray(hit) ? [...hit] : [hit];
  }
  return [];
}

/** Map targets that do not exist in the seed catalog (stale map entries).
 *  Returns the unknown `platform:modelId` keys. */
export function validateModelMapTargets(map: ModelMap, catalogKeys: Set<string>): string[] {
  const unknown = new Set<string>();
  for (const source of ['aa', 'benchlm', 'livebench'] as const) {
    for (const value of Object.values(map[source])) {
      for (const target of Array.isArray(value) ? value : [value]) {
        if (!catalogKeys.has(target)) unknown.add(target);
      }
    }
  }
  return [...unknown].sort();
}

// ---------------------------------------------------------------------------
// Budgets (persisted usage counters)
// ---------------------------------------------------------------------------

export interface BudgetState {
  version: 1;
  updatedAt: string;
  aa: { used: number; windowStartMs: number | null };
  benchlm: { used: number; month: string | null };
  /** Last `X-RateLimit-Remaining` seen from each provider, if any (advisory
   *  only — local counters are what enforce the budget). */
  serverRemaining?: Partial<Record<RankingSource, number>>;
}

export function emptyBudget(nowMs: number = Date.now()): BudgetState {
  return {
    version: 1,
    updatedAt: new Date(nowMs).toISOString(),
    aa: { used: 0, windowStartMs: null },
    benchlm: { used: 0, month: null },
  };
}

export function loadBudget(budgetPath: string, nowMs: number = Date.now()): BudgetState {
  if (!fs.existsSync(budgetPath)) return emptyBudget(nowMs);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(budgetPath, 'utf8')) as unknown;
  } catch {
    // Corrupt budget file: fail closed by treating it as empty BUT keep the
    // file — the caller overwrites it on the next record. Never silently
    // grant quota on a file we could not read, so surface it loudly.
    throw new Error(`ranking budget file at ${budgetPath} is not valid JSON — fix or delete it before fetching`);
  }
  if (!parsed || typeof parsed !== 'object') throw new Error(`ranking budget file at ${budgetPath} is not an object`);
  const raw = parsed as Partial<BudgetState>;
  const state = emptyBudget(nowMs);
  if (raw.aa && typeof raw.aa.used === 'number') state.aa.used = raw.aa.used;
  if (raw.aa && typeof raw.aa.windowStartMs === 'number') state.aa.windowStartMs = raw.aa.windowStartMs;
  if (raw.benchlm && typeof raw.benchlm.used === 'number') state.benchlm.used = raw.benchlm.used;
  if (raw.benchlm && typeof raw.benchlm.month === 'string') state.benchlm.month = raw.benchlm.month;
  if (raw.serverRemaining && typeof raw.serverRemaining === 'object') state.serverRemaining = raw.serverRemaining;
  return state;
}

export function saveBudget(budgetPath: string, state: BudgetState): void {
  fs.mkdirSync(path.dirname(budgetPath), { recursive: true });
  const toWrite: BudgetState = { ...state, updatedAt: new Date().toISOString() };
  fs.writeFileSync(budgetPath, JSON.stringify(toWrite, null, 2) + '\n');
}

function utcMonth(nowMs: number): string {
  const d = new Date(nowMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface BudgetStatus {
  allowed: boolean;
  remaining: number;
  limit: number;
  used: number;
  /** When the current window resets (ISO string), for the refusal message. */
  resetsAt: string;
}

/** Rolling-window status. AA: fixed 24h window anchored at the first
 *  request in the window (per AA docs). BenchLM: UTC calendar month. */
export function budgetStatus(state: BudgetState, source: 'aa' | 'benchlm', nowMs: number = Date.now()): BudgetStatus {
  if (source === 'aa') {
    const start = state.aa.windowStartMs;
    if (start === null || nowMs - start >= AA_WINDOW_MS) {
      return {
        allowed: true,
        remaining: AA_DAILY_LIMIT,
        limit: AA_DAILY_LIMIT,
        used: 0,
        resetsAt: new Date(nowMs + AA_WINDOW_MS).toISOString(),
      };
    }
    const used = state.aa.used;
    return {
      allowed: used < AA_DAILY_LIMIT,
      remaining: Math.max(0, AA_DAILY_LIMIT - used),
      limit: AA_DAILY_LIMIT,
      used,
      resetsAt: new Date(start + AA_WINDOW_MS).toISOString(),
    };
  }
  const month = utcMonth(nowMs);
  if (state.benchlm.month !== month) {
    return {
      allowed: true,
      remaining: BENCHLM_MONTHLY_LIMIT,
      limit: BENCHLM_MONTHLY_LIMIT,
      used: 0,
      resetsAt: nextMonthStart(nowMs).toISOString(),
    };
  }
  const used = state.benchlm.used;
  return {
    allowed: used < BENCHLM_MONTHLY_LIMIT,
    remaining: Math.max(0, BENCHLM_MONTHLY_LIMIT - used),
    limit: BENCHLM_MONTHLY_LIMIT,
    used,
    resetsAt: nextMonthStart(nowMs).toISOString(),
  };
}

function nextMonthStart(nowMs: number): Date {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

/** Mutate `state` to record `count` consumed requests. Resets an expired
 *  window first, so a stale counter never blocks a fresh window. */
export function recordUsage(
  state: BudgetState,
  source: 'aa' | 'benchlm',
  nowMs: number = Date.now(),
  count: number = 1,
  serverRemaining?: number,
): BudgetState {
  if (source === 'aa') {
    if (state.aa.windowStartMs === null || nowMs - state.aa.windowStartMs >= AA_WINDOW_MS) {
      state.aa = { used: 0, windowStartMs: nowMs };
    }
    state.aa.used += count;
  } else {
    const month = utcMonth(nowMs);
    if (state.benchlm.month !== month) state.benchlm = { used: 0, month };
    state.benchlm.used += count;
  }
  if (serverRemaining !== undefined) {
    state.serverRemaining = { ...(state.serverRemaining ?? {}), [source]: serverRemaining };
  }
  state.updatedAt = new Date(nowMs).toISOString();
  return state;
}

/** Throw RankingFetchError(budget_exhausted) when the source has no quota
 *  left; otherwise return its status. Call BEFORE any fetch. */
export function checkBudgetOrThrow(
  state: BudgetState,
  source: 'aa' | 'benchlm',
  nowMs: number = Date.now(),
): BudgetStatus {
  const status = budgetStatus(state, source, nowMs);
  if (!status.allowed) {
    const label = source === 'aa' ? 'Artificial Analysis' : 'BenchLM';
    throw new RankingFetchError(
      source,
      'budget_exhausted',
      `${label} budget exhausted: ${status.used}/${status.limit} used; resets ${status.resetsAt}. Refusing to fetch — no request was sent.`,
    );
  }
  return status;
}

// ---------------------------------------------------------------------------
// Fetch plumbing (injectable fetch for tests)
// ---------------------------------------------------------------------------

export interface MinimalResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchFn = (url: string, init?: Record<string, unknown>) => Promise<MinimalResponse>;

function defaultFetchFn(): FetchFn {
  return (async (url: string, init?: Record<string, unknown>) => {
    const res = await fetch(url, init as RequestInit);
    return res as unknown as MinimalResponse;
  }) as FetchFn;
}

function parseRetryAfter(res: MinimalResponse): number | undefined {
  const raw = res.headers?.get('retry-after') ?? res.headers?.get('Retry-After');
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function parseServerRemaining(res: MinimalResponse): number | undefined {
  const raw = res.headers?.get('x-ratelimit-remaining') ?? res.headers?.get('X-RateLimit-Remaining');
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

async function readErrorBody(res: MinimalResponse): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 500);
  } catch {
    return '';
  }
}

function httpErrorFor(source: RankingSource, status: number, body: string, retryAfter?: number): RankingFetchError {
  if (status === 401) {
    return new RankingFetchError(
      source,
      'unauthorized',
      `${source}: HTTP 401 — bad API key. Check the key in the environment (never in code); no request quota was wasted beyond this one. ${body}`,
      { status },
    );
  }
  if (status === 403) {
    return new RankingFetchError(
      source,
      'forbidden',
      `${source}: HTTP 403 — this key/tier does not cover the endpoint. For AA, the free key must use ${AA_MODELS_FREE_PATH} (the plain list endpoint is Pro+). ${body}`,
      { status },
    );
  }
  if (status === 429) {
    return new RankingFetchError(
      source,
      'rate_limited',
      `${source}: HTTP 429 — provider rate limit hit${retryAfter !== undefined ? `; retry after ${retryAfter}s` : ''}. Back off; the local budget counter already recorded this request. ${body}`,
      { status, retryAfterSeconds: retryAfter },
    );
  }
  return new RankingFetchError(source, 'http_error', `${source}: HTTP ${status}. ${body}`, { status });
}

// ---------------------------------------------------------------------------
// Parsing — one SourceResult per source per run
// ---------------------------------------------------------------------------

export interface SourceResult {
  source: RankingSource;
  /** ISO timestamp the snapshot was fetched (becomes `sourceDate`). */
  fetchedAt: string;
  /** Source version string, e.g. "aa-v5", "benchlm-v5.8", "livebench-2.0". */
  version: string;
  /** Catalog key (`platform:modelId`) → per-source benchmark inputs. */
  scores: Map<string, BenchmarkInputs>;
  /** Source ids that had no entry in the model map (stays Unranked). */
  unmatched: string[];
  /** Source rows with no parseable score (never treated as 0). */
  unscored: string[];
  /** Rows seen in the source payload. */
  rawCount: number;
  /** Catalog keys that received a score. */
  matchedCount: number;
  /** True when the source paginated beyond the single request we made. */
  partial: boolean;
  /** True when parsed from a cached snapshot instead of a live fetch. */
  fromCache?: boolean;
}

function emptyResult(source: RankingSource, fetchedAt: string, version: string): SourceResult {
  return {
    source,
    fetchedAt,
    version,
    scores: new Map(),
    unmatched: [],
    unscored: [],
    rawCount: 0,
    matchedCount: 0,
    partial: false,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function finiteScore(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Extract the AA Intelligence Index from one AA model row. Accepts the
 *  documented field as a number or as `{ value | score }` (see module
 *  header caveat — the exact sub-field name is unverified from public
 *  docs). Returns null when no parseable score is present. */
export function extractAaScore(row: Record<string, unknown>): number | null {
  const evaluations = row.evaluations;
  if (isRecord(evaluations)) {
    const direct = finiteScore(evaluations.artificial_analysis_intelligence_index);
    if (direct !== null) return direct;
    const nested = evaluations.artificial_analysis_intelligence_index;
    if (isRecord(nested)) {
      const v = finiteScore(nested.value) ?? finiteScore(nested.score);
      if (v !== null) return v;
    }
    // Fallbacks for a renamed field — same composite, other spellings.
    const alt = finiteScore(evaluations.intelligence_index) ?? finiteScore(evaluations.intelligenceIndex);
    if (alt !== null) return alt;
  }
  return finiteScore(row.artificial_analysis_intelligence_index);
}

export function parseAaResponse(payload: unknown, map: ModelMap, fetchedAt: string): SourceResult {
  if (!isRecord(payload)) {
    throw new RankingFetchError('aa', 'malformed_payload', 'AA response is not a JSON object');
  }
  // Never mix versions: the aggregate is defined on Intelligence Index v5.
  const versionRaw = payload.intelligence_index_version;
  if (typeof versionRaw === 'number' && Math.floor(versionRaw) !== AA_EXPECTED_INTELLIGENCE_INDEX_MAJOR) {
    throw new RankingFetchError(
      'aa',
      'version_mismatch',
      `AA Intelligence Index version is v${versionRaw}, expected v${AA_EXPECTED_INTELLIGENCE_INDEX_MAJOR}. Refusing to merge — never mix versions (see ranking.ts).`,
    );
  }
  const version =
    typeof versionRaw === 'number' ? `aa-v${versionRaw}` : 'aa-v5 (version not reported by API)';
  const result = emptyResult('aa', fetchedAt, version);
  const data = payload.data;
  if (!Array.isArray(data)) {
    throw new RankingFetchError('aa', 'malformed_payload', 'AA response has no `data` array');
  }
  const pagination = isRecord(payload.pagination) ? payload.pagination : undefined;
  result.partial = pagination?.has_more === true;
  result.rawCount = data.length;
  for (const entry of data) {
    if (!isRecord(entry)) {
      result.unscored.push('(non-object row)');
      continue;
    }
    const slug = typeof entry.slug === 'string' ? entry.slug : '';
    const name = typeof entry.name === 'string' ? entry.name : '';
    const sourceId = slug || name || '(unnamed row)';
    const score = extractAaScore(entry);
    if (score === null) {
      result.unscored.push(sourceId);
      continue;
    }
    const targets = resolveModel(map, 'aa', [slug, name].filter(Boolean));
    if (targets.length === 0) {
      result.unmatched.push(sourceId);
      continue;
    }
    for (const key of targets) {
      const prev = result.scores.get(key) ?? {};
      result.scores.set(key, { ...prev, aa: score, sourceDate: fetchedAt });
    }
  }
  result.matchedCount = result.scores.size;
  return result;
}

/** BenchLM evidence label → BenchmarkInputs.benchlmQuality. Anything that
 *  is not clearly Supported is treated as Estimated (the Low-confidence
 *  branch) unless it is unrecognised, in which case quality is left unset
 *  rather than guessed. */
export function benchlmQualityFromLabel(label: unknown): 'supported' | 'estimated' | undefined {
  if (typeof label !== 'string') return undefined;
  if (/support/i.test(label)) return 'supported';
  if (/estimat/i.test(label)) return 'estimated';
  return undefined;
}

function benchlmRowFields(row: Record<string, unknown>): {
  model: string;
  score: number | null;
  quality: 'supported' | 'estimated' | undefined;
} {
  const model =
    (typeof row.model === 'string' && row.model) ||
    (typeof row.model_name === 'string' && row.model_name) ||
    (typeof row.name === 'string' && row.name) ||
    (typeof row.canonical_id === 'string' && row.canonical_id) ||
    (typeof row.model_id === 'string' && row.model_id) ||
    (typeof row.slug === 'string' && row.slug) ||
    '';
  const score =
    finiteScore(row.score) ??
    finiteScore(row.final_score) ??
    finiteScore(row.benchalign_score) ??
    finiteScore(row.overall_score) ??
    null;
  const quality = benchlmQualityFromLabel(
    row.evidence ?? row.evidence_label ?? row.label ?? row.evidence_status,
  );
  return { model, score, quality };
}

export function parseBenchlmResponse(payload: unknown, map: ModelMap, fetchedAt: string): SourceResult {
  // BenchAlign v5.8 Overall is the version ranking.ts is defined on.
  const result = emptyResult('benchlm', fetchedAt, 'benchlm-v5.8');
  let rows: unknown;
  if (Array.isArray(payload)) {
    rows = payload;
  } else if (isRecord(payload)) {
    rows = payload.data ?? payload.rankings ?? payload.results ?? payload.items;
    const methodology = payload.methodology_version ?? payload.version;
    if (typeof methodology === 'string' && methodology.length > 0) result.version = `benchlm-${methodology}`;
    if (typeof methodology === 'number') result.version = `benchlm-v${methodology}`;
  }
  if (!Array.isArray(rows)) {
    throw new RankingFetchError(
      'benchlm',
      'malformed_payload',
      'BenchLM response has no row array (`data` / `rankings` / `results` / `items`)',
    );
  }
  result.rawCount = rows.length;
  for (const entry of rows) {
    if (!isRecord(entry)) {
      result.unscored.push('(non-object row)');
      continue;
    }
    const { model, score, quality } = benchlmRowFields(entry);
    const sourceId = model || '(unnamed row)';
    if (score === null) {
      result.unscored.push(sourceId);
      continue;
    }
    const targets = resolveModel(map, 'benchlm', [model]);
    if (targets.length === 0) {
      result.unmatched.push(sourceId);
      continue;
    }
    for (const key of targets) {
      const prev = result.scores.get(key) ?? {};
      const next: BenchmarkInputs = { ...prev, benchlm: score, sourceDate: fetchedAt };
      if (quality !== undefined) next.benchlmQuality = quality;
      result.scores.set(key, next);
    }
  }
  result.matchedCount = result.scores.size;
  return result;
}

/**
 * LiveBench snapshot file shape (operator-supplied, no API exists):
 *   [{ "model": "DeepSeek V4.1 Flash", "score": 79.2, "date": "2026-10-25" }, ...]
 * `model` is the LiveBench published model name, `score` the LiveBench 2.0
 * Overall (0–100), `date` the result date (defaults to the fetch date when
 * omitted). Rows are validated strictly — a bad row throws, it is never
 * silently skipped, because a silent skip would look like "Unranked".
 */
export function parseLivebenchSnapshot(payload: unknown, map: ModelMap, fetchedAt: string): SourceResult {
  if (!Array.isArray(payload)) {
    throw new RankingFetchError(
      'livebench',
      'malformed_payload',
      'LiveBench snapshot must be a JSON array of { model, score, date? } rows',
    );
  }
  const result = emptyResult('livebench', fetchedAt, `livebench-${LIVEBENCH_VERSION}`);
  result.rawCount = payload.length;
  for (let i = 0; i < payload.length; i++) {
    const entry = payload[i];
    if (!isRecord(entry)) {
      throw new RankingFetchError('livebench', 'malformed_payload', `LiveBench snapshot row ${i} is not an object`);
    }
    if (typeof entry.model !== 'string' || entry.model.length === 0) {
      throw new RankingFetchError(
        'livebench',
        'malformed_payload',
        `LiveBench snapshot row ${i} has no string "model"`,
      );
    }
    const score = finiteScore(entry.score);
    if (score === null || score < 0 || score > 100) {
      throw new RankingFetchError(
        'livebench',
        'malformed_payload',
        `LiveBench snapshot row ${i} ("${entry.model}") has no finite 0–100 "score"`,
      );
    }
    const date = typeof entry.date === 'string' && entry.date.length > 0 ? entry.date : fetchedAt;
    const targets = resolveModel(map, 'livebench', [entry.model]);
    if (targets.length === 0) {
      result.unmatched.push(entry.model);
      continue;
    }
    for (const key of targets) {
      const prev = result.scores.get(key) ?? {};
      result.scores.set(key, { ...prev, livebench: score, sourceDate: date });
    }
  }
  result.matchedCount = result.scores.size;
  return result;
}

/** Read a LiveBench snapshot file. Returns null when the file is absent
 *  (LiveBench simply missing for that run — missing = null, never 0). */
export function loadLivebenchSnapshot(
  livebenchPath: string,
  map: ModelMap,
  fetchedAt: string = new Date().toISOString(),
): SourceResult | null {
  if (!fs.existsSync(livebenchPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(livebenchPath, 'utf8')) as unknown;
  } catch (err) {
    throw new RankingFetchError(
      'livebench',
      'malformed_payload',
      `LiveBench snapshot at ${livebenchPath} is not valid JSON: ${(err as Error).message}`,
    );
  }
  return parseLivebenchSnapshot(parsed, map, fetchedAt);
}

// ---------------------------------------------------------------------------
// Live fetching — one request per source per run
// ---------------------------------------------------------------------------

export interface FetchOptions {
  fetchFn?: FetchFn;
  budgetPath?: string;
  cachePath?: string;
  /** Override for tests / deterministic runs. Defaults to Date.now(). */
  nowMs?: number;
}

interface BudgetHandle {
  state: BudgetState;
  path: string;
  nowMs: number;
}

function loadBudgetHandle(source: 'aa' | 'benchlm', opts: FetchOptions): BudgetHandle {
  const paths = defaultPaths();
  const nowMs = opts.nowMs ?? Date.now();
  const budgetPath = opts.budgetPath ?? paths.budget;
  const state = loadBudget(budgetPath, nowMs);
  checkBudgetOrThrow(state, source, nowMs);
  return { state, path: budgetPath, nowMs };
}

function writeCache(cachePath: string | undefined, payload: unknown): void {
  if (!cachePath) return;
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(payload, null, 2) + '\n');
  } catch (err) {
    // A failed cache write must not fail the fetch — the in-memory result
    // is still valid; the operator just loses the offline fallback.
    console.warn(`warning: could not write ranking cache to ${cachePath}: ${(err as Error).message}`);
  }
}

async function fetchJson(
  source: RankingSource,
  url: string,
  headers: Record<string, string>,
  fetchFn: FetchFn,
): Promise<{ payload: unknown; serverRemaining?: number; retryAfter?: number }> {
  let res: MinimalResponse;
  try {
    res = await fetchFn(url, { headers });
  } catch (err) {
    throw new RankingFetchError(source, 'network_error', `${source}: network error fetching ${url}: ${(err as Error).message}`);
  }
  const serverRemaining = parseServerRemaining(res);
  const retryAfter = parseRetryAfter(res);
  if (!res.ok) {
    const body = await readErrorBody(res);
    throw httpErrorFor(source, res.status, body, retryAfter);
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    throw new RankingFetchError(source, 'malformed_payload', `${source}: response is not valid JSON: ${(err as Error).message}`);
  }
  return { payload, serverRemaining, retryAfter };
}

export async function fetchAa(
  apiKey: string,
  map: ModelMap,
  opts: FetchOptions = {},
): Promise<SourceResult> {
  if (!apiKey) {
    throw new RankingFetchError('aa', 'missing_key', `AA key missing: set ${ENV_AA_KEY} in the environment (never in code)`);
  }
  const { state, path: budgetFile, nowMs } = loadBudgetHandle('aa', opts);
  const fetchedAt = new Date(nowMs).toISOString();
  const url = `${AA_BASE_URL}${AA_MODELS_FREE_PATH}?page=1`;
  const fetchFn = opts.fetchFn ?? defaultFetchFn();
  let payload: unknown;
  let serverRemaining: number | undefined;
  try {
    ({ payload, serverRemaining } = await fetchJson('aa', url, { 'x-api-key': apiKey, Accept: 'application/json' }, fetchFn));
  } catch (err) {
    // Any HTTP response received counts against AA's quota, even a 401/429:
    // record it before rethrowing. A network error never reached AA and is
    // not counted (fetchJson throws network_error without a response).
    if (err instanceof RankingFetchError && err.code !== 'network_error') {
      recordUsage(state, 'aa', nowMs, 1, serverRemaining);
      saveBudget(budgetFile, state);
    }
    throw err;
  }
  recordUsage(state, 'aa', nowMs, 1, serverRemaining);
  saveBudget(budgetFile, state);
  const cachePath = opts.cachePath ?? defaultPaths().cacheAa;
  writeCache(cachePath, { source: 'aa', fetchedAt, payload });
  return parseAaResponse(payload, map, fetchedAt);
}

export async function fetchBenchlm(
  apiKey: string,
  map: ModelMap,
  opts: FetchOptions = {},
): Promise<SourceResult> {
  if (!apiKey) {
    throw new RankingFetchError(
      'benchlm',
      'missing_key',
      `BenchLM key missing: set ${ENV_BENCHLM_KEY} in the environment (never in code)`,
    );
  }
  const { state, path: budgetFile, nowMs } = loadBudgetHandle('benchlm', opts);
  const fetchedAt = new Date(nowMs).toISOString();
  const url =
    `${BENCHLM_BASE_URL}${BENCHLM_RANKINGS_PATH}` +
    `?surface=${encodeURIComponent(BENCHLM_DEFAULT_SURFACE)}&limit=${BENCHLM_DEFAULT_LIMIT}`;
  const fetchFn = opts.fetchFn ?? defaultFetchFn();
  let payload: unknown;
  let serverRemaining: number | undefined;
  try {
    ({ payload, serverRemaining } = await fetchJson(
      'benchlm',
      url,
      { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      fetchFn,
    ));
  } catch (err) {
    if (err instanceof RankingFetchError && err.code !== 'network_error') {
      recordUsage(state, 'benchlm', nowMs, 1, serverRemaining);
      saveBudget(budgetFile, state);
    }
    throw err;
  }
  recordUsage(state, 'benchlm', nowMs, 1, serverRemaining);
  saveBudget(budgetFile, state);
  const cachePath = opts.cachePath ?? defaultPaths().cacheBenchlm;
  writeCache(cachePath, { source: 'benchlm', fetchedAt, payload });
  return parseBenchlmResponse(payload, map, fetchedAt);
}

/** Parse a previously cached raw snapshot (see writeCache) without
 *  touching the network or the budget. Used by --offline. */
export function fetchFromCache(
  source: 'aa' | 'benchlm',
  cachePath: string,
  map: ModelMap,
): SourceResult | null {
  if (!fs.existsSync(cachePath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as unknown;
  } catch (err) {
    throw new RankingFetchError(
      source,
      'malformed_payload',
      `ranking cache at ${cachePath} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!isRecord(parsed) || !('payload' in parsed)) {
    throw new RankingFetchError(source, 'malformed_payload', `ranking cache at ${cachePath} has no "payload"`);
  }
  const fetchedAt = typeof parsed.fetchedAt === 'string' ? parsed.fetchedAt : new Date().toISOString();
  const result =
    source === 'aa'
      ? parseAaResponse(parsed.payload, map, fetchedAt)
      : parseBenchlmResponse(parsed.payload, map, fetchedAt);
  result.fromCache = true;
  return result;
}

// ---------------------------------------------------------------------------
// Merge — seed round-trips unchanged except benchmarks / sourceDate
// ---------------------------------------------------------------------------

export interface MergeResult {
  seed: SeedCatalog;
  /** Catalog keys whose `benchmarks` changed (new or different values). */
  changed: string[];
  /** Catalog keys that received at least one score this run. */
  matched: string[];
  /** Per-source coverage: matched catalog keys / unmatched source rows. */
  coverage: Record<RankingSource, { matched: number; unmatched: string[]; unscored: string[] }>;
}

export function mergeBenchmarks(seed: SeedCatalog, results: SourceResult[]): MergeResult {
  const byKey = new Map<string, BenchmarkInputs>();
  const coverage: MergeResult['coverage'] = {
    aa: { matched: 0, unmatched: [], unscored: [] },
    benchlm: { matched: 0, unmatched: [], unscored: [] },
    livebench: { matched: 0, unmatched: [], unscored: [] },
  };
  for (const result of results) {
    coverage[result.source] = {
      matched: result.matchedCount,
      unmatched: [...result.unmatched],
      unscored: [...result.unscored],
    };
    for (const [key, inputs] of result.scores) {
      const prev = byKey.get(key) ?? {};
      const next: BenchmarkInputs = { ...prev };
      // Only overwrite a source's score when this run has a value for it;
      // every other source's score (and its date) is preserved.
      if (inputs.aa !== undefined && inputs.aa !== null) next.aa = inputs.aa;
      if (inputs.livebench !== undefined && inputs.livebench !== null) next.livebench = inputs.livebench;
      if (inputs.benchlm !== undefined && inputs.benchlm !== null) next.benchlm = inputs.benchlm;
      if (inputs.benchlmQuality !== undefined) next.benchlmQuality = inputs.benchlmQuality;
      // sourceDate = the newest contributing fetch for this model.
      const prevDate = prev.sourceDate ? Date.parse(prev.sourceDate) : NaN;
      const newDate = inputs.sourceDate ? Date.parse(inputs.sourceDate) : NaN;
      if (!Number.isNaN(newDate) && (Number.isNaN(prevDate) || newDate >= prevDate)) {
        next.sourceDate = inputs.sourceDate;
      } else if (prev.sourceDate) {
        next.sourceDate = prev.sourceDate;
      }
      byKey.set(key, next);
    }
  }

  const changed: string[] = [];
  const matched: string[] = [];
  const models = seed.models.map((model) => {
    const key = `${model.platform}:${model.modelId}`;
    const incoming = byKey.get(key);
    if (!incoming) return model;
    matched.push(key);
    const merged: BenchmarkInputs = { ...(model.benchmarks ?? {}), ...incoming };
    // sourceDate is per-model, not per-source: keep the NEWEST date the
    // model has ever carried, so an older run for one source can never
    // rewind a newer date earned from another source.
    const existingDate = model.benchmarks?.sourceDate ? Date.parse(model.benchmarks.sourceDate) : NaN;
    const mergedDate = merged.sourceDate ? Date.parse(merged.sourceDate) : NaN;
    if (!Number.isNaN(existingDate) && (Number.isNaN(mergedDate) || existingDate > mergedDate)) {
      merged.sourceDate = model.benchmarks!.sourceDate;
    }
    if (benchmarksEqual(model.benchmarks, merged)) return model;
    changed.push(key);
    return { ...model, benchmarks: merged };
  });

  return { seed: { ...seed, models }, changed, matched, coverage };
}

function benchmarksEqual(a: BenchmarkInputs | undefined, b: BenchmarkInputs): boolean {
  return (
    (a?.aa ?? null) === (b.aa ?? null) &&
    (a?.livebench ?? null) === (b.livebench ?? null) &&
    (a?.benchlm ?? null) === (b.benchlm ?? null) &&
    (a?.benchlmQuality ?? null) === (b.benchlmQuality ?? null) &&
    (a?.sourceDate ?? null) === (b.sourceDate ?? null)
  );
}
