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
 * tokenharbor, mixlayer, openrouter — all suffix-rule rosters that rotate —
 * plus xkiro, llm7, navy, whose public lists carry a rotating aggregator
 * roster — plus nvidia and kilo, whose free rosters rotate/vanish without
 * notice — plus routeway, bazaarlink and requesty, whose free rosters
 * rotate (suffix-rule / zero-price aggregator pools) — plus orcarouter and
 * unorouter, whose free rosters rotate (suffix-rule aggregator pools);
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
/** NaraRouter Free plan, from the public /api/plans endpoint (live 2026-11-09). */
const NARA_FREE: ReadonlySet<string> = new Set(['laguna-s-2.1']);
/** Experiential Labs Free core models (pricing page 2026-11-09). */
const EXPERIENTIAL_FREE: ReadonlySet<string> = new Set(['gpt-6-luna', 'deepseek-v4.1-flash']);
/** AnyAPI free models (model pages' "model ID" fields, all ₳0/₳0, 2026-11-09). */
const ANYAPI_FREE: ReadonlySet<string> = new Set([
  'qwen/qwen3.8-27b:free',
  'inclusionai/ling-3.0-flash-fin:free',
  'inclusionai/ling-3.0-flash-sante:free',
  'google/gemma-4-26b-a4b-it:free',
]);
/** AMD Radeon Cloud TokenFactory chat models (official model catalog, 2026-11-09).
 *  The 5 non-chat models (MinerU2.5-Pro OCR, OmniVoice TTS, Clef/d3/d3-flash
 *  decision endpoints) are excluded; /v1/models 401s keyless. */
const RADEON_CHAT_FREE: ReadonlySet<string> = new Set([
  'DeepSeek-V4-Flash',
  'DeepSeek-V4-Flash-Vision-Exp',
  'DeepSeek-V4.1-Flash',
  'Qwen3.8-Flash-Next',
  'Qwen3.8-27B',
  'GLM-5.3-Flash',
  'MiMo-V2.6-Flash',
  'MiniCPM5-2B',
  'MiniCPM-V-4.7-1B',
  'MiniCPM-V-4.7-35B-A3B',
  'Gemma-4-31B-IT',
]);
/** NVIDIA NIM chat-capable ids (live /v1/models 2026-11-09: 84 ids; 61 kept).
 *  Excluded as non-chat by name: 9 embeddings, 5 guard/safety classifiers,
 *  1 reward model, 1 image-gen, 1 video detector, 2 parse/OCR, 2 translation,
 *  1 CLIP, 1 calibration. The list carries no free marker — the whole hosted
 *  catalog is the free trial tier (no card, ~40 RPM), so the frozen set IS the
 *  filter; additions need operator review. */
