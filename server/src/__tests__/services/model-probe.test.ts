// model-probe tests (#1438 PR 1): candidate selection (stalest-first, fresh
// real-traffic skip), label recording, per-pass budget, restart stagger +
// first-sighting scheduling, failed-probe backoff, transport-error
// inconclusiveness (verdict preserved), and the kill switch.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  selectProbeCandidates,
  probeModel,
  recordProbeResult,
  computeHealthScore,
  getMaxProbesPerProvider,
  isLiveSignalProbeDisabled,
  runModelProbePass,
  resetModelProbeState,
  startModelProbe,
  stopModelProbe,
  MODEL_PROBE_STALE_MS,
} from '../../services/model-probe.js';
import type { ProbeCandidate } from '../../services/model-probe.js';

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  resetModelProbeState();
  const db = getDb();
  db.prepare('DELETE FROM model_probe_status').run();
  db.prepare('DELETE FROM fallback_config').run();
  db.prepare('DELETE FROM profile_models').run();
  db.prepare('DELETE FROM api_keys').run();
  db.prepare('DELETE FROM models').run();
  // Fresh healthy key the models can hang off.
  db.prepare(`INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, status, enabled)
              VALUES (1, 'probe-test', '', '', '', '', 'healthy', 1)`).run();
});

function addModel(id: number, modelId: string, opts: { enabled?: number } = {}): void {
  getDb().prepare(`INSERT INTO models (id, platform, model_id, display_name, intelligence_rank, speed_rank, endpoint_scope, enabled)
                   VALUES (?, 'probe-test', ?, ?, 0, 0, '', ?)`).run(id, modelId, modelId, opts.enabled ?? 1);
}

const candidate = (over: Partial<ProbeCandidate> = {}): ProbeCandidate => ({
  keyId: 1,
  platform: 'probe-test',
  modelId: 'm1',
  modelDbId: 1,
  endpointScope: '',
  ...over,
});

// Seed one pass' worth of candidates so stagger/backoff choreography is
// deterministic: first sighting schedules (no probe), next pass probes.
function seedCandidates(n: number): ProbeCandidate[] {
  const out: ProbeCandidate[] = [];
  for (let i = 1; i <= n; i++) {
    addModel(i, `m${i}`);
    out.push(candidate({ modelId: `m${i}`, modelDbId: i }));
  }
  return out;
}

const selectFrom = (list: ProbeCandidate[]) => (limit: number) => list.slice(0, limit);
const chatOk = () => vi.fn(async () => ({}));
const chatFail = (message: string) => vi.fn(async () => { throw new Error(message); });
const noJitter = () => 0;

describe('candidate selection', () => {
  it('probes the stalest evidence first, never-probed before stale', () => {
    const db = getDb();
    addModel(1, 'old');
    addModel(2, 'fresh');
    addModel(3, 'never');
    recordProbeResult(db, candidate({ modelId: 'old', modelDbId: 1 }),
      { status: 'working', latencyMs: 5 }, new Date(Date.now() - MODEL_PROBE_STALE_MS - 1000));
    recordProbeResult(db, candidate({ modelId: 'fresh', modelDbId: 2 }),
      { status: 'working', latencyMs: 5 }, new Date());

    const picked = selectProbeCandidates(db, 10);
    expect(picked.map(p => p.modelId)).toEqual(['never', 'old']);
  });

  it('skips models with fresh evidence (staleness window)', () => {
    const db = getDb();
    addModel(1, 'fresh');
    recordProbeResult(db, candidate({ modelId: 'fresh', modelDbId: 1 }),
      { status: 'working', latencyMs: 5 }, new Date());
    expect(selectProbeCandidates(db, 10)).toEqual([]);
  });

  it('ignores disabled models and disabled/invalid keys', () => {
    const db = getDb();
    addModel(1, 'off-model', { enabled: 0 });
    addModel(2, 'bad-key-model');
    db.prepare("UPDATE api_keys SET status = 'invalid' WHERE id = 1").run();
    expect(selectProbeCandidates(db, 10)).toEqual([]);
  });
});

