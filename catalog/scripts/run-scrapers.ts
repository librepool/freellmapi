/**
 * Scraper runner CLI — run-once polling of every registered scraper.
 *
 * Usage (from catalog/):
 *   node scripts/run-scrapers.ts [--seed <path>] [--state <path>] [--out <path>]
 *                                 [--platform <name>]... [--apply] [--help]
 *
 * Defaults (relative to catalog/):
 *   --seed  data/seed-catalog.json   (the catalog source of truth)
 *   --state data/scraper-state.json  (per-platform lastHash/lastCheckedAt/lastModelIds)
 *   --out   data/scraper-changes.json (the run report)
 *
 * Default run: polls all registered scrapers once each, writes the report
 * to --out, updates --state, prints a summary — and changes nothing else.
 * Stubs are recorded as skipped with their reason; robots-disallowed
 * polls are recorded as skipped with the robots.txt reason; fetch failures
 * are recorded as errors. No run ever deletes a seed row.
 *
 * --apply: ALSO applies the run's verified additions to the seed — new
 * list-verified models are added with premiumSince = today (live tier
 * immediately, free tier 15 days later via the snapshot rule) and the
 * catalog version is bumped to today's YYYY.MM.DD. A `<seed>.bak` backup
 * is written first. Removals are never applied.
 *
 * DEVELOPMENT SAFETY: never run --apply against the real seed while
 * testing. Test against a temp copy instead:
 *   cp data/seed-catalog.json /tmp/seed-test.json
 *   node scripts/run-scrapers.ts --seed /tmp/seed-test.json --state /tmp/state.json \
 *     --out /tmp/changes.json --apply
 *   diff data/seed-catalog.json /tmp/seed-test.json
 *
 * Scheduling: this runner is run-once; a long-running scheduler inside the
 * feed service is out of scope. See catalog/docs/scrapers.md for the cron /
 * systemd timer examples. One poll per platform per run, sequential —
 * never concurrent floods.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyScrapeToSeed, runScraper, ScraperStateStore } from '../src/scraper.ts';
import type { ScrapeReport } from '../src/scraper.ts';
import { loadSeed } from '../src/catalog-store.ts';
import { REGISTRY, registeredPlatforms, seedPlatforms } from '../src/scrapers/index.ts';
import type { SeedCatalog } from '../src/types.ts';

const CATALOG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function argAll(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]);
  });
  return out;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function usage(): void {
  console.log(`Usage: node scripts/run-scrapers.ts [--seed <path>] [--state <path>] [--out <path>]
                                 [--platform <name>]... [--apply] [--help]
Defaults (relative to catalog/):
  --seed  data/seed-catalog.json
  --state data/scraper-state.json
  --out   data/scraper-changes.json
Default run polls all registered scrapers once, writes the report, updates
state, and changes nothing else. --apply also adds verified models to the
seed (backup <seed>.bak first, version bumped to today). Never --apply
against the real seed during development — use a temp copy.`);
}

function seedChatIds(seed: SeedCatalog, platform: string): string[] {
  return seed.models.filter((m) => m.platform === platform).map((m) => m.modelId).sort();
}

async function main(): Promise<void> {
  if (hasFlag('help')) {
    usage();
    return;
  }
  const seedPath = path.resolve(arg('seed') ?? path.join(CATALOG_DIR, 'data/seed-catalog.json'));
  const statePath = path.resolve(arg('state') ?? path.join(CATALOG_DIR, 'data/scraper-state.json'));
  const outPath = path.resolve(arg('out') ?? path.join(CATALOG_DIR, 'data/scraper-changes.json'));
  const onlyPlatforms = argAll('platform');
  const apply = hasFlag('apply');

  const seed = loadSeed(seedPath);
  const store = new ScraperStateStore(statePath);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const platforms = (onlyPlatforms.length > 0 ? onlyPlatforms : registeredPlatforms()).sort();
  for (const p of platforms) {
    if (!REGISTRY[p]) {
      console.error(`unknown platform "${p}" — not in the registry`);
      process.exit(2);
    }
  }
  const missing = seedPlatforms(seed).filter((p) => !REGISTRY[p]);
  if (missing.length > 0) {
    console.error(`seed platforms with no registry entry: ${missing.join(', ')} — refusing to run`);
    process.exit(2);
  }

  const reports: ScrapeReport[] = [];
  for (const platform of platforms) {
    const entry = REGISTRY[platform];
    if (entry.kind === 'stub') {
      reports.push({
        platform,
        listUrl: null,
        kind: 'feed',
        status: 'skipped',
        checkedAt: nowIso,
        listHash: store.get(platform)?.lastHash ?? null,
        previousHash: store.get(platform)?.lastHash ?? null,
        addedModelIds: [],
        removedModelIds: [],
        verification: [],
        skippedReason: `stub: ${entry.reason ?? 'no usable list endpoint'}`,
        notes: entry.notes,
      });
      continue;
    }
    const scraper = entry.create();
    const prior = store.get(platform);
    const report = await runScraper(scraper, prior, seedChatIds(seed, platform), nowMs);
    reports.push(report);
    // State: record the attempt's timestamp always; hash/ids only on a
    // successful poll (a skipped/errored run must not clobber the baseline).
    if (report.status === 'changed' || report.status === 'unchanged') {
      const ids =
        report.status === 'changed'
          ? [...new Set([...(prior?.lastModelIds ?? seedChatIds(seed, platform)), ...report.addedModelIds])]
              .filter((id) => !report.removedModelIds.includes(id))
              .sort()
          : (prior?.lastModelIds ?? seedChatIds(seed, platform));
      store.set(platform, {
        lastHash: report.listHash,
        lastCheckedAt: nowIso,
        lastModelIds: ids,
      });
    } else if (prior) {
      store.set(platform, { ...prior, lastCheckedAt: nowIso });
    } else {
      store.set(platform, { lastHash: null, lastCheckedAt: nowIso, lastModelIds: seedChatIds(seed, platform) });
    }
  }

  store.save();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: nowIso, reports }, null, 2) + '\n', 'utf8');

  // Summary.
  let changed = 0;
  let added = 0;
  let removed = 0;
  let skipped = 0;
  let errored = 0;
  for (const r of reports) {
    if (r.status === 'changed') {
      changed += 1;
      added += r.addedModelIds.length;
      removed += r.removedModelIds.length;
      console.log(`changed   ${r.platform}: +${r.addedModelIds.length} -${r.removedModelIds.length} (hash ${(r.listHash ?? '').slice(0, 12)})`);
      for (const id of r.addedModelIds) {
        const v = r.verification.find((x) => x.modelId === id);
        console.log(`          + ${id} [${v?.level ?? 'unverified'}]`);
      }
      for (const id of r.removedModelIds) console.log(`          - ${id} (reported only, never auto-deleted)`);
      for (const n of r.notes ?? []) console.log(`          note: ${n}`);
    } else if (r.status === 'unchanged') {
      console.log(`unchanged ${r.platform}`);
    } else if (r.status === 'skipped') {
      skipped += 1;
      console.log(`skipped   ${r.platform}: ${r.skippedReason ?? ''}`);
    } else {
      errored += 1;
      console.log(`error     ${r.platform}: ${r.error ?? ''}`);
    }
  }
  console.log(`\n${reports.length} platforms: ${changed} changed (+${added}/-${removed}), ${skipped} skipped, ${errored} errors. Report: ${outPath}`);

  if (apply) {
    const result = applyScrapeToSeed(seed, reports, nowMs);
    if (result.added.length === 0) {
      console.log('--apply: nothing verified to add; seed unchanged.');
      if (result.removedReported.length > 0) {
        console.log(`--apply: ${result.removedReported.length} removal(s) reported for operator review, none deleted.`);
      }
      return;
    }
    const backupPath = `${seedPath}.bak`;
    fs.copyFileSync(seedPath, backupPath);
    fs.writeFileSync(seedPath, JSON.stringify(result.seed, null, 2) + '\n', 'utf8');
    console.log(`--apply: backup ${backupPath}`);
    console.log(`--apply: added ${result.added.length} model(s), version → ${result.seed.version}:`);
    for (const a of result.added) console.log(`          + ${a.platform}:${a.modelId} (premiumSince ${new Date(nowMs).toISOString().slice(0, 10)})`);
    for (const s of result.skipped) console.log(`          skipped ${s.platform}:${s.modelId} — ${s.reason}`);
    if (result.removedReported.length > 0) {
      console.log(`--apply: ${result.removedReported.length} removal(s) reported for operator review, none deleted.`);
    }
  }
}

main().catch((err) => {
  console.error(`run-scrapers failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
