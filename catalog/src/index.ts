/**
 * Entrypoint for the LibrePool catalog feed service.
 *
 * Loads .env (if present, no dependency — tiny inline parser), the seed
 * catalog, the license store, and the Ed25519 signing key, then serves.
 * See catalog/README.md for how to run it and point a dev router at it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CatalogStore, loadSeed } from './catalog-store.ts';
import { LicenseStore } from './license-store.ts';
import { startFeedService } from './server.ts';
import { loadPrivateKey, publicKeyPem } from './signing.ts';
import { loadStripeConfig, stripeIsConfigured } from './stripe.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_ROOT = path.resolve(__dirname, '..');

function loadDotEnv(): void {
  const envPath = path.join(CATALOG_ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(name in process.env)) process.env[name] = value;
  }
}

function resolvePath(value: string | undefined, fallback: string): string {
  const raw = value ?? fallback;
  return path.isAbsolute(raw) ? raw : path.join(CATALOG_ROOT, raw);
}

function main(): void {
  loadDotEnv();
  const seedPath = resolvePath(process.env.CATALOG_SEED_PATH, './data/seed-catalog.json');
  const licensePath = resolvePath(process.env.CATALOG_LICENSE_DB_PATH, './data/licenses.json');
  const catalogStore = new CatalogStore(loadSeed(seedPath));
  const licenseStore = new LicenseStore(licensePath);
  const privateKey = loadPrivateKey();
  const stripeConfig = loadStripeConfig();
  const port = Number(process.env.CATALOG_PORT ?? 8080);
  const host = process.env.CATALOG_HOST ?? '127.0.0.1';
  console.log(`[catalog] signing public key:\n${publicKeyPem(privateKey).trim()}`);
  console.log(`[catalog] seed: ${seedPath} (v${catalogStore.version}), licenses: ${licenseStore.size} key(s) in store`);
  console.log(`[catalog] stripe: ${stripeIsConfigured(stripeConfig) ? 'configured' : 'NOT configured (checkout/portal/webhook return not_configured)'}`);
  startFeedService({ catalogStore, licenseStore, privateKey, stripeConfig }, port, host);
}

main();
