// model-probe — proactive per-model probes with explicit labels (#1438 PR 1).
//
// Key-level health says a credential works; it says nothing about whether a
// specific MODEL behind that key actually answers. Free-tier aggregators
// routinely list models that 403 on every real chat (upstream quota drained),
// and the router only learns that after burning a real user turn (#1267 is
// passive: it demotes a model after real traffic has already hit it).
//
// This job sends a minimal real chat request ("Reply with OK") to routable
// model+key pairs that have not been observed recently, and writes an explicit
// status row: 'working' | 'unavailable'. PR 1 is OBSERVATION ONLY — nothing in
// routing, scoring or fallback reads the table yet; a follow-up consumes the
// labels (tool-call variant, chat_only classification, dashboard badges).
//
// What it will never do:
//   - probe a model that just served real traffic successfully (serving is
//     stronger evidence than any probe, and probes cost free-tier quota);
//   - feed the health checker, cooldowns or the failure counters — a probe is
//     a question, never a verdict (same principle as probeKeyValidity);
//   - use the fallback/healing machinery: the probe measures the model as-is,
//     not the pipeline, so a probe never retries and never repairs;
//   - thundering-herd a provider after a restart: first-sighting staggering
//     plus a small per-pass budget keep probe traffic bounded.
//
// Cadence: one pass every 30 minutes, at most MODEL_PROBE_MAX_PER_PASS probes
// per pass (default 3). OFF by default: probes spend the user's free-tier
// quota and nothing consumes the labels yet, so the scheduled job only runs
// with MODEL_PROBE_ENABLED=1. POST /api/health/probe-models always runs a pass.
//
// Phase B live-signal routing (design note §4): the probe now also writes a
// graded health score (0..1) per model+provider — see computeHealthScore —
// which the router folds into the reliability axis as a small Beta prior
// (scoring.ts probeReliabilityPrior, weight 2 pseudo-observations). The score
// is the graded signal alongside the binary verdict; the verdict is unchanged.
// Candidate selection prioritizes the 16 churn-prone platforms' top free
// models (CHURN_PLATFORMS, health.ts) and caps candidates per provider per
// pass (LIVE_SIGNAL_PROBE_MAX_PER_PROVIDER, default 2).
//
// Tension to be explicit about: the global cap (MODEL_PROBE_MAX_PER_PASS,
// default 3) still applies as the ceiling, so with both defaults a pass
// probes at most 3 models across at most 2 providers. Raise both together to
// widen a pass — raising only the per-provider cap changes nothing while the
// global cap stays at 3.
//
// Kill switch: LIVE_SIGNAL_PROBE_DISABLED=1 turns off the Phase B additions
// only — the graded score is never read into routing and candidate selection
// reverts to the pre-Phase-B stalest-first order with no per-provider cap.
// The underlying observation-only job keeps its own opt-in
// (MODEL_PROBE_ENABLED=1) and keeps running.