const NVIDIA_CHAT_FREE: ReadonlySet<string> = new Set([
  '01-ai/yi-large',
  'adept/fuyu-8b',
  'ai21labs/jamba-1.5-large-instruct',
  'aisingapore/sea-lion-7b-instruct',
  'bigcode/starcoder2-15b',
  'databricks/dbrx-instruct',
  'deepseek-ai/deepseek-coder-6.7b-instruct',
  'deepseek-ai/deepseek-v4.1-flash',
  'google/codegemma-1.1-7b',
  'google/codegemma-7b',
  'google/deplot',
  'google/gemma-2b',
  'google/gemma-3-12b-it',
  'google/gemma-3-4b-it',
  'google/gemma-4-31b-it',
  'google/recurrentgemma-2b',
  'ibm/granite-3.0-3b-a800m-instruct',
  'ibm/granite-3.0-8b-instruct',
  'ibm/granite-34b-code-instruct',
  'ibm/granite-8b-code-instruct',
  'meta/codellama-70b',
  'meta/llama-3.2-90b-vision-instruct',
  'meta/llama2-70b',
  'meta/muse-glimmer-30b',
  'microsoft/kosmos-2',
  'microsoft/phi-3-vision-128k-instruct',
  'microsoft/phi-3.5-moe-instruct',
  'minimaxai/minimax-m3.1-flash',
  'mistralai/codestral-22b-instruct-v0.1',
  'mistralai/mistral-7b-instruct-v0.3',
  'mistralai/mistral-large',
  'mistralai/mistral-large-2-instruct',
  'mistralai/mistral-large-4-1t-a52b',
  'mistralai/mixtral-8x22b-v0.1',
  'moonshotai/kimi-k2.6',
  'nv-mistralai/mistral-nemo-12b-instruct',
  'nvidia/cosmos-reason2-8b',
  'nvidia/llama-3.1-nemotron-51b-instruct',
  'nvidia/llama-3.1-nemotron-70b-instruct',
  'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'nvidia/llama3-chatqa-1.5-70b',
  'nvidia/mistral-nemo-minitron-8b-8k-instruct',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
  'nvidia/nemotron-3-super-120b-a12b',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'nvidia/nemotron-3.5-bolt-e4b',
  'nvidia/nemotron-3.5-lightning-30b-a3b',
  'nvidia/nemotron-3.5-super-vl-120b-a12b',
  'nvidia/nemotron-4-340b-instruct',
  'nvidia/nemotron-nano-3-30b-a3b',
  'nvidia/neva-22b',
  'nvidia/vila',
  'openai/gpt-oss-20b',
  'poolside/laguna-xs-2.1',
  'stepfun-ai/step-5-preview',
  'writer/palmyra-creative-122b',
  'writer/palmyra-fin-70b-32k',
  'writer/palmyra-med-70b',
  'writer/palmyra-med-70b-32k',
  'z-ai/glm-5.3-flash',
  'zyphra/zamba2-7b-instruct',
]);
/** Cohere trial-key chat models (official rate-limits page, 2026-11-09):
 *  all 9 Command/North chat models at 20 RPM on a trial key (1,000 calls/mo,
 *  non-commercial only). /v1/models 401s keyless. */
const COHERE_CHAT_FREE: ReadonlySet<string> = new Set([
  'command-a-03-2025',
  'command-a-plus-05-2026',
  'command-a-reasoning-08-2025',
  'command-a-translate-08-2025',
  'command-a-vision-07-2025',
  'command-r-08-2024',
  'command-r-plus-08-2024',
  'command-r7b-12-2024',
  'north-mini-code-1.0',
]);
/** Z.ai $0 models (official pricing page docs.z.ai, updated 2026-10-21):
 *  $0 on every line (input, cached input, storage, output). /v1/models 401s
 *  keyless on both the domestic and global hosts. */
const ZHIPU_FREE: ReadonlySet<string> = new Set([
  'glm-4.7-flash',
  'glm-4.5-flash',
  'glm-4.6v-flash',
]);
/** OVHcloud AI Endpoints chat models (live keyless /v1/models 2026-11-09:
 *  21 ids; 9 chat. Excluded: whisper-large-v3/turbo (transcription),
 *  Qwen3Guard-Gen-0.6B/8B (guard classifiers), stable-diffusion-xl-base-v10
 *  (image), nvr-tts-* (TTS), bge-multilingual-gemma2 / bge-m3 /
 *  Qwen3-Embedding-8B (embeddings). The list carries authenticated pricing
 *  (nonzero for chat models) — anonymous access is free, so price is NOT
 *  the signal; the frozen set is the filter. */
const OVH_CHAT_FREE: ReadonlySet<string> = new Set([
  'Qwen2.5-VL-72B-Instruct',
  'gpt-oss-120b',
  'Qwen3.6-27B',
  'Qwen3.5-397B-A17B',
  'Qwen3.8-27B',
  'Qwen3.5-9B',
  'gpt-oss-20b',
  'Mistral-Small-3.2-24B-Instruct-2506',
  'Meta-Llama-3_3-70B-Instruct',
]);
/** Agnes AI $0 Flash models (official pricing page wiki.agnes-ai.com,
 *  corroborated by one successful keyless /v1/models 200 on 2026-11-09:
 *  exactly the two Flash models are $0; Pro is metered; video/image
 *  models are media, not chat). */
const AGNES_FLASH_FREE: ReadonlySet<string> = new Set([
  'agnes-2.5-flash',
  'agnes-3.0-flash',
]);
/** SEA-LION chat models, docs-sourced (current API docs examples at
 *  docs.sea-lion.ai/guides/inferencing/api: Qwen-SEA-LION-v4.5-27B-IT
 *  instruct + tool use, Llama-SEA-LION-v3.5-70B-R reasoning).
 *  /v1/models 401s keyless, so the live list cannot be enumerated without
 *  a trial key; SEA-Guard (classifier) and the embedding model are not
 *  chat rows. */
