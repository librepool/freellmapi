import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { hashKey, LicenseStore, type LicenseRecord } from './license-store.ts';

function tmpStore(): { store: LicenseStore; dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'librepool-licenses-'));
  const file = path.join(dir, 'licenses.db');
  return { store: new LicenseStore(file), dir, file };
}

/** Read the audit trail straight from the SQLite file (test-only access). */
function auditEvents(file: string): Array<{ key_hash: string; event: string; detail: string | null }> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT key_hash, event, detail FROM license_events ORDER BY id').all() as Array<{
      key_hash: string; event: string; detail: string | null;
    }>;
  } finally {
    db.close();
  }
}

test('issue → activate returns a valid annual license', () => {
  const { store } = tmpStore();
  const { key } = store.issue();
  assert.match(key, /^lp_/);
  const a = store.activate(key);
  assert.equal(a.valid, true);
  assert.equal(a.plan, 'annual');
  assert.equal(a.status, 'active');
  assert.ok(Date.parse(a.expiresAt!) > Date.now());
});

test('unknown key → unknown_key, expired → expired, canceled → canceled', () => {
  const { store } = tmpStore();
  assert.deepEqual(store.activate('lp_nope'), { valid: false, plan: null, status: null, expiresAt: null, reason: 'unknown_key' });
  store.insertForTest('lp_expired', {
    plan: 'annual', status: 'active',
    expiresAt: new Date(Date.now() - 1000).toISOString(), createdAt: new Date().toISOString(),
  });
  assert.equal(store.activate('lp_expired').reason, 'expired');
  assert.equal(store.activate('lp_expired').valid, false);
  const { key } = store.issue();
  assert.equal(store.setStatus(key, 'canceled'), true);
  assert.equal(store.activate(key).reason, 'canceled');
});

test('check() returns a LicenseStatus with checkedAtMs', () => {
  const { store } = tmpStore();
  const { key } = store.issue();
  const s = store.check(key);
  assert.equal(s.valid, true);
  assert.equal(s.plan, 'annual');
  assert.equal(typeof s.checkedAtMs, 'number');
  const unknown = store.check('lp_nope');
  assert.equal(unknown.valid, false);
  assert.equal(unknown.reason, 'unknown_key');
});

test('check() reflects cancelAtPeriodEnd', () => {
  const { store } = tmpStore();
  const { key } = store.issue();
  assert.equal(store.check(key).cancelAtPeriodEnd, undefined);
  const sub = 'sub_cancel_test';
  const issued = store.issue({ stripeCustomerId: 'cus_1', stripeSubscriptionId: sub });
  assert.equal(store.updateBySubscription(sub, { cancelAtPeriodEnd: true }), true);
  assert.equal(store.check(issued.key).cancelAtPeriodEnd, true);
  assert.equal(store.check(issued.key).valid, true);
});

test('the store file never contains a plaintext key (hashes only)', () => {
  const { store, file } = tmpStore();
  const { key } = store.issue();
  const raw = fs.readFileSync(file);
  assert.equal(raw.includes(Buffer.from(key, 'utf8')), false);
  assert.equal(raw.includes(Buffer.from('lp_', 'utf8')), false);
  // …but the hash is there.
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('SELECT key_hash FROM licenses').get() as { key_hash: string };
    assert.equal(row.key_hash, hashKey(key));
  } finally {
    db.close();
  }
});

test('store reloads from disk (issue in one instance, activate in another)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'librepool-licenses-'));
  const file = path.join(dir, 'licenses.db');
  const { key } = new LicenseStore(file).issue();
  assert.equal(new LicenseStore(file).activate(key).valid, true);
});

test('opening a legacy JSON store refuses with a migration hint, file untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'librepool-licenses-'));
  const file = path.join(dir, 'licenses.json');
  const legacy: LicenseRecord[] = [{
    keyHash: 'deadbeef', plan: 'annual', status: 'active',
    expiresAt: new Date(Date.now() + 1000).toISOString(), createdAt: new Date().toISOString(),
  }];
  fs.writeFileSync(file, JSON.stringify(legacy, null, 2));
  assert.throws(() => new LicenseStore(file), /legacy JSON store.*migrate-licenses/i);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), legacy);
});

test('issue records an audit event; setStatus appends cancel/activate events', () => {
  const { store, file } = tmpStore();
  const { key, record } = store.issue();
  assert.deepEqual(
    auditEvents(file).map((e) => e.event),
    ['issue'],
  );
  assert.equal(store.setStatus(key, 'canceled'), true);
  assert.equal(store.setStatus('lp_nope', 'canceled'), false);
  assert.equal(store.setStatus(key, 'active'), true);
  assert.deepEqual(
    auditEvents(file).map((e) => [e.event, e.key_hash]),
    [['issue', record.keyHash], ['cancel', record.keyHash], ['activate', record.keyHash]],
  );
  // activate()/check() are read-only validations: no audit rows for them.
  store.activate(key);
  store.check(key);
  assert.equal(auditEvents(file).length, 3);
});

test('findByStripeSubscriptionId / findByStripeCustomerId round-trip', () => {
  const { store } = tmpStore();
  assert.equal(store.findByStripeSubscriptionId('sub_nope'), null);
  assert.equal(store.findByStripeCustomerId('cus_nope'), null);
  const first = store.issue({ stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' });
  const second = store.issue({ stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_2' });
  assert.equal(store.findByStripeSubscriptionId('sub_1')?.keyHash, first.record.keyHash);
  assert.equal(store.findByStripeSubscriptionId('sub_2')?.keyHash, second.record.keyHash);
  // Same customer, two subscriptions: the most recently created wins.
  assert.equal(store.findByStripeCustomerId('cus_1')?.keyHash, second.record.keyHash);
});

test('updateBySubscription patches status/expiry/cancel flag and audits', () => {
  const { store, file } = tmpStore();
  const { key, record } = store.issue({ stripeCustomerId: 'cus_9', stripeSubscriptionId: 'sub_9' });
  assert.equal(store.updateBySubscription('sub_nope', { status: 'canceled' }), false);
  const newExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(
    store.updateBySubscription('sub_9', { status: 'canceled', cancelAtPeriodEnd: true, expiresAt: newExpiry }),
    true,
  );
  const updated = store.findByStripeSubscriptionId('sub_9')!;
  assert.equal(updated.status, 'canceled');
  assert.equal(updated.cancelAtPeriodEnd, true);
  assert.equal(updated.expiresAt, newExpiry);
  assert.equal(store.activate(key).reason, 'canceled');
  const events = auditEvents(file).filter((e) => e.key_hash === record.keyHash);
  assert.deepEqual(events.map((e) => e.event), ['issue', 'cancel']);
  assert.match(events[1].detail ?? '', /"status":"canceled"/);
  // Empty patch on a matching subscription is a no-op that still returns true.
  assert.equal(store.updateBySubscription('sub_9', {}), true);
  assert.equal(auditEvents(file).length, 2);
});

test('size counts stored licenses', () => {
  const { store } = tmpStore();
  assert.equal(store.size, 0);
  store.issue();
  store.issue();
  assert.equal(store.size, 2);
});
