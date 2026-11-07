/**
 * License store — file-backed JSON, dev-only.
 *
 * Production needs a real store (Postgres/SQLite with a proper schema, keyed
 * lookups, and an audit trail). This MVP keeps the contract small: keys are
 * stored ONLY as SHA-256 hashes, never in plaintext, so a leaked store file
 * does not leak usable keys. License keys are issued by the Stripe checkout
 * flow (see stripe.ts); this store only records and validates them.
 *
 * Key format: `lp_` + 32 random bytes, base64url (43 chars).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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

export function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key.trim()).digest('hex');
}

export function generateLicenseKey(): string {
  return `lp_${crypto.randomBytes(32).toString('base64url')}`;
}

export class LicenseStore {
  private records = new Map<string, LicenseRecord>();
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const r of parsed as LicenseRecord[]) {
          if (r?.keyHash) this.records.set(r.keyHash, r);
        }
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') throw err;
      // No store yet: start empty; the file is created on first issue.
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.records.values()], null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
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
    this.records.set(record.keyHash, record);
    this.save();
    return { key, record };
  }

  find(key: string): LicenseRecord | null {
    // Re-read the file on every lookup: keys may be issued by another
    // process (e.g. the Stripe webhook handler) after this instance started.
    // load() merges file records into the map; it never drops in-memory ones.
    this.load();
    return this.records.get(hashKey(key)) ?? null;
  }

  /** Test/ops helper: insert a record with a known key. */
  insertForTest(key: string, record: Omit<LicenseRecord, 'keyHash'>): void {
    this.records.set(hashKey(key), { ...record, keyHash: hashKey(key) });
    this.save();
  }

  setStatus(key: string, status: LicenseStatusValue): boolean {
    const rec = this.find(key);
    if (!rec) return false;
    rec.status = status;
    this.save();
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

  get size(): number {
    return this.records.size;
  }
}
