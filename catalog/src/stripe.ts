/**
 * Stripe wiring — real Checkout, webhook, and Billing Portal via the
 * Stripe SDK (stripe@23.1.0, pinned API version `2026-10-28.endive`).
 *
 * No real Stripe keys exist in this repo; every credential comes from the
 * environment, and no key value is ever invented or hard-coded.
 *
 * Environment:
 *   STRIPE_SECRET_KEY       Secret key (sk_live_… / sk_test_…). Required.
 *   STRIPE_PRICE_ID         Price id for the $19/yr annual plan. Required.
 *   STRIPE_WEBHOOK_SECRET   Signing secret (whsec_…) for POST
 *                           /v1/stripe/webhook. Required.
 *   STRIPE_SUCCESS_URL      Checkout success page (default is the
 *                           librepool.com placeholder below — set it to a
 *                           real page before selling).
 *   STRIPE_CANCEL_URL       Checkout cancel page (same placeholder rule).
 *   STRIPE_PORTAL_URL       Dev-only fallback URL returned by /v1/portal
 *                           when a key has no Stripe customer id stored.
 *   STRIPE_PORTAL_RETURN_URL Optional return URL after the Billing Portal.
 *   EMAIL_TRANSPORT / EMAIL_FROM / RESEND_API_KEY — purchase email, see
 *                           email.ts (the webhook sends the key by email).
 *
 * Alex steps (dashboard, not code — nothing here creates Stripe objects):
 *   1. In the Stripe dashboard create a $19.00 USD recurring price with
 *      interval `year` (every 1 year) and put its id in STRIPE_PRICE_ID.
 *      There is NO lifetime SKU: the checkout verifies the price at
 *      session creation and refuses anything that is not $19/yr annual.
 *   2. Create the webhook endpoint for POST /v1/stripe/webhook, subscribe
 *      it to checkout.session.completed, customer.subscription.updated,
 *      customer.subscription.deleted, and invoice.payment_failed, and put
 *      its signing secret in STRIPE_WEBHOOK_SECRET.
 *   3. Build the success/cancel pages and set STRIPE_SUCCESS_URL /
 *      STRIPE_CANCEL_URL to them.
 *   4. Configure the purchase email (email.ts): EMAIL_TRANSPORT=resend
 *      + RESEND_API_KEY + a verified EMAIL_FROM. Until then the `log`
 *      transport only prints the key to stdout (dev only).
 *
 * Checkout flow ($19/yr, annual only — no lifetime SKU):
 *   1. POST /v1/checkout creates a Stripe Checkout Session (mode
 *      'subscription') for STRIPE_PRICE_ID, after fetching the price and
 *      verifying it is $19/yr annual. Returns {url, sessionId}.
 *   2. Stripe sends `checkout.session.completed` to POST /v1/stripe/webhook.
 *   3. The webhook verifies the Stripe-Signature header with
 *      STRIPE_WEBHOOK_SECRET, retrieves the subscription, and calls
 *      LicenseStore.issue(), recording the Stripe customer/subscription
 *      ids and the expiry from the subscription's first item
 *      (current_period_end).
 *   4. The issued license key is delivered to the buyer by purchase email
 *      (customer_details.email). Delivery is SINGLE-SHOT: the store keeps
 *      only a hash of the key, so if the email send fails the key cannot
 *      be re-sent — the webhook returns 500 so the failure is visible in
 *      Stripe, and the key must be replaced manually.
 *   5. The buyer pastes the key into the router (POST /api/premium/key);
 *      the router validates it via POST /v1/license/activate, then gets
 *      the live tier from GET /v1/latest with `Authorization: Bearer <key>`.
 *   6. Cancellations / card updates / invoices go through the Stripe
 *      Billing Portal: POST /v1/portal {key} creates a portal session for
 *      the stored stripeCustomerId. STRIPE_PORTAL_URL is only a dev
 *      fallback for keys with no customer id stored.
 *   7. `customer.subscription.updated` / `deleted` webhooks flip the
 *      stored license status; the router's next POST /v1/license/check
 *      reflects it. `invoice.payment_failed` is logged only: Stripe's
 *      dunning (Smart Retries) owns recovery, and the license stays valid
 *      until Stripe actually ends the subscription, at which point
 *      `customer.subscription.deleted` cancels it.
 *
 * Idempotency: Stripe may deliver a webhook event more than once. On
 * `checkout.session.completed`, if a license already exists for that
 * subscription id the handler issues NO second key and sends NO second
 * email — it logs and returns 200. (Check-then-issue is not atomic
 * against a concurrent duplicate delivery of the same event, but Stripe
 * delivers a given event sequentially in practice.)
 */
