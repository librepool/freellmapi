# Per-provider scrapers

The feed service keeps its catalog fresh by polling each provider's model
list, diffing it against what the catalog already has, verifying additions
against the live list, and stamping verified additions with the date they
enter the live tier. The free tier sees them 15 days later through the
existing snapshot rule (`src/snapshot.ts`).

## Files

| File | What it is |
|---|---|
| `src/scraper.ts` | The contract (`CatalogScraper`: poll → hash/diff → verify → stamp) plus scheduler support: `ScraperStateStore`, `ScrapeReport`, `runScraper`, verification levels, `probeServing`, `applyScrapeToSeed` |
| `src/scrapers/robots.ts` | robots.txt parser + pre-poll gate (`checkRobotsTxt`, `RobotsDisallowedError`) |
| `src/scrapers/openai-compatible.ts` | Reusable `OpenAICompatibleScraper` base: `GET {baseUrl}/models`, free-id filter, 5-min in-memory cache (one poll per platform per run, verification reuses the fetch) |
| `src/scrapers/aihubmix.ts`, `nous.ts`, `llmtr.ts`, `airforce.ts` | The four concrete scrapers (churn-prone providers) |
| `src/scrapers/index.ts` | Registry: every seed platform → concrete / generic / stub |
| `src/scraper.test.ts` | 22 tests (filters, robots parser, mocked polling, state, apply rules, registry coverage) |
| `scripts/run-scrapers.ts` | The run-once runner CLI |

## How a run works

1. **Baseline.** The first run for a platform diffs the live free list
   against the seed catalog's ids for that platform. Later runs diff
   against `catalog/data/scraper-state.json`
   (`lastHash` + `lastCheckedAt` + `lastModelIds` per platform).
2. **Robots gate.** Before any list fetch, the scraper fetches
   `<origin>/robots.txt`. If the list path is disallowed, the poll is
   skipped and the report says so. A missing robots.txt (404) means no
   restriction; a robots.txt fetch failure fails closed (skip, retry next
   run). There is no bypass flag: re-enabling a disallowed poll needs a
   documented operator decision (see "Robots.txt, per host" below).
3. **Poll.** One `GET {baseUrl}/models` per platform per run, sequential
   (never concurrent floods), 20s timeout, `LibrePool-scraper/1.0`
   User-Agent. No key is sent — only public list endpoints are scraped.
4. **Hash/diff.** The sorted free-id list is SHA-256 hashed. Same hash as
   last time → `unchanged`, no verification, no report noise. Different
   hash → `added` / `removed` vs the previous ids.
5. **Verify.** Every added id is re-checked against the fetched list and
   labelled `list-verified` (present) or `unverified` (absent on re-check).
   See "Verification levels" below.
6. **Report.** Every platform emits a `ScrapeReport` every run — `changed`,
   `unchanged`, `skipped`, or `error`. Absence of a report means the run
   never happened, never "no change".
7. **Apply (only with `--apply`).** Verified additions enter the seed with
   `premiumSince = today` (UTC midnight) and the catalog version bumps to
   today's `YYYY.MM.DD`. Removed models are **never deleted** — they are
   listed in the report for an operator to decide (outage vs rename vs
   real retirement).

## Verification levels — labelled honestly

| Level | Meaning | Who can produce it |
|---|---|---|
| `list-verified` | The id appears in the provider's live model list | The scheduler, on every poll |
| `serving-verified` | A real 1-token chat call for this id succeeded | An operator, with a provider key (`probeServing` in `src/scraper.ts`) |
| `unverified` | Checked and NOT confirmed | — |

A 1-token serving probe needs a provider key, which the feed service does
not hold. `probeServing(baseUrl, modelId, apiKey)` exists for an operator
who supplies a key explicitly (never from env, config, or state); the
scheduler never calls it, and nothing in this module ever claims a serving
probe it did not run. List-verified is enough for `--apply` — the router
already refuses to serve a model the provider rejects at call time — but
serving verification is the step that catches a listed-but-unservable id,
so high-churn additions should get it before they are relied on.

## The runner