import type { Scheduler } from '../lib/scheduler.js';
import type { Db } from '../db/types.js';
import { getDb } from '../db/index.js';
import { resolveProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { decryptProxyUrl } from '../lib/key-proxy.js';
import { withKeyProxy } from '../lib/proxy.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';
import { providerLog } from '../lib/server-logs.js';
import { inferQuotaPoolKey } from './provider-quota.js';
import { CHURN_PLATFORMS } from './health.js';
import { TTFB_BEST_MS, TTFB_WORST_MS } from './scoring.js';

// One pass every 30 minutes. Probes are quota-costing real requests; the point
// is freshness on the scale of "an operator glances at the dashboard", not
// second-level liveness (the cooldown/health machinery owns that).
export const MODEL_PROBE_INTERVAL_MS = 30 * 60 * 1000;

// Stale rows are re-probed after this long; fresher evidence is trusted and
// the model is skipped. Well above the pass cadence so a skipped model is not
// re-considered every pass.
export const MODEL_PROBE_STALE_MS = 6 * 60 * 60 * 1000;

// A model+key that served a real request within this window does not need a
// probe: real success is stronger evidence, and the probe would only spend
// free-tier quota to re-learn it. Mirrors the RECENT_CHECK_SKIP_MS idea from
// the health pass.
export const RECENT_SERVE_SKIP_MS = 60 * 60 * 1000;

const DEFAULT_MAX_PROBES_PER_PASS = 3;

// ── Phase B: kill switch + per-provider cap ────────────────────────────────
// LIVE_SIGNAL_PROBE_DISABLED=1 (same convention as COOLDOWN_PROBE_DISABLED=1)
// turns off the Phase B additions only: the graded score is never read into
// routing (router.ts checks this before looking the score up) and candidate
// selection below reverts to the pre-Phase-B order with no per-provider cap.
// The underlying observation-only job is unaffected — it keeps its own
// MODEL_PROBE_ENABLED=1 opt-in.
export function isLiveSignalProbeDisabled(): boolean {
  return process.env.LIVE_SIGNAL_PROBE_DISABLED === '1';
}

const DEFAULT_MAX_PROBES_PER_PROVIDER = 2;

/** Per-provider probe budget per pass. Tunable; 0 or a bad value falls back
 *  to the default (mirrors getMaxProbesPerPass). Raise this together with
 *  MODEL_PROBE_MAX_PER_PASS — with the defaults (3 global, 2 per provider) a
 *  pass probes at most 3 models across at most 2 providers. */
export function getMaxProbesPerProvider(): number {
  const raw = process.env.LIVE_SIGNAL_PROBE_MAX_PER_PROVIDER;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return DEFAULT_MAX_PROBES_PER_PROVIDER;
}

// Ceiling for one probe request, mirroring health's transport posture. A probe
// that takes longer than this is treated as an error (inconclusive), not as
// evidence the model is unavailable.
const PROBE_TIMEOUT_MS = 60 * 1000;

// max_tokens floor: some relays reject max_tokens <= 2 (#903). The probe never
// relies on tiny ceilings, so a generous floor avoids that whole failure class.
const PROBE_MAX_TOKENS = 64;

/** Per-pass probe budget. Tunable; 0 or a bad value falls back to the default
 *  (mirrors HEALTH_CHECK_CONCURRENCY / COOLDOWN_PROBE_MAX_PER_PASS). */
function getMaxProbesPerPass(): number {
  const raw = process.env.MODEL_PROBE_MAX_PER_PASS;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return DEFAULT_MAX_PROBES_PER_PASS;
}

export type ModelProbeStatus = 'working' | 'unavailable';

export interface ProbeCandidate {
  keyId: number;
  platform: string;
  modelId: string;
  modelDbId: number;
  endpointScope: string;
}

export interface ProbeOutcome {
  status: ModelProbeStatus | 'error';
  latencyMs?: number;
  error?: string;
}

export interface ProbePassResult {
  probed: ProbeCandidate[];
  outcomes: Array<ProbeCandidate & { outcome: ProbeOutcome }>;
}

// ── Candidate selection ──────────────────────────────────────────────────────
// Routable pairs only: enabled model on an enabled, currently-healthy-or-
// unknown key, with endpoint scope carried through (custom-endpoint identity,
// migration 20260729_000001). Ordered to rotate fairly: stalest evidence
// first, models never probed (NULL last_probed_at) before stale ones.
//
// Phase B: when the live-signal kill switch is off, churn-prone platforms
// come first and, within a platform, the top free models by intelligence
// rank (best rank first — rank is only calibrated WITHIN a provider's own
// catalog, so the cross-platform rank order is a heuristic tiebreak, not a
// cross-provider quality claim; the per-provider cap below is what stops one
// platform's top models from eating the whole pass). A platform with no
// ranked rows (intelligence_rank NULL or <= 0) falls back to seeded catalog
// order (m.id ASC) for its models. Candidates are also capped per provider
// (LIVE_SIGNAL_PROBE_MAX_PER_PROVIDER, default 2). When the kill switch is
// set, selection is exactly the pre-Phase-B order with no cap.
export interface SelectProbeCandidatesOptions {
  maxPerProvider?: number;
}

interface ProbeCandidateRow extends ProbeCandidate {
  lastProbedAt: string | null;
}

export function selectProbeCandidates(
  db: Db,
  limit: number,
  now = Date.now(),
  opts: SelectProbeCandidatesOptions = {},
): ProbeCandidateRow[] {
  const phaseB = !isLiveSignalProbeDisabled();
  const maxPerProvider = opts.maxPerProvider ?? getMaxProbesPerProvider();
  const churnPlaceholders = CHURN_PLATFORMS.map(() => '?').join(', ');
  const orderBy = phaseB
    ? `CASE WHEN m.platform IN (${churnPlaceholders}) THEN 0 ELSE 1 END ASC,
       CASE WHEN m.intelligence_rank IS NULL OR m.intelligence_rank <= 0 THEN 1 ELSE 0 END ASC,
       m.intelligence_rank ASC,
       (p.last_probed_at IS NULL) DESC, p.last_probed_at ASC, m.id ASC, k.id ASC`
    : `(p.last_probed_at IS NULL) DESC, p.last_probed_at ASC, m.id ASC, k.id ASC`;
  const rows = db.prepare(`
    SELECT m.id AS modelDbId, m.platform, m.model_id AS modelId, m.endpoint_scope AS endpointScope,
           k.id AS keyId, COALESCE(p.last_probed_at, '') AS lastProbedAt
      FROM models m
      JOIN api_keys k ON k.platform = m.platform AND k.enabled = 1 AND k.status IN ('healthy', 'unknown')
     LEFT JOIN model_probe_status p
            ON p.platform = m.platform AND p.model_id = m.model_id
           AND p.endpoint_scope = m.endpoint_scope AND p.key_id = k.id
     WHERE m.enabled = 1
     ORDER BY ${orderBy}
     LIMIT ?
  `).all(...(phaseB ? [...CHURN_PLATFORMS] : []), limit * 8) as Array<{
    modelDbId: number; platform: string; modelId: string; endpointScope: string;
    keyId: number; lastProbedAt: string;
  }>;

  const out: ProbeCandidateRow[] = [];
  const perProvider = new Map<string, number>();
  for (const row of rows) {
    if (out.length >= limit) break;
    if (phaseB) {
      const count = perProvider.get(row.platform) ?? 0;
      if (count >= maxPerProvider) continue;
    }
    if (row.lastProbedAt) {
      const seen = Date.parse(row.lastProbedAt.includes('T') ? row.lastProbedAt : row.lastProbedAt.replace(' ', 'T') + 'Z');
      if (Number.isFinite(seen) && now - seen < MODEL_PROBE_STALE_MS) continue;
    }
    if (phaseB) perProvider.set(row.platform, (perProvider.get(row.platform) ?? 0) + 1);
    out.push(row);
  }
  return out;
}

// ── The probe itself ─────────────────────────────────────────────────────────

export interface ModelProbeRequestDeps {
  // Test seam: the chat call the probe makes. Production uses the provider's
  // own chatCompletion through the key's proxy.
  chat?: (candidate: ProbeCandidate) => Promise<unknown>;
}

async function probeChat(candidate: ProbeCandidate): Promise<void> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ? AND enabled = 1').get(candidate.keyId) as any;
  if (!row) throw new Error('key not found or disabled');
  const provider = resolveProvider(candidate.platform as any, row.base_url);
  if (!provider) throw new Error(`no provider adapter for ${candidate.platform}`);

  const apiKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
  // Same reasoning as checkKeyHealth (#590): probe through the key's own proxy,
  // or a key only reachable via its proxy would fail the probe while real
  // traffic through the proxy works fine.
  await withKeyProxy(decryptProxyUrl(row), () => provider.chatCompletion(apiKey, [
    { role: 'user', content: 'Reply with OK' },
  ], candidate.modelId, {
    max_tokens: PROBE_MAX_TOKENS,
    timeoutMs: PROBE_TIMEOUT_MS,
  } as any, {
    platform: candidate.platform as any,
    keyId: candidate.keyId,
    quotaPoolKey: inferQuotaPoolKey(candidate.platform as any, null),
    endpoint: 'chat',
    origin: 'probe',
  } as any));
}