describe('probe outcome classification', () => {
  it('a successful chat is working with latency', async () => {
    const outcome = await probeModel(candidate(), { chat: chatOk() });
    expect(outcome.status).toBe('working');
    expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('a provider rejection is unavailable and carries the sanitized error', async () => {
    const outcome = await probeModel(candidate(), { chat: chatFail('403: quota exhausted upstream') });
    expect(outcome.status).toBe('unavailable');
    expect(outcome.error).toContain('403');
  });

  it('a transport error is inconclusive (error), never unavailable', async () => {
    const outcome = await probeModel(candidate(), { chat: chatFail('fetch failed: getaddrinfo ENOTFOUND api.example.com') });
    expect(outcome.status).toBe('error');
  });
});

describe('recording', () => {
  it('writes working with latency and clears prior errors', () => {
    const db = getDb();
    recordProbeResult(db, candidate(), { status: 'unavailable', error: '403' });
    recordProbeResult(db, candidate(), { status: 'working', latencyMs: 42 });
    const row = db.prepare('SELECT * FROM model_probe_status').get() as any;
    expect(row.status).toBe('working');
    expect(row.latency_ms).toBe(42);
    expect(row.last_error).toBeNull();
  });

  it('an inconclusive probe preserves the previous verdict', () => {
    const db = getDb();
    recordProbeResult(db, candidate(), { status: 'working', latencyMs: 10 });
    recordProbeResult(db, candidate(), { status: 'error', error: 'fetch failed' });
    const row = db.prepare('SELECT * FROM model_probe_status').get() as any;
    expect(row.status).toBe('working');
    expect(row.last_error).toBe('fetch failed');
  });
});

describe('probe pass', () => {
  it('first sighting schedules instead of probing; the next pass probes within budget', async () => {
    const list = seedCandidates(5);
    const chat = chatOk();
    const pass1 = await runModelProbePass({ chat, jitter: noJitter, maxProbes: 3, select: selectFrom(list) });
    expect(pass1.probed).toEqual([]);
    expect(chat).not.toHaveBeenCalled();

    const pass2 = await runModelProbePass({ chat, jitter: noJitter, maxProbes: 3, select: selectFrom(list) });
    expect(pass2.probed).toHaveLength(3);
    expect(chat).toHaveBeenCalledTimes(3);
  });

  it('a working probe clears pacing so the model is not re-probed until stale', async () => {
    const list = seedCandidates(1);
    const chat = chatOk;
    await runModelProbePass({ chat, jitter: noJitter, select: selectFrom(list) });
    await runModelProbePass({ chat, jitter: noJitter, select: selectFrom(list) });
    // Third pass: the single candidate just worked; nothing is probeable.
    const pass3 = await runModelProbePass({ chat, jitter: noJitter, select: selectFrom(list) });
    expect(pass3.probed).toEqual([]);
  });

  it('an unavailable probe backs off instead of re-probing every pass', async () => {
    const list = seedCandidates(1);
    const chat = chatFail('403 quota');
    // Pass 1: first sighting only schedules.
    await runModelProbePass({ chat, jitter: noJitter, select: selectFrom(list) });
    // Pass 2: the actual probe — fails, sets a 30m backoff.
    const pass2 = await runModelProbePass({ chat, jitter: noJitter, select: selectFrom(list) });
    expect(pass2.probed).toHaveLength(1);
    // Pass 3 immediately after: still inside the backoff, nothing probed.
    const pass3 = await runModelProbePass({ chat, jitter: noJitter, select: selectFrom(list) });
    expect(pass3.probed).toEqual([]);
    // Past the first backoff step (30m) it probes again.
    const later = Date.now() + 31 * 60_000;
    const pass4 = await runModelProbePass({ chat, jitter: noJitter, select: selectFrom(list), now: later });
    expect(pass4.probed).toHaveLength(1);
  });

  it('records outcomes in the table', async () => {
    const list = seedCandidates(2);
    await runModelProbePass({ chat: chatOk(), jitter: noJitter, select: selectFrom(list) });
    await runModelProbePass({ chat: chatOk(), jitter: noJitter, select: selectFrom(list) });
    const rows = getDb().prepare('SELECT model_id, status FROM model_probe_status ORDER BY model_id').all() as any[];
    expect(rows).toEqual([
      { model_id: 'm1', status: 'working' },
      { model_id: 'm2', status: 'working' },
    ]);
  });
});

describe('kill switch and lifecycle', () => {
  it('is off by default: the scheduler does not start without MODEL_PROBE_ENABLED=1', () => {
    delete process.env.MODEL_PROBE_ENABLED;
    const scheduler = { every: vi.fn(() => () => undefined) };
    startModelProbe(scheduler as any);
    expect(scheduler.every).not.toHaveBeenCalled();
    stopModelProbe();
  });

  it('MODEL_PROBE_ENABLED=1 schedules the job on the 30m cadence', () => {
    process.env.MODEL_PROBE_ENABLED = '1';
    const scheduler = { every: vi.fn(() => () => undefined) };
    startModelProbe(scheduler as any);
    expect(scheduler.every).toHaveBeenCalledTimes(1);
    expect(scheduler.every.mock.calls[0][0]).toBe(30 * 60 * 1000);
    delete process.env.MODEL_PROBE_ENABLED;
    stopModelProbe();
  });
});

describe('Phase B graded health score', () => {
  it('first observation sets the score: fast success 1, slow success 0.5, unavailable 0', () => {
    expect(computeHealthScore(null, { status: 'working', latencyMs: 100 })).toBe(1);
    expect(computeHealthScore(null, { status: 'working' })).toBe(1);
    expect(computeHealthScore(null, { status: 'working', latencyMs: 6000 })).toBe(0.5);
    expect(computeHealthScore(null, { status: 'working', latencyMs: 2650 })).toBeCloseTo(0.75, 5);
    expect(computeHealthScore(null, { status: 'unavailable', error: '403' })).toBe(0);
  });

  it('blends with weight 0.5 toward the new target', () => {
    expect(computeHealthScore(1, { status: 'unavailable', error: '403' })).toBe(0.5);
    expect(computeHealthScore(0, { status: 'working', latencyMs: 100 })).toBe(0.5);
    expect(computeHealthScore(0.5, { status: 'working', latencyMs: 100 })).toBe(0.75);
  });

  it('an inconclusive outcome never changes the score', () => {
    expect(computeHealthScore(0.8, { status: 'error', error: 'fetch failed' })).toBe(0.8);
    expect(computeHealthScore(null, { status: 'error', error: 'fetch failed' })).toBeNull();
  });

  it('recordProbeResult stores the score, sample count and timestamp', () => {
    const db = getDb();
    recordProbeResult(db, candidate(), { status: 'working', latencyMs: 100 });
    let row = db.prepare('SELECT * FROM model_probe_status').get() as any;
    expect(row.health_score).toBe(1);
    expect(row.health_samples).toBe(1);
    expect(row.health_updated_at).toBeTruthy();

    recordProbeResult(db, candidate(), { status: 'unavailable', error: '403' });
    row = db.prepare('SELECT * FROM model_probe_status').get() as any;
    expect(row.status).toBe('unavailable');
    expect(row.health_score).toBe(0.5);
    expect(row.health_samples).toBe(2);
  });

  it('an inconclusive probe preserves the score and sample count', () => {
    const db = getDb();
    recordProbeResult(db, candidate(), { status: 'working', latencyMs: 100 });
    recordProbeResult(db, candidate(), { status: 'error', error: 'fetch failed' });
    const row = db.prepare('SELECT * FROM model_probe_status').get() as any;
    expect(row.status).toBe('working');
    expect(row.health_score).toBe(1);
    expect(row.health_samples).toBe(1);
  });
});

describe('Phase B churn scoping and per-provider cap', () => {
  function addKey(platform: string): void {
    getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
                     VALUES (?, 'k', '', '', '', 'healthy', 1)`).run(platform);
  }

  function addChurnModel(id: number, platform: string, modelId: string, rank: number): void {
    getDb().prepare(`INSERT INTO models (id, platform, model_id, display_name, intelligence_rank, speed_rank, endpoint_scope, enabled)
                     VALUES (?, ?, ?, ?, ?, 0, '', 1)`).run(id, platform, modelId, modelId, rank);
  }

  beforeEach(() => {
    delete process.env.LIVE_SIGNAL_PROBE_DISABLED;
    delete process.env.LIVE_SIGNAL_PROBE_MAX_PER_PROVIDER;
  });

  afterEach(() => {
    delete process.env.LIVE_SIGNAL_PROBE_DISABLED;
    delete process.env.LIVE_SIGNAL_PROBE_MAX_PER_PROVIDER;
  });

  it('churn platforms come first, best intelligence rank first within a platform', () => {
    const db = getDb();
    addKey('openrouter');
    addChurnModel(1, 'openrouter', 'or-rank5', 5);
    addChurnModel(2, 'openrouter', 'or-rank1', 1);
    addChurnModel(3, 'probe-test', 'plain', 1);
    const picked = selectProbeCandidates(db, 10);
    expect(picked.map(p => p.modelId)).toEqual(['or-rank1', 'or-rank5', 'plain']);
  });

  it('a platform with no ranked rows falls back to catalog (id) order', () => {
    const db = getDb();
    addKey('openrouter');
    addChurnModel(2, 'openrouter', 'or-second', 0);
    addChurnModel(1, 'openrouter', 'or-first', 0);
    const picked = selectProbeCandidates(db, 10);
    expect(picked.map(p => p.modelId)).toEqual(['or-first', 'or-second']);
  });

  it('caps candidates per provider per pass (default 2)', () => {
    expect(getMaxProbesPerProvider()).toBe(2);
    const db = getDb();
    addKey('openrouter');
    addKey('nous');
    for (let i = 1; i <= 4; i++) addChurnModel(i, 'openrouter', `or-${i}`, i);
    for (let i = 5; i <= 6; i++) addChurnModel(i, 'nous', `nous-${i}`, i);
    const picked = selectProbeCandidates(db, 10);
    const byPlatform = new Map<string, number>();
    for (const p of picked) byPlatform.set(p.platform, (byPlatform.get(p.platform) ?? 0) + 1);
    expect(byPlatform.get('openrouter')).toBe(2);
    expect(byPlatform.get('nous')).toBe(2);
    expect(picked).toHaveLength(4);
  });

  it('LIVE_SIGNAL_PROBE_MAX_PER_PROVIDER tunes the cap; invalid values fall back to 2', () => {
    process.env.LIVE_SIGNAL_PROBE_MAX_PER_PROVIDER = '1';
    expect(getMaxProbesPerProvider()).toBe(1);
    process.env.LIVE_SIGNAL_PROBE_MAX_PER_PROVIDER = '0';
    expect(getMaxProbesPerProvider()).toBe(2);
    process.env.LIVE_SIGNAL_PROBE_MAX_PER_PROVIDER = 'bogus';
    expect(getMaxProbesPerProvider()).toBe(2);
    const db = getDb();
    addKey('openrouter');
    for (let i = 1; i <= 3; i++) {
      getDb().prepare(`INSERT INTO models (id, platform, model_id, display_name, intelligence_rank, speed_rank, endpoint_scope, enabled)
                       VALUES (?, 'openrouter', ?, ?, ?, 0, '', 1)`).run(i, `or-${i}`, `or-${i}`, i);
    }
    process.env.LIVE_SIGNAL_PROBE_MAX_PER_PROVIDER = '3';
    expect(selectProbeCandidates(db, 10)).toHaveLength(3);
  });

  it('kill switch reverts selection to stalest-first with no per-provider cap', () => {
    const db = getDb();
    addKey('openrouter');
    addChurnModel(1, 'openrouter', 'churn-old', 1);
    addChurnModel(2, 'probe-test', 'plain-never', 99);
    addChurnModel(3, 'openrouter', 'churn-never', 5);
    const orKeyId = (db.prepare("SELECT id FROM api_keys WHERE platform = 'openrouter'").get() as { id: number }).id;
    recordProbeResult(db,
      { keyId: orKeyId, platform: 'openrouter', modelId: 'churn-old', modelDbId: 1, endpointScope: '' },
      { status: 'working', latencyMs: 5 }, new Date(Date.now() - MODEL_PROBE_STALE_MS - 1000));

    // Phase B on: churn first by rank (stale top model still eligible).
    expect(selectProbeCandidates(db, 10).map(p => p.modelId))
      .toEqual(['churn-old', 'churn-never', 'plain-never']);

    // Kill switch on: pre-Phase-B order — never-probed first by id, no cap.
    process.env.LIVE_SIGNAL_PROBE_DISABLED = '1';
    expect(isLiveSignalProbeDisabled()).toBe(true);
    expect(selectProbeCandidates(db, 10).map(p => p.modelId))
      .toEqual(['plain-never', 'churn-never', 'churn-old']);
  });
});

describe('Phase B kill switch and lifecycle', () => {
  afterEach(() => {
    delete process.env.LIVE_SIGNAL_PROBE_DISABLED;
    delete process.env.MODEL_PROBE_ENABLED;
    stopModelProbe();
  });

  it('logs the kill switch at startup but still starts the job when opted in', () => {
    process.env.LIVE_SIGNAL_PROBE_DISABLED = '1';
    process.env.MODEL_PROBE_ENABLED = '1';
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const scheduler = { every: vi.fn(() => () => undefined) };
    try {
      startModelProbe(scheduler as any);
      expect(scheduler.every).toHaveBeenCalledTimes(1);
      expect(log.mock.calls.some(c => String(c[0]).includes('LIVE_SIGNAL_PROBE_DISABLED=1'))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it('logs the kill switch at startup and does not start the job without the opt-in', () => {
    process.env.LIVE_SIGNAL_PROBE_DISABLED = '1';
    delete process.env.MODEL_PROBE_ENABLED;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const scheduler = { every: vi.fn(() => () => undefined) };
    try {
      startModelProbe(scheduler as any);
      expect(scheduler.every).not.toHaveBeenCalled();
      expect(log.mock.calls.some(c => String(c[0]).includes('LIVE_SIGNAL_PROBE_DISABLED=1'))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it('no kill-switch log when the switch is off', () => {
    delete process.env.LIVE_SIGNAL_PROBE_DISABLED;
    process.env.MODEL_PROBE_ENABLED = '1';
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const scheduler = { every: vi.fn(() => () => undefined) };
    try {
      startModelProbe(scheduler as any);
      expect(log.mock.calls.some(c => String(c[0]).includes('LIVE_SIGNAL_PROBE_DISABLED'))).toBe(false);
    } finally {
      log.mockRestore();
    }
  });
});
