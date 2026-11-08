/**
 * Ed25519 signing for the catalog feed.
 *
 * The router verifies `x-catalog-signature` (base64 Ed25519 over the exact
 * response bytes) against the pinned public key in
 * server/src/services/catalog-sync.ts. The private key lives on the feed host
 * only: locally it is catalog/dev-keys/signing-private.pem (git-ignored, see
 * catalog/README.md); in production it comes from the host's secret store via
 * CATALOG_SIGNING_PRIVATE_KEY_PEM or CATALOG_SIGNING_KEY_PATH.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

export function loadPrivateKey(): crypto.KeyObject {
  const inline = process.env.CATALOG_SIGNING_PRIVATE_KEY_PEM;
  if (inline) {
    return crypto.createPrivateKey({ key: inline.replace(/\\n/g, '\n'), format: 'pem' });
  }
  const path = process.env.CATALOG_SIGNING_KEY_PATH ?? './dev-keys/signing-private.pem';
  const pem = fs.readFileSync(path, 'utf8');
  return crypto.createPrivateKey({ key: pem, format: 'pem' });
}

export function publicKeyPem(privateKey: crypto.KeyObject): string {
  return crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
}

export function signBytes(privateKey: crypto.KeyObject, bytes: Buffer): string {
  return crypto.sign(null, bytes, privateKey).toString('base64');
}

export function verifyBytes(publicKeyPemString: string, bytes: Buffer, signatureB64: string): boolean {
  const key = crypto.createPublicKey({ key: publicKeyPemString, format: 'pem' });
  return crypto.verify(null, bytes, key, Buffer.from(signatureB64, 'base64'));
}

/** Generate a fresh Ed25519 keypair (used by scripts/generate-keypair.ts). */
export function generateKeypair(): { publicPem: string; privatePem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/**
 * Fingerprint of a public key: first 16 hex chars of the SHA-256 of the
 * SPKI DER encoding. Printed by scripts/generate-keypair.ts so the
 * operator can confirm the router pins the intended key without pasting
 * the whole PEM into chat or logs. A fingerprint is not a secret, but it
 * is not a substitute for comparing the full PEM either — always compare
 * the PEM itself when rotating a production key.
 */
export function keyFingerprint(publicPem: string): string {
  const key = crypto.createPublicKey({ key: publicPem, format: 'pem' });
  const der = key.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
}
