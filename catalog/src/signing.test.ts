import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { generateKeypair, keyFingerprint, signBytes, verifyBytes } from './signing.ts';

function privateKeyOf(pem: string): crypto.KeyObject {
  return crypto.createPrivateKey({ key: pem, format: 'pem' });
}

test('signature round-trip: sign then verify with the public key', () => {
  const { publicPem, privatePem } = generateKeypair();
  const bytes = Buffer.from(JSON.stringify({ version: '2026.11.06', tier: 'monthly' }));
  const sig = signBytes(privateKeyOf(privatePem), bytes);
  assert.equal(verifyBytes(publicPem, bytes, sig), true);
});

test('tampered bytes fail verification', () => {
  const { publicPem, privatePem } = generateKeypair();
  const bytes = Buffer.from('{"version":"2026.11.06"}');
  const sig = signBytes(privateKeyOf(privatePem), bytes);
  assert.equal(verifyBytes(publicPem, Buffer.from('{"version":"2026.11.07"}'), sig), false);
});

test('signature from a different key fails verification', () => {
  const a = generateKeypair();
  const b = generateKeypair();
  const bytes = Buffer.from('catalog-bytes');
  const sig = signBytes(privateKeyOf(a.privatePem), bytes);
  assert.equal(verifyBytes(b.publicPem, bytes, sig), false);
  assert.notEqual(a.publicPem, b.publicPem);
});

test('keyFingerprint is 16 lowercase hex chars, stable per key, distinct per key', () => {
  const a = generateKeypair();
  const b = generateKeypair();
  const fpA = keyFingerprint(a.publicPem);
  assert.match(fpA, /^[0-9a-f]{16}$/);
  assert.equal(keyFingerprint(a.publicPem), fpA);
  assert.notEqual(keyFingerprint(b.publicPem), fpA);
});

test('keyFingerprint is the first 16 hex chars of SHA-256 over the SPKI DER', () => {
  const { publicPem } = generateKeypair();
  const der = crypto.createPublicKey({ key: publicPem, format: 'pem' }).export({ type: 'spki', format: 'der' });
  const expected = crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
  assert.equal(keyFingerprint(publicPem), expected);
});
