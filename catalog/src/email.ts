/**
 * Purchase email for the LibrePool live feed.
 *
 * One email is sent per purchase: it carries the license key to the buyer.
 * The key is shown EXACTLY ONCE in the email body (and never in the
 * subject) — the license store keeps only a SHA-256 hash of the key, so a
 * lost key cannot be re-sent or recovered. `buildPurchaseEmail()` is the
 * single place the key is rendered; do not add the key to any other part
 * of the message (subject, footer, portal link, …).
 *
 * Transports (`EMAIL_TRANSPORT`, default `log`):
 *   - `log` (default, dev only): writes the whole email to stdout and
 *     sends nothing. Safe with no credentials; never use it in
 *     production — buyers would never receive their key.
 *   - `resend`: sends via the Resend HTTP email API with the global
 *     `fetch` (no extra dependency).
 *
 * Why an HTTP email API instead of SMTP (nodemailer)? The service already
 * sends exactly one transactional email per purchase, so there is no
 * benefit in a long-lived SMTP connection pool, and SMTP egress (ports
 * 25/587) is blocked on many hosts. One HTTPS POST to a transactional
 * email API is the simplest durable option: zero new dependencies, no
 * connection management, and a single auditable request/response. The
 * endpoint is overridable (`RESEND_API_URL`) so the provider can be
 * swapped for any Resend-compatible HTTP email API without a code change.
 *
 * Environment (all credentials come from env only — never put a real key
 * or address in code):
 *   EMAIL_TRANSPORT   'log' | 'resend' (default 'log').
 *   EMAIL_FROM        Sender address, e.g. 'LibrePool <billing@librepool.com>'.
 *                     Required for `resend`: it must be a sender identity
 *                     verified in the email provider, or delivery fails.
 *                     For `log` it is cosmetic (defaults to the
 *                     `noreply@librepool.com` placeholder below).
 *   RESEND_API_KEY    API key for the email provider (required for `resend`).
 *   RESEND_API_URL    Override the send endpoint (default
 *                     https://api.resend.com/emails).
 *   EMAIL_REPLY_TO    Optional Reply-To address.
 */

export type EmailTransportName = 'log' | 'resend';

export interface EmailConfig {
  transport: EmailTransportName;
  /** Null when EMAIL_FROM is unset. Required for the `resend` transport. */
  from: string | null;
  resendApiKey: string | null;
  resendApiUrl: string;
  replyTo: string | null;
}

export const DEFAULT_EMAIL_FROM = 'LibrePool <noreply@librepool.com>';
export const DEFAULT_RESEND_API_URL = 'https://api.resend.com/emails';

export function loadEmailConfig(env: NodeJS.ProcessEnv = process.env): EmailConfig {
  const pick = (name: string): string | null => {
    const v = env[name];
    return v && v.trim().length > 0 ? v.trim() : null;
  };
  const rawTransport = (env.EMAIL_TRANSPORT ?? 'log').trim().toLowerCase();
  if (rawTransport !== 'log' && rawTransport !== 'resend') {
    throw new Error(
      `Unknown EMAIL_TRANSPORT ${JSON.stringify(rawTransport)}: expected 'log' (dev only) or 'resend'.`,
    );
  }
  return {
    transport: rawTransport,
    from: pick('EMAIL_FROM'),
    resendApiKey: pick('RESEND_API_KEY'),
    resendApiUrl: pick('RESEND_API_URL') ?? DEFAULT_RESEND_API_URL,
    replyTo: pick('EMAIL_REPLY_TO'),
  };
}

/** True when this config can actually deliver a purchase email. The `log`
 *  transport is always "configured" — it just writes to stdout. */
export function emailIsConfigured(config: EmailConfig): boolean {
  return config.transport === 'log' || Boolean(config.from && config.resendApiKey);
}

