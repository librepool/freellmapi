/**
 * Scraper registry: EVERY platform in the seed catalog maps to exactly one
 * entry — a concrete scraper class, the generic OpenAI-compatible scraper
 * with that provider's base URL + free filter, or an explicit stub with a
 * reason. No platform in the seed is left unregistered; the test suite
 * asserts coverage against catalog/data/seed-catalog.json, so adding a
 * seed platform without a registry entry fails the build.
 *
 * Kinds:
 *  - 'concrete': a dedicated class in this directory (the four churn-prone
 *    providers: aihubmix, nous, llmtr, airforce). The class owns the
 *    provider's free-id rule and ToS notes.
 *  - 'generic': OpenAICompatibleScraper configured with the provider's
 *    base URL and the free filter from its router adapter. New providers
 *    are covered by configuration, not new code.
 *  - 'stub': no usable list endpoint. The entry records WHY (key-gated
 *    list, bespoke non-OpenAI API, search-only provider, …) instead of
 *    pretending to poll. StubScraper always reports "no change" and the
 *    runner records it as skipped with the reason.
 *
 * Free filters are conservative by design: when the free/paid boundary is
 * unclear for an id, the filter excludes it. A missed model is a lost
 * lane; a wrongly-included paid model is a billing incident.
 *
 * Intervals: 6h for churn-prone rosters (the four concrete scrapers,
 * tokenharbor, mixlayer — all suffix-rule rosters that rotate);
 * 24h for the rest; 0 ("not scheduled") for stubs.
 */
import { AihubmixScraper } from './aihubmix.ts';
import { AirforceScraper } from './airforce.ts';
import { LlmtrScraper } from './llmtr.ts';
import { NousScraper } from './nous.ts';
import { OpenAICompatibleScraper } from './openai-compatible.ts';
import type { ModelListEntry } from './openai-compatible.ts';
import { StubScraper } from '../scraper.ts';
import type { CatalogScraper } from '../scraper.ts';
import type { SeedCatalog } from '../types.ts';

export type RegistryKind = 'concrete' | 'generic' | 'stub';

export interface ScraperDeps {
  fetchImpl?: typeof fetch;
  /** Test seam: false skips the robots.txt fetch. Production always checks. */
  robotsCheck?: boolean;
}

export interface RegistryEntry {
  platform: string;
  kind: RegistryKind;
  /** Null for stubs (no list endpoint). */
  baseUrl: string | null;
  /** Null for stubs. */
  listUrl: string | null;
  /** Poll interval in ms. 0 = not scheduled (stub entries). */
  intervalMs: number;
  create: (deps?: ScraperDeps) => CatalogScraper;
  /** Stub entries only: why there is no usable list endpoint. */
  reason?: string;
  /** Curation notes the operator should know (beta caveats, ToS, …). */
  notes?: string[];
}

const SIX_HOURS = 6 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

function generic(
  platform: string,
  baseUrl: string,
  freeFilter: (entry: ModelListEntry) => boolean,
  intervalMs: number,
  notes?: string[],
): RegistryEntry {
  return {
    platform,
    kind: 'generic',
    baseUrl,
    listUrl: `${baseUrl}/models`,
    intervalMs,
    create: (deps: ScraperDeps = {}) =>
      new OpenAICompatibleScraper({ platform, baseUrl, freeFilter, intervalMs, ...deps }),
    notes,
  };
}

function stub(platform: string, reason: string, notes?: string[]): RegistryEntry {
  return {
    platform,
    kind: 'stub',
    baseUrl: null,
    listUrl: null,
    intervalMs: 0,
    create: () =>
      new StubScraper({ platform, listUrl: '', kind: 'feed', intervalMs: 0 }),
    reason,
    notes,
  };
}

/** Frozen free sets, copied from the router adapters (cited per entry). */
const MEGANOVA_TIER1_FREE: ReadonlySet<string> = new Set([
  'meganova-ai/manta-mini-1.0',
  'meganova-ai/manta-flash-1.0',
  'Sao10K/L3-8B-Stheno-v3.2',
  'Sao10K/L3-70B-Euryale-v2.1',
  'Steelskull/L3.3-MS-Nevoria-70b',
  'BruhzWater/Sapphira-L3.3-70b-0.1',
  'FallenMerick/MN-Violet-Lotus-12B',
  'mistralai/Mistral-Small-3.2-24B-Instruct-2506',
]);
const KIOSAPI_FREE_ROUTES: ReadonlySet<string> = new Set([
  'meta/llama-3.1-8b',
  'qwen/qwen3-30b',
  'zai/glm-4.7-flash',
  'google/gemma-4-26b',
  'aisingapore/sea-lion-27b',
]);
const ZRO_FREE: ReadonlySet<string> = new Set(['deepseek-v4.1-flash', 'glm-5.3-flash']);