import Stripe from 'stripe';
import { loadEmailConfig, sendPurchaseEmail, type EmailConfig, type PurchaseEmailInput } from './email.ts';
import type { LicenseStore } from './license-store.ts';
import type { LicenseStatusValue } from './types.ts';

/** Pinned Stripe API version (the stripe@23.1.0 default), so SDK upgrades
 *  cannot silently change API behaviour. */
const STRIPE_API_VERSION = '2026-10-28.endive';

/** The $19/yr annual price the checkout requires. */
const EXPECTED_PRICE_AMOUNT = 1900; // cents
const EXPECTED_PRICE_CURRENCY = 'usd';
const EXPECTED_PRICE_INTERVAL = 'year';

export const DEFAULT_STRIPE_SUCCESS_URL = 'https://librepool.com/premium/success';
export const DEFAULT_STRIPE_CANCEL_URL = 'https://librepool.com/premium/cancel';

export interface StripeConfig {
  secretKey: string | null;
  priceId: string | null;
  webhookSecret: string | null;
  /** Optional fixed portal URL, returned by /v1/portal only when the key
   *  has no Stripe customer id stored (dev/self-host convenience only). */
  portalUrl: string | null;
  /** Checkout success/cancel pages. Defaults are librepool.com
   *  placeholders — set STRIPE_SUCCESS_URL / STRIPE_CANCEL_URL to real
   *  pages before selling. */
  successUrl: string;
  cancelUrl: string;
  /** Optional return URL after the Billing Portal (null → Stripe default). */
  portalReturnUrl: string | null;
}

export function loadStripeConfig(env: NodeJS.ProcessEnv = process.env): StripeConfig {
  const pick = (name: string): string | null => {
    const v = env[name];
    return v && v.trim().length > 0 ? v.trim() : null;
  };
  return {
    secretKey: pick('STRIPE_SECRET_KEY'),
    priceId: pick('STRIPE_PRICE_ID'),
    webhookSecret: pick('STRIPE_WEBHOOK_SECRET'),
    portalUrl: pick('STRIPE_PORTAL_URL'),
    successUrl: pick('STRIPE_SUCCESS_URL') ?? DEFAULT_STRIPE_SUCCESS_URL,
    cancelUrl: pick('STRIPE_CANCEL_URL') ?? DEFAULT_STRIPE_CANCEL_URL,
    portalReturnUrl: pick('STRIPE_PORTAL_RETURN_URL'),
  };
}

export function stripeIsConfigured(config: StripeConfig): boolean {
  return Boolean(config.secretKey && config.priceId && config.webhookSecret);
}

export const STRIPE_NOT_CONFIGURED = {
  error: 'stripe_not_configured',
  detail: 'Stripe is not wired for this feed service yet (STRIPE_SECRET_KEY / STRIPE_PRICE_ID / STRIPE_WEBHOOK_SECRET are unset). License keys cannot be purchased until checkout is configured — see catalog/README.md.',
} as const;

/** Error for POST /v1/portal when the key has no Stripe customer id. The
 *  server falls back to STRIPE_PORTAL_URL in that case, when one is set. */
export const PORTAL_NO_CUSTOMER = 'billing_portal_no_customer';

/**
 * Minimal Stripe surface this module uses. The real SDK client satisfies
 * it structurally; tests inject a fake implementing the same shape, so no
 * test ever calls the live Stripe API.
 */
export interface StripePriceLike {
  recurring: { interval: string; interval_count?: number | null } | null;
  unit_amount: number | null;
  currency: string;
}

export interface StripeCheckoutSessionLike {
  id: string;
  url: string | null;
}

