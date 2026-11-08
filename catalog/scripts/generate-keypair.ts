/**
 * Generate a fresh Ed25519 keypair for the catalog feed.
 *
 * Usage: node scripts/generate-keypair.ts [--out <dir>] [--force]
 * Default output: catalog/dev-keys/ (git-ignored — the private key must
 * NEVER be committed; production keys live on the feed host only).
 *
 * Refuses to overwrite existing key files unless --force is passed.
 * Prints the public key PEM, its fingerprint, and the exact
 * PINNED_CATALOG_PUBKEY replacement snippet for
 * server/src/services/catalog-sync.ts.
 *
 * PRODUCTION WARNING: a production keypair must be generated ON the feed
 * host (or in the host's secret store), never on a dev machine, and the
 * private key must never leave the host, never be pasted into chat, and
 * never be committed. The default --out (catalog/dev-keys/) is for DEV
 * keys only. See catalog/docs/key-rotation.md for the full rotation flow.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeypair, keyFingerprint } from '../src/signing.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_ROOT = path.resolve(__dirname, '..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const outDir = path.resolve(arg('out') ?? path.join(CATALOG_ROOT, 'dev-keys'));
const force = process.argv.includes('--force');
const privatePath = path.join(outDir, 'signing-private.pem');
const publicPath = path.join(outDir, 'signing-public.pem');

const existing = [privatePath, publicPath].filter((p) => fs.existsSync(p));
if (existing.length > 0 && !force) {
  console.error(`error: refusing to overwrite existing key file(s):\n  ${existing.join('\n  ')}`);
  console.error('Pass --force to overwrite (the old keypair will be destroyed — only do this');
  console.error('if the old key was never pinned anywhere, or after completing a key rotation).');
  process.exit(1);
}
if (existing.length > 0 && force) {
  console.error(`WARNING: --force passed; overwriting ${existing.join(', ')}.`);
}

fs.mkdirSync(outDir, { recursive: true });
const { publicPem, privatePem } = generateKeypair();
fs.writeFileSync(privatePath, privatePem, { mode: 0o600 });
fs.writeFileSync(publicPath, publicPem, { mode: 0o644 });
const fingerprint = keyFingerprint(publicPem);
console.log(`Wrote keypair to ${outDir}/`);
console.log(`Public key fingerprint: ${fingerprint}`);
console.log('');
console.log('Public key (paste into PINNED_CATALOG_PUBKEY in server/src/services/catalog-sync.ts):');
console.log(publicPem.trim());
console.log('');
console.log('Exact replacement snippet for server/src/services/catalog-sync.ts:');
console.log('const PINNED_CATALOG_PUBKEY = `');
console.log(publicPem.trim());
console.log('`;');
console.log(`// Fingerprint: ${fingerprint} — compare it with the fingerprint printed by the`);
console.log('// feed service at startup (or by keyFingerprint()) before deploying the router.');
console.log('');
console.log('WARNING: the private key must never be committed or leave the feed host.');
console.log('For PRODUCTION, generate the keypair ON the feed host (or in its secret store),');
console.log('never on a dev machine — a key generated here is a DEV key only. See');
console.log('catalog/docs/key-rotation.md for the full rotation flow.');
