# LibrePool catalog feed service

The feed service is the server behind the router's catalog sync
(`server/src/services/catalog-sync.ts`). It serves the signed catalog JSON,
validates license keys, and (once wired) sells the $19/yr live feed through
Stripe. It is a **new build**, not a rebrand: no catalog server exists in the
upstream repo.

Zero runtime dependencies: Node's built-in `http` + `crypto` only. TypeScript
with erasable syntax, run directly with Node ≥ 22.6 type stripping
(`node src/index.ts`) or via `npm start`. Tests use the Node test runner.

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/latest[?since=<version>]` | Signed catalog JSON. `Authorization: Bearer <premium_license_key>` → tier `live`; no/invalid key → tier `monthly` (the 15-day-old snapshot). `?since=<applied version>` → `304` when unchanged. Response carries `x-catalog-signature` (base64 Ed25519 over the exact response bytes). `version` is `YYYY.MM.DD`, ≥ `2026.06.07` (`MIN_CATALOG_VERSION` — the router ignores older catalogs). |
| `POST` | `/v1/license/activate` | Body `{key}` → `{valid, plan, status, expiresAt, reason?}`. Plan is annual-only. |
| `POST` | `/v1/license/check` | `Authorization: Bearer <key>` → `LicenseStatus` JSON (`{valid, plan, status, expiresAt, cancelAtPeriodEnd?, checkedAtMs}`). No/invalid key → `401`. |
| `POST` | `/v1/portal` | Body `{key}` → `{url}` Stripe Billing Portal session. **Stub**: returns `501 billing_portal_not_configured` until Stripe is wired (or `STRIPE_PORTAL_URL` is set, in which case that URL is returned). |
| `POST` | `/v1/stripe/webhook` | Stripe webhook receiver. **Stub**: always `501` — signature verification + the Stripe SDK are still TODO (see `src/stripe.ts`). |
| `GET` | `/healthz` | Liveness only (`{ok, version}`). |

## Signing

- Fresh Ed25519 keypair, generated for LibrePool. The public key is pinned in
  the router as `PINNED_CATALOG_PUBKEY` (`server/src/services/catalog-sync.ts`).
- **Private keys live on the feed host only.** For local dev the key is
  `catalog/dev-keys/signing-private.pem` — that directory is git-ignored and
  must NEVER be committed. Production keys come from the host's secret store
  via `CATALOG_SIGNING_PRIVATE_KEY_PEM` (inline PEM, `\n` escapes) or
  `CATALOG_SIGNING_KEY_PATH`.
- Generate a new pair: `node scripts/generate-keypair.ts` (writes to
  `dev-keys/`; prints the public PEM to paste into the router).
- Sign a document offline: `node scripts/sign-catalog.ts --in catalog.json [--out signed.json]`.
- The live service signs the exact bytes it serves, at request time.

## The 15-day free snapshot

LibrePool's free tier is the catalog as of 15 days ago. The monthly document
includes a model/engine/registry entry iff its `premiumSince` is absent
(grandfathered / always-free) or ≤ now − 15 days — for **every** section
(chat models, embeddings, transcription, video, search, decision).
`managedPlatforms` in the monthly document names platforms that still have
live-only rows (still inside their Premium window), so the router knows the
catalog manages them even with zero rows in that tier.

The router has no gate for chat models; it simply receives what its tier
provides. The only router-side 15-day values are display-only `freeFrom`
computations for search engines (`FREE_LAG_MS` in
`server/src/services/search.ts`, `FREE_TIER_LAG_MS` in
`client/src/lib/search.ts`). Decision models carry `premiumSince` in
`meta_json` but no `freeFrom` is computed for them anywhere (server or
client) — the feed-side filter is the only enforcement, by design.

**Snapshot cadence:** the monthly document is regenerated whenever the live
catalog version changes AND at least once every 24h (models age into the
free tier daily, not just on version bumps). Monthly regeneration is the
floor; per-version-change regeneration is the rule
(`src/catalog-store.ts`).

## Ranking (feed-side aggregate)

`src/ranking.ts` folds the benchmarked aggregate into `intelligenceRank` at
export time (plan §6 option (a)):

- Sources: Artificial Analysis Intelligence Index v5, LiveBench 2.0 Overall,
  BenchLM BenchAlign v5.8 Overall. Never mix versions.
- Per-source min-max normalization **per snapshot** (raw scores are not
  comparable: AA tops out ~60, BenchLM ~89, LiveBench ~86).
- Weights: AA 45% / LiveBench 30% / BenchLM 25%. BenchLM is a
  meta-aggregator (it ingests AA + LiveBench-family data), so it is
  deliberately the smallest weight.
- Missing = null, never 0; weights renormalize over available sources.
  0 sources = Unranked — the model keeps its seed `intelligenceRank` and is
  never promoted above a scored model on quality grounds.
- Confidence: High = all 3 sources, or AA + LiveBench; Medium = any other
  2-source case, or BenchLM Supported-only; Low = a single source, or
  BenchLM Estimated-only. Source data older than 30 days decays confidence
  one level. Same-family proxy: inherit the LOWEST scored sibling, marked
  proxy, Low confidence — never the best sibling.

**HARD RULE: the feed carries ONLY the aggregate rank in `intelligenceRank`.
Per-source AA / BenchLM / LiveBench scores must NEVER enter the catalog
JSON.** `applyBenchmarkRanks` strips the feed-internal `benchmarks` field
before serving; the tests assert the served JSON contains no per-source
scores. The router's `CatalogModel` has no per-source fields at all.

Ranking keys are env placeholders only (`LIBREPOOL_RANKING_AA_KEY`,
`LIBREPOOL_RANKING_BENCHLM_KEY`, `LIBREPOOL_RANKING_LIVEBENCH_KEY` — free
tier, fetched by the feed service at export time). No real key values exist
in this repo, and none may ever be committed.

## License store (dev-only)

`src/license-store.ts`: JSON file at `CATALOG_LICENSE_DB_PATH` (default
`catalog/data/licenses.json`, git-ignored). Keys are stored ONLY as SHA-256
hashes, never in plaintext. Key format: `lp_` + 32 random bytes (base64url).
Annual only — 1-year expiry, no lifetime plan. **Production needs a real
store** (Postgres/SQLite with a proper schema, keyed lookups, audit trail);
this file store is for local dev and tests.

## Stripe (stubs only — not wired)

No real Stripe keys exist for LibrePool. Env placeholders:
`STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` ($19/yr annual-only price),
`STRIPE_WEBHOOK_SECRET`. Until they are set, checkout/portal/webhook return
a clear `stripe_not_configured` error instead of pretending to work.

Documented checkout flow ($19/yr, annual only, no lifetime SKU):

1. Buyer completes Stripe Checkout for `STRIPE_PRICE_ID`.
2. Stripe sends `checkout.session.completed` to `POST /v1/stripe/webhook`.
3. The webhook handler (TODO: signature verification with
   `STRIPE_WEBHOOK_SECRET` + the Stripe SDK) calls
   `LicenseStore.issue()` and records the Stripe customer/subscription ids.
4. The issued license key is delivered to the buyer by purchase email
   (email sending is out of scope for this service).
5. The buyer pastes the key into the router (`POST /api/premium/key`); the
   router validates it via `POST /v1/license/activate`, then gets the live
   tier from `GET /v1/latest` with `Authorization: Bearer <key>`.
6. Cancellations / card updates / invoices go through the Stripe Billing
   Portal: `POST /v1/portal {key}` creates a portal session.
7. `customer.subscription.deleted` / `updated` webhooks flip the stored
   license status (canceled / expired); the router's next
   `POST /v1/license/check` reflects it.

## Catalog assembly & source of truth

The feed's source of truth is its **own seed data**
(`CATALOG_SEED_PATH`, default `data/seed-catalog.json`), populated by
scrapers + curation — NOT a single router's SQLite file. The seed is
development data (a handful of real-platform rows so a dev round-trip
applies cleanly); production seed data is a separate, later step.

`server/src/scripts/export-catalog.ts` is the bridge that builds a
compatible document from a router DB (all sections: chat models,
embeddings, transcription, video, search, decision, quirks). Known gaps in
that bridge, documented there:

- Chat-model `premiumSince` is not stored in the router DB — it comes from
  an optional `--premium-since` sidecar JSON map
  (`{"platform:model_id": "ISO date"}`); without it, chat models omit the
  field and the feed service must get entry dates from its own records.
- Media (image/audio) rows carry no `speedRank` / `sizeLabel` /
  `contextWindow` in the DB; they are emitted with those fields omitted
  (the router's media path never reads them) and `limits` all-null, which
  the router's shape check requires on every `models[]` entry.

## Scrapers (interface only)

`src/scraper.ts` defines the contract for the later per-provider phase
(`CatalogScraper`: poll → hash/diff change detection → verify before
catalog entry → stamp `catalog_version` + `effective_date`). Per-provider
scrapers are NOT built here; `StubScraper` always reports "no change".
Rules for future scrapers: prefer official model-list APIs, respect
robots.txt and provider ToS, verify a detected model (live probe) before it
enters the catalog.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CATALOG_PORT` | `8080` | Listen port |
| `CATALOG_HOST` | `127.0.0.1` | Bind host |
| `CATALOG_SIGNING_KEY_PATH` | `./dev-keys/signing-private.pem` | Ed25519 private key (dev) |
| `CATALOG_SIGNING_PRIVATE_KEY_PEM` | — | Inline private key PEM (production) |
| `CATALOG_SEED_PATH` | `./data/seed-catalog.json` | Seed catalog (source of truth) |
| `CATALOG_LICENSE_DB_PATH` | `./data/licenses.json` | License store file (dev-only) |
| `STRIPE_SECRET_KEY` | — | Stripe secret (placeholder until wired) |
| `STRIPE_PRICE_ID` | — | $19/yr annual price id (placeholder) |
| `STRIPE_WEBHOOK_SECRET` | — | Webhook signing secret (placeholder) |
| `STRIPE_PORTAL_URL` | — | Optional fixed portal URL for the `/v1/portal` stub |
| `LIBREPOOL_RANKING_AA_KEY` | — | Artificial Analysis free key (placeholder) |
| `LIBREPOOL_RANKING_BENCHLM_KEY` | — | BenchLM free key (placeholder) |
| `LIBREPOOL_RANKING_LIVEBENCH_KEY` | — | LiveBench free key (placeholder) |

