# LibrePool hosting options

Research + proposal only. No host chosen, no account created, no service
provisioned, no domain registered. Dated **7–8 November 2026** (prices read
2026-11-08, 07:05 UTC / 2026-11-07 23:05 PST unless noted otherwise).

## What is being hosted

Two separate things — do not conflate them:

1. **The feed service** (`catalog/`, see `catalog/README.md` and the
   implementation plan §7). A small Node service, zero runtime dependencies
   today (a Stripe SDK dependency is being added by a parallel worker).
   It serves signed catalog JSON over HTTPS (`GET /v1/latest`, license
   activate/check, Stripe Billing Portal, Stripe webhook receiver) and needs:
   - a **public HTTPS URL** — Stripe webhooks require it, and the router
     syncs twice daily against it;
   - a **persistent file for the license store** — SQLite file after this
     phase (today a JSON file at `CATALOG_LICENSE_DB_PATH`; keys stored only
     as SHA-256 hashes, plaintext shown once at issuance and never stored);
   - the **seed catalog JSON** (can ship with the deploy artifact);
   - **secrets from env**: Stripe keys, `STRIPE_WEBHOOK_SECRET`, the Ed25519
     signing private key (`CATALOG_SIGNING_PRIVATE_KEY_PEM` /
     `CATALOG_SIGNING_KEY_PATH`), ranking API keys (free tier).
2. **The website** — `librepool.com`, the marketing/docs site. Static
   content only (no server process, no database). Domains `librepool.com` /
   `librepool.ai` were checked available in Nov 2026; **nothing bought, no
   registrar chosen**.

Traffic is small: a niche open-source router's catalog syncs (twice daily
per install) plus occasional $19/yr checkouts. Single instance, single
region is a reasonable starting assumption; nothing here needs multi-region
or HA on day one.

### The awkward part: the license store

The persistent SQLite file is the one thing that constrains the choice.
Everything else about the service (stateless HTTP, tiny CPU/RAM) runs
anywhere.

- On a **PaaS without a persistent disk**, the license file is lost on
  every restart/redeploy — unacceptable: issued license keys exist only as
  hashes in that file, so losing it means every paid key stops validating
  and cannot be recovered (the plaintext was shown once, at purchase).
- On a **PaaS with a persistent disk**, the file survives restarts but
  lives on one physical host/volume: a dead disk with no backup is still
  total license loss. Snapshots help; an off-box export is what actually
  saves you.
- On a **VPS**, the local disk is persistent by nature; backup is entirely
  your job (add-on or your own script).

Whichever host is chosen, the license store needs **two** things that are
not the host's default: an off-box backup/export of the SQLite file, and a
documented key-reissue plan for the day the store is lost anyway. The seed
catalog, by contrast, is rebuildable from the repo/scrapers and does not
need the same treatment.

### Verification status — read before trusting a number

- **Verified directly on the provider's own pricing page in this pass
  (crawled 2026-11-08):** Fly.io, Railway (metered rates), DigitalOcean
  Droplets, Cloudflare Pages.
- **Not re-verified on the provider's own live page in this pass:**
  Render (its pricing page crawler returned the FAQ only — prices are
  JS-rendered) and Hetzner Cloud (its cloud page crawler returned the
  marketing page without the price table). Their figures below come from
  independent checks of the providers' own pages in Oct 2026 that agree
  with each other; they are marked **[secondary, Oct 2026]** and must be
  re-checked on the live page before any money moves.
- Prices exclude VAT/tax where the provider states that. Hetzner prices
  are EUR; everything else is USD. No FX conversion is given — do not
  compare EUR and USD figures as if they were the same currency.
- "Estimated monthly cost for LibrePool" rows are **arithmetic on the
  published rates** for a small always-on service, not measured bills.
  They assume ~0.25 vCPU / 0.5 GB RAM average on metered hosts, negligible
  egress (catalog JSON is small; syncs are twice daily per install), and
  a 1 GB persistent volume where one is needed. Re-check after the first
  real invoice.

## Option 1 — Fly.io (feed service)

**What it would run:** feed service only (the website belongs on a static
host; Fly can serve static files but that is not its strength).

