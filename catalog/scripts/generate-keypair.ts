/**
 * Generate a fresh Ed25519 keypair for the catalog feed.
 *
 * Usage: node scripts/generate-keypair.ts [--out <dir>]
 * Default output: catalog/dev-keys/ (git-ignored — the private key must
 * NEVER be committed; production keys live on the feed host only).
 * Prints the public key PEM: paste it into PINNED_CATALOG_PUBKEY in
 * server/src/services/catalog-sync.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeypair } from '../src/signing.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_ROOT = path.resolve(__dirname, '..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const outDir = path.resolve(arg('out') ?? path.join(CATALOG_ROOT, 'dev-keys'));
fs.mkdirSync(outDir, { recursive: true });
const { publicPem, privatePem } = generateKeypair();
fs.writeFileSync(path.join(outDir, 'signing-private.pem'), privatePem, { mode: 0o600 });
fs.writeFileSync(path.join(outDir, 'signing-public.pem'), publicPem, { mode: 0o644 });
console.log(`Wrote keypair to ${outDir}/`);
console.log('Public key (paste into PINNED_CATALOG_PUBKEY in server/src/services/catalog-sync.ts):');
console.log(publicPem);
console.log('WARNING: the private key must never be committed or leave the feed host.');
