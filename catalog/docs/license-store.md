# License store

The feed service's license store is SQLite, via Node's built-in
`node:sqlite` (`catalog/src/license-store.ts`). It replaced the dev-only
JSON file store in the feed-service productionization pass.

## Why SQLite (and why not the alternatives)

| Option | Verdict |
|---|---|
| `node:sqlite` (built-in) | **Chosen.** Zero new dependencies, single self-contained file, WAL mode, synchronous API that matches the store's existing sync callers in `server.ts`. The feed service has a handful of licenses, not thousands of writes/sec — SQLite is far past sufficient. |
| JSON file (previous store) | Replaced. Whole-file rewrite on every issue, no keyed lookups, no audit trail, and a torn write on crash. Fine for a dev stub, not for a service that takes money. |
| Postgres | Overkill for this service: another host, another credential, another backup story, for a table that will hold tens of rows. Revisit if the feed service ever outgrows a single host (multi-instance writes, or license volume in the six figures). |
| `better-sqlite3` / `node-sqlite3` | Same engine, extra dependency. `better-sqlite3` is a native addon (needs a rebuild per Node version, which is exactly the kind of deploy friction this service avoids); `node:sqlite` is already in the runtime. |

`node:sqlite` needs no flag on Node ≥ 22.13.0 (unflagged since 22.13.0 /
23.4.0; added in 22.5.0 behind `--experimental-sqlite`). The package
`engines` floor therefore rises from `>=20.18.0` to `>=22.13.0` —
`catalog/package.json` still says `>=20.18.0` and must be updated by the
coordinator. The VM runs Node 24.22.1, verified working.

## File location and env

`CATALOG_LICENSE_DB_PATH`, default `./data/licenses.db` (set in
`src/index.ts`; the old default was `./data/licenses.json`). The file plus
its `-wal` / `-shm` sidecars live in `catalog/data/` and are git-ignored
(`*.db` in the repo root `.gitignore`). **Back up all three files
together** (or checkpoint first: `sqlite3 licenses.db "PRAGMA
wal_checkpoint(TRUNCATE);"` then copy the `.db` alone). Never copy the
`.db` file while the service is running without checkpointing — a bare
`.db` copy can be missing the newest committed rows still sitting in the
WAL.

Pragmas set on open: `journal_mode = WAL` (readers never block the
writer — the HTTP handler and a webhook/ops process may hold separate
connections), `synchronous = FULL` (the durability the old
atomic-rename JSON store had), `foreign_keys = ON`.

## Schema

```sql
CREATE TABLE licenses (
  key_hash TEXT PRIMARY KEY,          -- SHA-256 hex of the license key; NEVER plaintext
  plan TEXT NOT NULL,                 -- 'annual' (LibrePool is annual-only)
  status TEXT NOT NULL,               -- 'active' | 'expired' | 'canceled' | 'refunded'
  expires_at TEXT NOT NULL,           -- ISO 8601
  created_at TEXT NOT NULL,           -- ISO 8601
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT
);
CREATE INDEX idx_licenses_stripe_subscription_id ON licenses (stripe_subscription_id);
CREATE INDEX idx_licenses_stripe_customer_id ON licenses (stripe_customer_id);

CREATE TABLE license_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash TEXT NOT NULL,
  event TEXT NOT NULL,                -- issue | activate | cancel | expire | refund | update | import
  detail TEXT,                        -- JSON for updateBySubscription patches; free text otherwise
  created_at TEXT NOT NULL            -- ISO 8601
);
CREATE INDEX idx_license_events_key_hash ON license_events (key_hash);
```

The schema lives in `LICENSE_STORE_SCHEMA` in `license-store.ts` and is
shared with `scripts/migrate-licenses.ts`, so the migration creates
exactly the tables the store expects. There is deliberately no foreign
key from `license_events` to `licenses`: the audit table is append-only
history and must survive even if a license row is ever replaced or
removed.

