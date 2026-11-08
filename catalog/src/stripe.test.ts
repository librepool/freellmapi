import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkAnnualPrice,
  createCheckoutSession,
  createPortalSession,
  handleStripeWebhook,
  loadStripeConfig,
  mapSubscriptionStatus,
  PORTAL_NO_CUSTOMER,
  type StripeClient,
  type StripeConfig,
  type StripeEventLike,
} from './stripe.ts';
import type { LicenseRecord, LicenseStore } from './license-store.ts';
import type { PurchaseEmailInput } from './email.ts';

/**
 * Fake Stripe client + fake license store. No test here touches the live
 * Stripe API: the client is injected into every function under test, and
 * the store is in-memory.
 */

function testConfig(overrides: Partial<StripeConfig> = {}): StripeConfig {
  return {
    secretKey: 'sk_test_fake',
    priceId: 'price_test_19yr',
    webhookSecret: 'whsec_test_fake',
    portalUrl: null,
    successUrl: 'https://example.test/premium/success',
    cancelUrl: 'https://example.test/premium/cancel',
    portalReturnUrl: null,
    ...overrides,
  };
}

const UNCONFIGURED: StripeConfig = {
  secretKey: null,
  priceId: null,
  webhookSecret: null,
  portalUrl: null,
  successUrl: 'https://example.test/premium/success',
  cancelUrl: 'https://example.test/premium/cancel',
  portalReturnUrl: null,
};

class FakeStore {
  records: LicenseRecord[] = [];
  private byKey = new Map<string, LicenseRecord>();
  issued = 0;

  issue(opts: { stripeCustomerId?: string; stripeSubscriptionId?: string; expiresAt?: string } = {}): { key: string; record: LicenseRecord } {
    this.issued += 1;
    const key = `lp_test_${this.issued}_${'k'.repeat(20)}`;
    const record: LicenseRecord = {
      keyHash: `hash-${this.issued}`,
      plan: 'annual',
      status: 'active',
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
      ...(opts.stripeCustomerId ? { stripeCustomerId: opts.stripeCustomerId } : {}),
      ...(opts.stripeSubscriptionId ? { stripeSubscriptionId: opts.stripeSubscriptionId } : {}),
    };
    this.records.push(record);
    this.byKey.set(key, record);
    return { key, record };
  }

  /** Seed a record under a known key (portal tests). */
  seed(key: string, record: Omit<LicenseRecord, 'keyHash'>): void {
    const full: LicenseRecord = { ...record, keyHash: `hash-${key}` };
    this.records.push(full);
    this.byKey.set(key, full);
  }

  find(key: string): LicenseRecord | null {
    return this.byKey.get(key) ?? null;
  }

  findByStripeSubscriptionId(subscriptionId: string): LicenseRecord | null {
    return this.records.find((r) => r.stripeSubscriptionId === subscriptionId) ?? null;
  }

  findByStripeCustomerId(customerId: string): LicenseRecord | null {
    const found = this.records.filter((r) => r.stripeCustomerId === customerId);
    return found[found.length - 1] ?? null;
  }

  updateBySubscription(
    subscriptionId: string,
    patch: { status?: LicenseRecord['status']; cancelAtPeriodEnd?: boolean; expiresAt?: string },
  ): boolean {
    const rec = this.findByStripeSubscriptionId(subscriptionId);
    if (!rec) return false;
    if (patch.status !== undefined) rec.status = patch.status;
    if (patch.cancelAtPeriodEnd !== undefined) rec.cancelAtPeriodEnd = patch.cancelAtPeriodEnd;
    if (patch.expiresAt !== undefined) rec.expiresAt = patch.expiresAt;
    return true;
  }

  asLicenseStore(): LicenseStore {
    return this as unknown as LicenseStore;
  }
}

interface FakeStripeOptions {
  price?: { recurring: { interval: string; interval_count?: number | null } | null; unit_amount: number | null; currency: string };
  priceError?: Error;
  checkoutUrl?: string | null;
  checkoutError?: Error;
  subscription?: { id: string; customer: string; status: string; items: { data: Array<{ current_period_end: number }> }; cancel_at_period_end: boolean };
  subscriptionError?: Error;
  portalUrl?: string;
  portalError?: Error;
  event?: StripeEventLike | null;
}

interface FakeStripe {
  client: StripeClient;
  calls: {
    pricesRetrieved: string[];
    checkoutCreated: unknown[];
    subscriptionsRetrieved: string[];
    portalCreated: unknown[];
    constructEventArgs: Array<{ payload: Buffer; signature: string; secret: string }>;
  };
  /** Mutable: webhook tests set the event the fake constructEvent returns. */
  event: StripeEventLike | null;
}