Router-side env (for the dev router pointing at this service):
`CATALOG_BASE_URL` (e.g. `http://127.0.0.1:8080`), `CATALOG_PUBKEY`
(override the pinned key when testing with a different keypair),
`PREMIUM_SITE_URL`, `CATALOG_SYNC_DISABLED=1` (until a feed exists).

## Run it locally

```bash
cd catalog
cp .env.example .env   # no real secrets needed for dev
node src/index.ts      # listens on http://127.0.0.1:8080
```

Point a dev router at it:

```bash
CATALOG_BASE_URL=http://127.0.0.1:8080 npm run dev -w server
# Without a key the router syncs the monthly (15-day) snapshot; with a key
# issued by this service it syncs the live tier.
```

Issue a dev license key (plaintext is shown once — deliver it like a
purchase email would, then never store it again):

```bash
node -e "import('./src/license-store.ts').then(async ({LicenseStore}) => {
  const s = new LicenseStore('./data/licenses.json');
  console.log(s.issue().key);
})"
```

Then in the router: `POST /api/premium/key {key}` (or paste it on the
dashboard Premium page) and watch the next sync apply the live tier.

## Tests & typecheck

```bash
node --test src/*.test.ts        # 33 tests: signing, snapshot, ranking, licenses, HTTP
../node_modules/.bin/tsc --noEmit -p tsconfig.json   # uses the workspace TypeScript
```

## What remains (not done here)

- Deploy the feed service (host, TLS, real Ed25519 keys on the host — the
  dev keypair in `dev-keys/` must never be used in production).
- Finish Stripe: Checkout + webhook signature verification + portal
  sessions + purchase-email key delivery; replace the JSON license store
  with a real store.
- Real ranking ingestion: fetch AA / BenchLM / LiveBench with the free keys
  (placeholders today) and populate per-model `benchmarks` in the seed.
- Production seed catalog data (the seed here is a small dev sample).
- Per-provider scrapers (interface only today).
