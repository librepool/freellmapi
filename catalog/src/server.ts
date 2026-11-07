/**
 * HTTP service for the LibrePool catalog feed.
 *
 * Endpoints (the router's contract — see server/src/services/catalog-sync.ts):
 *   GET  /v1/latest[?since=<version>]  — signed catalog JSON; Bearer
 *        premium_license_key → tier 'live', otherwise tier 'monthly' (the
 *        15-day-old snapshot). ?since=<applied version> → 304 when unchanged.
 *        Response carries x-catalog-signature (base64 Ed25519 over the exact
 *        response bytes).
 *   POST /v1/license/activate {key}    — {valid, plan, status, expiresAt, reason?}
 *   POST /v1/license/check (Bearer)    — LicenseStatus JSON.
 *   POST /v1/portal {key}              — {url} Stripe Billing Portal session
 *        (stub until Stripe is wired; see stripe.ts).
 *   POST /v1/stripe/webhook            — Stripe webhook receiver (stub).
 *   GET  /healthz                      — liveness only, no catalog data.
 *
 * Zero runtime dependencies: node:http + node:crypto only.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import type { CatalogStore } from './catalog-store.ts';
import type { LicenseStore } from './license-store.ts';
import { signBytes } from './signing.ts';
import { handleStripeWebhook, loadStripeConfig, STRIPE_NOT_CONFIGURED, type StripeConfig } from './stripe.ts';

export interface FeedServiceDeps {
  catalogStore: CatalogStore;
  licenseStore: LicenseStore;
  privateKey: crypto.KeyObject;
  stripeConfig?: StripeConfig;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function jsonBody(raw: Buffer): Record<string, unknown> {
  if (raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function bearerKey(req: http.IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  const key = h.slice('Bearer '.length).trim();
  return key.length > 0 ? key : null;
}

export function createFeedHandler(deps: FeedServiceDeps): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const { catalogStore, licenseStore, privateKey } = deps;
  const stripeConfig = deps.stripeConfig ?? loadStripeConfig();

  return async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const sendJson = (status: number, body: unknown, extraHeaders: Record<string, string> = {}): void => {
      const bytes = Buffer.from(JSON.stringify(body));
      res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
      res.end(bytes);
    };

    try {
      if (req.method === 'GET' && url.pathname === '/healthz') {
        sendJson(200, { ok: true, version: catalogStore.version });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/latest') {
        const key = bearerKey(req);
        const live = key !== null && licenseStore.activate(key).valid;
        const doc = live ? catalogStore.liveDocument() : catalogStore.monthlyDocument();
        const since = url.searchParams.get('since');
        if (since && since === doc.version) {
          res.writeHead(304);
          res.end();
          return;
        }
        const bytes = Buffer.from(JSON.stringify(doc));
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'x-catalog-signature': signBytes(privateKey, bytes),
        });
        res.end(bytes);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/license/activate') {
        const body = jsonBody(await readBody(req));
        const key = typeof body.key === 'string' ? body.key : '';
        if (!key) {
          sendJson(400, { valid: false, plan: null, status: null, expiresAt: null, reason: 'missing_key' });
          return;
        }
        sendJson(200, licenseStore.activate(key));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/license/check') {
        const key = bearerKey(req);
        if (!key) {
          sendJson(401, { valid: false, plan: null, status: null, expiresAt: null, reason: 'missing_key', checkedAtMs: Date.now() });
          return;
        }
        sendJson(200, licenseStore.check(key));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/portal') {
        const body = jsonBody(await readBody(req));
        const key = typeof body.key === 'string' ? body.key : '';
        if (!key || !licenseStore.activate(key).valid) {
          sendJson(400, { error: 'That key is not active.' });
          return;
        }
        if (stripeConfig.portalUrl) {
          sendJson(200, { url: stripeConfig.portalUrl });
          return;
        }
        sendJson(501, {
          error: 'billing_portal_not_configured',
          detail: 'Stripe Billing Portal is not wired yet. ' + (STRIPE_NOT_CONFIGURED.detail ?? ''),
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/stripe/webhook') {
        const raw = await readBody(req);
        const sig = typeof req.headers['stripe-signature'] === 'string' ? req.headers['stripe-signature'] : null;
        const result = handleStripeWebhook(raw, sig, licenseStore, stripeConfig);
        sendJson(result.status, result.body);
        return;
      }

      sendJson(404, { error: 'not_found' });
    } catch (err) {
      console.error(`[catalog] ${req.method} ${url.pathname}:`, err instanceof Error ? err.message : err);
      if (!res.headersSent) sendJson(500, { error: 'internal_error' });
      else res.end();
    }
  };
}

export function startFeedService(deps: FeedServiceDeps, port: number, host: string): http.Server {
  const server = http.createServer(createFeedHandler(deps));
  server.listen(port, host, () => {
    console.log(`[catalog] LibrePool feed service listening on http://${host}:${port} (catalog v${deps.catalogStore.version})`);
  });
  return server;
}