function makeFakeStripe(opts: FakeStripeOptions = {}): FakeStripe {
  const calls: FakeStripe['calls'] = {
    pricesRetrieved: [],
    checkoutCreated: [],
    subscriptionsRetrieved: [],
    portalCreated: [],
    constructEventArgs: [],
  };
  const fake: FakeStripe = {
    event: opts.event ?? null,
    calls,
    client: {
      prices: {
        retrieve: async (id: string) => {
          calls.pricesRetrieved.push(id);
          if (opts.priceError) throw opts.priceError;
          return opts.price ?? { recurring: { interval: 'year', interval_count: 1 }, unit_amount: 1900, currency: 'usd' };
        },
      },
      checkout: {
        sessions: {
          create: async (params) => {
            calls.checkoutCreated.push(params);
            if (opts.checkoutError) throw opts.checkoutError;
            return {
              id: 'cs_test_123',
              url: opts.checkoutUrl === undefined ? 'https://checkout.stripe.com/pay/cs_test_123' : opts.checkoutUrl,
            };
          },
        },
      },
      subscriptions: {
        retrieve: async (id: string) => {
          calls.subscriptionsRetrieved.push(id);
          if (opts.subscriptionError) throw opts.subscriptionError;
          return opts.subscription ?? { id, customer: 'cus_test_1', status: 'active', items: { data: [{ current_period_end: 1893456000 }] }, cancel_at_period_end: false };
        },
      },
      billingPortal: {
        sessions: {
          create: async (params) => {
            calls.portalCreated.push(params);
            if (opts.portalError) throw opts.portalError;
            return { url: opts.portalUrl ?? 'https://billing.stripe.com/session/test' };
          },
        },
      },
      webhooks: {
        constructEvent: (payload: Buffer, signature: string, secret: string) => {
          calls.constructEventArgs.push({ payload, signature, secret });
          if (signature !== 'sig_valid') {
            throw new Error('No signatures found matching the expected signature version for payload');
          }
          if (!fake.event) throw new Error('no fake event configured');
          return fake.event;
        },
      },
    },
  };
  return fake;
}

function checkoutCompletedEvent(overrides: {
  subscription?: string | { id: string } | null;
  customer?: string | null;
  email?: string | null;
  customerEmail?: string | null;
} = {}): StripeEventLike {
  return {
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_123',
        subscription: overrides.subscription === undefined ? 'sub_test_1' : overrides.subscription,
        customer: overrides.customer === undefined ? 'cus_test_1' : overrides.customer,
        customer_details: { email: overrides.email === undefined ? 'buyer@example.com' : overrides.email },
        customer_email: overrides.customerEmail ?? null,
      },
    },
  };
}

function subscriptionEvent(type: 'customer.subscription.updated' | 'customer.subscription.deleted', object: Record<string, unknown>): StripeEventLike {
  return { type, data: { object } };
}

test('loadStripeConfig picks up success/cancel URLs and defaults to librepool.com placeholders', () => {
  const cfg = loadStripeConfig({
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_PRICE_ID: 'price_x',
    STRIPE_WEBHOOK_SECRET: 'whsec_x',
    STRIPE_SUCCESS_URL: 'https://shop.example.test/success',
    STRIPE_CANCEL_URL: 'https://shop.example.test/cancel',
    STRIPE_PORTAL_RETURN_URL: 'https://shop.example.test/account',
  });
  assert.equal(cfg.successUrl, 'https://shop.example.test/success');
  assert.equal(cfg.cancelUrl, 'https://shop.example.test/cancel');
  assert.equal(cfg.portalReturnUrl, 'https://shop.example.test/account');
  const defaults = loadStripeConfig({ STRIPE_SECRET_KEY: 'sk_test_x' });
  assert.equal(defaults.successUrl, 'https://librepool.com/premium/success');
  assert.equal(defaults.cancelUrl, 'https://librepool.com/premium/cancel');
  assert.equal(defaults.portalReturnUrl, null);
});

