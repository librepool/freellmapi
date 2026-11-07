/**
 * export-catalog — build the signed catalog product from the live freeapi DB.
 *
 * This is the single source of truth pipeline: every model and its resolved
 * quirks come straight out of the same SQLite DB the router uses, so the
 * published catalog can never drift from what the gateway actually serves.
 * The output JSON is what the standalone catalog server (catalog/) hands
 * to clients — fresh ("live") to Premium, a monthly snapshot to free users.
 *
 * LibrePool notes:
 *  - The 15-day free delay is enforced by the feed service
 *    (catalog/src/snapshot.ts), NOT here: this script emits the full live
 *    document; the feed service derives the monthly snapshot from it.
 *  - The feed service's source of truth is its own seed DB, not a router DB;
 *    this script is the bridge that lets a router DB produce a compatible
 *    document (e.g. for bootstrapping the feed's seed data).
 *  - Chat-model `premiumSince` is NOT stored in the router DB (the `models`
 *    table has no such column and the router never stores it for chat
 *    models), so it can only come from an optional sidecar file:
 *    --premium-since <path> (JSON map "platform:model_id" -> ISO date).
 *    Without it, chat models omit premiumSince and the feed service must get
 *    entry dates from its own records. Search/decision premiumSince comes
 *    from media_models.meta_json, where the router stores it.
 *  - Media (image/audio) rows live in media_models, not models, and carry no
 *    speedRank / sizeLabel / contextWindow in the DB; they are emitted as
 *    `models[]` entries with modality set and those fields omitted — the
 *    router's media path never reads them — plus `limits` all-null, which
 *    the router's shape check requires on every models[] entry.
 *
 * Usage:
 *   tsx src/scripts/export-catalog.ts [--db <path>] [--out <path>]
 *                                     [--version <YYYY.MM.DD>] [--tier live|monthly]
 *                                     [--premium-since <path>] [--stdout]
 *
 * Defaults: reads the server's data/freeapi.db, writes the repo's
 * catalog/data/catalog.live.json. The catalog server signs it separately
 * (catalog/src/scripts/sign-catalog.ts) so the signature covers the exact
 * bytes served.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, getDb } from '../db/index.js';
import { getAllProviders } from '../providers/index.js';
import { resolveQuirksByModel, quirkKey, listQuirkDefinitions } from '../services/quirks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// server/src/scripts -> repo root (where catalog/ lives in the LibrePool fork).
const SUITE_ROOT = path.resolve(__dirname, '../../..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function dateVersion(d = new Date()): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}.${mm}.${dd}`;
}

/** Adapter metadata the router stores in media_models.meta_json (see
 *  server/src/services/catalog-sync.ts applyCatalog + the media-meta
 *  migration). Parsed defensively: a corrupt blob yields {}. */
function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function metaStr(meta: Record<string, unknown>, key: string): string | undefined {
  return typeof meta[key] === 'string' ? (meta[key] as string) : undefined;
}

function metaNum(meta: Record<string, unknown>, key: string): number | null {
  return typeof meta[key] === 'number' ? (meta[key] as number) : null;
}

interface ModelRow {
  platform: string;
  model_id: string;
  display_name: string;
  intelligence_rank: number;
  speed_rank: number;
  size_label: string;
  rpm_limit: number | null;
  rpd_limit: number | null;
  tpm_limit: number | null;
  tpd_limit: number | null;
  monthly_token_budget: string;
  context_window: number | null;
  enabled: number;
  supports_vision: number;
  supports_tools: number;
}

interface MediaRow {
  platform: string;
  model_id: string;
  display_name: string;
  modality: string;
  priority: number;
  enabled: number;
  quota_label: string;
  meta_json: string | null;
}

interface EmbeddingRow {
  family: string;
  platform: string;
  model_id: string;
  display_name: string;
  dimensions: number;
  max_input_tokens: number | null;
  priority: number;
  enabled: number;
  quota_label: string;
}