```bash
cd catalog
# Read-only run (default): polls, writes data/scraper-changes.json, updates
# data/scraper-state.json, changes nothing else.
node scripts/run-scrapers.ts

# One platform only:
node scripts/run-scrapers.ts --platform nous

# Apply verified additions to the seed (backup <seed>.bak first):
node scripts/run-scrapers.ts --apply
```

**Development safety: never run `--apply` against the real seed while
testing.** Test against a temp copy:

```bash
cp data/seed-catalog.json /tmp/seed-test.json
node scripts/run-scrapers.ts --seed /tmp/seed-test.json --state /tmp/scraper-state.json \
  --out /tmp/scraper-changes.json --apply
diff data/seed-catalog.json /tmp/seed-test.json   # review before anything real
```

## State and report files (git-ignored runtime state)

`catalog/data/scraper-state.json` (per-platform lastHash/lastCheckedAt/
lastModelIds) and `catalog/data/scraper-changes.json` (the latest run
report) are runtime state, not source. Add them to `.gitignore`:

```
catalog/data/scraper-state.json
catalog/data/scraper-changes.json
```

(`*.bak` is already ignored at the repo root, which covers the `--apply`
backup.) If the state file is missing or corrupt, the runner starts from
an empty state and diffs against the seed baseline — it never crashes the
run over state.

## Scheduling

The runner is run-once; a long-running scheduler inside the feed service
is out of scope. Schedule it externally. Intervals are per-source in the
registry (6h for churn-prone rosters, 24h otherwise); the runner itself
does not enforce them — the schedule below is the enforcement. One run
polls each platform at most once, sequentially.

Cron (twice daily, 06:00 and 18:00 UTC):

```cron
0 6,18 * * * cd /srv/librepool/freellmapi/catalog && /usr/local/bin/node scripts/run-scrapers.ts >> /var/log/librepool/scrapers.log 2>&1
```

systemd timer (same cadence, with logging to the journal):

```ini
# /etc/systemd/system/librepool-scrapers.service
[Unit]
Description=LibrePool per-provider scraper run
After=network-online.target
[Service]
Type=oneshot
WorkingDirectory=/srv/librepool/freellmapi/catalog
ExecStart=/usr/local/bin/node scripts/run-scrapers.ts
# --apply is deliberately NOT here: applying to the seed stays a manual,
# reviewed operator step until the reports have proven stable.

# /etc/systemd/system/librepool-scrapers.timer
[Unit]
Description=LibrePool scrapers, twice daily
[Timer]
OnCalendar=06:00,18:00
Persistent=true
[Install]
WantedBy=timers.target
```

## Robots.txt, per host (live, 2026-11-08)

| Host | robots.txt | Effect on the scraper |
|---|---|---|
| `aihubmix.com` | `User-agent: *` / `Disallow: /v1/` ("API endpoints not indexed") | Polls **skip** by default |
| `inference-api.nousresearch.com` | None (404) | Polls **run** — the only concrete scraper live by default |
| `llmtr.com` | `User-agent: *` / `Disallow: /v1/` (also `/api/`, `/dashboard`); file advertises `/llms.txt` and `/llms-full.txt` as machine-readable surfaces | Polls **skip** by default; `/llms-full.txt` is a future alternative source, not implemented here |
| `api.airforce` | `User-agent: *` / `Disallow: /v1/` (comment: the block targets indexing waste — "backend API endpoints, not content pages") | Polls **skip** by default |

Three of the four concrete scrapers therefore report `skipped` on the
default schedule. That is the faithful outcome of the two requirements
(poll the official list; respect robots.txt) — the Disallow lines are
indexing directives aimed at search engines, but this module does not
second-guess them. The live lists were confirmed by one-off manual probes
during the build (next section); if the operator wants scheduled polling
for a disallowed host, that is a documented decision for the operator to
record in the registry entry — not a flag to add quietly.

## Runner smoke run (2026-11-08, read-only, state/report in /tmp)

`node scripts/run-scrapers.ts --state /tmp/smoke-state.json --out /tmp/smoke-changes.json`
(all 26 platforms, first run, diffed against the seed baseline):

