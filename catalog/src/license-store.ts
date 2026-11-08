/**
 * License store — SQLite-backed (Node's built-in `node:sqlite`).
 *
 * Durable store for a small feed service: a single SQLite file (WAL mode),
 * keyed lookups, and an append-only audit trail. Zero new dependencies —
 * `node:sqlite` ships with Node (unflagged since 22.13.0 / 23.4.0) and
 * `@types/node` already covers it, so the `engines` floor moves from
 * `>=20.18.0` to `>=22.13.0` (see catalog/docs/license-store.md).
 *
 * Keys are stored ONLY as SHA-256 hashes, never in plaintext, so a leaked
 * store file does not leak usable keys. License keys are issued by the
 * Stripe checkout flow (see stripe.ts); this store only records and
 * validates them.
 *
 * Key format: `lp_` + 32 random bytes, base64url (43 chars).
 *
 * The store file lives at CATALOG_LICENSE_DB_PATH (default
 * `./data/licenses.db` — set in src/index.ts). The file is created on
 * first use; its `-wal` / `-shm` sidecars live next to it. If the path
 * still holds the legacy JSON store, the constructor refuses to open it
 * and points at the migration script instead of silently corrupting it.
 *
 * Audit trail (`license_events`): every state transition is appended —
 * `issue` on issue(), `activate` / `cancel` / `expire` / `refund` on
 * setStatus() / updateBySubscription() when the status moves to that
 * value, `update` on a subscription patch with no status change, `import`
 * on rows brought in by scripts/migrate-licenses.ts. `activate()` /
 * `check()` are read-only validations and are NOT audited — they run on
 * every catalog fetch, so logging them would flood the table. The audited
 * `activate` event is the status transition back to `active`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { LicenseActivation, LicensePlan, LicenseStatus, LicenseStatusValue } from './types.ts';

export interface LicenseRecord {
  keyHash: string;
  plan: LicensePlan;
  status: LicenseStatusValue;
  expiresAt: string;
  createdAt: string;
  cancelAtPeriodEnd?: boolean;
  /** Stripe customer/subscription ids, when issued through checkout. */
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
}

/** Event names recorded in the append-only `license_events` audit table. */
export type LicenseEventName = 'issue' | 'activate' | 'cancel' | 'expire' | 'refund' | 'update' | 'import';

/**
 * The store schema, shared with scripts/migrate-licenses.ts so the
 * migration creates exactly the tables this store expects.
 */