export interface StripeSubscriptionLike {
  id: string;
  customer: string | { id: string };
  status: string;
  cancel_at_period_end: boolean;
  /** Current Stripe API versions put the billing period on the
   *  subscription item, not on the subscription itself (there is no
   *  top-level `current_period_end` on Subscription anymore). */
  items: { data: Array<{ current_period_end: number }> };
}

export interface StripePortalSessionLike {
  url: string;
}

export interface StripeEventLike {
  type: string;
  data: { object: unknown };
}

export interface StripeClient {
  prices: { retrieve(priceId: string): Promise<StripePriceLike> };
  checkout: {
    sessions: {
      create(params: {
        mode: 'subscription';
        line_items: Array<{ price: string; quantity: number }>;
        success_url: string;
        cancel_url: string;
        customer_email?: string;
      }): Promise<StripeCheckoutSessionLike>;
    };
  };
  subscriptions: { retrieve(subscriptionId: string): Promise<StripeSubscriptionLike> };
  billingPortal: {
    sessions: {
      create(params: { customer: string; return_url?: string }): Promise<StripePortalSessionLike>;
    };
  };
  webhooks: { constructEvent(payload: Buffer, signature: string, secret: string): StripeEventLike };
}

export function createStripeClient(secretKey: string): StripeClient {
  return new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Billing-period end (unix seconds) for a retrieved subscription: the
 *  first item's `current_period_end`. Null when the subscription has no
 *  items (should not happen for a Checkout subscription). */
export function subscriptionPeriodEnd(subscription: StripeSubscriptionLike): number | null {
  const first = subscription.items?.data?.[0];
  return first && typeof first.current_period_end === 'number' ? first.current_period_end : null;
}

/** Billing-period end for a webhook event's subscription object: the first
 *  item's `current_period_end` (current API versions), falling back to a
 *  top-level `current_period_end` for older payloads. */
function eventPeriodEnd(sub: Record<string, unknown>): number | null {
  const items = asRecord(sub.items);
  const data = items && Array.isArray(items.data) ? items.data : null;
  const first = data && data.length > 0 ? asRecord(data[0]) : null;
  if (first && typeof first.current_period_end === 'number') return first.current_period_end;
  return typeof sub.current_period_end === 'number' ? sub.current_period_end : null;
}

/** A Stripe id that may arrive as a bare string or an expanded object. */
function idOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  const rec = asRecord(value);
  return rec ? asString(rec.id) : null;
}

type WebhookResult = { status: number; body: Record<string, unknown> };

/**
 * Verify a fetched price is the $19/yr annual price. Returns null when it
 * matches, otherwise a human-readable description of the mismatch.
 */
export function checkAnnualPrice(price: StripePriceLike): string | null {
  if (!price.recurring) {
    return 'the price is not recurring (it has no recurring billing configured)';
  }
  if (price.recurring.interval !== EXPECTED_PRICE_INTERVAL) {
    return `the price bills every '${price.recurring.interval}', expected '${EXPECTED_PRICE_INTERVAL}'`;
  }
  if (
    price.recurring.interval_count !== undefined
    && price.recurring.interval_count !== null
    && price.recurring.interval_count !== 1
  ) {
    return `the price bills every ${price.recurring.interval_count} years, expected every 1 year`;
  }
  if (price.unit_amount !== EXPECTED_PRICE_AMOUNT || price.currency !== EXPECTED_PRICE_CURRENCY) {
    return `the price is ${price.unit_amount ?? 'unknown'} ${price.currency}, expected ${EXPECTED_PRICE_AMOUNT} ${EXPECTED_PRICE_CURRENCY} ($19/year)`;
  }
  return null;
}

/**
 * Create a real Stripe Checkout Session (mode 'subscription') for
 * STRIPE_PRICE_ID. The price is fetched and verified first: anything that
 * is not the $19/yr annual price fails with `stripe_price_misconfigured`
 * before any money moves. Returns {url, sessionId} on success.
 */