test('checkAnnualPrice accepts $19/yr annual and rejects everything else', () => {
  const annual = { recurring: { interval: 'year', interval_count: 1 }, unit_amount: 1900, currency: 'usd' };
  assert.equal(checkAnnualPrice(annual), null);
  assert.match(checkAnnualPrice({ recurring: { interval: 'month', interval_count: 1 }, unit_amount: 1900, currency: 'usd' })!, /month/);
  assert.match(checkAnnualPrice({ recurring: null, unit_amount: 1900, currency: 'usd' })!, /not recurring/);
  assert.match(checkAnnualPrice({ recurring: { interval: 'year', interval_count: 1 }, unit_amount: 2900, currency: 'usd' })!, /2900/);
  assert.match(checkAnnualPrice({ recurring: { interval: 'year', interval_count: 1 }, unit_amount: 1900, currency: 'eur' })!, /eur/);
  assert.match(checkAnnualPrice({ recurring: { interval: 'year', interval_count: 2 }, unit_amount: 1900, currency: 'usd' })!, /2 years/);
});

test('createCheckoutSession: verifies the price, then returns {url, sessionId}', async () => {
  const fake = makeFakeStripe();
  const result = await createCheckoutSession(fake.client, testConfig(), { email: 'buyer@example.com' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { url: 'https://checkout.stripe.com/pay/cs_test_123', sessionId: 'cs_test_123' });
  assert.deepEqual(fake.calls.pricesRetrieved, ['price_test_19yr']);
  assert.equal(fake.calls.checkoutCreated.length, 1);
  const params = fake.calls.checkoutCreated[0] as Record<string, unknown>;
  assert.equal(params.mode, 'subscription');
  assert.deepEqual(params.line_items, [{ price: 'price_test_19yr', quantity: 1 }]);
  assert.equal(params.success_url, 'https://example.test/premium/success');
  assert.equal(params.cancel_url, 'https://example.test/premium/cancel');
  assert.equal(params.customer_email, 'buyer@example.com');
});

test('createCheckoutSession: 501 when Stripe is not configured', async () => {
  const fake = makeFakeStripe();
  const result = await createCheckoutSession(fake.client, UNCONFIGURED);
  assert.equal(result.status, 501);
  assert.equal(result.body.error, 'stripe_not_configured');
  assert.equal(fake.calls.pricesRetrieved.length, 0);
});

test('createCheckoutSession: 500 stripe_price_misconfigured when the price is not $19/yr', async () => {
  const fake = makeFakeStripe({
    price: { recurring: { interval: 'month', interval_count: 1 }, unit_amount: 1900, currency: 'usd' },
  });
  const result = await createCheckoutSession(fake.client, testConfig());
  assert.equal(result.status, 500);
  assert.equal(result.body.error, 'stripe_price_misconfigured');
  assert.match(String(result.body.detail), /month/);
  assert.equal(fake.calls.checkoutCreated.length, 0);
});

test('createCheckoutSession: 500 stripe_price_lookup_failed when the price cannot be fetched', async () => {
  const fake = makeFakeStripe({ priceError: new Error('No such price: price_test_19yr') });
  const result = await createCheckoutSession(fake.client, testConfig());
  assert.equal(result.status, 500);
  assert.equal(result.body.error, 'stripe_price_lookup_failed');
});

test('createCheckoutSession: 502 when Stripe returns a session without a URL', async () => {
  const fake = makeFakeStripe({ checkoutUrl: null });
  const result = await createCheckoutSession(fake.client, testConfig());
  assert.equal(result.status, 502);
  assert.equal(result.body.error, 'stripe_checkout_failed');
});

test('createCheckoutSession: 502 when session creation throws', async () => {
  const fake = makeFakeStripe({ checkoutError: new Error('api error') });
  const result = await createCheckoutSession(fake.client, testConfig());
  assert.equal(result.status, 502);
  assert.equal(result.body.error, 'stripe_checkout_failed');
});

test('createPortalSession: creates a portal session for the stored customer id', async () => {
  const store = new FakeStore();
  store.seed('lp_portal_key', {
    plan: 'annual', status: 'active',
    expiresAt: '2027-11-07T00:00:00.000Z', createdAt: '2026-11-07T00:00:00.000Z',
    stripeCustomerId: 'cus_test_1', stripeSubscriptionId: 'sub_test_1',
  });
  const fake = makeFakeStripe();
  const result = await createPortalSession(fake.client, store.asLicenseStore(), 'lp_portal_key', testConfig());
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { url: 'https://billing.stripe.com/session/test' });
  assert.deepEqual(fake.calls.portalCreated, [{ customer: 'cus_test_1' }]);
});

