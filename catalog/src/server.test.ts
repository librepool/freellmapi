import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CatalogStore } from './catalog-store.ts';
import type { PurchaseEmailInput } from './email.ts';
import type { LicenseRecord } from './license-store.ts';
import { LicenseStore } from './license-store.ts';
import { createFeedHandler } from './server.ts';
import { generateKeypair, publicKeyPem, verifyBytes } from './signing.ts';
import type { StripeClient, StripeConfig, StripeEventLike } from './stripe.ts';
import type { LicenseActivation, LicenseStatus, LicenseStatusValue, SeedCatalog } from './types.ts';

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

/* ---- Stripe HTTP tests (fake Stripe client + fake store + fake email) ---- */

/** In-memory stand-in for LicenseStore, implementing the surface the
 *  handler and stripe.ts use (activate/check/find/issue + the Stripe
 *  seam). No test here touches the live Stripe API. */
class FakeLicenseStore {
  private byKey = new Map<string, LicenseRecord>();
  private bySub = new Map<string, LicenseRecord>();

  issue(opts: { stripeCustomerId?: string; stripeSubscriptionId?: string; expiresAt?: string } = {}): { key: string; record: LicenseRecord } {
    const key = `lp_${crypto.randomBytes(32).toString('base64url')}`;
    const now = new Date();
    const record: LicenseRecord = {
      keyHash: `hash-${key}`,
      plan: 'annual',
      status: 'active',
      expiresAt: opts.expiresAt ?? new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      createdAt: now.toISOString(),
      ...(opts.stripeCustomerId ? { stripeCustomerId: opts.stripeCustomerId } : {}),
      ...(opts.stripeSubscriptionId ? { stripeSubscriptionId: opts.stripeSubscriptionId } : {}),
    };
    this.byKey.set(key, record);
    if (record.stripeSubscriptionId) this.bySub.set(record.stripeSubscriptionId, record);
    return { key, record };
  }

  find(key: string): LicenseRecord | null {
    return this.byKey.get(key) ?? null;
  }

  findByStripeSubscriptionId(subscriptionId: string): LicenseRecord | null {
    return this.bySub.get(subscriptionId) ?? null;
  }

  findByStripeCustomerId(customerId: string): LicenseRecord | null {
    const found = [...this.byKey.values()].filter((r) => r.stripeCustomerId === customerId);
    return found[found.length - 1] ?? null;
  }

  updateBySubscription(
    subscriptionId: string,
    patch: { status?: LicenseStatusValue; cancelAtPeriodEnd?: boolean; expiresAt?: string },
  ): boolean {
    const rec = this.bySub.get(subscriptionId);
    if (!rec) return false;
    if (patch.status !== undefined) rec.status = patch.status;
    if (patch.cancelAtPeriodEnd !== undefined) rec.cancelAtPeriodEnd = patch.cancelAtPeriodEnd;
    if (patch.expiresAt !== undefined) rec.expiresAt = patch.expiresAt;
    return true;
  }

  activate(key: string): LicenseActivation {
    const rec = this.find(key);
    if (!rec) return { valid: false, plan: null, status: null, expiresAt: null, reason: 'unknown_key' };
    if (rec.status === 'canceled') return { valid: false, plan: rec.plan, status: 'canceled', expiresAt: rec.expiresAt, reason: 'canceled' };
    if (rec.status === 'refunded') return { valid: false, plan: rec.plan, status: 'refunded', expiresAt: rec.expiresAt, reason: 'refunded' };
    if (rec.status === 'expired' || Date.parse(rec.expiresAt) <= Date.now()) {
      return { valid: false, plan: rec.plan, status: 'expired', expiresAt: rec.expiresAt, reason: 'expired' };
    }
    return { valid: true, plan: rec.plan, status: 'active', expiresAt: rec.expiresAt };
  }

  check(key: string): LicenseStatus {
    const base: LicenseStatus = {
      valid: false, plan: null, status: null, expiresAt: null, checkedAtMs: Date.now(),
    };
    const rec = this.find(key);
    if (!rec) return { ...base, reason: 'unknown_key' };
    const activation = this.activate(key);
    return {
      valid: activation.valid,
      plan: activation.plan,
      status: activation.status,
      expiresAt: activation.expiresAt,
      ...(rec.cancelAtPeriodEnd ? { cancelAtPeriodEnd: true } : {}),
      ...(activation.reason ? { reason: activation.reason } : {}),
      checkedAtMs: Date.now(),
    };
  }