export const LICENSE_STORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS licenses (
  key_hash TEXT PRIMARY KEY,
  plan TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_licenses_stripe_subscription_id
  ON licenses (stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_licenses_stripe_customer_id
  ON licenses (stripe_customer_id);
CREATE TABLE IF NOT EXISTS license_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash TEXT NOT NULL,
  event TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_license_events_key_hash
  ON license_events (key_hash);
`;

interface LicenseRow {
  key_hash: string;
  plan: string;
  status: string;
  expires_at: string;
  created_at: string;
  cancel_at_period_end: number;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
}

function statusToEvent(status: LicenseStatusValue): LicenseEventName {
  switch (status) {
    case 'active': return 'activate';
    case 'canceled': return 'cancel';
    case 'expired': return 'expire';
    case 'refunded': return 'refund';
  }
}

export function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key.trim()).digest('hex');
}

export function generateLicenseKey(): string {
  return `lp_${crypto.randomBytes(32).toString('base64url')}`;
}

export class LicenseStore {
  private db: DatabaseSync;
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Refuse to open the legacy JSON store as a database: a JSON file at
    // this path means the operator has not migrated yet. Point at the
    // migration script instead of letting SQLite throw a bare error (or
    // worse, overwriting the backup).
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(1024);
        const n = fs.readSync(fd, buf, 0, 1024, 0);
        const head = buf.subarray(0, n).toString('utf8').trimStart();
        if (head.startsWith('[') || head.startsWith('{')) {
          throw new Error(
            `License store at ${filePath} looks like the legacy JSON store, not a SQLite database. ` +
              `Migrate it first (the JSON file is left untouched as a backup): ` +
              `node scripts/migrate-licenses.ts --from ${filePath} --to ./data/licenses.db, ` +
              `then point CATALOG_LICENSE_DB_PATH at the .db file.`,
          );
        }
      } finally {
        fs.closeSync(fd);
      }
    }
    this.db = new DatabaseSync(filePath);
    try {
      // WAL: readers never block the writer (the HTTP handler and a
      // webhook/ops process may hold separate connections), and a crash
      // cannot tear a half-written row. FULL synchronous keeps the
      // durability the old atomic-rename JSON store had.
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
      this.db.exec(LICENSE_STORE_SCHEMA);
    } catch (err) {
      if (err instanceof Error && /file is not a database/i.test(err.message)) {
        throw new Error(
          `License store at ${filePath} is not a SQLite database — it may be the legacy JSON store. ` +
            `Migrate it first: node scripts/migrate-licenses.ts --from ${filePath} --to ./data/licenses.db.`,
        );
      }
      throw err;
    }
  }

  private inTransaction(fn: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Rollback failing means the connection is already unusable;
        // surface the original error.
      }
      throw err;
    }
  }

  private rowToRecord(row: LicenseRow): LicenseRecord {
    return {
      keyHash: row.key_hash,
      plan: row.plan as LicensePlan,
      status: row.status as LicenseStatusValue,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      ...(row.cancel_at_period_end === 1 ? { cancelAtPeriodEnd: true } : {}),
      ...(row.stripe_customer_id !== null ? { stripeCustomerId: row.stripe_customer_id } : {}),
      ...(row.stripe_subscription_id !== null ? { stripeSubscriptionId: row.stripe_subscription_id } : {}),
    };
  }

  private findByHash(keyHash: string): LicenseRecord | null {
    const row = this.db
      .prepare('SELECT * FROM licenses WHERE key_hash = ?')
      .get(keyHash) as unknown as LicenseRow | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  private audit(keyHash: string, event: LicenseEventName, detail?: string): void {
    this.db
      .prepare('INSERT INTO license_events (key_hash, event, detail, created_at) VALUES (?, ?, ?, ?)')
      .run(keyHash, event, detail ?? null, new Date().toISOString());
  }

  /** Issue a new annual license (1 year from now). Returns the plaintext key
   *  ONCE — the caller must deliver it to the buyer (purchase email) and
   *  never store it again. */
  issue(opts: { stripeCustomerId?: string; stripeSubscriptionId?: string; expiresAt?: string } = {}): { key: string; record: LicenseRecord } {
    const key = generateLicenseKey();
    const now = new Date();
    const expires = opts.expiresAt ?? new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const record: LicenseRecord = {
      keyHash: hashKey(key),
      plan: 'annual',
      status: 'active',
      expiresAt: expires,
      createdAt: now.toISOString(),
      ...opts.stripeCustomerId ? { stripeCustomerId: opts.stripeCustomerId } : {},
      ...opts.stripeSubscriptionId ? { stripeSubscriptionId: opts.stripeSubscriptionId } : {},
    };
    this.inTransaction(() => {
      this.db
        .prepare(
          'INSERT INTO licenses (key_hash, plan, status, expires_at, created_at, cancel_at_period_end, stripe_customer_id, stripe_subscription_id) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          record.keyHash, record.plan, record.status, record.expiresAt, record.createdAt,
          0, record.stripeCustomerId ?? null, record.stripeSubscriptionId ?? null,
        );
      this.audit(record.keyHash, 'issue');
    });
    return { key, record };
  }

  find(key: string): LicenseRecord | null {
    // SQLite is the shared store: every query reads committed data, so a
    // key issued by another process (e.g. the Stripe webhook handler) is
    // visible immediately with no re-read dance.
    return this.findByHash(hashKey(key));
  }

  /** Test/ops helper: insert a record with a known key. Upserts; writes no
   *  audit event (it is a test fixture, not a real transition). */
  insertForTest(key: string, record: Omit<LicenseRecord, 'keyHash'>): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO licenses (key_hash, plan, status, expires_at, created_at, cancel_at_period_end, stripe_customer_id, stripe_subscription_id) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        hashKey(key), record.plan, record.status, record.expiresAt, record.createdAt,
        record.cancelAtPeriodEnd ? 1 : 0, record.stripeCustomerId ?? null, record.stripeSubscriptionId ?? null,
      );
  }

  setStatus(key: string, status: LicenseStatusValue): boolean {
    const rec = this.find(key);
    if (!rec) return false;
    this.inTransaction(() => {
      this.db.prepare('UPDATE licenses SET status = ? WHERE key_hash = ?').run(status, rec.keyHash);
      this.audit(rec.keyHash, statusToEvent(status));
    });
    return true;
  }

  activate(key: string): LicenseActivation {
    const rec = this.find(key);
    if (!rec) return { valid: false, plan: null, status: null, expiresAt: null, reason: 'unknown_key' };
    if (rec.status === 'canceled') return { valid: false, plan: rec.plan, status: 'canceled', expiresAt: rec.expiresAt, reason: 'canceled' };
    if (rec.status === 'refunded') return { valid: false, plan: rec.plan, status: 'refunded', expiresAt: rec.expiresAt, reason: 'refunded' };
    if (rec.status === 'expired' || Date.parse(rec.expiresAt) <= Date.now()) {
      return { valid: false, plan: rec.plan, status: 'expired', expiresAt: rec.expiresAt, reason: 'expired' };
    }
    return { valid: true, plan: rec.plan, status: 'active', expiresAt: rec.expiresAt };
  }

  check(key: string): LicenseStatus {
    const base: LicenseStatus = {
      valid: false, plan: null, status: null, expiresAt: null, checkedAtMs: Date.now(),
    };
    const rec = this.find(key);
    if (!rec) return { ...base, reason: 'unknown_key' };
    const activation = this.activate(key);
    return {
      valid: activation.valid,
      plan: activation.plan,
      status: activation.status,
      expiresAt: activation.expiresAt,
      ...(rec.cancelAtPeriodEnd ? { cancelAtPeriodEnd: true } : {}),
      ...(activation.reason ? { reason: activation.reason } : {}),
      checkedAtMs: Date.now(),
    };
  }

  /** Stripe webhook lookup: the license issued for a subscription. */
  findByStripeSubscriptionId(subscriptionId: string): LicenseRecord | null {
    const row = this.db
      .prepare('SELECT * FROM licenses WHERE stripe_subscription_id = ? LIMIT 1')
      .get(subscriptionId) as unknown as LicenseRow | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  /** Stripe webhook lookup: the most recently issued license for a
   *  customer (a customer re-subscribing gets a fresh key; insertion
   *  order — `rowid` — is the recency signal, since `created_at` only
   *  has millisecond resolution and two issues can share a timestamp). */
  findByStripeCustomerId(customerId: string): LicenseRecord | null {
    const row = this.db
      .prepare('SELECT * FROM licenses WHERE stripe_customer_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(customerId) as unknown as LicenseRow | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  /**
   * Stripe webhook update: apply a subscription change to the license
   * issued for it and append an audit event. Only the fields present in
   * `patch` change; an empty patch is a no-op. Returns false when no
   * license matches the subscription id.
   */
  updateBySubscription(
    subscriptionId: string,
    patch: { status?: LicenseStatusValue; cancelAtPeriodEnd?: boolean; expiresAt?: string },
  ): boolean {
    const rec = this.findByStripeSubscriptionId(subscriptionId);
    if (!rec) return false;
    const sets: string[] = [];
    const values: (string | number)[] = [];
    if (patch.status !== undefined) {
      sets.push('status = ?');
      values.push(patch.status);
    }
    if (patch.cancelAtPeriodEnd !== undefined) {
      sets.push('cancel_at_period_end = ?');
      values.push(patch.cancelAtPeriodEnd ? 1 : 0);
    }
    if (patch.expiresAt !== undefined) {
      sets.push('expires_at = ?');
      values.push(patch.expiresAt);
    }
    if (sets.length === 0) return true;
    const event: LicenseEventName = patch.status !== undefined ? statusToEvent(patch.status) : 'update';
    this.inTransaction(() => {
      this.db
        .prepare(`UPDATE licenses SET ${sets.join(', ')} WHERE key_hash = ?`)
        .run(...values, rec.keyHash);
      this.audit(rec.keyHash, event, JSON.stringify(patch));
    });
    return true;
  }

  get size(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM licenses').get() as unknown as { n: number };
    return row.n;
  }
}