- **26 platforms: 7 changed (+12/−1), 11 skipped, 8 errors.**
- Polling live and unchanged vs seed: **Nous** (hash `282a96d6e4b3…`,
  reproduces the manual probe), **Gonka, Inferbase, KiosAPI, LLM.kiwi,
  MegaNova** (first-run hashes recorded; no adds/removes). **Typhoon**
  errored on the first run (bare-array list — fixed, see below) and polled
  clean on re-run (hash `6e9339fdf334…`, no adds/removes).
- **OpenRouter: +12 free `:free` models, −1.** The 12 additions are
  list-verified (cohere/north-mini-code:free, dots-studio/dots-3-note-preview:free,
  google/gemma-4-26b-a4b-it:free, google/gemma-4-31b-it:free,
  liquid/lfm-2.5-2.6b:free, liquid/lfm-3-1.7b:free,
  nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free,
  nvidia/nemotron-3-ultra-550b-a55b:free,
  nvidia/nemotron-3.5-lightning:free, nvidia/nemotron-3.5-super-vl:free,
  recursive/flint-v1.0:free, xingchen-agi/xing4.0-29b-a4b:free). The
  removal is the seed's own `meta-llama/llama-3.3-70b-instruct:free` —
  absent from the live free list; reported only, never auto-deleted, and
  flagged here for operator review (rename vs retirement — not yet
  confirmed).
- **Skipped (11):** 7 stubs (groq, mistral, cloudflare, google, exa,
  tavily, watsonx) + 4 robots-disallowed (aihubmix, llmtr, airforce —
  robots fetch timed out once, fail-closed — and pollinations, whose
  `gen.pollinations.ai/robots.txt` also disallows `/v1/`).
- **Errors (8), all recorded, none fatal:** Mixlayer, Token Harbor, Zro,
  SenseNova, SimpleLLM, Arli — `GET /v1/models` returns **401 without a
  key**, verified live by direct probe for Token Harbor and Zro. Their
  registry entries now say so; they report errors until a list key
  exists. Moark timed out once (direct curl then returned 200 — slow/
  flaky host). Typhoon returned a bare-array list, which the base class
  did not accept — fixed in `openai-compatible.ts` (both `{data: […]}` and
  bare `[{…}]` are now accepted) with a regression test.

## Live-probe results (manual, 2026-11-08 — build-time ground truth)

All four list endpoints confirmed live, no key, `GET /v1/models` → 200.
Counts are the **free** list after each provider's filter; hashes are
SHA-256 of the sorted free-id list.

| Provider | Total listed | Free (filter) | Seed | Added vs seed | Removed | Free-list hash (first 16 hex) |
|---|---|---|---|---|---|---|
| AIHubMix | 662 | 42 (`-free`/`:free` suffix; classifier excluded → 41 scrapable) | 41 | 1 — `nemotron-3.5-content-safety-free` (a classifier, deliberately not seeded; the scraper excludes it) | 0 | `2c2352d40ee01ea2` (42, incl. classifier) |
| Nous Portal | 393 | 4 (`:free` suffix) | 4 | 0 | 0 | `282a96d6e4b36cc4` |
| LLMTR | 399 | 16 (zero pricing + `CHAT_COMPLETIONS`) | 5 | 11 — `openai/gpt-oss-safeguard-20b`, `liquid/lfm3-1.7b-free`, `evren/gemma-4-31b`, `evren/deepseek-v4-flash-tr`, `evren/qwen3.8-flash-next`, `evren/glm-5.3-fp8`, `evren/qwen3-vl-30b`, `evren/mimo-v2.6-pro-tr`, `evren/deepseek-v4.1-flash-tr`, `parallel/parallel-free`, `parallel/parallel` | 0 | `473ad625b19f6277` |
| Api.Airforce | 790 | 26 (`tier: "free"` + `supports_chat`) | 4 | 22 | 0 | `2814426e7cd4ebef` |

Notes from the probes:

- **LLMTR:** the public roster mixes paid/promo/BYOK rows — there is no
  suffix rule. The free signal is zero `pricing.prompt` + `pricing.completion`
  plus `supported_operations` containing `CHAT_COMPLETIONS`. One
  zero-priced embeddings route (`liquid/lfm-2.5-embedding-350m-free`) is
  correctly excluded from the chat list. LLMTR also refuses automated
  key-validation probes outright — never probe keys here.