export interface PurchaseEmailInput {
  /** Buyer's address (from Stripe `customer_details.email`). */
  to: string;
  /** Plaintext license key. Rendered exactly once, in the body only. */
  key: string;
  /** ISO expiry of the issued license. */
  expiresAt: string;
}

export interface PurchaseEmail {
  to: string;
  from: string;
  subject: string;
  /** Plain text only (no HTML part — the key must appear exactly once in
   *  the whole message, and a second MIME part would repeat it). */
  text: string;
}

export function buildPurchaseEmail(input: PurchaseEmailInput, from: string): PurchaseEmail {
  const parsed = new Date(input.expiresAt);
  const expiresLabel = Number.isNaN(parsed.getTime())
    ? input.expiresAt
    : parsed.toISOString().slice(0, 10);
  const text = [
    'Hi,',
    '',
    'Thank you for purchasing the LibrePool live catalog feed — $19/year (annual plan).',
    '',
    'Your license key is below. It appears exactly once in this email: we store only a hash of it, so keep it safe — it cannot be re-sent if you lose it.',
    '',
    input.key,
    '',
    `Plan: LibrePool live feed, $19/year (annual, renews yearly unless cancelled).`,
    `Expires: ${expiresLabel}.`,
    '',
    'To activate it in the router:',
    '  1. Open the router dashboard → Premium page and paste the key above, or',
    '  2. POST /api/premium/key with { "key": "<the key above>" }.',
    '',
    'The router validates the key against the feed service and then syncs the live catalog. To manage or cancel the subscription, request a Billing Portal link from the feed service with POST /v1/portal and your key.',
    '',
    '— LibrePool',
  ].join('\n');
  return {
    to: input.to,
    from,
    subject: 'Your LibrePool live feed license key',
    text,
  };
}

export interface EmailSendResult {
  transport: EmailTransportName;
  /** Provider message id, when the transport returns one. */
  messageId?: string;
}

/**
 * Send a purchase email. Throws on any delivery failure — the caller
 * (the Stripe webhook) must treat a throw as "key issued, email NOT
 * delivered" and fail loudly, because the plaintext key cannot be
 * recovered from the store afterwards.
 *
 * `fetchFn` / `log` are injectable for tests; defaults are the global
 * `fetch` and `console.log`.
 */
export async function sendPurchaseEmail(
  config: EmailConfig,
  input: PurchaseEmailInput,
  deps: { fetchFn?: typeof fetch; log?: (...args: unknown[]) => void } = {},
): Promise<EmailSendResult> {
  const email = buildPurchaseEmail(input, config.from ?? DEFAULT_EMAIL_FROM);
  if (config.transport === 'log') {
    (deps.log ?? console.log)(
      '[catalog] purchase email (log transport — dev only, NOT sent):\n'
      + '---\n'
      + `To: ${email.to}\nFrom: ${email.from}\nSubject: ${email.subject}\n\n${email.text}\n---`,
    );
    return { transport: 'log' };
  }
  // resend transport.
  if (!config.resendApiKey) {
    throw new Error('EMAIL_TRANSPORT=resend requires RESEND_API_KEY to be set.');
  }
  if (!config.from) {
    throw new Error(
      'EMAIL_TRANSPORT=resend requires EMAIL_FROM to be set to a sender address verified in the email provider.',
    );
  }
  const fetchFn = deps.fetchFn ?? fetch;
  const res = await fetchFn(config.resendApiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: email.from,
      to: email.to,
      subject: email.subject,
      text: email.text,
      ...(config.replyTo ? { reply_to: config.replyTo } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Email provider error (HTTP ${res.status} from ${config.resendApiUrl}): ${body.slice(0, 500)}`,
    );
  }
  const data: unknown = await res.json().catch(() => ({}));
  const messageId =
    data && typeof data === 'object' && 'id' in data && typeof data.id === 'string' ? data.id : undefined;
  return { transport: 'resend', ...(messageId ? { messageId } : {}) };
}