/**
 * Run the probe against one candidate: does this model answer at all?
 * A transport error is 'error' (inconclusive — the network, not the model,
 * failed); any provider rejection (quota, 403/404 on the model) is
 * 'unavailable'. A success is 'working'.
 *
 * Capability classification (tool_capable / chat_only) is a follow-up PR; this
 * pass establishes liveness only.
 *
 * Testable: `chat` replaces the wire call.
 */
export async function probeModel(candidate: ProbeCandidate, deps: ModelProbeRequestDeps = {}): Promise<ProbeOutcome> {
  const started = Date.now();
  const chat = deps.chat ?? probeChat;
  try {
    await chat(candidate);
    return { status: 'working', latencyMs: Date.now() - started };
  } catch (err: any) {
    const message = sanitizeProviderErrorMessage(err?.message ?? err);
    const transport = /(?:fetch failed|network|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|certificate|TLS|timeout)/i.test(message);
    if (transport || err?.name === 'AbortError') return { status: 'error', error: message };
    return { status: 'unavailable', error: message };
  }
}

// ── Recording ────────────────────────────────────────────────────────────────
// Phase B graded health score (0..1) per model+provider, stored alongside the
// binary verdict. Exponential decay with weight HEALTH_SCORE_NEW_OBSERVATION_WEIGHT
// (0.5) on the new observation, so one probe moves the score halfway toward
// its target and a few consistent probes converge — a single flaky probe
// neither crowns nor condemns a model.
//
// Targets: success → toward 1, failure/unavailable → toward 0. A working
// model is graded by its probe latency too: the probe's wall-clock latency is
// an upper-bound proxy for TTFT (TTFT ≤ wall time — the probe makes one tiny
// completion, so the two are close), mapped through the same TTFB ramp the
// speed axis uses, so a fast success targets 1.0 and a success past
// TTFB_WORST_MS targets 0.5 — still working, but graded below a fast one. A
// success with no latency reading targets 1.0 (no evidence of slowness).
// An 'error' (inconclusive) outcome must NOT change the score, exactly as it
// doesn't change the status: it returns the previous score untouched.
export const HEALTH_SCORE_NEW_OBSERVATION_WEIGHT = 0.5;

