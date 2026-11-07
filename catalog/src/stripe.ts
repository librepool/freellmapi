/**
 * Stripe wiring — configuration + stubs only.
 *
 * No real Stripe keys exist for LibrePool yet; every value here is a
 * placeholder from the environment, and no key value is ever invented or
 * hard-coded. Until Stripe is wired, checkout/portal/webhook return a clear
 * `not_configured` error instead of pretending to work.
 *
 * Documented checkout flow ($19/yr, annual only — no lifetime SKU):
 *   1. Buyer completes Stripe Checkout for STRIPE_PRICE_ID ($19/yr).
 *   2. Stripe sends `checkout.session.completed` to POST /v1/stripe/webhook.
 *   3. The webhook handler (TODO: signature verification with
 *      STRIPE_WEBHOOK_SECRET + the Stripe SDK) calls
 *      LicenseStore.issue() and records the Stripe customer/subscription ids.
 *   4. The issued license key is delivered to the buyer by purchase email
 *      (email sending is out of scope for this service).
 *   5. The buyer pastes the key into the router (POST /api/premium/key);
 *      the router validates it via POST /v1/license/activate, then gets the
 *      live tier from GET /v1/latest with `Authorization: Bearer <key>`.
 *   6. Cancellations / card updates / invoices go through the Stripe Billing
 *      Portal: POST /v1/portal {key} creates a portal session.
 *   7. `customer.subscription.deleted` / `updated` webhooks flip the stored
 *      license status (canceled / expired); the router's next
 *      POST /v1/license/check reflects it.
 */
import type { LicenseStore } from './license-store.ts';

export interface StripeConfig {
  secretKey: string | null;
  priceId: string | null;
  webhookSecret: string | null;
  /** Optional fixed portal URL, returned by /v1/portal until real portal
   *  sessions are wired (dev/self-host convenience only). */
  portalUrl: string | null;
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
  };
}

export function stripeIsConfigured(config: StripeConfig): boolean {
  return Boolean(config.secretKey && config.priceId && config.webhookSecret);
}

export const STRIPE_NOT_CONFIGURED = {
  error: 'stripe_not_configured',
  detail: 'Stripe is not wired for this feed service yet (STRIPE_SECRET_KEY / STRIPE_PRICE_ID / STRIPE_WEBHOOK_SECRET are unset). License keys cannot be purchased until checkout is configured — see catalog/README.md.',
} as const;

/**
 * Handle a Stripe webhook event. STUB: without the Stripe SDK and a
 * configured webhook secret there is no safe way to verify the event
 * signature, so every call is refused. The real handler must:
 *  - verify the Stripe-Signature header with STRIPE_WEBHOOK_SECRET,
 *  - on checkout.session.completed: issue a license key and record the
 *    customer/subscription ids,
 *  - on customer.subscription.deleted/updated: update the license status.
 */
export function handleStripeWebhook(
  _rawBody: Buffer,
  _signature: string | null,
  _store: LicenseStore,
  config: StripeConfig,
): { status: number; body: Record<string, unknown> } {
  if (!stripeIsConfigured(config)) {
    return { status: 501, body: { ...STRIPE_NOT_CONFIGURED } };
  }
  return {
    status: 501,
    body: {
      error: 'stripe_webhook_not_implemented',
      detail: 'Stripe is configured but webhook handling is not implemented yet: signature verification (STRIPE_WEBHOOK_SECRET) and the Stripe SDK are still TODO. No license was issued.',
    },
  };
}