export async function createCheckoutSession(
  client: StripeClient | null,
  config: StripeConfig,
  opts: { email?: string } = {},
): Promise<WebhookResult> {
  if (!stripeIsConfigured(config)) {
    return { status: 501, body: { ...STRIPE_NOT_CONFIGURED } };
  }
  if (!client) {
    return { status: 500, body: { error: 'stripe_client_unavailable', detail: 'Stripe is configured but no Stripe client could be created.' } };
  }
  let price: StripePriceLike;
  try {
    price = await client.prices.retrieve(config.priceId!);
  } catch (err) {
    return {
      status: 500,
      body: {
        error: 'stripe_price_lookup_failed',
        detail: `Could not fetch STRIPE_PRICE_ID ${config.priceId} from Stripe: ${errorMessage(err)}. Check the price id and STRIPE_SECRET_KEY.`,
      },
    };
  }
  const problem = checkAnnualPrice(price);
  if (problem) {
    return {
      status: 500,
      body: {
        error: 'stripe_price_misconfigured',
        detail: `STRIPE_PRICE_ID ${config.priceId} is not the $19/yr annual price: ${problem}. Create a $19/year recurring price in the Stripe dashboard and set STRIPE_PRICE_ID to it — there is no lifetime SKU.`,
      },
    };
  }
  try {
    const session = await client.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: config.priceId!, quantity: 1 }],
      success_url: config.successUrl,
      cancel_url: config.cancelUrl,
      ...(opts.email ? { customer_email: opts.email } : {}),
    });
    if (!session.url) {
      return { status: 502, body: { error: 'stripe_checkout_failed', detail: 'Stripe returned a Checkout Session without a URL.' } };
    }
    return { status: 200, body: { url: session.url, sessionId: session.id } };
  } catch (err) {
    return { status: 502, body: { error: 'stripe_checkout_failed', detail: `Stripe Checkout Session creation failed: ${errorMessage(err)}` } };
  }
}

/**
 * Create a real Billing Portal session for the Stripe customer stored on
 * the license key. Returns 501 `billing_portal_no_customer` when the key
 * has no customer id (e.g. issued outside checkout) — the server falls
 * back to STRIPE_PORTAL_URL in that case, when one is set.
 */
export async function createPortalSession(
  client: StripeClient | null,
  store: LicenseStore,
  key: string,
  config: StripeConfig,
): Promise<WebhookResult> {
  if (!stripeIsConfigured(config)) {
    return { status: 501, body: { ...STRIPE_NOT_CONFIGURED } };
  }
  if (!client) {
    return { status: 500, body: { error: 'stripe_client_unavailable', detail: 'Stripe is configured but no Stripe client could be created.' } };
  }
  const record = store.find(key);
  if (!record) {
    return { status: 400, body: { error: 'That key is not active.' } };
  }
  if (!record.stripeCustomerId) {
    return {
      status: 501,
      body: {
        error: PORTAL_NO_CUSTOMER,
        detail: 'This key has no Stripe customer id stored (it was not issued through Stripe Checkout), so no Billing Portal session can be created for it. Set STRIPE_PORTAL_URL as a dev-only fallback, or issue the key through checkout.',
      },
    };
  }
  try {
    const session = await client.billingPortal.sessions.create({
      customer: record.stripeCustomerId,
      ...(config.portalReturnUrl ? { return_url: config.portalReturnUrl } : {}),
    });
    return { status: 200, body: { url: session.url } };
  } catch (err) {
    return { status: 502, body: { error: 'stripe_portal_failed', detail: `Stripe Billing Portal session creation failed: ${errorMessage(err)}` } };
  }
}

export interface StripeWebhookDeps {
  /** Injected client (tests); defaults to a real client from the secret key. */
  client?: StripeClient | null;
  emailConfig?: EmailConfig;
  /** Injected email sender (tests); defaults to sendPurchaseEmail(). */
  sendEmail?: (input: PurchaseEmailInput) => Promise<unknown>;
}

/**
 * Map a Stripe subscription status onto the license status. Only terminal
 * states flip the license: past_due / unpaid / incomplete / paused keep
 * it active, because access runs to current_period_end and Stripe sends
 * customer.subscription.deleted when the subscription actually ends (or
 * the subscription recovers on a successful retry). There is no 'paused'
 * license status; a paused subscription is treated the same way.
 */
export function mapSubscriptionStatus(status: string | null): LicenseStatusValue {
  if (status === 'canceled') return 'canceled';
  if (status === 'incomplete_expired') return 'expired';
  return 'active';
}