  asLicenseStore(): LicenseStore {
    return this as unknown as LicenseStore;
  }
}

interface HttpFakeStripe {
  client: StripeClient;
  /** Mutable: webhook tests set the event constructEvent returns. */
  event: StripeEventLike | null;
  portalCreated: unknown[];
}

function makeHttpFakeStripe(opts: {
  price?: { recurring: { interval: string; interval_count?: number | null } | null; unit_amount: number | null; currency: string };
} = {}): HttpFakeStripe {
  const fake: HttpFakeStripe = {
    event: null,
    portalCreated: [],
    client: {
      prices: {
        retrieve: async () => opts.price ?? { recurring: { interval: 'year', interval_count: 1 }, unit_amount: 1900, currency: 'usd' },
      },
      checkout: {
        sessions: {
          create: async () => ({ id: 'cs_test_123', url: 'https://checkout.stripe.com/pay/cs_test_123' }),
        },
      },
      subscriptions: {
        retrieve: async (id: string) => ({ id, customer: 'cus_http_2', status: 'active', items: { data: [{ current_period_end: 1893456000 }] }, cancel_at_period_end: false }),
      },
      billingPortal: {
        sessions: {
          create: async (params) => {
            fake.portalCreated.push(params);
            return { url: 'https://billing.stripe.com/session/http-test' };
          },
        },
      },
      webhooks: {
        constructEvent: (_payload: Buffer, signature: string, _secret: string) => {
          if (signature !== 'sig_valid') throw new Error('bad signature');
          if (!fake.event) throw new Error('no fake event configured');
          return fake.event;
        },
      },
    },
  };
  return fake;
}

interface StripeRunning {
  base: string;
  key: string;
  keyNoCustomer: string;
  store: FakeLicenseStore;
  fake: HttpFakeStripe;
  emails: PurchaseEmailInput[];
  close: () => Promise<void>;
}