function latencyFactor(latencyMs?: number): number {
  if (latencyMs == null || !Number.isFinite(latencyMs)) return 1;
  if (latencyMs <= TTFB_BEST_MS) return 1;
  if (latencyMs >= TTFB_WORST_MS) return 0;
  return 1 - (latencyMs - TTFB_BEST_MS) / (TTFB_WORST_MS - TTFB_BEST_MS);
}

export function computeHealthScore(
  previous: number | null | undefined,
  outcome: ProbeOutcome,
): number | null {
  if (outcome.status === 'error') return previous ?? null;
  const target = outcome.status === 'working'
    ? 0.5 + 0.5 * latencyFactor(outcome.latencyMs)
    : 0;
  if (previous == null || !Number.isFinite(previous)) return target;
  return (1 - HEALTH_SCORE_NEW_OBSERVATION_WEIGHT) * previous
    + HEALTH_SCORE_NEW_OBSERVATION_WEIGHT * target;
}

export function recordProbeResult(db: Db, candidate: ProbeCandidate, outcome: ProbeOutcome, probedAt = new Date()): void {
  if (outcome.status === 'error') {
    // Inconclusive: do not overwrite the last real verdict, but keep the
    // diagnostic and refresh the timestamp so pacing/backoff can see it.
    // The graded score, sample count and score timestamp are untouched too.
    db.prepare(`
      UPDATE model_probe_status SET last_error = ?, last_probed_at = datetime('now')
       WHERE platform = ? AND model_id = ? AND endpoint_scope = ? AND key_id = ?
    `).run(outcome.error ?? 'probe error', candidate.platform, candidate.modelId, candidate.endpointScope, candidate.keyId);
    return;
  }
  const prev = db.prepare(`
    SELECT health_score AS healthScore, health_samples AS healthSamples FROM model_probe_status
     WHERE platform = ? AND model_id = ? AND endpoint_scope = ? AND key_id = ?
  `).get(candidate.platform, candidate.modelId, candidate.endpointScope, candidate.keyId) as
    { healthScore: number | null; healthSamples: number | null } | undefined;
  const healthScore = computeHealthScore(prev?.healthScore ?? null, outcome);
  const healthSamples = (prev?.healthSamples ?? 0) + 1;
  db.prepare(`
    INSERT INTO model_probe_status (platform, model_id, endpoint_scope, key_id, status, last_probed_at, last_error, latency_ms, health_score, health_samples, health_updated_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
    ON CONFLICT(platform, model_id, endpoint_scope, key_id) DO UPDATE SET
      status = excluded.status,
      last_probed_at = excluded.last_probed_at,
      last_error = NULL,
      latency_ms = excluded.latency_ms,
      health_score = excluded.health_score,
      health_samples = excluded.health_samples,
      health_updated_at = excluded.health_updated_at
  `).run(
    candidate.platform, candidate.modelId, candidate.endpointScope, candidate.keyId,
    outcome.status, probedAt.toISOString(), outcome.latencyMs ?? null,
    healthScore, healthSamples, probedAt.toISOString(),
  );
}

// ── The pass ─────────────────────────────────────────────────────────────────

// Failed-probe backoff per candidate: 30m, 1h, 2h, capped at 6h. A model that
// stays unavailable converges to one probe per staleness window — re-probing
// it harder only burns the free quota the probe is meant to conserve.
const PROBE_BACKOFF_BASE_MS = 30 * 60 * 1000;
const PROBE_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

// Stagger window for a candidate's FIRST probe after boot, so a restart with a
// large catalog does not fire every probe at once (mirrors cooldown-probe).
const FIRST_PROBE_STAGGER_MS = 60 * 1000;

interface CandidateProbeState {
  failures: number;
  nextProbeAtMs: number;
}

// keyId -> pacing, in-memory only (same as cooldown-probe: restart forgetting
// backoff is fine because first-sighting staggering re-spaces probes anyway).
const probeState = new Map<string, CandidateProbeState>();

