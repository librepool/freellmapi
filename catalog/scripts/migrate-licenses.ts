/**
 * Migrate the legacy JSON license store into the SQLite store.
 *
 * One-way and idempotent: rows whose key_hash is already in the SQLite
 * database are skipped, so re-running the script after a partial import
 * (or a second time by accident) is safe. The JSON file is only ever
 * READ — it is never modified or deleted, and stays in place as a backup
 * until the operator removes it by hand.
 *
 * Usage:
 *   node scripts/migrate-licenses.ts [--from <legacy json>] [--to <sqlite db>]
 *
 * Defaults: --from catalog/data/licenses.json,
 *   --to $CATALOG_LICENSE_DB_PATH or catalog/data/licenses.db.
 *
 * Hashes, statuses, expiry dates, and Stripe ids are copied verbatim —
 * nothing is re-hashed (the JSON store already holds SHA-256 hashes, not
 * plaintext keys). Each imported row gets an `import` audit event so the
 * trail shows where it came from.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { LICENSE_STORE_SCHEMA, type LicenseRecord } from '../src/license-store.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_ROOT = path.resolve(__dirname, '..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function resolvePath(value: string): string {
  return path.isAbsolute(value) ? value : path.join(CATALOG_ROOT, value);
}

const fromPath = resolvePath(arg('from') ?? './data/licenses.json');
const toPath = resolvePath(arg('to') ?? process.env.CATALOG_LICENSE_DB_PATH ?? './data/licenses.db');

if (fromPath === toPath) {
  console.error('error: --from and --to point at the same file; refusing to migrate a file into itself.');
  process.exit(1);
}

if (!fs.existsSync(fromPath)) {
  console.log(`No legacy JSON store at ${fromPath}; nothing to import.`);
  process.exit(0);
}

const parsed: unknown = JSON.parse(fs.readFileSync(fromPath, 'utf8'));
if (!Array.isArray(parsed)) {
  console.error(`error: ${fromPath} is not a JSON array of license records; refusing to import.`);
  process.exit(1);
}

function isRecord(value: unknown): value is LicenseRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<LicenseRecord>;
  return typeof r.keyHash === 'string' && r.keyHash.length > 0
    && typeof r.expiresAt === 'string' && r.expiresAt.length > 0;
}

fs.mkdirSync(path.dirname(toPath), { recursive: true });
const db = new DatabaseSync(toPath);
try {
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
  db.exec(LICENSE_STORE_SCHEMA);
} catch (err) {
  if (err instanceof Error && /file is not a database/i.test(err.message)) {
    console.error(
      `error: target ${toPath} is not a SQLite database — it may itself be the legacy JSON store. ` +
        `Pick a different --to path (e.g. ./data/licenses.db).`,
    );
    process.exit(1);
  }
  throw err;
}

const insert = db.prepare(
  'INSERT OR IGNORE INTO licenses ' +
  '(key_hash, plan, status, expires_at, created_at, cancel_at_period_end, stripe_customer_id, stripe_subscription_id) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
);
const audit = db.prepare(
  "INSERT INTO license_events (key_hash, event, detail, created_at) VALUES (?, 'import', ?, ?)",
);

let imported = 0;
let skipped = 0;
let invalid = 0;
for (const entry of parsed as unknown[]) {
  if (!isRecord(entry)) {
    invalid += 1;
    continue;
  }
  const result = insert.run(
    entry.keyHash,
    entry.plan ?? 'annual',
    entry.status ?? 'active',
    entry.expiresAt,
    entry.createdAt ?? new Date().toISOString(),
    entry.cancelAtPeriodEnd ? 1 : 0,
    entry.stripeCustomerId ?? null,
    entry.stripeSubscriptionId ?? null,
  );
  if (Number(result.changes) === 1) {
    imported += 1;
    audit.run(entry.keyHash, 'migrated from legacy JSON store', new Date().toISOString());
  } else {
    skipped += 1;
  }
}

console.log(`Migrated ${imported} license(s) from ${fromPath} into ${toPath}.`);
console.log(`Skipped ${skipped} already present, ignored ${invalid} malformed record(s).`);
console.log(`The JSON file was not modified or deleted; it remains as a backup at ${fromPath}.`);