**Cost (verified, fly.io/pricing, crawled 2026-11-08):**

| Item | Price |
|---|---|
| `shared-cpu-1x`, 256 MB, always on | $2.19/mo |
| `shared-cpu-1x`, 512 MB, always on | $3.69/mo (per Oct 2026 checks; the live page table in this crawl showed the 256 MB and 2 GB presets — treat the 512 MB figure as secondary, Oct 2026) |
| `shared-cpu-1x`, 1 GB, always on | $6.70/mo |
| Extra RAM | $6.00/GB/mo |
| Volumes (provisioned size) | $0.15/GB/mo |
| Volume snapshots | $0.08/GB/mo beyond the first 10 GB free |
| Egress, North America / Europe | $0.02/GB |
| Egress, Asia-Pacific / Oceania / South America | $0.04/GB |
| Egress, Africa / India | $0.12/GB |
| Dedicated IPv4 | $2.00/mo (shared IPv4 + unlimited Anycast IPv6 included) |
| Trial | $1 credit to start, no card needed (per the live pricing page) |

No platform/plan fee: billing is pure pay-as-you-go, per second while a
Machine runs. Support is community-only unless you pay: Standard $29/mo,
Premium $199/mo (same page).

**Estimated monthly cost for LibrePool:** ~$3.85–$6.85/mo — one
`shared-cpu-1x` at 512 MB ($3.69) or 1 GB ($6.70) + a 1 GB volume ($0.15)
+ ~$0 egress at this traffic. A stopped Machine still bills its root
filesystem at $0.15/GB/mo.

**Ops burden:** medium. Deploy with `flyctl` from a Dockerfile /
`fly.toml`; one `fly deploy` from git. TLS is automatic (shared IPv4 /
`*.fly.dev` plus free certs for a custom domain). Secrets via
`fly secrets set` (Stripe keys, signing key PEM). Persistent disk: a Fly
Volume mounted in `fly.toml`. Backups: automatic daily volume snapshots,
5-day retention by default (Fly docs).

**Fit for the license store:** workable, with a caveat. A Volume is local
persistent NVMe attached to exactly one Machine in one region; Fly does
not automatically replicate data between volumes, and a volume cannot be
attached to two Machines at once — so the service is pinned to a single
Machine. That is fine at this scale (and matches the single-instance
assumption), but it means: no horizontal scaling without a replication
layer (e.g. LiteFS) and no failover. Snapshots are the built-in safety
net; they are not a substitute for an off-box export.

**Risks:**

- No free tier for new organisations (retired 7 Oct 2024) — only the $1
  trial credit. Old articles quoting a free Hobby plan or $1.94/mo for the
  smallest Machine are stale: RAM went from $5 to $6/GB on 1 Oct 2026,
  taking the smallest Machine from $1.94 to $2.19/mo.
- No spending cap by default (reported Oct 2026) — a runaway (e.g. a
  scraper loop, a retry storm) bills without a ceiling. Set billing alerts
  and consider `auto_stop_machines` — but note auto-stop suspends idle
  Machines, which delays Stripe webhook delivery (Stripe retries, so this
  is a delay, not data loss; keep auto-stop off for the webhook path or
  accept the latency).
- Regional price variation: the pricing page defaults to Ashburn/Secaucus
  (cheapest); other regions cost more.
- Single-vendor CLI/config (`fly.toml`) — migration means re-doing deploy
  config, though the service itself is a plain Node process in a container.

## Option 2 — Railway (feed service)

**What it would run:** feed service only (same static-site caveat as Fly).

**Cost (metered rates verified, railway.com/pricing, crawled 2026-11-08;
plan fees corroborated — see note):**

| Item | Price |
|---|---|
| CPU | $0.00000772/vCPU-sec ≈ $20/vCPU/mo |
| Memory | $0.00000386/GB-sec ≈ $10/GB/mo |
| Volumes | $0.00000006/GB-sec ≈ $0.15/GB/mo |
| Egress | $0.05/GB |
| Object storage | $0.015/GB-mo, free egress |