export const REGISTRY: Record<string, RegistryEntry> = {
  // ---- Concrete scrapers (churn-prone, dedicated class + ToS notes) ----
  aihubmix: {
    platform: 'aihubmix', kind: 'concrete', baseUrl: 'https://aihubmix.com/v1',
    listUrl: 'https://aihubmix.com/v1/models', intervalMs: SIX_HOURS,
    create: (deps: ScraperDeps = {}) => new AihubmixScraper(deps),
    notes: ['robots.txt disallows /v1/ — polls skip by default; see docs/scrapers.md'],
  },
  nous: {
    platform: 'nous', kind: 'concrete', baseUrl: 'https://inference-api.nousresearch.com/v1',
    listUrl: 'https://inference-api.nousresearch.com/v1/models', intervalMs: SIX_HOURS,
    create: (deps: ScraperDeps = {}) => new NousScraper(deps),
    notes: ['no robots.txt on the host — the one concrete scraper that polls live by default'],
  },
  llmtr: {
    platform: 'llmtr', kind: 'concrete', baseUrl: 'https://llmtr.com/v1',
    listUrl: 'https://llmtr.com/v1/models', intervalMs: SIX_HOURS,
    create: (deps: ScraperDeps = {}) => new LlmtrScraper(deps),
    notes: ['robots.txt disallows /v1/ — polls skip by default; /llms-full.txt is the advertised alternative source'],
  },
  airforce: {
    platform: 'airforce', kind: 'concrete', baseUrl: 'https://api.airforce/v1',
    listUrl: 'https://api.airforce/v1/models', intervalMs: SIX_HOURS,
    create: (deps: ScraperDeps = {}) => new AirforceScraper(deps),
    notes: ['robots.txt disallows /v1/ — polls skip by default; 1 req/min/account when re-enabled'],
  },

  // ---- Generic OpenAI-compatible scrapers (configuration, not code) ----
  mixlayer: generic('mixlayer', 'https://mixlayer.ai/v1', (e) => e.id.endsWith('-free'), SIX_HOURS,
    ['-free suffix rule (adapter: isMixlayerFreeModelId)',
     'GET /v1/models requires a key (401 without one, verified live in the 2026-11-08 smoke run) — this entry reports errors until a list key exists']),
  tokenharbor: generic('tokenharbor', 'https://tokenharbor.ai/v1', (e) => e.id.endsWith(':free'), SIX_HOURS,
    [':free suffix rule (adapter: isTokenHarborFreeModelId); zero price alone does NOT mean free — th-orchestra reports $0 but 402s',
     'GET /v1/models requires a key (401 without one, verified live in the 2026-11-08 smoke run) — this entry reports errors until a list key exists']),
  gonka: generic('gonka', 'https://proxy.gonkabroker.com/v1',
    (e) => e.id !== 'BAAI/bge-m3', DAY,
    ['live /v1/models probe 2026-11-08: exactly 4 models, all free; BAAI/bge-m3 is the embeddings row, excluded from the chat list']),
  llmkiwi: generic('llmkiwi', 'https://api.llm.kiwi/v1', () => true, DAY,
    ['whole service currently free (adapter: live /v1/models 2026-11-08, 5 models, all free); re-check if a paid tier appears']),
  zro: generic('zro', 'https://zro.moonmath.ai/v1', (e) => ZRO_FREE.has(e.id), DAY,
    ['frozen Free-plan set (adapter: deepseek-v4.1-flash, glm-5.3-flash)',
     'GET /v1/models requires a key (401 without one, verified live in the 2026-11-08 smoke run) — this entry reports errors until a list key exists']),
  meganova: generic('meganova', 'https://api.meganova.ai/v1', (e) => MEGANOVA_TIER1_FREE.has(e.id), DAY,
    ['frozen Tier 1 set (adapter); Manta Pro 1.0 / GLM-4.7-Flash are tagged "free" in the list but need the $1 Tier 2 deposit — excluded',
     'ToS Annex A: free modules are "for evaluation and interactive use only" — high-throughput/production use may lead to suspension']),
  moark: generic('moark', 'https://api.moark.com/v1', (e) => e.id === 'deepseek-v4-flash-0731', DAY,
    ['frozen set (adapter: only the vendor-documented featured id is seeded; models marked "free" in the square need a purchased resource package)',
     'slow/flaky from the feed host in the 2026-11-08 smoke run (robots fetch timed out once; direct curl then returned 200) — errors retry next run']),
  sensenova: generic('sensenova', 'https://token.sensenova.ai/v1', () => true, DAY,
    ['BETA: no permanent free tier published — free during the public beta only; re-check before routing paid traffic here',
     'GET /v1/models requires a key (401 without one, verified live in the 2026-11-08 smoke run) — this entry reports errors until a list key exists']),
  simplellm: generic('simplellm', 'https://api.simplellm.eu/v1', (e) => e.id.startsWith('free-'), DAY,
    ['free- prefix (adapter: free-gemma-4-E4B, free-Llama-3.1-8B-Instruct)',
     'GET /v1/models requires a key (401 without one, verified live in the 2026-11-08 smoke run) — this entry reports errors until a list key exists']),
  kiosapi: generic('kiosapi', 'https://api.kiosapi.id/v1', (e) => KIOSAPI_FREE_ROUTES.has(e.id), DAY,
    ['frozen free-route set (adapter FREE_ROUTES); the public roster also lists paid models']),
  arli: generic('arli', 'https://api.arliai.com/v1', (e) => e.id === 'Qwen3.5-27B-Derestricted', DAY,
    ['exactly one permanently free model (adapter); other models are a 5-request / 2-day trial — never seeded',
     'GET /v1/models requires a Bearer key (401 without one, verified 2026-11-08) — this entry will report errors until a list key exists; see docs/scrapers.md']),
  inferbase: generic('inferbase', 'https://api.inferbase.ai/v1', (e) => e.id === 'auto', DAY,
    ['seeded id is the auto router only (adapter: /models is public); any other listed id needs a free-tier check before seeding']),
  typhoon: generic('typhoon', 'https://api.opentyphoon.ai/v1', (e) => e.id === 'typhoon-v2.5-30b-a3b-instruct', DAY,
    ['seeded-only filter: detects removals/renames, never adds — no free-id rule is established for the wider roster (research API, rate-limited)',
     'list shape is a bare array [{id, …}], not {data: […]} — the base class accepts both (found in the 2026-11-08 smoke run)']),
  pollinations: generic('pollinations', 'https://gen.pollinations.ai/v1', () => true, DAY,
    ['free rule UNVERIFIED in the adapter — additions from this entry need operator review before --apply; seed rows here are media (flux/seedance), not chat ids',
     'gen.pollinations.ai/robots.txt disallows /v1/ (found in the 2026-11-08 smoke run) — polls skip by default']),

  // ---- Explicit stubs (no usable list endpoint) ----
  groq: stub('groq',
    'GET /v1/models requires a provider API key (401 without one); the feed service holds no provider keys.',
    ['seed rows are the free-tier llama-3.3-70b-versatile / llama-3.1-8b-instant; refresh needs an operator key or a docs change']),
  mistral: stub('mistral',
    'GET /v1/models requires a provider API key (401 without one); the feed service holds no provider keys.'),
  cloudflare: stub('cloudflare',
    'Bespoke Workers AI REST API — no OpenAI-compatible /v1/models list endpoint exists.',
    ['free tier is the Workers AI daily allocation, not a model roster; seed also carries a decision-model row']),
  google: stub('google',
    'Bespoke Gemini API (generativelanguage.googleapis.com/v1beta) — no OpenAI-compatible /v1/models list endpoint exists.',
    ['seed carries only an embeddings row (gemini-embedding-001) for this platform']),
  exa: stub('exa',
    'Search-only provider — no chat model list; the engine roster is fixed (exa-search).'),
  tavily: stub('tavily',
    'Search-only provider — no chat model list; the engine roster is fixed (tavily-search).'),
  watsonx: stub('watsonx',
    'Bespoke IBM IAM + /ml/v1 API — no public model-list endpoint; the Lite-plan models are fixed in the seed.',
    ['free tier is 300K foundation-model tokens/month; a card is held for identity verification (adapter comment)']),
};

/** Platforms with a registry entry, sorted. */
export function registeredPlatforms(): string[] {
  return Object.keys(REGISTRY).sort();
}

export function createScraper(platform: string, deps?: ScraperDeps): CatalogScraper {
  const entry = REGISTRY[platform];
  if (!entry) throw new Error(`no scraper registered for platform "${platform}"`);
  return entry.create(deps);
}

/** Every platform named anywhere in the seed (chat, embeddings, transcription, video, search, decision). */
export function seedPlatforms(seed: SeedCatalog): string[] {
  const out = new Set<string>();
  for (const m of seed.models) out.add(m.platform);
  for (const m of seed.embeddings ?? []) out.add(m.platform);
  for (const m of seed.transcriptionModels ?? []) out.add(m.platform);
  for (const m of seed.videoModels ?? []) out.add(m.platform);
  for (const m of seed.searchEngines ?? []) out.add(m.platform);
  for (const m of seed.decisionModels ?? []) out.add(m.platform);
  return [...out].sort();
}

/** Seed platforms with no registry entry — must be empty; the tests assert it. */
export function unregisteredSeedPlatforms(seed: SeedCatalog): string[] {
  return seedPlatforms(seed).filter((p) => !REGISTRY[p]);
}