async function handleCheckoutCompleted(
  event: StripeEventLike,
  store: LicenseStore,
  client: StripeClient,
  deps: StripeWebhookDeps,
): Promise<WebhookResult> {
  const session = asRecord(event.data.object);
  const subscriptionId = session ? idOf(session.subscription) : null;
  if (!session || !subscriptionId) {
    console.error('[catalog] stripe webhook: checkout.session.completed without a subscription id; ignoring.');
    return { status: 200, body: { received: true, ignored: 'checkout.session.completed without subscription' } };
  }
  // Idempotency: never issue a second key (or a second email) for a
  // subscription that already has a license.
  const existing = store.findByStripeSubscriptionId(subscriptionId);
  if (existing) {
    console.log(`[catalog] stripe webhook: license already exists for subscription ${subscriptionId}; not issuing a second key or re-sending the email.`);
    return { status: 200, body: { received: true, duplicate: true } };
  }
  let subscription: StripeSubscriptionLike;
  try {
    subscription = await client.subscriptions.retrieve(subscriptionId);
  } catch (err) {
    console.error(`[catalog] stripe webhook: could not retrieve subscription ${subscriptionId}: ${errorMessage(err)}`);
    return { status: 502, body: { error: 'stripe_subscription_lookup_failed', detail: `Could not retrieve subscription ${subscriptionId} from Stripe: ${errorMessage(err)}` } };
  }
  const customerId = idOf(subscription.customer) ?? idOf(session.customer);
  const details = asRecord(session.customer_details);
  const email = (details ? asString(details.email) : null) ?? asString(session.customer_email);
  const periodEnd = subscriptionPeriodEnd(subscription);
  if (periodEnd === null) {
    console.warn(`[catalog] stripe webhook: subscription ${subscriptionId} has no billing period on its items; issuing with the default 1-year expiry.`);
  }
  const { key, record } = store.issue({
    ...(customerId ? { stripeCustomerId: customerId } : {}),
    stripeSubscriptionId: subscriptionId,
    ...(periodEnd !== null ? { expiresAt: new Date(periodEnd * 1000).toISOString() } : {}),
  });
  if (!email) {
    console.error(`[catalog] stripe webhook: no buyer email on the checkout session for subscription ${subscriptionId}; license issued but the key could not be delivered.`);
    return { status: 200, body: { received: true, issued: true, email: 'missing' } };
  }
  const sendEmail = deps.sendEmail
    ?? ((input: PurchaseEmailInput) => sendPurchaseEmail(deps.emailConfig ?? loadEmailConfig(), input));
  try {
    await sendEmail({ to: email, key, expiresAt: record.expiresAt });
  } catch (err) {
    // Single-shot delivery: the plaintext key exists only in memory here
    // (the store keeps a hash), so a failed email cannot be retried from
    // the store. Fail loudly (non-2xx) so Stripe retries and the failure
    // is visible; the retry hits the idempotency branch above and
    // returns 200. The undelivered key must be replaced manually.
    console.error(`[catalog] stripe webhook: purchase email failed for subscription ${subscriptionId} (buyer ${email}): ${errorMessage(err)}. License was issued; the key was NOT delivered and cannot be re-sent from the store.`);
    return {
      status: 500,
      body: {
        error: 'purchase_email_failed',
        detail: `License issued for subscription ${subscriptionId}, but the purchase email to ${email} failed: ${errorMessage(err)}. The key cannot be re-sent from the store (hash-only); issue a replacement key manually.`,
      },
    };
  }
  return { status: 200, body: { received: true, issued: true } };
}