Plans: Free ($0; 30-day trial with $5 one-time credit, then $1/mo
credit; 1 vCPU / 0.5 GB RAM per service; 0.5 GB volume) · Hobby $5/mo ·
Pro $20/mo per workspace. **Note on verification:** the live pricing
page's text extraction in this pass showed the metered rates and the
included usage credits ($5 Hobby / $20 Pro) but not the plan-price
headings; the $5 / $20 plan fees are corroborated by independent checks
of railway.com/pricing dated 5 Nov 2026. The plan fee is a **minimum,
not a cap**: the fee includes the same amount of usage credit, and the
bill is whichever is higher, the fee or actual usage. Included credit
resets monthly and does not accumulate. A user-set hard usage limit
(minimum $10) is available.

**Estimated monthly cost for LibrePool:** ~$5–$10/mo on Hobby. At
0.25 vCPU + 0.5 GB RAM average, usage is ~$10/mo (0.25×$20 + 0.5×$10),
so the bill is ~$10; if the service idles lower (Railway meters actual
use per second), it falls toward the $5 floor. A 1 GB volume adds ~$0.15.

**Ops burden:** low — the lowest of the PaaS options here. GitHub
connected deploy or Dockerfile, dashboard env vars for secrets, custom
domain + automatic TLS, private networking, one-click rollbacks,
built-in database/volume backups (per the pricing page's feature table).
Volumes are persistent and attach to the service; the service can sleep
(Serverless setting) when idle — keep that off for the webhook path, as
with Fly.

**Fit for the license store:** good. Volumes exist on Hobby (up to 5 GB),
persist across redeploys, and backups are built in. Same single-copy
caveat as Fly: still export the SQLite file off-box.

**Risks:**

- **October 2026 secrets breach — material for this service.** Railway
  disclosed on 21 Oct 2026 that an attacker accessed the systems storing
  customer environment variables and obtained the decrypted contents of
  some of them; its preliminary report (22–23 Oct 2026) put the upper
  bound at 1.85% of workspaces (~100,000) and advised **all** users to
  rotate stored secrets. Railway marked the incident resolved 24 Oct 2026
  and says it has rebuilt internal tooling and moved builds to
  single-tenant environments, but the forensic investigation was still
  ongoing at last report. For LibrePool this matters directly: the
  platform would hold the Stripe secret key and the Ed25519 signing
  private key — the two secrets whose compromise is most damaging
  (forged catalog signatures; Stripe misuse). If Railway is chosen, the
  signing key must be treated as rotatable (generate a fresh keypair,
  publish the new public key to the router, revoke the old one) and
  rotation must be rehearsed, not just possible.
- Metered billing is the least predictable of the fixed-price options: a
  busy month (scrapers, a traffic spike) bills above the plan fee with no
  ceiling other than the optional hard limit — which, when hit, takes
  workloads offline.
- Reliability history in 2026 includes an 8-hour platform-wide outage in
  May (per Oct 2026 reviews) in addition to the October incident.
- Pro support is forum-based with a typical 72-hour response (per Oct
  2026 reviews); there is no included SLA with service credits on Hobby.

## Option 3 — Render (feed service, and optionally the website)

**What it would run:** feed service, and/or the website as a free static
site. One vendor for both is possible here.

**Cost — [secondary, Oct 2026; NOT re-verified on the live page in this
pass]:** the render.com/pricing crawl on 2026-11-08 returned the FAQ
only (prices are JS-rendered). Figures below are from independent checks
of render.com/pricing in Oct 2026 that agree with each other. Re-check
on the live page before committing.

| Item | Price (secondary, Oct 2026) |
|---|---|
| Workspace: Hobby | $0/mo |
| Workspace: Pro | $25/mo flat, unlimited seats |
| Workspace: Scale | $499/mo |
| Web service: Free | $0 (512 MB, sleeps — see below) |
| Web service: Starter | $7/mo (0.5 CPU / 512 MB) |
| Web service: Standard | $25/mo (1 CPU / 2 GB) |
| Web service: Pro | $85/mo (2 CPU / 4 GB) |
| Persistent disk | $0.25/GB/mo |
| Bandwidth overage | $0.15/GB past the included allowance (5 GB Hobby / 25 GB Pro) |
| Postgres Basic-256mb (for reference only — LibrePool uses SQLite, not Postgres) | $6/mo |

Render bills three things separately: workspace plan (flat) + compute
per service (prorated per second) + metered features (bandwidth). The
workspace fee never includes compute. A workspace with no services and
no activity in a month has the workspace fee waived (per Render's own
FAQ, verified in this pass).

**Estimated monthly cost for LibrePool:** ~$7.25/mo — Hobby workspace
$0 + Starter web service $7 + 1 GB persistent disk $0.25. Pro workspace
($25) is not needed for a solo project.

**Ops burden:** low. Git-push / Docker deploy, dashboard env vars,
automatic TLS, preview environments. Persistent disks attach to paid
services only.

**Fit for the license store:** good **only on a paid instance**. The free
web service has an ephemeral filesystem and **cannot attach a persistent
disk** — a SQLite license file stored there is lost on every restart,
redeploy, or idle shutdown. Free Postgres (1 GB) expires 30 days after
creation and is not a substitute (LibrePool's store is a file, not
Postgres). On Starter ($7) + disk ($0.25/GB), the store persists; backups
of the disk itself are your job — export the file off-box (Render's
backups/PITR apply to its managed Postgres, not to your disk).

**Risks:**

- **The free tier is a trap for this service, not a saving.** Free web
  services spin down after 15 minutes without traffic and take ~a minute
  to wake; a Stripe webhook arriving during sleep is delayed (Stripe
  retries, so it is not lost, but license issuance is delayed and the
  first sync after a cold start is slow). Do not run the feed service on
  Free in production.
- The $7 Starter is the cheapest honest price; the "free" headline does
  not apply to a stateful service.
- Fewer regions than Fly/Railway (US Oregon/Ohio/Virginia, Frankfurt,
  Singapore — per Oct 2026 reviews); no South America / Africa / India /
  Australia region.
- Render's own docs advise against Free instances for production dynamic
  apps; the platform is the most "fixed-price predictable" of the PaaS
  options, which is a plus, but the persistent-disk story is the thinnest
  (no built-in disk backup).

## Option 4 — Plain VPS: Hetzner Cloud (feed service + website on one box)

**What it would run:** both — feed service and website on the same
server (e.g. Node service behind Caddy/Nginx, static site from the same
box or a second vhost). One box, one bill.

**Cost — [secondary, Oct 2026 for prices; availability verified on the
live page in this pass]:**

| Item | Price |
|---|---|
| CX23 (2 shared vCPU / 4 GB / 40 GB NVMe, 20 TB traffic, EU) | €5.49/mo excl. VAT, excl. IPv4 — June 15 2026 list price [secondary, Oct 2026] |
| Same, incl. primary IPv4 (€0.50/mo) | €5.99/mo excl. VAT [secondary, Oct 2026] |
| Automated backups (7 daily slots) | +20% of server price (≈ €1.10/mo on a CX23) [secondary, Oct 2026] |
| Snapshots | €0.0143/GB/mo [secondary, Oct 2026] |
| Fallback if CX is unorderable: CPX22 (2 vCPU / 4 GB / 80 GB) | €19.49/mo excl. VAT (≈ €19.99 incl. IPv4) [secondary, Oct 2026] |

Older figures still circulating (€3.79, €4.35/mo for the CX22) are **stale**:
Hetzner raised cloud prices 1 Apr 2026 (+30–37%) and again 15 Jun 2026
(CX +~30–38%, CPX/CCX far more), and renamed the entry box CX22 → CX23.
The CX22 name should not be quoted as a current plan.

**Estimated monthly cost for LibrePool:** ~€7.19/mo if a CX23 can be
ordered (€5.99 incl. IPv4 + €1.20 backups), excl. VAT. **But see the
availability risk below — the price may not be buyable.**

**Ops burden:** high — the highest here. You are the sysadmin: OS
patching, firewall (Hetzner provides a free stateful firewall), reverse
proxy + TLS (Caddy with automatic Let's Encrypt, or Nginx + certbot),
Node process management (systemd/Docker), secrets as env files with
strict permissions, log rotation, monitoring/uptime checks, and backup
verification. No deploy pipeline unless you build one (git pull +
systemd restart, or a small CI job). In exchange: full control, no
platform constraints on the SQLite file, and the website and feed service
share one box.

**Fit for the license store:** excellent in the narrow sense — the SQLite
file sits on local NVMe and persists across reboots and deploys. The risk
moves entirely to backup discipline: enable the 20% automated backups
and/or snapshot the volume, and still keep an off-box export (a VPS disk
backup restores the whole box; a file export restores just the licenses).

**Risks:**

- **Availability — the headline risk, verified on hetzner.com/cloud in
  this pass (crawled 2026-11-08): the shared / Cost-Optimized plans show
  "Currently not available".** Hetzner's status page has carried a
  "Limited availability of cloud instances" notice since 26 Jun 2026,
  restricting new cloud servers for new customers (and some existing
  customers). Independent checks in Sep–Oct 2026 found all eight
  Cost-Optimized plans (CX/CAX) unorderable, with availability flickering
  by location and time of day. A price on an unorderable plan is not an
  offer: do not plan around €5.99/mo until the Console's create-server
  screen shows the plan orderable in the chosen location on the day of
  purchase. The reliably orderable fallback (CPX22, ~€19.99/mo) costs
  ~3× the headline price and erases the cost advantage over a $6–$7
  Droplet or a PaaS.
- **No free tier.** Hetzner Cloud has no free VPS tier (and no free
  trial for cloud servers). Separately, the Hetzner *inference-provider*
  free tier (the LLM provider, not the VPS) is also gone for new users —
  "Token creation disabled" in its own dashboard, checked Nov 2026.
  Do not confuse the two; neither is available.
- US pricing is ~3× EU pricing for the same plan (per Oct 2026 checks);
  EU traffic allowance is 20 TB/mo, US 1 TB, Singapore 0.5 TB. EU is the
  sensible region on price, which puts the service a continent away from
  a US-based operator — irrelevant at this traffic level, but note it.
- Account setup friction reported in 2026: identity verification
  (passport/ID upload) for new accounts.
- 99.9% uptime SLA (hetzner.com/cloud, verified in this pass). Single
  server = single point of failure; there is no managed failover.

## Option 5 — DigitalOcean Droplet (feed service + website on one box)

**What it would run:** both — same shape as Hetzner: feed service +
static website on one Droplet (Nginx/Caddy + Node).

**Cost (verified, digitalocean.com/pricing/droplets, crawled 2026-11-08):**

| Item | Price |
|---|---|
| Basic Droplet, 512 MiB / 1 vCPU / 10 GiB SSD / 500 GiB transfer | $4.00/mo |
| Basic Droplet, 1 GiB / 1 vCPU / 25 GiB SSD / 1,000 GiB transfer | $6.00/mo |
| Basic Droplet, 2 GiB / 1 vCPU / 50 GiB SSD / 2,000 GiB transfer | $12.00/mo |
| Basic Droplet, 4 GiB / 2 vCPU / 80 GiB SSD / 4,000 GiB transfer | $24.00/mo |
| Backups | +20% (weekly) or +30% (daily) of Droplet cost |
| Droplet snapshots | $0.06/GB/mo |
| Transfer overage | $0.01/GiB beyond the included allowance |

Per-second billing since 1 Jan 2026 (60-second / $0.01 minimum), with a
monthly cap — an always-on Droplet never exceeds its flat monthly price.
Public IPv4 is included on bundled plans. Inbound transfer is free.

**Estimated monthly cost for LibrePool:** ~$7.20/mo — the 1 GiB Droplet
($6) + weekly backups (+20%, $1.20). The $4 / 512 MiB Droplet is the
cheapest headline but is tight for Node + SQLite + future scrapers; $6
is the realistic minimum, $12 the comfortable one.

**Ops burden:** high, same as Hetzner (you are the sysadmin: patching,
firewall, reverse proxy + TLS, process management, secrets, monitoring).
Slightly lower friction than Hetzner in practice: no availability
problem, US/EU regions, a large documentation/community base, and a
straightforward console and API. No managed deploy pipeline — same
git-pull/systemd or CI setup as Hetzner.

**Fit for the license store:** excellent, same as Hetzner — local disk,
persistent across reboots/deploys; backup discipline is yours (weekly
backups add-on and/or snapshots + off-box file export).

**Risks:**

- The most expensive per-GB-of-RAM of the VPS options: 4 GiB costs $24/mo
  here vs ~€6/mo (if orderable) at Hetzner. At the 1–2 GiB size LibrePool
  needs, the absolute difference is a few dollars a month — do not
  over-weight it.
- Same single-server, single-point-of-failure shape as Hetzner.
- Backups are off by default and cost extra; snapshots are a separate
  line ($0.06/GB/mo — notably more than Hetzner's €0.0143/GB/mo).
- DigitalOcean also sells App Platform (PaaS) — **not priced here**; it
  was not verified in this pass and is not needed for this decision.

## Option 6 — Static-site hosting for the website (Cloudflare Pages; GitHub Pages noted)

**What it would run:** the website only. **It cannot run the feed
service**: Pages serves static files (and optional Pages Functions, which
run on Workers — no persistent process, no SQLite file, 10 ms CPU per
invocation on the free plan). Do not try to fit the feed service here.

**Cloudflare Pages — cost (verified, cloudflare.com Pages page, crawled
2026-11-08):**

| Item | Price |
|---|---|
| Free | $0 forever — unlimited sites, seats, requests, bandwidth |
| Pro | $25/mo billed monthly; $240/yr billed annually (= $20/mo) |
| Business | $250/mo billed monthly; $2,400/yr billed annually (= $200/mo) |
| Builds | 500/mo (Free) · 5,000/mo (Pro) · 20,000/mo (Business); 1 / 5 / 20 concurrent |
| Custom domains | 100 / 250 / 500 per project |
| Pages Functions (Workers) | billed separately on the Workers plan: Free 100,000 req/day; Workers Paid $5/mo [secondary, Oct 2026] |

**Estimated monthly cost for LibrePool:** **$0** on the Free plan — a
marketing/docs site is far inside 500 builds/mo and unlimited bandwidth.
No commercial-use restriction on the free plan (per Oct 2026 checks of
Cloudflare's terms) — relevant because the site sells a $19/yr product.

**Ops burden:** very low. Git-connected deploys (push to the site repo),
automatic TLS + CDN + DDoS protection, custom domain, preview
deployments. No server to patch.

**Risks:** Cloudflare-account-scoped build limits (not per-project);
Pages Functions limits if the site ever needs dynamic behaviour (it
should not — checkout lives at Stripe, license activation lives on the
feed service). Vendor lock-in is light: the site is static files, portable
anywhere.

**GitHub Pages — the alternative, and why it is second choice here:**
$0, custom domain with automatic HTTPS, 1 GB published site, soft
100 GB/mo bandwidth, 10 builds/hour [secondary, Oct–Nov 2026]. Two
reasons it ranks below Cloudflare Pages for LibrePool: GitHub's terms
say Pages is not for running an online business / e-commerce / SaaS
site, and the LibrePool site *is* the storefront for a paid product;
and the free tier requires a public repository (fine for an open-source
project, but the site repo would be public by necessity). If the site
were pure docs with no commerce, GitHub Pages would be equally good —
it is not the wrong answer, just the worse fit for a site that sells.

**Render static sites** are also free with no usage limits [secondary,
Oct 2026] and would be the zero-extra-vendor choice if Render hosts the
feed service — worth knowing, but Cloudflare Pages is the stronger
standalone static host (unlimited bandwidth, more builds, no commerce
restriction).

## Comparison table

Estimated costs are for LibrePool's actual shape (small always-on feed
service + static site), not the providers' headline minimums. Hetzner
EUR ≠ USD; do not compare the currencies directly.

| Option | Runs | Est. cost/mo | Persistent disk for the license store? | TLS | Secrets | Ops burden | Backups |
|---|---|---|---|---|---|---|---|
| Fly.io | Feed only | ~$3.85–$6.85 | Yes — Volume, 1 Machine, 1 region; daily snapshots, 5-day retention | Automatic | `fly secrets` | Medium | Volume snapshots (built-in); off-box export still needed |
| Railway | Feed only | ~$5–$10 (Hobby) | Yes — Volumes, built-in DB/volume backups | Automatic | Dashboard env vars | Low | Built-in (per pricing page); off-box export still needed |
| Render | Feed (+ static site free) | ~$7.25 (Hobby + Starter + 1 GB disk) | Only on paid instance ($0.25/GB/mo); Free = ephemeral, data lost | Automatic | Dashboard env vars | Low | Disk backup is your job; managed backups are Postgres-only |
| Hetzner VPS | Feed + site, one box | ~€7.19 if CX23 orderable (€5.99 + backups); ~€19.99+ on CPX22 fallback | Yes — local NVMe, persistent by nature | Your job (Caddy/Let's Encrypt) | Env files / systemd, your job | High | +20% add-on (7 slots) + snapshots €0.0143/GB/mo |
| DigitalOcean Droplet | Feed + site, one box | ~$7.20 (1 GiB + weekly backups) | Yes — local SSD, persistent by nature | Your job (Caddy/Let's Encrypt) | Env files / systemd, your job | High | +20% weekly / +30% daily; snapshots $0.06/GB/mo |
| Cloudflare Pages | Website only | $0 | **No — cannot host the feed service or its SQLite file** | Automatic | n/a (static) | Very low | Git is the backup |

What the table does not show, and matters more than the $2–$4/mo
spread: Railway's October 2026 secrets breach (the platform would hold
the signing key); Hetzner's cheapest plan being unorderable as of the
Nov 2026 check; Render's free tier being unusable for a stateful service;
and the fact that **every** option still needs an off-box license-store
export and a key-rotation plan — none of them supplies that by default.

## What to decide

Alex must decide the following. Nothing here is decided for him, and
nothing below has been bought, provisioned, or registered.

1. **Hosting choice — one decision, or two?** Feed service on a PaaS
   (Fly / Railway / Render) + website on Cloudflare Pages, or both on
   one VPS (Hetzner / DigitalOcean)? The split is ~$4–$10/mo for the
   feed service + $0 for the site; the single-box route is ~€6–€20/mo
   or ~$7–$12/mo all-in, with materially more sysadmin work. The cost
   gap is a few dollars a month either way — decide on ops burden and
   trust (see #5), not on price.
2. **If Hetzner: accept the availability risk?** The €5.99/mo CX23 price
   is only real if the Console shows it orderable in the chosen location
   on the day of purchase (it did not on 2026-11-08). Decide whether to
   wait/retry for a CX23, pay ~€19.99/mo for a CPX22, or drop Hetzner.
   Do not budget on the CX23 price until it is orderable.
3. **If Railway: accept the post-breach trust position?** The platform
   would hold the Stripe secret key and the Ed25519 signing private key
   less than a month after Railway disclosed decrypted environment
   variables. Decide whether that is acceptable, and if so, require a
   rehearsed key-rotation plan (fresh signing keypair + router public-key
   update + Stripe key rotation) before going live.
4. **Domain purchase.** `librepool.com` / `librepool.ai` were checked
   available in Nov 2026; nothing is bought and no registrar is chosen.
   Registrar pricing checked 6 Nov 2026 (Namecheap: librepool.com
   $12.08/yr) must be re-checked at purchase — prices and promos move.
   Decide: registrar, which TLD(s) to buy (`.com` only, or `.com` +
   `.ai`), and whether to buy through Cloudflare Registrar at wholesale
   (no markup, privacy included) instead. Also decide the feed hostname
   (`api.librepool.com` is the natural choice; the router's
   `DEFAULT_BASE_URL` currently points at `api.freellmapi.co`).
5. **TLS.** On a PaaS this is automatic; on a VPS it is a decision:
   Caddy (automatic Let's Encrypt, least work) vs Nginx + certbot.
   Either way, the feed hostname needs a valid public cert before Stripe
   webhooks can be configured.
6. **Secrets management.** Where do the production Ed25519 private key,
   Stripe secret key, webhook secret, and ranking keys live? Options:
   the host's secret store (Fly/Railway/Render dashboard), or files on
   the VPS with strict permissions. Rules that hold on every host: the
   production signing key is generated fresh on (or for) the host, never
   the dev keypair in `catalog/dev-keys/`; no secret ever enters the repo
   (that directory is git-ignored for a reason); Stripe keys must be
   rotatable without a redeploy of the router.
7. **Backup strategy for the license store.** Decide: backup mechanism
   (host snapshots/add-on + an off-box SQLite export — e.g. a scheduled
   export to object storage), backup frequency, restore test (actually
   restore it once), and the key-reissue plan for total loss (how buyers
   get a new key; the plaintext of issued keys cannot be recovered from
   hashes). Also decide the seed catalog's treatment: it ships with the
   deploy and is rebuildable, so it needs versioning, not backup.
8. **Stripe account + webhook endpoint.** Separate from hosting but
   gated on it: the Stripe account, the $19/yr price, and the webhook URL
   (`https://<feed-host>/v1/stripe/webhook`) cannot be configured until
   the host and hostname exist. The webhook secret then goes into the
   host's secret store (#6).
9. **What "production" means for uptime.** No option here is HA at these
   prices, and none needs to be yet: the router caches the last verified
   catalog and works offline, and Stripe retries webhooks. Decide the
   acceptable recovery story instead — who is paged (or emailed) when
   the feed is down, and how a rebuild/redeploy happens from the repo
   alone.

## Sources

- Fly.io pricing — https://fly.io/pricing — crawled 2026-11-08 07:05 UTC.
  Fly.io volumes docs — https://docs.fly.io/volumes/volume-manage —
  daily snapshots, 5-day retention; a volume attaches to one Machine.
- Railway pricing — https://railway.com/pricing — crawled 2026-11-08
  07:05 UTC (metered rates; plan fees corroborated by independent checks
  of the same page dated 5 Nov 2026). Railway Oct 2026 incident:
  disclosure 21 Oct 2026; preliminary report 22–23 Oct 2026 (upper bound
  1.85% of workspaces, ~100,000); resolved 24 Oct 2026, investigation
  ongoing — as reported in Oct 2026 coverage; not re-verified against
  Railway's own incident page in this pass.
- Render pricing — https://render.com/pricing — crawled 2026-11-08
  07:05 UTC; crawler returned the FAQ only (billing is workspace +
  compute + metered features; inactive-workspace fee waived). All Render
  prices in this doc are from independent Oct 2026 checks of
  render.com/pricing — re-check on the live page before committing.
- Hetzner Cloud — https://www.hetzner.com/cloud/ — crawled 2026-11-08
  07:06 UTC (shared / Cost-Optimized plans shown "Currently not
  available"; 99.9% SLA; locations Germany, Finland, Singapore, USA).
  Prices, June 2026 price rises, backup/snapshot rates, and the
  "limited availability" notice (since 26 Jun 2026) are from independent
  Oct 2026 checks of Hetzner's own price-adjustment page and Console —
  re-check on the live page before committing.
- DigitalOcean Droplet pricing —
  https://www.digitalocean.com/pricing/droplets — crawled 2026-11-08
  07:05 UTC.
- Cloudflare Pages — https://www.cloudflare.com/en-gb/developer-platform/products/pages/
  — crawled 2026-11-08 07:05 UTC. Workers Paid $5/mo and the
  no-commercial-restriction note are from Oct 2026 checks of Cloudflare's
  docs — re-check before relying on them.
- GitHub Pages limits/terms — independent Oct–Nov 2026 checks of GitHub
  Docs (1 GB site, soft 100 GB/mo bandwidth, 10 builds/hour; not for
  running an online business/e-commerce/SaaS) — not re-verified against
  GitHub Docs in this pass.
- LibrePool context: `catalog/README.md` (feed-service shape, endpoints,
  license store, env vars); implementation plan §7
  (`workspace/research_notes/librepool-implementation-plan/report.md`).
  Domain availability (librepool.com / librepool.ai) and the 6 Nov 2026
  Namecheap check are from prior LibrePool research, not re-verified in
  this pass.