function main() {
  const dbPath = arg('db');
  const tier = (arg('tier') as 'live' | 'monthly' | undefined) ?? 'live';
  const version = arg('version') ?? dateVersion();

  // Optional sidecar: {"platform:model_id": "ISO premiumSince"} — the only
  // source of chat-model entry dates, since the router DB stores none.
  const premiumSinceMap: Record<string, string> = {};
  const premiumSincePath = arg('premium-since');
  if (premiumSincePath) {
    const parsed: unknown = JSON.parse(fs.readFileSync(premiumSincePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      Object.assign(premiumSinceMap, parsed);
    }
  }

  // In --stdout mode stdout must carry ONLY the JSON document; incidental
  // logs (e.g. initDb's "Database initialized at ...") go to stderr instead.
  if (flag('stdout')) console.log = console.error;

  initDb(dbPath);
  const db = getDb();

  const models = db
    .prepare(
      `SELECT platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
              rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
              enabled, supports_vision, supports_tools
         FROM models
        ORDER BY intelligence_rank ASC, platform ASC, model_id ASC`,
    )
    .all() as ModelRow[];

  // Generative-media, transcription, video, search and decision rows all live
  // in media_models, distinguished by modality.
  const mediaRows = db
    .prepare(
      `SELECT platform, model_id, display_name, modality, priority, enabled, quota_label, meta_json
         FROM media_models
        ORDER BY priority ASC, platform ASC, model_id ASC`,
    )
    .all() as MediaRow[];

  const embeddingRows = db
    .prepare(
      `SELECT family, platform, model_id, display_name, dimensions, max_input_tokens,
              priority, enabled, quota_label
         FROM embedding_models
        ORDER BY priority ASC, platform ASC, model_id ASC`,
    )
    .all() as EmbeddingRow[];

  const quirksByModel = resolveQuirksByModel(db);
  const quirkDefs = listQuirkDefinitions(db);

  // Only platforms that actually have a registered provider AND a model in the
  // catalog — skip 'custom' (user-supplied endpoint, nothing to publish).
  const livePlatforms = new Set([
    ...models.map((m) => m.platform),
    ...mediaRows.map((m) => m.platform),
    ...embeddingRows.map((m) => m.platform),
  ]);
  const platforms = getAllProviders()
    .filter((p) => p.platform !== 'custom' && livePlatforms.has(p.platform))
    .map((p) => ({ id: p.platform, name: p.name }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const catalogModels = models.map((m) => {
    const since = premiumSinceMap[`${m.platform}:${m.model_id}`];
    return {
      platform: m.platform,
      modelId: m.model_id,
      displayName: m.display_name,
      intelligenceRank: m.intelligence_rank,
      speedRank: m.speed_rank,
      sizeLabel: m.size_label,
      limits: {
        rpm: m.rpm_limit,
        rpd: m.rpd_limit,
        tpm: m.tpm_limit,
        tpd: m.tpd_limit,
      },
      monthlyTokenBudget: m.monthly_token_budget,
      contextWindow: m.context_window,
      enabled: m.enabled === 1,
      supportsVision: m.supports_vision === 1,
      supportsTools: m.supports_tools === 1,
      ...(typeof since === 'string' ? { premiumSince: since } : {}),
      quirks: quirksByModel.get(quirkKey(m.platform, m.model_id)) ?? [],
    };
  });

  // Media rows (modality image/audio) ride in models[] with modality set,
  // exactly how the router's applyCatalog routes them back into media_models.
  // The DB stores no speedRank/sizeLabel/limits/contextWindow for them and
  // the router's media path never reads those fields, so they are omitted.
  const byModality = (modality: string): MediaRow[] => mediaRows.filter((r) => r.modality === modality);
  for (const r of [...byModality('image'), ...byModality('audio')]) {
    const meta = parseMeta(r.meta_json);
    const since = metaStr(meta, 'premiumSince');
    catalogModels.push({
      platform: r.platform,
      modelId: r.model_id,
      displayName: r.display_name,
      intelligenceRank: r.priority,
      modality: r.modality,
      // The router's shape check requires `limits` on every models[] entry;
      // media rows store no caps, so all-null (honest, not invented).
      limits: { rpm: null, rpd: null, tpm: null, tpd: null },
      mediaNote: r.quota_label || undefined,
      ...(metaStr(meta, 'requestStyle') ? { requestStyle: metaStr(meta, 'requestStyle') } : {}),
      enabled: r.enabled === 1,
      ...(typeof since === 'string' ? { premiumSince: since } : {}),
      quirks: quirksByModel.get(quirkKey(r.platform, r.model_id)) ?? [],
    } as never);
  }

  const embeddings = embeddingRows.map((m) => ({
    family: m.family,
    platform: m.platform,
    modelId: m.model_id,
    displayName: m.display_name,
    dimensions: m.dimensions,
    maxInputTokens: m.max_input_tokens,
    priority: m.priority,
    enabled: m.enabled === 1,
    quotaLabel: m.quota_label,
  }));

  const transcriptionModels = byModality('transcription').map((r) => {
    const meta = parseMeta(r.meta_json);
    const subtitleFormats = Array.isArray(meta.subtitleFormats)
      ? (meta.subtitleFormats as unknown[]).filter((f): f is string => typeof f === 'string')
      : undefined;
    return {
      platform: r.platform,
      modelId: r.model_id,
      displayName: r.display_name,
      priority: r.priority,
      enabled: r.enabled === 1,
      ...(subtitleFormats?.length ? { subtitleFormats } : {}),
      ...(metaNum(meta, 'maxBytes') !== null ? { maxBytes: metaNum(meta, 'maxBytes') } : {}),
      ...(metaStr(meta, 'requestStyle') ? { requestStyle: metaStr(meta, 'requestStyle') } : {}),
      ...(r.quota_label ? { quotaLabel: r.quota_label } : {}),
      ...(metaStr(meta, 'premiumSince') ? { premiumSince: metaStr(meta, 'premiumSince') } : {}),
    };
  });

  const videoModels = byModality('video').map((r) => {
    const meta = parseMeta(r.meta_json);
    return {
      platform: r.platform,
      modelId: r.model_id,
      displayName: r.display_name,
      priority: r.priority,
      enabled: r.enabled === 1,
      ...(r.quota_label ? { quotaLabel: r.quota_label } : {}),
      ...(metaStr(meta, 'providerModelId') ? { providerModelId: metaStr(meta, 'providerModelId') } : {}),
      ...(metaStr(meta, 'premiumSince') ? { premiumSince: metaStr(meta, 'premiumSince') } : {}),
    };
  });

  const searchEngines = byModality('search').map((r) => {
    const meta = parseMeta(r.meta_json);
    const features = meta.features && typeof meta.features === 'object' && !Array.isArray(meta.features)
      ? (meta.features as { news?: boolean; answer?: boolean; fullContent?: boolean })
      : undefined;
    return {
      platform: r.platform,
      engineId: r.model_id,
      displayName: r.display_name,
      priority: r.priority,
      enabled: r.enabled === 1,
      ...(r.quota_label ? { quotaLabel: r.quota_label } : {}),
      ...(metaNum(meta, 'creditsPerQuery') !== null ? { creditsPerQuery: metaNum(meta, 'creditsPerQuery') } : {}),
      ...(features ? { features } : {}),
      ...(metaStr(meta, 'premiumSince') ? { premiumSince: metaStr(meta, 'premiumSince') } : {}),
    };
  });

  const decisionModels = byModality('decision').map((r) => {
    const meta = parseMeta(r.meta_json);
    return {
      platform: r.platform,
      modelId: r.model_id,
      displayName: r.display_name,
      priority: r.priority,
      enabled: r.enabled === 1,
      ...(r.quota_label ? { quotaLabel: r.quota_label } : {}),
      ...(metaNum(meta, 'contextWindow') !== null ? { contextWindow: metaNum(meta, 'contextWindow') } : {}),
      ...(metaStr(meta, 'premiumSince') ? { premiumSince: metaStr(meta, 'premiumSince') } : {}),
    };
  });

  // Sections the source DB has no rows for are OMITTED, not emitted empty:
  // the router treats a present-but-empty search/decision/video/
  // transcription snapshot as authoritative ("zero rows") and prunes existing
  // rows, while an omitted key leaves them untouched. An empty source DB
  // means "unknown", not "retired everything".
  const catalog = {
    version,
    generatedAt: new Date().toISOString(),
    tier,
    counts: {
      platforms: platforms.length,
      models: catalogModels.length,
      enabledModels: catalogModels.filter((m) => m.enabled).length,
      embeddings: embeddings.length,
      transcriptionModels: transcriptionModels.length,
      videoModels: videoModels.length,
      searchEngines: searchEngines.length,
      decisionModels: decisionModels.length,
      quirks: quirkDefs.length,
    },
    platforms,
    models: catalogModels,
    ...(embeddings.length > 0 ? { embeddings } : {}),
    ...(transcriptionModels.length > 0 ? { transcriptionModels } : {}),
    ...(videoModels.length > 0 ? { videoModels } : {}),
    ...(searchEngines.length > 0 ? { searchEngines } : {}),
    ...(decisionModels.length > 0 ? { decisionModels } : {}),
    quirks: quirkDefs,
  };

  const json = JSON.stringify(catalog, null, 2) + '\n';

  if (flag('stdout')) {
    process.stdout.write(json);
    return;
  }

  const outPath = arg('out') ?? path.join(SUITE_ROOT, 'catalog', 'data', `catalog.${tier}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, json);
  console.log(
    `Wrote ${tier} catalog ${version}: ${catalog.counts.models} models ` +
      `(${catalog.counts.enabledModels} enabled), ${catalog.counts.platforms} platforms, ` +
      `${catalog.counts.embeddings} embeddings, ${catalog.counts.transcriptionModels} transcription, ` +
      `${catalog.counts.videoModels} video, ${catalog.counts.searchEngines} search, ` +
      `${catalog.counts.decisionModels} decision, ${catalog.counts.quirks} quirks -> ${outPath}`,
  );
}

main();