- **Airforce:** list prices are NOT the free signal (free-tier
  `kimi-k2.7-code` lists 58/240 per M tokens). On the probe day only 3 of
  the 26 free chat models reported `operational` (llama-instant,
  mistral-large-4, kimi-k2.7-code); the other 23 reported `major_outage`,
  including seeded `glm-4.7-flash`. The scraper surfaces this as a report
  note — "26 free chat models" is not "26 working lanes" on a day like
  that. Rate limit when polling is re-enabled: 1 req/min/account.
- **AIHubMix / Nous:** the suffix rules match the router adapters exactly;
  both rosters churn (AIHubMix had 42 free on 2026-11-08; Nous 4, down
  from 7 on 2026-10-15).

## Registry coverage (38 seed platforms)

| Platform | Kind | List / filter |
|---|---|---|
| aihubmix | concrete | `/v1/models`, `-free`/`:free` suffix (classifier excluded) |
| nous | concrete | `/v1/models`, `:free` suffix |
| llmtr | concrete | `/v1/models`, zero pricing + `CHAT_COMPLETIONS` |
| airforce | concrete | `/v1/models`, `tier: "free"` + `supports_chat` |
| mixlayer | generic | `/v1/models`, `-free` suffix |
| tokenharbor | generic | `/v1/models`, `:free` suffix (zero price alone is NOT free) |
| gonka | generic | `/v1/models`, all ids except embeddings `BAAI/bge-m3` |
| llmkiwi | generic | `/v1/models`, all ids (whole service currently free) |
| zro | generic | `/v1/models`, frozen `{deepseek-v4.1-flash, glm-5.3-flash}` |
| meganova | generic | `/v1/models`, frozen Tier 1 set (8 ids) |
| moark | generic | `/v1/models`, frozen `{deepseek-v4-flash-0731}` |
| sensenova | generic | `/v1/models`, all ids (beta — no permanent free tier published) |
| simplellm | generic | `/v1/models`, `free-` prefix |
| kiosapi | generic | `/v1/models`, frozen free-route set (5 ids) |
| arli | generic | `/v1/models`, frozen `{Qwen3.5-27B-Derestricted}` — but the list endpoint 401s without a key, so this entry reports errors until a list key exists |
| inferbase | generic | `/v1/models`, frozen `{auto}` |
| typhoon | generic | `/v1/models`, seeded-only (removal detection; no free-id rule for the wider roster) |
| openrouter | generic | `/v1/models`, `:free` suffix |
| pollinations | generic | `/v1/models`, all ids — free rule **unverified**; additions need operator review |
| nara | generic | `/v1/models`, frozen `{laguna-s-2.1}` (from public `/api/plans`) — but the list endpoint 401s without a key, so this entry reports errors until a list key exists |
| xkiro | generic | `/v1/models`, `access_tier: "free"` (26 of 69 live, all $0) |
| experiential | generic | `/v1/models`, frozen `{gpt-6-luna, deepseek-v4.1-flash}` — but the list endpoint 401s without a key, so this entry reports errors until a list key exists |
| llm7 | generic | `/v1/models`, `tier: "turbo"` + `model_type: "chat"`, not `usage_based_only` (4 live) |
| navy | generic | `/v1/models`, `premium: false` + chat-completions endpoint (70 live) |
| aion | generic | `/v1/models`, all ids (whole 6-model roster is free-tier) |
| anyapi | generic | `/v1/models`, frozen `:free` set (4 ids) — but the list endpoint 401s without a key, so this entry reports errors until a list key exists |
| radeon | generic | `/v1/models`, frozen chat set (11 ids, official model catalog) — but the list endpoint 401s without a key, so this entry reports errors until a list key exists |
| nvidia | generic | `/v1/models`, frozen chat set (61 of 84 live; 23 non-chat excluded by name) — the list carries no free marker, the whole hosted catalog is the free trial tier |
| cohere | generic | `/v1/models`, frozen chat set (9 Command/North ids, official rate-limits page) — but the list endpoint 401s without a key, so this entry reports errors until a list key exists |
| zhipu | generic | `/v1/models`, frozen `$0` set (3 Flash ids, official pricing page) — but the list endpoint 401s without a key, so this entry reports errors until a list key exists |
| kilo | generic | `/api/gateway/models` (not `/v1/models`, which only takes POST), `isFree === true` (11 of 379 live) |
| groq | stub | List endpoint requires a provider key; the service holds none |
| mistral | stub | List endpoint requires a provider key; the service holds none |
| cloudflare | stub | Bespoke Workers AI API, no `/v1/models` |
| google | stub | Bespoke Gemini API, no `/v1/models` (seed has 7 free Flash chat rows + the gemini-embedding-001 embeddings row) |
| exa | stub | Search-only; engine roster is fixed (`exa-search`) |
| tavily | stub | Search-only; engine roster is fixed (`tavily-search`) |
| watsonx | stub | Bespoke IAM + `/ml/v1` API, no public list endpoint |