const SEALION_CHAT_FREE: ReadonlySet<string> = new Set([
  'aisingapore/Qwen-SEA-LION-v4.5-27B-IT',
  'aisingapore/Llama-SEA-LION-v3.5-70B-R',
]);
/** ModelScope chat models (live keyless /v1/models 2026-11-09: 38 ids; 36
 *  chat. Excluded: MusePublic/Qwen-Image-Edit + Qwen/Qwen-Image-Edit
 *  (image editing, not chat). The list carries no free marker — the whole
 *  inference catalog is on the free magic-grain tier (~2,000 req/day
 *  aggregate, ≤500/model/day), so the frozen set IS the filter; additions
 *  need operator review. Retired models answer 429 "insufficient balance"
 *  — keep them out of the seed (see the adapter comment). */
const MODELSCOPE_CHAT_FREE: ReadonlySet<string> = new Set([
  'deepseek-ai/DeepSeek-V4-Flash-0731',
  'deepseek-ai/DeepSeek-V4-Pro',
  'deepseek-ai/DeepSeek-V4-Pro-0813',
  'deepseek-ai/DeepSeek-V4.1-Flash',
  'deepseek-ai/DeepSeek-V4.1-Flash-1017',
  'early-access/EA-29B-A4B',
  'MedAIBase/AntAngelMed',
  'meituan-longcat/LongCat-Flash-Lite',
  'MiniMax/MiniMax-M1-80k',
  'MiniMax/MiniMax-M3',
  'mistralai/Mistral-Large-Instruct-2407',
  'moonshotai/Kimi-K3.1-Pro',
  'nex-agi/Nex-N2.5-mini',
  'nex-agi/Nex-N2.5-Pro',
  'opencompass/CompassJudger-1-32B-Instruct',
  'OpenGVLab/InternVL3_5-241B-A28B',
  'PaddlePaddle/ERNIE-4.5-0.3B-PT',
  'PaddlePaddle/ERNIE-4.5-21B-A3B-PT',
  'PaddlePaddle/ERNIE-4.5-300B-A47B-PT',
  'PaddlePaddle/ERNIE-4.5-VL-28B-A3B-PT',
  'Qwen/Qwen3.5-122B-A10B',
  'Qwen/Qwen3.5-27B',
  'Qwen/Qwen3.5-35B-A3B',
  'Qwen/Qwen3.5-397B-A17B',
  'Qwen/Qwen3.8-27B',
  'Qwen/Qwen3.8-Flash-Next',
  'Shanghai_AI_Laboratory/Intern-S1',
  'Shanghai_AI_Laboratory/Intern-S1-mini',
  'Shanghai_AI_Laboratory/Intern-S2-Preview',
  'stepfun-ai/Step-3.5-Flash',
  'stepfun-ai/Step-3.7-Flash',
  'stepfun-ai/Step-5-Preview',
  'XGenerationLab/XiYanSQL-QwenCoder-32B-2412',
  'XGenerationLab/XiYanSQL-QwenCoder-32B-2504',
  'ZhipuAI/GLM-4.7-Flash',
  'ZhipuAI/GLM-5.2',
]);
/** Baidu Qianfan free ERNIE models (official free-opening announcement
 *  2024-05-21, doc updated 2025-04-11: 7 preset services free, "planned
 *  to stay open long-term"). Seeded 5: the AppBuilder-only Speed variant
 *  and the dated ERNIE-Lite-8K-0922 snapshot are excluded. The 17-model
 *  new-user grant (1M tokens each, 3-month validity) is one-time credit,
 *  not a permanent tier — never seeded. */
