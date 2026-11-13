// OpenRouter auto lane: with OPENROUTER_AUTO_LANE=1 the chain's OpenRouter
// :free entries collapse into one synthetic 'openrouter/auto' lane entry
// (collapseOpenRouterLane, pure), and routeRequest hands the allow-list to
// the provider via RouteResult.openrouterAuto. Flag off = unchanged routing.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  collapseOpenRouterLane,
  openrouterAutoLaneEnabled,
  routeRequest,
  setRoutingStrategy,
  type ChainRow,
} from '../../services/router.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { addToActiveChain } from '../helpers/chain.js';

function row(partial: Partial<ChainRow> & { model_db_id: number; platform: string; model_id: string }): ChainRow {
  return {
    priority: partial.model_db_id,
    enabled: 1,
    display_name: partial.model_id,
    intelligence_rank: 3,
    size_label: 'Large',
    monthly_token_budget: '~50M',
    rpm_limit: null,
    rpd_limit: null,
    tpm_limit: null,
    tpd_limit: null,
    supports_vision: 0,
    supports_tools: 1,
    context_window: null,
    key_id: null,
    endpoint_scope: '',
    ...partial,
  };
}

describe('collapseOpenRouterLane', () => {
  it('is a no-op with no OpenRouter free entries', () => {
    const chain = [
      row({ model_db_id: 1, platform: 'groq', model_id: 'groq-model' }),
      row({ model_db_id: 2, platform: 'openrouter', model_id: 'acme/paid-model' }),
    ];
    expect(collapseOpenRouterLane(chain)).toEqual(chain);
  });

  it('is a no-op with a single OpenRouter free entry (nothing to delegate among)', () => {
    const chain = [
      row({ model_db_id: 1, platform: 'openrouter', model_id: 'acme/alpha:free' }),
      row({ model_db_id: 2, platform: 'groq', model_id: 'groq-model' }),
    ];
    expect(collapseOpenRouterLane(chain)).toEqual(chain);
  });

  it('collapses 2+ OpenRouter free entries into one lane at the best entry slot', () => {
    const chain = [
      row({ model_db_id: 1, platform: 'groq', model_id: 'groq-model' }),
      row({ model_db_id: 2, platform: 'openrouter', model_id: 'acme/alpha:free' }),
      row({ model_db_id: 3, platform: 'openrouter', model_id: 'acme/paid-model' }),
      row({ model_db_id: 4, platform: 'openrouter', model_id: 'acme/beta:free' }),
      row({ model_db_id: 5, platform: 'google', model_id: 'google-model' }),
    ];
    const out = collapseOpenRouterLane(chain);
    expect(out.map(e => e.model_id)).toEqual([
      'groq-model',
      'openrouter/auto',
      'acme/paid-model',
      'google-model',
    ]);
    const lane = out[1];
    expect(lane.model_db_id).toBe(2);
    expect(lane.openrouterAllowedModels).toEqual(['acme/alpha:free', 'acme/beta:free']);
    // Non-free OpenRouter rows and other platforms pass through untouched.
    expect(out[0]).toBe(chain[0]);
    expect(out[2]).toBe(chain[2]);
    expect(out[3]).toBe(chain[4]);
  });

  it('dedupes the allow-list when one free id sits on two endpoint scopes', () => {
    const chain = [
      row({ model_db_id: 1, platform: 'openrouter', model_id: 'acme/alpha:free' }),
      row({ model_db_id: 2, platform: 'openrouter', model_id: 'acme/alpha:free', endpoint_scope: 'relay-b' }),
      row({ model_db_id: 3, platform: 'openrouter', model_id: 'acme/beta:free' }),
    ];
    const out = collapseOpenRouterLane(chain);
    expect(out).toHaveLength(1);
    expect(out[0].openrouterAllowedModels).toEqual(['acme/alpha:free', 'acme/beta:free']);
  });
});

describe('openrouterAutoLaneEnabled', () => {
  afterEach(() => {
    delete process.env.OPENROUTER_AUTO_LANE;
  });

  it('is opt-in: only OPENROUTER_AUTO_LANE=1 enables it', () => {
    delete process.env.OPENROUTER_AUTO_LANE;
    expect(openrouterAutoLaneEnabled()).toBe(false);
    process.env.OPENROUTER_AUTO_LANE = '0';
    expect(openrouterAutoLaneEnabled()).toBe(false);
    process.env.OPENROUTER_AUTO_LANE = 'true';
    expect(openrouterAutoLaneEnabled()).toBe(false);
    process.env.OPENROUTER_AUTO_LANE = '1';
    expect(openrouterAutoLaneEnabled()).toBe(true);
  });
});

describe('routeRequest with the OpenRouter lane', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
  });

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    initDb(':memory:');
    getDb().exec('DELETE FROM fallback_config; DELETE FROM api_keys; DELETE FROM models; DELETE FROM requests;');
    delete process.env.OPENROUTER_AUTO_LANE;
    setRoutingStrategy('priority');
  });

  afterEach(() => {
    delete process.env.OPENROUTER_AUTO_LANE;
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
  }

  function addKey(platform: string): void {
    const { encrypted, iv, authTag } = encrypt(`test-${platform}-key`);
    getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, 'k', ?, ?, ?, 'healthy', 1)
    `).run(platform, encrypted, iv, authTag);
  }

  function seedChain(): void {
    addModel('openrouter', 'acme/alpha:free', 1);
    addModel('groq', 'groq-model', 2);
    addModel('openrouter', 'acme/beta:free', 3);
    addModel('openrouter', 'acme/paid-model', 4);
    addKey('openrouter');
    addKey('groq');
  }

  it('flag off: routes to the concrete best OpenRouter free model, no lane hint', () => {
    seedChain();
    const route = routeRequest();
    expect(route.platform).toBe('openrouter');
    expect(route.modelId).toBe('acme/alpha:free');
    expect(route.openrouterAuto).toBeUndefined();
  });

  it('flag on: the first route is the delegated lane restricted to the free ids', () => {
    seedChain();
    process.env.OPENROUTER_AUTO_LANE = '1';
    const route = routeRequest();
    expect(route.platform).toBe('openrouter');
    expect(route.modelId).toBe('openrouter/auto');
    expect(route.openrouterAuto).toEqual({ allowedModels: ['acme/alpha:free', 'acme/beta:free'] });
  });
});