The test suite asserts this table against the seed: adding a seed
platform without a registry entry fails the build.

## ToS notes (from the router adapters, where known)

- **MegaNova:** ToS Annex A — free modules are "for evaluation and
  interactive use only"; high-throughput/production use may lead to
  suspension. (Already an accepted routing-lane decision; the note stays
  in the registry entry.)
- **SenseNova:** beta-scoped, no permanent free tier published. If paid
  tiers launch, the catalog must be re-checked before routing paid
  traffic here.
- **LLM7:** Terms §3A — no resale, redistribution, proxying, gatewaying
  or downstream access without prior written approval. Routing here
  needs approval (verified against TERMS.md 2026-11-09, not yet sought).
- **NVIDIA NIM:** API Trial Terms — internal testing/evaluation only,
  not production; prompts may be used to improve NVIDIA models.
  Models vanish without notice (three of five in one June 2026 post
  were gone by October).
- **Cohere:** trial (evaluation) keys are non-commercial only; 1,000
  calls/month shared across the key. Production use needs a production
  key — and the four newest Command variants stay at trial limits even
  on one (contact sales).
- **Kilo Code:** free prompts/outputs are logged for training; the
  gateway re-serves upstream free lanes, and free routes transition
  to paid without notice.
- **AMD Radeon Cloud:** Token Factory is a "free trial and development
  service, not for production"; reselling access is not allowed.
- **Moark:** models marked "free" in the model square are NOT free — the
  FAQ says they need a purchased resource package. Only the
  vendor-documented featured id is seeded.
- **Token Harbor:** zero price alone does NOT mean free — `th-orchestra`
  reports $0 but answers 402 on a real call. Only the `:free` suffix is
  trusted.
- **LLMTR:** automated key-validation probes are refused outright; a
  validation probe can get an account flagged. Never probe keys here.
- **Airforce:** 1 request/minute/account; a 429 carries Retry-After.

## What still needs an operator

- **Serving verification for every addition.** The scheduler only ever
  produces `list-verified`. A serving probe needs a provider key per
  provider (AIHubMix, Nous, LLMTR, Airforce, and any generic entry whose
  additions get applied). No key values exist in this repo and none may
  ever be committed.
- **Robots-disallowed hosts (AIHubMix, LLMTR, Airforce).** Scheduled
  polling for these three needs a documented operator decision recorded
  in the registry — until then they report `skipped` and their lists are
  refreshed by manual probe only.
- **Arli's list endpoint** 401s without a key, so its generic entry
  reports errors; a list key or a docs change is needed before it can poll.
  The same applies to Mixlayer, Token Harbor, Zro, SenseNova, and
  SimpleLLM (all 401 on keyless `/v1/models`, verified live 2026-11-08).
- **Removal decisions.** Removals are reported, never applied. When a
  report lists a removal, the operator decides: outage, rename, or real
  retirement — then edits the seed by hand.
- **Curation of `--apply` additions.** Applied rows carry neutral defaults
  (rank 500, speed 5, `Medium`, no limits/context) — the operator should
  fill in real ranks, limits, and context windows from the provider's
  docs, and confirm modality (a listed id is not always a chat model).
- **`catalog/README.md` "Scrapers (interface only)" section** is now
  stale — it still says per-provider scrapers are not built. It needs a
  one-line update pointing at this doc (not done here: README is outside
  this worker's file scope).