function handleSubscriptionUpdated(
  event: StripeEventLike,
  store: LicenseStore,
): WebhookResult {
  const sub = asRecord(event.data.object);
  const subscriptionId = sub ? asString(sub.id) : null;
  if (!sub || !subscriptionId) {
    console.error('[catalog] stripe webhook: customer.subscription.updated without a subscription id; ignoring.');
    return { status: 200, body: { received: true, ignored: 'customer.subscription.updated without subscription id' } };
  }
  const patch: { status?: LicenseStatusValue; cancelAtPeriodEnd?: boolean; expiresAt?: string } = {
    status: mapSubscriptionStatus(asString(sub.status)),
  };
  if (typeof sub.cancel_at_period_end === 'boolean') patch.cancelAtPeriodEnd = sub.cancel_at_period_end;
  const periodEnd = eventPeriodEnd(sub);
  if (periodEnd !== null) patch.expiresAt = new Date(periodEnd * 1000).toISOString();
  const ok = store.updateBySubscription(subscriptionId, patch);
  if (!ok) {
    // Diagnostic only: findByStripeCustomerId returns the customer's most
    // recent license, which may belong to a different subscription — it
    // tells ops whether this customer is known at all.
    const customerId = idOf(sub.customer);
    const knownCustomer = customerId ? store.findByStripeCustomerId(customerId) : null;
    console.warn(`[catalog] stripe webhook: customer.subscription.updated for unknown subscription ${subscriptionId} (customer ${customerId ?? 'unknown'}${knownCustomer ? ' has a license' : ' has no license'}); nothing updated.`);
  }
  return { status: 200, body: { received: true, updated: ok } };
}

function handleSubscriptionDeleted(
  event: StripeEventLike,
  store: LicenseStore,
): WebhookResult {
  const sub = asRecord(event.data.object);
  const subscriptionId = sub ? asString(sub.id) : null;
  if (!sub || !subscriptionId) {
    console.error('[catalog] stripe webhook: customer.subscription.deleted without a subscription id; ignoring.');
    return { status: 200, body: { received: true, ignored: 'customer.subscription.deleted without subscription id' } };
  }
  const ok = store.updateBySubscription(subscriptionId, { status: 'canceled' });
  if (!ok) {
    console.warn(`[catalog] stripe webhook: customer.subscription.deleted for unknown subscription ${subscriptionId}; nothing updated.`);
  }
  return { status: 200, body: { received: true, updated: ok, status: 'canceled' } };
}

/**
 * Handle a Stripe webhook event: verify the Stripe-Signature header with
 * STRIPE_WEBHOOK_SECRET, then dispatch. Unknown event types are
 * acknowledged (200) and ignored. `invoice.payment_failed` is logged only
 * (see the header comment for why). Signature failures are 400; a missing
 * Stripe configuration is 501.
 */
export async function handleStripeWebhook(
  rawBody: Buffer,
  signature: string | null,
  store: LicenseStore,
  config: StripeConfig,
  deps: StripeWebhookDeps = {},
): Promise<WebhookResult> {
  if (!stripeIsConfigured(config)) {
    return { status: 501, body: { ...STRIPE_NOT_CONFIGURED } };
  }
  if (!signature) {
    return { status: 400, body: { error: 'invalid_signature', detail: 'Missing Stripe-Signature header; the webhook cannot be verified.' } };
  }
  const client = deps.client ?? (config.secretKey ? createStripeClient(config.secretKey) : null);
  if (!client) {
    return { status: 501, body: { ...STRIPE_NOT_CONFIGURED } };
  }
  let event: StripeEventLike;
  try {
    event = client.webhooks.constructEvent(rawBody, signature, config.webhookSecret!);
  } catch (err) {
    console.error('[catalog] stripe webhook signature verification failed:', errorMessage(err));
    return { status: 400, body: { error: 'invalid_signature', detail: 'Stripe-Signature verification failed; the event was not processed.' } };
  }
  switch (event.type) {
    case 'checkout.session.completed':
      return handleCheckoutCompleted(event, store, client, deps);
    case 'customer.subscription.updated':
      return handleSubscriptionUpdated(event, store);
    case 'customer.subscription.deleted':
      return handleSubscriptionDeleted(event, store);
    case 'invoice.payment_failed': {
      const invoice = asRecord(event.data.object);
      console.log(
        `[catalog] stripe webhook: invoice.payment_failed (${asString(invoice?.id) ?? 'unknown invoice'}) — logged only; `
        + 'Stripe dunning owns recovery, and the license flips only if Stripe later sends customer.subscription.deleted.',
      );
      return { status: 200, body: { received: true, ignored: 'invoice.payment_failed' } };
    }
    default:
      console.log(`[catalog] stripe webhook: ignoring event ${event.type}.`);
      return { status: 200, body: { received: true, ignored: event.type } };
  }
}