test('createPortalSession: 501 billing_portal_no_customer when the key has no customer id', async () => {
  const store = new FakeStore();
  store.seed('lp_dev_key', {
    plan: 'annual', status: 'active',
    expiresAt: '2027-11-07T00:00:00.000Z', createdAt: '2026-11-07T00:00:00.000Z',
  });
  const fake = makeFakeStripe();
  const result = await createPortalSession(fake.client, store.asLicenseStore(), 'lp_dev_key', testConfig());
  assert.equal(result.status, 501);
  assert.equal(result.body.error, PORTAL_NO_CUSTOMER);
  assert.equal(fake.calls.portalCreated.length, 0);
});

test('createPortalSession: 400 for an unknown key, 501 when not configured', async () => {
  const store = new FakeStore();
  const fake = makeFakeStripe();
  const unknown = await createPortalSession(fake.client, store.asLicenseStore(), 'lp_nope', testConfig());
  assert.equal(unknown.status, 400);
  const unconfigured = await createPortalSession(fake.client, store.asLicenseStore(), 'lp_nope', UNCONFIGURED);
  assert.equal(unconfigured.status, 501);
  assert.equal(unconfigured.body.error, 'stripe_not_configured');
});

test('handleStripeWebhook: 501 when Stripe is not configured', async () => {
  const store = new FakeStore();
  const fake = makeFakeStripe();
  const result = await handleStripeWebhook(Buffer.from('{}'), 'sig_valid', store.asLicenseStore(), UNCONFIGURED, { client: fake.client });
  assert.equal(result.status, 501);
  assert.equal(result.body.error, 'stripe_not_configured');
});

test('handleStripeWebhook: 400 on a missing or invalid signature', async () => {
  const store = new FakeStore();
  const fake = makeFakeStripe({ event: checkoutCompletedEvent() });
  const missing = await handleStripeWebhook(Buffer.from('{}'), null, store.asLicenseStore(), testConfig(), { client: fake.client });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, 'invalid_signature');
  const bad = await handleStripeWebhook(Buffer.from('{}'), 'sig_bad', store.asLicenseStore(), testConfig(), { client: fake.client });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_signature');
  assert.equal(store.issued, 0);
});

test('handleStripeWebhook checkout.session.completed: issues one license and emails the key once', async () => {
  const store = new FakeStore();
  const sent: PurchaseEmailInput[] = [];
  const fake = makeFakeStripe({ event: checkoutCompletedEvent() });
  const result = await handleStripeWebhook(
    Buffer.from('{"id":"evt_1"}'), 'sig_valid', store.asLicenseStore(), testConfig(),
    { client: fake.client, sendEmail: async (input) => { sent.push(input); } },
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.issued, true);
  assert.equal(store.issued, 1);
  assert.equal(fake.calls.constructEventArgs.length, 1);
  assert.equal(fake.calls.constructEventArgs[0].signature, 'sig_valid');
  assert.equal(fake.calls.constructEventArgs[0].secret, 'whsec_test_fake');
  const record = store.findByStripeSubscriptionId('sub_test_1');
  assert.ok(record);
  assert.equal(record.stripeCustomerId, 'cus_test_1');
  assert.equal(record.stripeSubscriptionId, 'sub_test_1');
  // current_period_end 1893456000 → 2030-01-01.
  assert.equal(record.expiresAt, '2030-01-01T00:00:00.000Z');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'buyer@example.com');
  assert.equal(sent[0].expiresAt, '2030-01-01T00:00:00.000Z');
  // The emailed key is the issued key.
  assert.ok(store.find(sent[0].key));
});

test('handleStripeWebhook checkout.session.completed: a replay issues no second key and sends no second email', async () => {
  const store = new FakeStore();
  const sent: PurchaseEmailInput[] = [];
  const fake = makeFakeStripe({ event: checkoutCompletedEvent() });
  const deps = { client: fake.client, sendEmail: async (input: PurchaseEmailInput) => { sent.push(input); } };
  const first = await handleStripeWebhook(Buffer.from('{}'), 'sig_valid', store.asLicenseStore(), testConfig(), deps);
  assert.equal(first.status, 200);
  const replay = await handleStripeWebhook(Buffer.from('{}'), 'sig_valid', store.asLicenseStore(), testConfig(), deps);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.duplicate, true);
  assert.equal(store.issued, 1);
  assert.equal(sent.length, 1);
});

test('handleStripeWebhook checkout.session.completed: no buyer email still issues, but reports email missing', async () => {
  const store = new FakeStore();
  const sent: PurchaseEmailInput[] = [];
  const fake = makeFakeStripe({ event: checkoutCompletedEvent({ email: null }) });
  const result = await handleStripeWebhook(
    Buffer.from('{}'), 'sig_valid', store.asLicenseStore(), testConfig(),
    { client: fake.client, sendEmail: async (input) => { sent.push(input); } },
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.issued, true);
  assert.equal(result.body.email, 'missing');
  assert.equal(store.issued, 1);
  assert.equal(sent.length, 0);
});