async function startStripeServer(opts: {
  price?: { recurring: { interval: string; interval_count?: number | null } | null; unit_amount: number | null; currency: string };
  portalUrl?: string | null;
} = {}): Promise<StripeRunning> {
  const store = new FakeLicenseStore();
  const { key } = store.issue({ stripeCustomerId: 'cus_http_1', stripeSubscriptionId: 'sub_http_1' });
  const { key: keyNoCustomer } = store.issue();
  const emails: PurchaseEmailInput[] = [];
  const fake = makeHttpFakeStripe(opts);
  const kp = generateKeypair();
  const privateKey = crypto.createPrivateKey({ key: kp.privatePem, format: 'pem' });
  const stripeConfig: StripeConfig = {
    secretKey: 'sk_test_fake',
    priceId: 'price_test_19yr',
    webhookSecret: 'whsec_test_fake',
    portalUrl: opts.portalUrl ?? null,
    successUrl: 'https://example.test/premium/success',
    cancelUrl: 'https://example.test/premium/cancel',
    portalReturnUrl: null,
  };
  const server = http.createServer(createFeedHandler({
    catalogStore: new CatalogStore(seed()),
    licenseStore: store.asLicenseStore(),
    privateKey,
    stripeConfig,
    stripeClient: fake.client,
    emailSender: async (input) => { emails.push(input); },
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return {
    base: `http://127.0.0.1:${addr.port}`,
    key,
    keyNoCustomer,
    store,
    fake,
    emails,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('POST /v1/checkout with Stripe configured returns a Checkout URL', async (t) => {
  const s = await startStripeServer();
  t.after(s.close);
  const res = await fetch(`${s.base}/v1/checkout`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'buyer@example.com' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { url: string; sessionId: string };
  assert.equal(body.url, 'https://checkout.stripe.com/pay/cs_test_123');
  assert.equal(body.sessionId, 'cs_test_123');
});

test('POST /v1/checkout without Stripe configured returns not_configured', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const res = await fetch(`${s.base}/v1/checkout`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 501);
  const body = await res.json() as { error: string };
  assert.equal(body.error, 'stripe_not_configured');
});

test('POST /v1/checkout with a non-annual price returns stripe_price_misconfigured', async (t) => {
  const s = await startStripeServer({
    price: { recurring: { interval: 'month', interval_count: 1 }, unit_amount: 1900, currency: 'usd' },
  });
  t.after(s.close);
  const res = await fetch(`${s.base}/v1/checkout`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 500);
  const body = await res.json() as { error: string };
  assert.equal(body.error, 'stripe_price_misconfigured');
});

test('POST /v1/portal with a checkout-issued key creates a real portal session', async (t) => {
  const s = await startStripeServer();
  t.after(s.close);
  const res = await fetch(`${s.base}/v1/portal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: s.key }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { url: string };
  assert.equal(body.url, 'https://billing.stripe.com/session/http-test');
  assert.deepEqual(s.fake.portalCreated, [{ customer: 'cus_http_1' }]);
});

test('POST /v1/portal with a key with no customer id falls back to STRIPE_PORTAL_URL when set', async (t) => {
  const s = await startStripeServer({ portalUrl: 'https://example.test/fixed-portal' });
  t.after(s.close);
  const res = await fetch(`${s.base}/v1/portal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: s.keyNoCustomer }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { url: string };
  assert.equal(body.url, 'https://example.test/fixed-portal');
  assert.equal(s.fake.portalCreated.length, 0);
});

test('POST /v1/portal with a key with no customer id and no fallback returns billing_portal_no_customer', async (t) => {
  const s = await startStripeServer();
  t.after(s.close);
  const res = await fetch(`${s.base}/v1/portal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: s.keyNoCustomer }),
  });
  assert.equal(res.status, 501);
  const body = await res.json() as { error: string };
  assert.equal(body.error, 'billing_portal_no_customer');
});

test('POST /v1/stripe/webhook checkout.session.completed issues a license and emails the key; replay is a duplicate', async (t) => {
  const s = await startStripeServer();
  t.after(s.close);
  s.fake.event = {
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_456',
        subscription: 'sub_http_2',
        customer: 'cus_http_2',
        customer_details: { email: 'buyer@example.com' },
        customer_email: null,
      },
    },
  };
  const postWebhook = (sig: string): Promise<Response> => fetch(`${s.base}/v1/stripe/webhook`, {
    method: 'POST', headers: { 'stripe-signature': sig }, body: '{}',
  });
  const first = await postWebhook('sig_valid');
  assert.equal(first.status, 200);
  const firstBody = await first.json() as { issued: boolean };
  assert.equal(firstBody.issued, true);
  const record = s.store.findByStripeSubscriptionId('sub_http_2');
  assert.ok(record);
  assert.equal(record.stripeCustomerId, 'cus_http_2');
  assert.equal(record.expiresAt, '2030-01-01T00:00:00.000Z');
  assert.equal(s.emails.length, 1);
  assert.equal(s.emails[0].to, 'buyer@example.com');
  assert.ok(s.store.find(s.emails[0].key));

  const replay = await postWebhook('sig_valid');
  assert.equal(replay.status, 200);
  const replayBody = await replay.json() as { duplicate: boolean };
  assert.equal(replayBody.duplicate, true);
  assert.equal(s.emails.length, 1);
  assert.ok(s.store.findByStripeSubscriptionId('sub_http_2'));

  const bad = await postWebhook('sig_bad');
  assert.equal(bad.status, 400);
  const badBody = await bad.json() as { error: string };
  assert.equal(badBody.error, 'invalid_signature');
});

test('POST /v1/stripe/webhook customer.subscription.deleted cancels the license', async (t) => {
  const s = await startStripeServer();
  t.after(s.close);
  s.fake.event = {
    type: 'customer.subscription.deleted',
    data: {
      object: {
        id: 'sub_http_1', customer: 'cus_http_1', status: 'canceled',
        cancel_at_period_end: false, items: { data: [{ current_period_end: 1893456000 }] },
      },
    },
  };
  const res = await fetch(`${s.base}/v1/stripe/webhook`, {
    method: 'POST', headers: { 'stripe-signature': 'sig_valid' }, body: '{}',
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { updated: boolean; status: string };
  assert.equal(body.updated, true);
  assert.equal(body.status, 'canceled');
  const check = await fetch(`${s.base}/v1/license/check`, {
    method: 'POST', headers: { Authorization: `Bearer ${s.key}` },
  });
  const status = await check.json() as { valid: boolean; status: string; reason: string };
  assert.equal(status.valid, false);
  assert.equal(status.status, 'canceled');
  assert.equal(status.reason, 'canceled');
});