const QIANFAN_FREE: ReadonlySet<string> = new Set([
  'ernie-speed-8k',
  'ernie-speed-128k',
  'ernie-lite-8k',
  'ernie-lite-128k',
  'ernie-tiny-8k',
]);
/** AI Horde models with at least one worker online (live keyless
 *  /v1/models 2026-11-11: 13 ids; 6 seeded). The list IS the
 *  currently-online volunteer roster — it rotates by the hour, so the
 *  frozen set is the filter; additions need operator review. The two
 *  `debug-` ids are test deployments, not catalog entries.
 *  Orion-26B-A4B-v1.1 and Underdog-Saluki-27B-1.0-IQ2-mix-MTP-abliterated
 *  lost all workers and were removed from the seed 2026-11-09 (live
 *  re-check confirms); they stay in this set so the scraper re-reports
 *  them as additions if workers return. Gemma-4-E4B-it-Ultra-Uncensored-
 *  Heretic lost all workers and was removed 2026-11-10, workers returned
 *  and it re-entered the seed 2026-11-11 (live re-check confirms).
 *  Qwen3-1.7B, Qwen3-4B and zerofata/G4-MeroMero-26B-A4B lost all
 *  workers and were removed 2026-11-10 (live re-check confirms); also
 *  kept in the set. Qwen3-0.6B lost all workers 2026-11-11 — first
 *  absence, still seeded pending a second consecutive daily run.
 *  A newcomer, koboldcpp/gemma-4-E4B-it, appeared 2026-11-09, is not
 *  on the live list 2026-11-11, and is not yet in the set — operator
 *  review before adding. */