test('handleStripeWebhook checkout.session.completed: a failed email is a loud 500, license still issued', async () => {
  const store = new FakeStore();
  const fake = makeFakeStripe({ event: checkoutCompletedEvent() });
  const result = await handleStripeWebhook(
    Buffer.from('{}'), 'sig_valid', store.asLicenseStore(), testConfig(),
    { client: fake.client, sendEmail: async () => { throw new Error('resend down'); } },
  );
  assert.equal(result.status, 500);
  assert.equal(result.body.error, 'purchase_email_failed');
  assert.equal(store.issued, 1);
  // Stripe retries the failed webhook; the retry hits the idempotency
  // branch (200, duplicate) and cannot re-send the key — the store keeps
  // only a hash, so the undelivered key must be replaced manually.
  const sent: PurchaseEmailInput[] = [];
  const retry = await handleStripeWebhook(
    Buffer.from('{}'), 'sig_valid', store.asLicenseStore(), testConfig(),
    { client: fake.client, sendEmail: async (input) => { sent.push(input); } },
  );
  assert.equal(retry.status, 200);
  assert.equal(retry.body.duplicate, true);
  assert.equal(store.issued, 1);
  assert.equal(sent.length, 0);
});

test('handleStripeWebhook customer.subscription.updated: flips status, cancel flag, and expiry', async () => {
  const store = new FakeStore();
  const { record } = store.issue({ stripeCustomerId: 'cus_test_1', stripeSubscriptionId: 'sub_test_1' });
  assert.equal(record.status, 'active');
  const fake = makeFakeStripe({
    event: subscriptionEvent('customer.subscription.updated', {
      id: 'sub_test_1', customer: 'cus_test_1', status: 'active',
      cancel_at_period_end: true, items: { data: [{ current_period_end: 1924992000 }] },
    }),
  });
  const result = await handleStripeWebhook(Buffer.from('{}'), 'sig_valid', store.asLicenseStore(), testConfig(), { client: fake.client });
  assert.equal(result.status, 200);
  assert.equal(result.body.updated, true);
  const updated = store.findByStripeSubscriptionId('sub_test_1')!;
  assert.equal(updated.cancelAtPeriodEnd, true);
  assert.equal(updated.expiresAt, '2031-01-01T00:00:00.000Z');
  assert.equal(updated.status, 'active');

  fake.event = subscriptionEvent('customer.subscription.updated', {
    id: 'sub_test_1', customer: 'cus_test_1', status: 'canceled',
    cancel_at_period_end: false, items: { data: [{ current_period_end: 1924992000 }] },
  });
  const canceled = await handleStripeWebhook(Buffer.from('{}'), 'sig_valid', store.asLicenseStore(), testConfig(), { client: fake.client });
  assert.equal(canceled.status, 200);
  assert.equal(store.findByStripeSubscriptionId('sub_test_1')!.status, 'canceled');
});

test('handleStripeWebhook customer.subscription.updated for an unknown subscription: 200, updated false', async () => {
  const store = new FakeStore();
  const fake = makeFakeStripe({
    event: subscriptionEvent('customer.subscription.updated', {
      id: 'sub_unknown', customer: 'cus_unknown', status: 'active',
      cancel_at_period_end: false, items: { data: [{ current_period_end: 1924992000 }] },
    }),
  });
  const result = await handleStripeWebhook(Buffer.from('{}'), 'sig_valid', store.asLicenseStore(), testConfig(), { client: fake.client });
  assert.equal(result.status, 200);
  assert.equal(result.body.updated, false);
});

test('handleStripeWebhook customer.subscription.deleted: cancels the license', async () => {
  const store = new FakeStore();
  store.issue({ stripeCustomerId: 'cus_test_1', stripeSubscriptionId: 'sub_test_1' });
  const fake = makeFakeStripe({
    event: subscriptionEvent('customer.subscription.deleted', {
      id: 'sub_test_1', customer: 'cus_test_1', status: 'canceled',
      cancel_at_period_end: false, items: { data: [{ current_period_end: 1893456000 }] },
    }),
  });
  const result = await handleStripeWebhook(Buffer.from('{}'), 'sig_valid', store.asLicenseStore(), testConfig(), { client: fake.client });
  assert.equal(result.status, 200);
  assert.equal(result.body.updated, true);
  assert.equal(result.body.status, 'canceled');
  assert.equal(store.findByStripeSubscriptionId('sub_test_1')!.status, 'canceled');
});

