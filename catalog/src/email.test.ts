import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPurchaseEmail, loadEmailConfig, sendPurchaseEmail } from './email.ts';

test('buildPurchaseEmail shows the key exactly once, with plan, expiry, and paste instructions', () => {
  const key = 'lp_testkey_abc123';
  const email = buildPurchaseEmail(
    { to: 'buyer@example.com', key, expiresAt: '2027-11-07T00:00:00.000Z' },
    'LibrePool <billing@librepool.com>',
  );
  assert.equal(email.to, 'buyer@example.com');
  assert.equal(email.from, 'LibrePool <billing@librepool.com>');
  assert.equal(email.subject.includes(key), false);
  assert.equal(email.text.split(key).length - 1, 1);
  assert.match(email.text, /\$19\/year/);
  assert.match(email.text, /2027-11-07/);
  assert.match(email.text, /Premium page/);
  assert.match(email.text, /\/api\/premium\/key/);
});

test('buildPurchaseEmail keeps an unparseable expiry as-is instead of crashing', () => {
  const email = buildPurchaseEmail(
    { to: 'buyer@example.com', key: 'lp_key_once', expiresAt: 'sometime' },
    'LibrePool <billing@librepool.com>',
  );
  assert.match(email.text, /sometime/);
});

test('loadEmailConfig defaults to the log transport; an unknown transport throws', () => {
  const defaults = loadEmailConfig({});
  assert.equal(defaults.transport, 'log');
  assert.equal(defaults.from, null);
  assert.equal(defaults.resendApiKey, null);
  assert.equal(defaults.resendApiUrl, 'https://api.resend.com/emails');
  assert.throws(() => loadEmailConfig({ EMAIL_TRANSPORT: 'smtp' }), /Unknown EMAIL_TRANSPORT/);
});

test('loadEmailConfig reads resend settings from env', () => {
  const cfg = loadEmailConfig({
    EMAIL_TRANSPORT: 'resend',
    EMAIL_FROM: 'LibrePool <billing@librepool.com>',
    RESEND_API_KEY: 're_test_key',
    RESEND_API_URL: 'https://email.example.test/send',
    EMAIL_REPLY_TO: 'support@librepool.com',
  });
  assert.equal(cfg.transport, 'resend');
  assert.equal(cfg.from, 'LibrePool <billing@librepool.com>');
  assert.equal(cfg.resendApiKey, 're_test_key');
  assert.equal(cfg.resendApiUrl, 'https://email.example.test/send');
  assert.equal(cfg.replyTo, 'support@librepool.com');
});

test('sendPurchaseEmail with the log transport writes to stdout and never calls fetch', async () => {
  const lines: unknown[] = [];
  const result = await sendPurchaseEmail(
    { transport: 'log', from: null, resendApiKey: null, resendApiUrl: 'https://api.resend.com/emails', replyTo: null },
    { to: 'buyer@example.com', key: 'lp_key_once', expiresAt: '2027-11-07T00:00:00.000Z' },
    {
      fetchFn: (async () => { throw new Error('fetch must not be called for the log transport'); }) as unknown as typeof fetch,
      log: (...args) => { lines.push(...args); },
    },
  );
  assert.equal(result.transport, 'log');
  assert.equal(result.messageId, undefined);
  assert.equal(lines.length, 1);
  assert.match(String(lines[0]), /To: buyer@example\.com/);
  assert.match(String(lines[0]), /lp_key_once/);
});

test('sendPurchaseEmail with the resend transport posts one request and returns the message id', async () => {
  const seen: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
  const fakeFetch = (async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    seen.push({ url, init });
    return {
      ok: true, status: 200,
      json: async () => ({ id: 're_123' }),
      text: async () => '',
    };
  }) as unknown as typeof fetch;
  const result = await sendPurchaseEmail(
    { transport: 'resend', from: 'LibrePool <billing@librepool.com>', resendApiKey: 're_test_key', resendApiUrl: 'https://api.resend.com/emails', replyTo: 'support@librepool.com' },
    { to: 'buyer@example.com', key: 'lp_key_once', expiresAt: '2027-11-07T00:00:00.000Z' },
    { fetchFn: fakeFetch },
  );
  assert.equal(result.transport, 'resend');
  assert.equal(result.messageId, 're_123');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.resend.com/emails');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer re_test_key');
  assert.equal(seen[0].init.headers['Content-Type'], 'application/json');
  const body = JSON.parse(seen[0].init.body) as Record<string, unknown>;
  assert.equal(body.from, 'LibrePool <billing@librepool.com>');
  assert.equal(body.to, 'buyer@example.com');
  assert.equal(body.subject, 'Your LibrePool live feed license key');
  assert.equal(body.reply_to, 'support@librepool.com');
  assert.equal(String(body.text).split('lp_key_once').length - 1, 1);
});

test('sendPurchaseEmail with the resend transport throws without RESEND_API_KEY or EMAIL_FROM', async () => {
  const neverFetch = (async () => { throw new Error('fetch must not be called'); }) as unknown as typeof fetch;
  await assert.rejects(
    sendPurchaseEmail(
      { transport: 'resend', from: 'LibrePool <billing@librepool.com>', resendApiKey: null, resendApiUrl: 'https://api.resend.com/emails', replyTo: null },
      { to: 'buyer@example.com', key: 'lp_key_once', expiresAt: '2027-11-07T00:00:00.000Z' },
      { fetchFn: neverFetch },
    ),
    /RESEND_API_KEY/,
  );
  await assert.rejects(
    sendPurchaseEmail(
      { transport: 'resend', from: null, resendApiKey: 're_test_key', resendApiUrl: 'https://api.resend.com/emails', replyTo: null },
      { to: 'buyer@example.com', key: 'lp_key_once', expiresAt: '2027-11-07T00:00:00.000Z' },
      { fetchFn: neverFetch },
    ),
    /EMAIL_FROM/,
  );
});

test('sendPurchaseEmail with the resend transport throws on a non-2xx response', async () => {
  const failingFetch = (async () => ({
    ok: false, status: 401,
    json: async () => ({}),
    text: async () => 'invalid api key',
  })) as unknown as typeof fetch;
  await assert.rejects(
    sendPurchaseEmail(
      { transport: 'resend', from: 'LibrePool <billing@librepool.com>', resendApiKey: 're_bad_key', resendApiUrl: 'https://api.resend.com/emails', replyTo: null },
      { to: 'buyer@example.com', key: 'lp_key_once', expiresAt: '2027-11-07T00:00:00.000Z' },
      { fetchFn: failingFetch },
    ),
    /HTTP 401.*invalid api key/,
  );
});