const AIHORDE_FREE: ReadonlySet<string> = new Set([
  'koboldcpp/G4-MeroMero-26B-A4B-it-uncensored-heretic',
  'koboldcpp/Gemma-4-E4B-it-Ultra-Uncensored-Heretic',
  'koboldcpp/L3-8B-Stheno-v3.2',
  'koboldcpp/Llama-3.2-1B-Instruct',
  'koboldcpp/mini-magnum-12b-v1.1',
  'koboldcpp/Orion-26B-A4B-v1.1',
  'koboldcpp/Qwen3-0.6B',
  'koboldcpp/Qwen3-1.7B',
  'koboldcpp/Qwen3-4B',
  'koboldcpp/Underdog-Saluki-27B-1.0-IQ2-mix-MTP-abliterated',
  'koboldcpp/zerofata/G4-MeroMero-26B-A4B',
]);

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
  openrouter: generic('openrouter', 'https://openrouter.ai/api/v1', (e) => e.id.endsWith(':free'), SIX_HOURS,
    [':free suffix is the free marker; /v1/models is public']),
  pollinations: generic('pollinations', 'https://gen.pollinations.ai/v1', () => true, DAY,
    ['free rule UNVERIFIED in the adapter — additions from this entry need operator review before --apply; seed rows here are media (flux/seedance), not chat ids',
     'gen.pollinations.ai/robots.txt disallows /v1/ (found in the 2026-11-08 smoke run) — polls skip by default']),
  nara: generic('nara', 'https://router.bynara.id/v1', (e) => NARA_FREE.has(e.id), DAY,
    ['frozen Free-plan set from the public /api/plans endpoint (live 2026-11-09: Free = 7M tokens/day, no card, exactly [laguna-s-2.1])',
     'GET /v1/models requires a key (401 without one, verified live 2026-11-09) — this entry reports errors until a list key exists',
     'aggregator: Laguna is another provider\'s lane re-served; Nara\'s 210M/month is counted once in the token floor — never add an upstream cap for it']),
  xkiro: generic('xkiro', 'https://api.xkiro.com/v1', (e) => e.access_tier === 'free', SIX_HOURS,
    ['access_tier == "free" (live /v1/models 2026-11-09: 26 free of 69, all $0, all chat); paid models 403 on free accounts',
     'free ids re-serve Mistral/Cohere/SenseNova lanes; the 5M/day pool is shared — budget 150M is the pool, not per-model',
     'no robots.txt on the host (404, checked 2026-11-09) — polls run']),
  experiential: generic('experiential', 'https://api.experientiallabs.ai/v1', (e) => EXPERIENTIAL_FREE.has(e.id), DAY,
    ['frozen Free core-model set (pricing page 2026-11-09: GPT-6 Luna + DeepSeek V4.1 Flash share 1M/day); Clef is a decision endpoint, not chat; Jev is existing-accounts-only',
     'GET /v1/models requires a Bearer key (401 without one, verified live 2026-11-09) — this entry reports errors until a list key exists',
     'temporary $1 card-verification charge (refunded) unlocks free models',
     'no robots.txt on the host (404, checked 2026-11-09) — polls run']),
  llm7: generic('llm7', 'https://api.llm7.io/v1', (e) => e.tier === 'turbo' && e.model_type === 'chat' && e.usage_based_only !== true, SIX_HOURS,
    ['tier == "turbo" and model_type == "chat", not usage_based_only (live /v1/models 2026-11-09: 3 turbo chat models; the other 64 are Pro)',
     'free token: 100K tokens/day rolling 24h (TERMS.md 2026-10-15); anonymous access reaches the same turbo models at lower rates',
     'ToS §3A: no resale/proxy/downstream access without prior written approval — routing here needs approval',
     'robots.txt carries content-signal lines only, no Disallow (checked 2026-11-09) — polls run']),
  navy: generic('navy', 'https://api.navy/v1', (e) => e.premium === false && e.endpoint === '/v1/chat/completions', SIX_HOURS,
    ['premium == false and endpoint == "/v1/chat/completions" (live /v1/models 2026-11-09: 70 chat of 88 non-premium; the other 18 are image/audio/embeddings/moderation)',
     'free plan is 150K tokens/day; non-premium models draw from it at token_multiplier rates — budget 4.5M is the pool, not per-model',
     'live smoke tests required an explicit User-Agent header (adapter); the scraper sends its own UA — watch for 403s',
     'robots.txt fetch 403s (checked 2026-11-09) — a non-2xx robots fetch means "no restriction", so polls run']),
  aion: generic('aion', 'https://api.aionlabs.ai/v1', () => true, DAY,
    ['whole 6-model roster is free-tier (live /v1/models 2026-11-09; the rate-limits doc gates tiers by request/token limits only — Free is default on signup, 20K/day)',
     'first-party roleplay models; all priced per-token upstream, free within the daily cap',
     'robots.txt carries content-signal lines only, no Disallow (checked 2026-11-09) — polls run']),
  anyapi: generic('anyapi', 'https://api.anyapi.ai/v1', (e) => ANYAPI_FREE.has(e.id), DAY,
    ['frozen :free set (model pages 2026-11-09: 4 ids, all ₳0/₳0; the Gemma page is titled "Gemma 3n 4B (free)" but its model-ID field reads google/gemma-4-26b-a4b-it:free)',
     'GET /v1/models requires a key (401 without one, verified live 2026-11-09) — this entry reports errors until a list key exists',
     'budgets are in proprietary ANY Tokens, not raw tokens — see the anyapi-any-tokens quirk in the seed',
     'robots.txt fetch 403s (checked 2026-11-09) — a non-2xx robots fetch means "no restriction", so polls run']),
  radeon: generic('radeon', 'https://developer.amd.com.cn/radeon/api/v1', (e) => RADEON_CHAT_FREE.has(e.id), DAY,
    ['frozen chat set (official model catalog 2026-11-09: 11 chat ids; MinerU2.5-Pro OCR, OmniVoice TTS and Clef/d3/d3-flash decision endpoints excluded)',
     'GET /v1/models requires a key (401 without one, verified live 2026-11-09) — this entry reports errors until a list key exists',
     'Token Factory is free with a daily points cap (points are not money or credits); China site only; "free trial and development service, not for production" — no resale',
     'no robots.txt on the host (404, checked 2026-11-09) — polls run']),
  nvidia: generic('nvidia', 'https://integrate.api.nvidia.com/v1', (e) => NVIDIA_CHAT_FREE.has(e.id), SIX_HOURS,
    ['frozen chat set (live /v1/models 2026-11-09: 84 ids, 61 chat; 23 non-chat excluded by name — embeddings, guards, reward, image/video, parse, translation, CLIP, calibration)',
     'the list carries no free marker — the whole hosted catalog is the free trial tier (no card, ~40 RPM); the frozen set is the filter, additions need operator review',
     'trial ToS: internal testing/evaluation only, not production; prompts may be used to improve NVIDIA models; models vanish without notice — 6h churn check',
     'no robots.txt on the host (404, checked 2026-11-09) — polls run']),
  cohere: generic('cohere', 'https://api.cohere.ai/compatibility/v1', (e) => COHERE_CHAT_FREE.has(e.id), DAY,
    ['frozen chat set (official rate-limits page 2026-11-09: all 9 Command/North chat models at 20 RPM on a trial key)',
     'GET /v1/models requires a key (401 without one, verified live 2026-11-09 on both the native and compatibility hosts) — this entry reports errors until a list key exists',
     'trial key: 1,000 API calls/month shared across the key, non-commercial use only — the "trial key" wording is a friction flag, not a billing incident',
     'robots.txt fetch 403s (checked 2026-11-09) — a non-2xx robots fetch means "no restriction", so polls run']),
  zhipu: generic('zhipu', 'https://open.bigmodel.cn/api/paas/v4', (e) => ZHIPU_FREE.has(e.id), DAY,
    ['frozen $0 set (official pricing page docs.z.ai, updated 2026-10-21: glm-4.7-flash, glm-4.5-flash, glm-4.6v-flash $0 on every line; GLM-5.3-Flash is $0.15 — paid, excluded)',
     'GET /v1/models requires a key (401 without one, verified live 2026-11-09 on both the domestic and global hosts) — this entry reports errors until a list key exists',
     'robots.txt has no Disallow on /api/ (checked 2026-11-09) — polls run']),
  // Kilo's list lives at /api/gateway/models, NOT {baseUrl}/models (the /v1/models
  // path only accepts POST) — so this entry is built by hand: the registry
  // baseUrl is the router base, but the scraper is pointed at the gateway root
  // so its listUrl comes out as https://api.kilo.ai/api/gateway/models.
  kilo: {
    platform: 'kilo', kind: 'generic', baseUrl: 'https://api.kilo.ai/api/gateway/v1',
    listUrl: 'https://api.kilo.ai/api/gateway/models', intervalMs: SIX_HOURS,
    create: (deps: ScraperDeps = {}) =>
      new OpenAICompatibleScraper({ platform: 'kilo', baseUrl: 'https://api.kilo.ai/api/gateway', freeFilter: (e) => e.isFree === true, intervalMs: SIX_HOURS, ...deps }),
    notes: ['isFree === true (live /api/gateway/models 2026-11-12: 11 of 382, all $0 prompt/completion; the two $0-priced Lyria audio previews have isFree false and are excluded; thinkingmachines/inkling-2-small:free withdrawn 2026-11-12, remaining Inkling variants paid)',
      'gateway re-serves upstream free lanes (NVIDIA, Cohere, OpenRouter); kilo-auto/free and openrouter/free are routers, not models — they rotate/select free models',
      'free prompts/outputs are logged for training (adapter); free routes transition to paid without notice — 6h churn check',
      'robots.txt has no Disallow on /api/ (checked 2026-11-09) — polls run'],
  },
  ovh: generic('ovh', 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', (e) => OVH_CHAT_FREE.has(e.id), DAY,
    ['frozen chat set (live keyless /v1/models 2026-11-09: 21 ids, 9 chat; whisper, guard, image, TTS and embeddings excluded)',
     'anonymous tier is 2 RPM/IP/model (no key, no signup); list pricing is authenticated pricing, NOT the free signal — chat models list nonzero prices but are free anonymously',
     'mnfst lists an EOL of 2026-11-04 for Mistral-Small-3.2-24B-Instruct-2506, yet it is still in the live list — watch for removal',
     'no robots.txt on the host (404, checked 2026-11-09) — polls run']),
  agnes: generic('agnes', 'https://apihub.agnes-ai.com/v1', (e) => AGNES_FLASH_FREE.has(e.id), DAY,
    ['frozen $0 Flash set (official pricing page: agnes-2.5-flash + agnes-3.0-flash currently $0; Pro metered; video/image excluded)',
     'GET /v1/models 401s keyless as of 2026-11-09 — after one successful keyless 200 the same morning (9 ids) — this entry reports errors until a list key exists or keyless access stabilizes',
     '$0 is promotional ("previously $X" / "during this period") — watch for reversion to paid',
     'robots.txt fetch 403s (Cloudflare, checked 2026-11-09) — a non-2xx robots fetch means "no restriction", so polls run']),
  routeway: generic('routeway', 'https://api.routeway.ai/v1', (e) => e.id.endsWith(':free'), SIX_HOURS,
    [':free suffix rule (live /v1/models 2026-11-09: 287 models, 9 :free, all $0, all available; no other $0 models)',
     'free pool is 200 req/day, 20 RPM, shared low-priority queue; the :free roster is an aggregator pool — 6h churn check',
     'robots.txt fetch 403s (Cloudflare, checked 2026-11-09) — a non-2xx robots fetch means "no restriction", so polls run']),
  bazaarlink: generic('bazaarlink', 'https://bazaarlink.ai/api/v1',
    (e) => {
      const p = e.pricing as { prompt?: unknown; completion?: unknown } | undefined;
      return p?.prompt === '0' && p?.completion === '0';
    }, SIX_HOURS,
    ['zero pricing (prompt "0" + completion "0") is the free signal (live /v1/models 2026-11-09: 127 models, 7 at $0)',
     'the June-2026 adapter comment ("only auto:free is cataloged") is stale: the live list now also prices nemotron-3.5-lightning-free and glyph-cluster at $0, plus namespaced :free variants of the same two models and qwen/qwen3.7-flash:free — bare + :free ids of one model are both seeded, as listed',
     'free pool is 10 RPM + 60 weighted units/day (units are not tokens); the auto:free route picks a currently-available zero-cost model — 6h churn check',
     'robots.txt allows / (checked 2026-11-09) — polls run']),
  requesty: generic('requesty', 'https://router.requesty.ai/v1',
    (e) => e.api === 'chat' && e.input_price === 0 && e.output_price === 0 && e.id !== 'nvidia/nemotron-3.5-content-safety', SIX_HOURS,
    ['zero price (input_price 0 + output_price 0) + api == "chat" (live /v1/models 2026-11-10: 8 zero-price chat, all seeded; the content-safety classifier is also gone from the live list)',
     'nvidia/nemotron-3.5-content-safety is zero-price but a guard classifier — excluded, no seed precedent for guards',
     'free tier is 200 req/day on free models; Requesty says the free catalogue changes as providers add/remove models — 6h churn check',
     'no robots.txt on the host (404, checked 2026-11-09) — polls run']),
  sealion: generic('sealion', 'https://api.sea-lion.ai/v1', (e) => SEALION_CHAT_FREE.has(e.id), DAY,
    ['frozen docs-sourced set (current API docs examples: Qwen-SEA-LION-v4.5-27B-IT instruct + tool use, Llama-SEA-LION-v3.5-70B-R reasoning; SEA-Guard classifier excluded; embedding row SEA-LION-ModernBERT-Embedding-600M seeded from the docs example)',
     'GET /v1/models requires a key (401 without one, verified live 2026-11-09) — this entry reports errors until a list key exists',
     'trial key only: Google sign-in via the Playground, 1 key per user, 10 RPM, prototyping only — the "trial key" wording is a friction flag, not a billing incident',
     'no robots.txt on the host (404, checked 2026-11-09) — polls run']),
  orcarouter: generic('orcarouter', 'https://api.orcarouter.ai/v1',
    (e) => e.id === 'orcarouter/free' || e.id.endsWith('-free'), SIX_HOURS,
    ['-free suffix + the orcarouter/free auto route (adapter; live /v1/models 2026-11-12: 215 models, 6 free; orca/orcaverify-text1.0-free withdrawn 2026-11-12; two carry explicit $0 pricing, the rest no pricing field — the suffix is the marker)',
     'rotating $0 lineup, 10 RPM / 50 req/day; free routes never fall back to paid models, so a 429 is a clean quota signal, not a wallet risk — 6h churn check',
     'robots.txt has no Disallow on / (User-agent: * Allow: /, checked 2026-11-09) — polls run']),
  unorouter: generic('unorouter', 'https://api.unorouter.com/v1',
    (e) => {
      if (!e.id.endsWith(':free')) return false;
      const types = e.supported_endpoint_types as string[] | undefined;
      if (!Array.isArray(types) || !types.includes('openai')) return false;
      if (types.includes('embedding') || types.includes('image-generation')) return false;
      if (e.id.startsWith('whisper')) return false;
      return true;
    }, SIX_HOURS,
    [':free suffix + openai endpoint type, excluding embeddings / image-generation / whisper (live /v1/models 2026-11-09: 341 models, 180 :free, 110 chat; 34 embeddings, 24 image, 4 whisper excluded)',
     'pure aggregator of ~50 upstream free lanes; 1 req/min per free model; a burst of parallel requests trips an account-wide 429 on every :free model for several minutes — 6h churn check',
     'the :free roster includes frontier ids (gpt-4o, claude-haiku-4-5) whose upstream free provenance is unverified — a listed id is not a serving guarantee; the health check catches dead lanes',
     'api.unorouter.com/robots.txt disallows / (checked 2026-11-09) — polls skip by default; needs a documented operator decision to re-enable']),
  modelscope: generic('modelscope', 'https://api-inference.modelscope.cn/v1', (e) => MODELSCOPE_CHAT_FREE.has(e.id), DAY,
    ['frozen chat set (live keyless /v1/models 2026-11-09: 38 ids, 36 chat; the 2 Qwen-Image-Edit ids are image editing, not chat)',
     'the whole inference catalog is the free magic-grain tier (~2,000 req/day aggregate, ≤500/model/day) — the frozen set is the filter, additions need operator review',
     'calls only work after binding to an Alibaba Cloud CHINA-site account with real-name verification — unbound tokens 401',
     'no robots.txt on the host (404, checked 2026-11-09) — polls run']),
  qianfan: generic('qianfan', 'https://qianfan.baidubce.com/v2', (e) => QIANFAN_FREE.has(e.id), DAY,
    ['frozen free set (official 2024-05-21 announcement, doc updated 2025-04-11: 7 preset services free, "planned to stay open long-term"; seeded 5 — AppBuilder variant + dated Lite-8K-0922 snapshot excluded)',
     'GET /v2/models 429s keyless ("Over rate limit", checked 2026-11-09) — this entry reports errors until a list key exists',
     'CONFLICTING SIGNAL: one secondary source claims a 2026-07-28 retirement notice lists Speed/Lite — no official notice found; AIMap notes the models are "no longer shown in the current model list (unverified)". The seed rows rest on the still-live official announcement; re-check before relying on them',
     'the 17-model new-user grant (1M tokens each, 3 months) is one-time credit, not a permanent tier — never seeded',
     'no robots.txt on the host (404, checked 2026-11-09) — polls run']),
  xfyun: generic('xfyun', 'https://spark-api-open.xf-yun.com/v1', (e) => e.id === 'lite', DAY,
    ['frozen set (official Spark HTTP docs: Lite "can be used for free"; model id `lite`, max input 8K / output 4K)',
     'GET /v1/models requires a key (401 without one, verified live 2026-11-09) — this entry reports errors until a list key exists',
     'Lite does NOT support tool calling (Max/Ultra only) — the seed row carries supportsTools false; real-name verification required on the account',
     'robots.txt fetch 401s (checked 2026-11-09) — a non-2xx robots fetch means "no restriction", so polls run']),
  aihorde: generic('aihorde', 'https://oai.aihorde.net/v1', (e) => AIHORDE_FREE.has(e.id), DAY,
    ['frozen set of models with ≥1 worker online (live keyless /v1/models 2026-11-11: 13 ids, 6 seeded; Gemma-4-E4B-it-Ultra-Uncensored-Heretic lost all workers and left the seed 2026-11-10, workers returned and it re-entered 2026-11-11; Qwen3-1.7B, Qwen3-4B + zerofata/G4-MeroMero-26B-A4B still out — kept in the frozen set so the scraper re-reports them if workers return; Qwen3-0.6B absent first run 2026-11-11, still seeded, watch)',
     'volunteer kudos queue: anonymous key 0000000000 works at lowest priority, a registered key raises priority; no monthly cap, no key in the usual sense — the adapter is keyless',
     'the worker roster rotates by the hour — the frozen set is the filter so the scraper watches for seeded models losing all workers without flooding on every ephemeral worker; NOT a 6h churn candidate',
     'queue-based: calls can take tens of seconds, no upstream streaming, max_tokens >= 16, usage reported as kudos (synthesized into token counts)',
     'no robots.txt on the host (404, checked 2026-11-09) — polls run']),

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
    ['seed carries 7 free Flash chat rows (official pricing page 2026-11-09: gemini-3.8/3.6-flash, 3.5/3.1-flash-lite, 3-flash-preview, 2.5-flash/lite) plus the gemini-embedding-001 embeddings row; Pro Preview / Omni video / image / TTS / Live models are paid or non-chat and are not seeded']),
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
