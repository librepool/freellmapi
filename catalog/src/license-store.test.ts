import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LicenseStore } from './license-store.ts';

function tmpStore(): { store: LicenseStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'librepool-licenses-'));
  return { store: new LicenseStore(path.join(dir, 'licenses.json')), dir };
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

test('the store file never contains a plaintext key (hashes only)', () => {
  const { store, dir } = tmpStore();
  const { key } = store.issue();
  const raw = fs.readFileSync(path.join(dir, 'licenses.json'), 'utf8');
  assert.equal(raw.includes(key), false);
  assert.equal(raw.includes('lp_'), false);
});

test('store reloads from disk (issue in one instance, activate in another)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'librepool-licenses-'));
  const file = path.join(dir, 'licenses.json');
  const { key } = new LicenseStore(file).issue();
  assert.equal(new LicenseStore(file).activate(key).valid, true);
});
