/**
 * Shared types for the LibrePool catalog feed service.
 *
 * These mirror the router's contract in server/src/services/catalog-sync.ts
 * (Catalog, CatalogModel, …). The router validates incoming payloads with
 * catalogShapeProblems(); this service must emit exactly that shape.
 * Fields the router does not know about (feed-internal `premiumSince` on chat
 * models, `benchmarks`) are stripped before serving — see catalog-store.ts.
 */

export type CatalogTier = 'live' | 'monthly';

export interface CatalogLimits {
  rpm: number | null;
  rpd: number | null;
  tpm: number | null;
  tpd: number | null;
}

export interface CatalogModel {
  platform: string;
  modelId: string;
  displayName: string;
  intelligenceRank: number;
  speedRank: number;
  sizeLabel: string;
  limits: CatalogLimits;
  monthlyTokenBudget: string | null;
  contextWindow: number | null;
  enabled: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
  modality?: string;
  mediaNote?: string;
  requestStyle?: string | null;
  /** Feed-internal: when the model entered the live (Premium) tier.
   *  The router's CatalogModel has no such field (it is not stored for chat
   *  models), so it is stripped before serving; the 15-day rule is enforced
   *  here, by omitting young models from the monthly document. */
  premiumSince?: string;
  /** Feed-internal benchmark inputs — NEVER served (see ranking.ts). */
  benchmarks?: BenchmarkInputs;
}

export interface CatalogEmbedding {
  family: string;
  platform: string;
  modelId: string;
  displayName: string;
  dimensions: number;
  maxInputTokens: number | null;
  priority: number;
  enabled: boolean;
  quotaLabel: string;
  /** Feed-internal: the router's CatalogEmbedding has no such field, so the
   *  monthly document simply omits young entries. Stripped before serving. */
  premiumSince?: string;
}

export interface CatalogTranscriptionModel {
  platform: string;
  modelId: string;
  displayName: string;
  priority: number;
  enabled: boolean;
  subtitleFormats?: string[];
  maxBytes?: number | null;
  requestStyle?: string | null;
  quotaLabel?: string;
  premiumSince?: string;
}

export interface CatalogVideoModel {
  platform: string;
  modelId: string;
  displayName: string;
  priority: number;
  enabled: boolean;
  quotaLabel?: string;
  providerModelId?: string;
  premiumSince?: string;
}

export interface CatalogSearchEngine {
  platform: string;
  engineId: string;
  displayName: string;
  priority: number;
  enabled: boolean;
  quotaLabel?: string;
  creditsPerQuery?: number | null;
  features?: { news?: boolean; answer?: boolean; fullContent?: boolean };
  premiumSince?: string;
}

export interface CatalogDecisionModel {
  platform: string;
  modelId: string;
  displayName: string;
  priority: number;
  enabled: boolean;
  quotaLabel?: string;
  contextWindow?: number;
  premiumSince?: string;
}

export interface CatalogQuirk {
  slug: string;
  title: string;
  body: string;
  severity: 'blocker' | 'warning' | 'info';
  targets: { platform: string | null; modelGlob: string | null }[];
}

export interface Catalog {
  version: string;
  generatedAt: string;
  tier: CatalogTier;
  models: CatalogModel[];
  embeddings?: CatalogEmbedding[];
  transcriptionModels?: CatalogTranscriptionModel[];
  videoModels?: CatalogVideoModel[];
  searchEngines?: CatalogSearchEngine[];
  decisionModels?: CatalogDecisionModel[];
  managedPlatforms?: string[];
  quirks: CatalogQuirk[];
}

/** The feed's internal seed document: the served shape plus feed-internal
 *  fields (chat-model premiumSince, per-model benchmarks). */
export type SeedCatalog = Omit<Catalog, 'generatedAt' | 'tier'> & {
  generatedAt?: string;
};

/** Per-source benchmark inputs for one model. Scores are raw source scores
 *  (AA 0–100, LiveBench ~0–100, BenchLM ~0–100); normalization happens per
 *  snapshot in ranking.ts. `benchlmQuality` distinguishes BenchLM's
 *  "Supported" rows from "Estimated" rows for the confidence rule. */
export interface BenchmarkInputs {
  aa?: number | null;
  livebench?: number | null;
  benchlm?: number | null;
  benchlmQuality?: 'supported' | 'estimated';
  /** ISO date the source snapshot was taken; older than 30 days decays
   *  confidence one level (see ranking.ts). */
  sourceDate?: string;
}

export type LicensePlan = 'annual';

export type LicenseStatusValue = 'active' | 'expired' | 'canceled' | 'refunded';

export interface LicenseStatus {
  valid: boolean;
  plan: LicensePlan | null;
  status: LicenseStatusValue | null;
  expiresAt: string | null;
  cancelAtPeriodEnd?: boolean;
  reason?: string;
  checkedAtMs: number;
}

export interface LicenseActivation {
  valid: boolean;
  plan: LicensePlan | null;
  status: LicenseStatusValue | null;
  expiresAt: string | null;
  reason?: string;
}