function stateKey(candidate: ProbeCandidate): string {
  return `${candidate.platform}:${candidate.modelId}:${candidate.endpointScope}:${candidate.keyId}`;
}

export interface ProbePassOptions extends ModelProbeRequestDeps {
  now?: number;
  jitter?: () => number; // [0, 1), defaults to Math.random
  maxProbes?: number;
  select?: (limit: number, now: number) => ProbeCandidate[];
}

/** One probe pass: probe up to maxProbes stale candidates, record the outcomes.
 *  Exported for tests; production runs it on the scheduler via startModelProbe. */
export async function runModelProbePass(opts: ProbePassOptions = {}): Promise<ProbePassResult> {
  const now = opts.now ?? Date.now();
  const jitter = opts.jitter ?? Math.random;
  const maxProbes = opts.maxProbes ?? getMaxProbesPerPass();
  const select = opts.select ?? ((limit: number, at: number) => selectProbeCandidates(getDb(), limit, at));

  const candidates = select(maxProbes, now);
  const probed: ProbeCandidate[] = [];
  const outcomes: ProbePassResult['outcomes'] = [];

  for (const candidate of candidates) {
    if (probed.length >= maxProbes) break;
    const key = stateKey(candidate);
    const state = probeState.get(key);
    if (!state) {
      // First sighting after boot: schedule, don't probe (restart stagger).
      probeState.set(key, { failures: 0, nextProbeAtMs: now + Math.floor(jitter() * FIRST_PROBE_STAGGER_MS) });
      continue;
    }
    if (now < state.nextProbeAtMs) continue;

    probed.push(candidate);
    const outcome = await probeModel(candidate, opts);
    outcomes.push({ ...candidate, outcome });

    if (outcome.status === 'unavailable') {
      state.failures++;
      const backoff = Math.min(PROBE_BACKOFF_BASE_MS * 2 ** (state.failures - 1), PROBE_BACKOFF_MAX_MS);
      state.nextProbeAtMs = now + backoff;
      providerLog(
        'warn',
        `[ModelProbe] ${candidate.platform}/${candidate.modelId} (key ${candidate.keyId}) unavailable: ${outcome.error ?? 'unknown error'}`,
        { provider: candidate.platform, event: 'model_probe_unavailable' },
      );
    } else {
      // A model that answered is healthy, so its pacing resets: re-probing a
      // working model harder would only burn the free quota the probe exists
      // to conserve.
      probeState.delete(key);
      providerLog(
        'info',
        `[ModelProbe] ${candidate.platform}/${candidate.modelId} (key ${candidate.keyId}) → ${outcome.status}` +
        (outcome.latencyMs != null ? ` in ${outcome.latencyMs}ms` : ''),
        { provider: candidate.platform, event: 'model_probe_ok' },
      );
    }
    recordProbeResult(getDb(), candidate, outcome);
  }

  return { probed, outcomes };
}

// Overlap guard, same shape as checkAllKeys / runCooldownProbePass.
let passInFlight: Promise<ProbePassResult> | null = null;

function runGuardedPass(): Promise<ProbePassResult> {
  if (passInFlight) return passInFlight;
  passInFlight = runModelProbePass().finally(() => {
    passInFlight = null;
  });
  return passInFlight;
}

let cancelProbeJob: (() => void) | null = null;

export function startModelProbe(scheduler: Scheduler): void {
  if (cancelProbeJob) return;
  if (isLiveSignalProbeDisabled()) {
    // Phase B kill switch: the job itself still starts below when opted in —
    // only the graded score's routing use and the churn-prioritized selection
    // are off — but log it at startup so an operator can see why probe scores
    // are not moving routing (mirrors startCooldownProbe's disabled log).
    console.log('[ModelProbe] live-signal probing disabled via LIVE_SIGNAL_PROBE_DISABLED=1 (graded scores and churn prioritization off; observation-only probing continues)');
  }
  if (process.env.MODEL_PROBE_ENABLED !== '1') return;
  console.log(`[ModelProbe] starting proactive model probes (every ${MODEL_PROBE_INTERVAL_MS / 60_000}m, max ${getMaxProbesPerPass()}/pass)`);
  cancelProbeJob = scheduler.every(
    MODEL_PROBE_INTERVAL_MS,
    async () => {
      await runGuardedPass().catch(err => console.error('[ModelProbe] pass failed:', err));
    },
    { name: 'model-probe' },
  );
}

export function stopModelProbe(): void {
  if (cancelProbeJob) {
    cancelProbeJob();
    cancelProbeJob = null;
  }
}

/** Test seam: drop all probe pacing state. */
export function resetModelProbeState(): void {
  probeState.clear();
}
