import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CatalogStore } from './catalog-store.ts';
import { LicenseStore } from './license-store.ts';
import { createFeedHandler } from './server.ts';
import { generateKeypair, publicKeyPem, verifyBytes } from './signing.ts';
import type { SeedCatalog } from './types.ts';

const LIMITS = { rpm: null, rpd: null, tpm: null, tpd: null };

function seed(): SeedCatalog {
  return {
    version: '2026.11.06',
    models: [
      { platform: 'groq', modelId: 'old-chat', displayName: 'Old', intelligenceRank: 100, speedRank: 1, sizeLabel: 'Small', limits: LIMITS, monthlyTokenBudget: null, contextWindow: null, enabled: true, supportsVision: false, supportsTools: true, premiumSince: '2026-09-01T00:00:00.000Z' },
      { platform: 'groq', modelId: 'new-chat', displayName: 'New', intelligenceRank: 100, speedRank: 1, sizeLabel: 'Small', limits: LIMITS, monthlyTokenBudget: null, contextWindow: null, enabled: true, supportsVision: false, supportsTools: true, premiumSince: '2026-11-05T00:00:00.000Z' },
    ],
    searchEngines: [
      { platform: 'tavily', engineId: 'old-search', displayName: 'Old', priority: 1, enabled: true, premiumSince: '2026-09-01T00:00:00.000Z' },
    ],
    quirks: [],
  };
}

interface Running {
  base: string;
  key: string;
  publicPem: string;
  close: () => Promise<void>;
}

async function startServer(): Promise<Running> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'librepool-feed-'));
  const licenseStore = new LicenseStore(path.join(dir, 'licenses.json'));
  const { key } = licenseStore.issue();
  const kp = generateKeypair();
  const privateKey = crypto.createPrivateKey({ key: kp.privatePem, format: 'pem' });
  const server = http.createServer(createFeedHandler({
    catalogStore: new CatalogStore(seed()),
    licenseStore,
    privateKey,
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return {
    base: `http://127.0.0.1:${addr.port}`,
    key,
    publicPem: publicKeyPem(privateKey),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('GET /v1/latest without a key serves the monthly snapshot, signed', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const res = await fetch(`${s.base}/v1/latest`);
  assert.equal(res.status, 200);
  const bytes = Buffer.from(await res.arrayBuffer());
  const sig = res.headers.get('x-catalog-signature');
  assert.ok(sig, 'missing x-catalog-signature');
  assert.equal(verifyBytes(s.publicPem, bytes, sig!), true);
  const doc = JSON.parse(bytes.toString('utf8')) as { tier: string; version: string; models: Array<{ modelId: string }> };
  assert.equal(doc.tier, 'monthly');
  assert.equal(doc.version, '2026.11.06');
  assert.deepEqual(doc.models.map((m) => m.modelId), ['old-chat']);
  assert.equal(JSON.stringify(doc).includes('benchmarks'), false);
});

test('GET /v1/latest with a valid Bearer key serves the live tier', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const res = await fetch(`${s.base}/v1/latest`, { headers: { Authorization: `Bearer ${s.key}` } });
  const doc = await res.json() as { tier: string; models: Array<{ modelId: string }> };
  assert.equal(doc.tier, 'live');
  assert.deepEqual(doc.models.map((m) => m.modelId).sort(), ['new-chat', 'old-chat']);
});

test('GET /v1/latest with an invalid Bearer key falls back to monthly', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const res = await fetch(`${s.base}/v1/latest`, { headers: { Authorization: 'Bearer lp_invalid' } });
  const doc = await res.json() as { tier: string };
  assert.equal(doc.tier, 'monthly');
});

test('GET /v1/latest?since=<current version> returns 304', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const res = await fetch(`${s.base}/v1/latest?since=2026.11.06`);
  assert.equal(res.status, 304);
  const other = await fetch(`${s.base}/v1/latest?since=2026.11.05`);
  assert.equal(other.status, 200);
});

test('POST /v1/license/activate: valid, unknown, and missing keys', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const post = (body: unknown): Promise<Response> => fetch(`${s.base}/v1/license/activate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const ok = await (await post({ key: s.key })).json() as { valid: boolean; plan: string };
  assert.equal(ok.valid, true);
  assert.equal(ok.plan, 'annual');
  const unknown = await (await post({ key: 'lp_nope' })).json() as { valid: boolean; reason: string };
  assert.equal(unknown.valid, false);
  assert.equal(unknown.reason, 'unknown_key');
  const missing = await post({});
  assert.equal(missing.status, 400);
});

test('POST /v1/license/check: Bearer valid → LicenseStatus; none → 401', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const ok = await fetch(`${s.base}/v1/license/check`, { method: 'POST', headers: { Authorization: `Bearer ${s.key}` } });
  const body = await ok.json() as { valid: boolean; plan: string; checkedAtMs: number };
  assert.equal(ok.status, 200);
  assert.equal(body.valid, true);
  assert.equal(body.plan, 'annual');
  assert.equal(typeof body.checkedAtMs, 'number');
  const noAuth = await fetch(`${s.base}/v1/license/check`, { method: 'POST' });
  assert.equal(noAuth.status, 401);
});

test('POST /v1/portal without Stripe configured returns a clear error', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const res = await fetch(`${s.base}/v1/portal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: s.key }),
  });
  assert.equal(res.status, 501);
  const body = await res.json() as { error: string };
  assert.equal(body.error, 'billing_portal_not_configured');
});

test('POST /v1/stripe/webhook without Stripe configured returns not_configured', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const res = await fetch(`${s.base}/v1/stripe/webhook`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 501);
  const body = await res.json() as { error: string };
  assert.equal(body.error, 'stripe_not_configured');
});
