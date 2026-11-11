// Router probe prior (Phase B): graded probe scores feed the reliability
// axis as a small Beta prior via getRoutingScores (deterministic expected
// reliability), and routing is identical to base when no score exists or the
// kill switch is set.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { refreshStatsCache, getRoutingScores, setRoutingStrategy } from '../../services/router.js';
import { getDb, initDb } from '../../db/index.js';
import { addToActiveChain } from '../helpers/chain.js';

beforeEach(() => {
  process.env.DEV_MODE = 'true';
  process.env.NODE_ENV = 'test';
  initDb(':memory:');
  getDb().exec('DELETE FROM fallback_config; DELETE FROM api_keys; DELETE FROM models; DELETE FROM requests; DELETE FROM model_probe_status;');
  delete process.env.LIVE_SIGNAL_PROBE_DISABLED;
  setRoutingStrategy('balanced');
});

afterEach(() => {
  delete process.env.LIVE_SIGNAL_PROBE_DISABLED;
  delete process.env.DEV_MODE;
});

function addModel(platform: string, modelId: string, priority: number): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, enabled, supports_vision, supports_tools)
    VALUES (?, ?, ?, 3, 1, 'Large', '~50M', 1, 0, 1)
  `).run(platform, modelId, modelId);
  const id = (db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
    .get(platform, modelId) as { id: number }).id;
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(id, priority);
  addToActiveChain(id, priority);
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'k', 'enc', 'iv', 'tag', 'healthy', 1)
  `).run(platform);
}

function addHistory(platform: string, modelId: string, successes: number, failures: number): void {
  const db = getDb();
  const ins = db.prepare(`
    INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, ttfb_ms)
    VALUES (?, ?, 1, ?, 0, ?, ?, ?, NULL)
  `);
  for (let i = 0; i < successes; i++) ins.run(platform, modelId, 'success', 100, 1000, null);
  for (let i = 0; i < failures; i++) ins.run(platform, modelId, 'error', 0, 1000, 'boom');
}

function seedProbeScore(platform: string, modelId: string, score: number | null): void {
  getDb().prepare(`
    INSERT INTO model_probe_status (platform, model_id, endpoint_scope, key_id, status, health_score, health_samples, health_updated_at)
    VALUES (?, ?, '', 1, 'working', ?, 1, datetime('now'))
  `).run(platform, modelId, score);
  // A forced refresh is what makes a just-landed probe score visible: it
  // invalidates the 60s probe-score cache alongside the stats cache.
  refreshStatsCache(getDb(), true);
}

function reliabilityOf(modelId: string): number {
  const { scores } = getRoutingScores();
  return scores.find(s => s.modelId === modelId)!.reliability;
}

describe('router probe prior', () => {
  it('no probe score means no change: unseen models stay at the uniform 0.5', () => {
    addModel('google', 'good', 1);
    addModel('groq', 'flaky', 2);
    refreshStatsCache(getDb(), true);
    expect(reliabilityOf('good')).toBeCloseTo(0.5, 5);
    expect(reliabilityOf('flaky')).toBeCloseTo(0.5, 5);
  });

  it('a NULL probe score (never scored) also means no change', () => {
    addModel('google', 'good', 1);
    addModel('groq', 'flaky', 2);
    seedProbeScore('groq', 'flaky', null);
    expect(reliabilityOf('flaky')).toBeCloseTo(0.5, 5);
  });

  it('a zero probe score pulls reliability down, a perfect score pulls it up', () => {
    addModel('google', 'good', 1);
    addModel('groq', 'flaky', 2);
    seedProbeScore('groq', 'flaky', 0);
    expect(reliabilityOf('flaky')).toBeCloseTo(0.25, 5);
    expect(reliabilityOf('good')).toBeCloseTo(0.5, 5);

    // Replace the row (same PK) so the score is exactly 1, not an average.
    getDb().prepare('DELETE FROM model_probe_status WHERE platform = ? AND model_id = ?').run('groq', 'flaky');
    seedProbeScore('groq', 'flaky', 1);
    expect(reliabilityOf('flaky')).toBeCloseTo(0.75, 5);
  });

  it('local evidence dilutes the probe prior quickly', () => {
    addModel('google', 'good', 1);
    addModel('groq', 'flaky', 2);
    addHistory('groq', 'flaky', 10, 0);
    refreshStatsCache(getDb(), true);
    const localOnly = reliabilityOf('flaky');
    expect(localOnly).toBeCloseTo(11 / 12, 5);

    seedProbeScore('groq', 'flaky', 0);
    // 10 local successes + a zero probe prior (0 successes, 2 failures):
    // (10+0+1)/(10+0+1+0+2+1) = 11/14 ≈ 0.786 — moved, not dominated.
    expect(reliabilityOf('flaky')).toBeCloseTo(11 / 14, 5);
    expect(reliabilityOf('flaky')).toBeGreaterThan(0.7);
  });

  it('kill switch restores base behaviour in both directions', () => {
    addModel('google', 'good', 1);
    addModel('groq', 'flaky', 2);
    seedProbeScore('groq', 'flaky', 1);
    expect(reliabilityOf('flaky')).toBeCloseTo(0.75, 5);

    process.env.LIVE_SIGNAL_PROBE_DISABLED = '1';
    refreshStatsCache(getDb(), true);
    expect(reliabilityOf('flaky')).toBeCloseTo(0.5, 5);

    delete process.env.LIVE_SIGNAL_PROBE_DISABLED;
    refreshStatsCache(getDb(), true);
    expect(reliabilityOf('flaky')).toBeCloseTo(0.75, 5);
  });

  it('the probe prior moves the final score, not just the reliability axis', () => {
    addModel('google', 'good', 1);
    addModel('groq', 'flaky', 2);
    refreshStatsCache(getDb(), true);
    const before = getRoutingScores().scores.find(s => s.modelId === 'flaky')!.score;
    seedProbeScore('groq', 'flaky', 0);
    const after = getRoutingScores().scores.find(s => s.modelId === 'flaky')!.score;
    expect(after).toBeLessThan(before);
  });
});
