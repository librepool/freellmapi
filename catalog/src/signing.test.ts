import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { generateKeypair, signBytes, verifyBytes } from './signing.ts';

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