test('handleStripeWebhook invoice.payment_failed: logged only, no license change', async () => {
  const store = new FakeStore();
  store.issue({ stripeCustomerId: 'cus_test_1', stripeSubscriptionId: 'sub_test_1' });
  const fake = makeFakeStripe({
    event: { type: 'invoice.payment_failed', data: { object: { id: 'in_test_1', customer: 'cus_test_1', subscription: 'sub_test_1' } } },
  });
  const result = await handleStripeWebhook(Buffer.from('{}'), 'sig_valid', store.asLicenseStore(), testConfig(), { client: fake.client });
  assert.equal(result.status, 200);
  assert.equal(result.body.ignored, 'invoice.payment_failed');
  assert.equal(store.findByStripeSubscriptionId('sub_test_1')!.status, 'active');
  assert.equal(store.issued, 1);
});

test('handleStripeWebhook: unknown events are acknowledged and ignored', async () => {
  const store = new FakeStore();
  const fake = makeFakeStripe({
    event: { type: 'customer.created', data: { object: { id: 'cus_test_1' } } },
  });
  const result = await handleStripeWebhook(Buffer.from('{}'), 'sig_valid', store.asLicenseStore(), testConfig(), { client: fake.client });
  assert.equal(result.status, 200);
  assert.equal(result.body.ignored, 'customer.created');
});

test('handleStripeWebhook customer.subscription.updated: a legacy top-level current_period_end still updates expiry', async () => {
  const store = new FakeStore();
  store.issue({ stripeCustomerId: 'cus_test_1', stripeSubscriptionId: 'sub_test_1' });
  const fake = makeFakeStripe({
    event: subscriptionEvent('customer.subscription.updated', {
      id: 'sub_test_1', customer: 'cus_test_1', status: 'active',
      cancel_at_period_end: false, current_period_end: 1924992000,
    }),
  });
  const result = await handleStripeWebhook(Buffer.from('{}'), 'sig_valid', store.asLicenseStore(), testConfig(), { client: fake.client });
  assert.equal(result.status, 200);
  assert.equal(result.body.updated, true);
  assert.equal(store.findByStripeSubscriptionId('sub_test_1')!.expiresAt, '2031-01-01T00:00:00.000Z');
});

test('handleStripeWebhook with the REAL Stripe client verifies a genuinely signed payload (no network)', async () => {
  // The fake client above proves the handler logic; this proves the real
  // SDK wiring: generateTestHeaderString signs the payload exactly the
  // way Stripe does, and constructEvent verifies it. The event type is
  // invoice.payment_failed, which needs no further Stripe API calls, so
  // no network is involved.
  const { default: Stripe } = await import('stripe');
  const realClient = new Stripe('sk_test_fake', { apiVersion: '2026-10-28.endive' });
  const payload = JSON.stringify({
    id: 'evt_test_1',
    type: 'invoice.payment_failed',
    data: { object: { id: 'in_test_1', customer: 'cus_test_1', subscription: 'sub_test_1' } },
  });
  const header = realClient.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test_fake' });
  const store = new FakeStore();
  const ok = await handleStripeWebhook(Buffer.from(payload), header, store.asLicenseStore(), testConfig(), { client: realClient });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ignored, 'invoice.payment_failed');
  const tampered = await handleStripeWebhook(Buffer.from(payload), 't=1,v1=deadbeef', store.asLicenseStore(), testConfig(), { client: realClient });
  assert.equal(tampered.status, 400);
  assert.equal(tampered.body.error, 'invalid_signature');
});

test('mapSubscriptionStatus: only terminal states flip the license', () => {
  assert.equal(mapSubscriptionStatus('active'), 'active');
  assert.equal(mapSubscriptionStatus('trialing'), 'active');
  assert.equal(mapSubscriptionStatus('past_due'), 'active');
  assert.equal(mapSubscriptionStatus('unpaid'), 'active');
  assert.equal(mapSubscriptionStatus('incomplete'), 'active');
  assert.equal(mapSubscriptionStatus('paused'), 'active');
  assert.equal(mapSubscriptionStatus('canceled'), 'canceled');
  assert.equal(mapSubscriptionStatus('incomplete_expired'), 'expired');
  assert.equal(mapSubscriptionStatus(null), 'active');
});