**Keys are stored ONLY as SHA-256 hashes.** The plaintext key exists
exactly once — in the return value of `issue()`, which the caller must
deliver to the buyer (purchase email) and never store again. A leaked
`.db` file leaks hashes, not usable keys. The tests assert the store file
contains no `lp_` substring.

## Public API

Kept identical to the JSON store so `server.ts` works unchanged:

- `issue({ stripeCustomerId?, stripeSubscriptionId?, expiresAt? })` →
  `{ key, record }` (annual, 1 year from now unless `expiresAt` given)
- `find(key)` → `LicenseRecord | null`
- `activate(key)` → `LicenseActivation` (same shapes/reasons as before:
  `unknown_key` / `canceled` / `refunded` / `expired`)
- `check(key)` → `LicenseStatus` (same shape, incl. `checkedAtMs` and
  `cancelAtPeriodEnd`)
- `setStatus(key, status)` → `boolean`
- `insertForTest(key, record)` — test/ops helper; upserts and writes **no**
  audit event (it is a fixture, not a real transition)
- `size` — row count

Added for the Stripe worker (exact signatures):

- `findByStripeSubscriptionId(subscriptionId)` → `LicenseRecord | null`
- `findByStripeCustomerId(customerId)` → `LicenseRecord | null` — the
  most recently issued license for the customer (a re-subscribing
  customer gets a fresh key; recency is insertion order, since
  `created_at` has only millisecond resolution)
- `updateBySubscription(subscriptionId, patch: { status?, cancelAtPeriodEnd?, expiresAt? })`
  → `boolean` — applies only the fields present in `patch`, appends an
  audit event, returns `false` when no license matches the subscription.
  An empty patch on a matching subscription is a no-op that returns
  `true`.

State changes are applied in a transaction together with their audit
row, so a license row and its event never diverge.

## Audit trail

`license_events` records state **transitions**, not reads:

- `issue` — `issue()`
- `activate` / `cancel` / `expire` / `refund` — `setStatus()` or
  `updateBySubscription()` moving the status to that value
- `update` — `updateBySubscription()` with no status change (detail holds
  the patch JSON)
- `import` — rows brought in by the migration script

`activate()` / `check()` are read-only validations and are **not**
audited — they run on every catalog fetch, so logging them would flood
the table. The audited `activate` event is the status transition back
to `active`. Expiry by date is detected at validation time and does not
by itself flip the stored status or write an event; a row becomes
`expired` in the store only via an explicit `setStatus` /
`updateBySubscription` (e.g. a Stripe webhook).

## Migration from the JSON store

```bash
node scripts/migrate-licenses.ts [--from catalog/data/licenses.json] [--to <db path>]
# --to defaults to $CATALOG_LICENSE_DB_PATH or ./data/licenses.db
```

- Reads the old JSON array, copies `keyHash` / `plan` / `status` /
  `expiresAt` / `createdAt` / `cancelAtPeriodEnd` / Stripe ids verbatim
  (hashes are already SHA-256 — nothing is re-hashed).
- Idempotent: rows whose `key_hash` is already present are skipped, so
  re-running after a partial import is safe. Prints
  `imported / skipped / malformed` counts.
- **Never modifies or deletes the JSON file** — it stays in place as a
  backup until the operator removes it by hand.
- If `LicenseStore` is ever pointed at a path that still holds the legacy
  JSON file, its constructor refuses to open it and prints the migration
  command instead of corrupting the backup.

Order of operations on the host: run the migration, point
`CATALOG_LICENSE_DB_PATH` at the new `.db` file, restart the service,
verify a known key still activates, then (and only then) consider
removing the JSON backup.

## What this store is not

- It is not a billing system: Stripe remains the source of truth for
  payments; this store is a cache of issued keys and their statuses,
  kept in sync by webhooks.
- It has no deletion path and no expiry sweeper. Expired rows stay
  (they are history); if the table ever needs pruning, that is a
  separate, deliberate ops step — never silent.
