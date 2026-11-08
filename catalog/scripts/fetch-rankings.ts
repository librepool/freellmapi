/**
 * Ranking fetch job — pull benchmark scores into the seed catalog.
 *
 * Usage (from catalog/):
 *   node scripts/fetch-rankings.ts [--dry-run] [--apply]
 *     [--seed <path>] [--map <path>] [--budget <path>] [--livebench <path>]
 *     [--sources aa,benchlm,livebench] [--offline]
 *
 * Default is --dry-run: fetch (or read the snapshot/cache), print what
 * would change, write NOTHING to the seed catalog. --apply merges the
 * fetched scores into the seed's per-model `benchmarks` fields + sourceDate
 * and writes the seed back, after writing a `<seed>.bak` backup first
 * (`*.bak` is git-ignored).
 *
 * --offline reads only the cached raw snapshots
 * (`data/catalog.ranking-cache-<source>.json`, written by a previous live
 * run) plus the LiveBench file — no network, no budget consumed.
 *
 * IMPORTANT — quota: a dry run still FETCHES, so it still consumes provider
 * quota (AA 100 req/day, BenchLM 250 reads/month) and still updates the
 * budget file and the raw-snapshot cache. "Writes nothing" means the seed
 * catalog only. Run --offline --dry-run when you want a zero-quota preview.
 *
 * NEVER run --apply against the real catalog/data/seed-catalog.json during
 * development — test against temp copies only (--seed /tmp/seed-test.json).
 * Keys come from the environment (or catalog/.env, loaded the same way
 * src/index.ts loads it): LIBREPOOL_RANKING_AA_KEY,
 * LIBREPOOL_RANKING_BENCHLM_KEY. LiveBench has no API key — see
 * src/ranking-fetch.ts for the snapshot-file procedure. A source whose key
 * (or file) is missing is skipped with a warning, not an error.
 *
 * Exit codes: 0 = all requested sources fetched (or were skipped for a
 * missing key/file) and the seed was (or would be) written; 1 = a requested
 * source failed (HTTP error, budget exhausted, malformed payload) or the
 * seed could not be read/written; 2 = usage error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSeed } from '../src/catalog-store.ts';
import {
  ENV_AA_KEY,
  ENV_BENCHLM_KEY,
  RankingFetchError,
  budgetStatus,
  defaultPaths,
  fetchAa,
  fetchBenchlm,
  fetchFromCache,
  loadBudget,
  loadLivebenchSnapshot,
  loadModelMap,
  mergeBenchmarks,
  validateModelMapTargets,
  type ModelMap,
  type RankingSource,
  type SourceResult,
} from '../src/ranking-fetch.ts';
import type { SeedCatalog } from '../src/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_ROOT = path.resolve(__dirname, '..');

const ALL_SOURCES: RankingSource[] = ['aa', 'benchlm', 'livebench'];

interface Options {
  dryRun: boolean;
  apply: boolean;
  seedPath: string;
  mapPath: string;
  budgetPath: string;
  livebenchPath: string;
  sources: RankingSource[];
  offline: boolean;
}

function usageError(message: string): never {
  console.error(`error: ${message}`);
  console.error(
    'usage: node scripts/fetch-rankings.ts [--dry-run] [--apply] [--seed <path>] [--map <path>] [--budget <path>] [--livebench <path>] [--sources aa,benchlm,livebench] [--offline]',
  );
  process.exit(2);
}

/** Mirror src/index.ts's tiny .env loader (no dependency): keys may live
 *  in catalog/.env. Shell environment wins over .env. */
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

function parseArgs(argv: string[]): Options {
  const defaults = defaultPaths();
  const opts: Options = {
    dryRun: true,
    apply: false,
    seedPath: path.join(CATALOG_ROOT, 'data', 'seed-catalog.json'),
    mapPath: defaults.map,
    budgetPath: defaults.budget,
    livebenchPath: defaults.livebench,
    sources: [...ALL_SOURCES],
    offline: false,
  };
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);
  if (has('help') || has('h')) {
    console.log(
      'node scripts/fetch-rankings.ts [--dry-run] [--apply] [--seed <path>] [--map <path>] [--budget <path>] [--livebench <path>] [--sources aa,benchlm,livebench] [--offline]\n' +
        'Default is --dry-run (prints what would change; seed untouched). --apply writes the seed back with a .bak backup first.',
    );
    process.exit(0);
  }
  if (has('apply')) {
    opts.apply = true;
    opts.dryRun = false;
  }
  if (has('dry-run')) {
    opts.dryRun = true;
    opts.apply = false;
  }
  if (has('offline')) opts.offline = true;
  const seed = arg('seed');
  if (seed) opts.seedPath = path.resolve(seed);
  const map = arg('map');
  if (map) opts.mapPath = path.resolve(map);
  const budget = arg('budget');
  if (budget) opts.budgetPath = path.resolve(budget);
  const livebench = arg('livebench');
  if (livebench) opts.livebenchPath = path.resolve(livebench);
  const sources = arg('sources');
  if (sources !== undefined) {
    const list = sources
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean) as RankingSource[];
    if (list.length === 0) usageError('--sources needs at least one of aa,benchlm,livebench');
    for (const s of list) {
      if (!ALL_SOURCES.includes(s)) usageError(`unknown source "${s}" (want aa, benchlm, livebench)`);
    }
    opts.sources = list;
  }
  for (const a of argv) {
    if (a.startsWith('--') && !['--dry-run', '--apply', '--offline', '--help', '--h'].includes(a)) {
      const name = a.slice(2);
      if (!['seed', 'map', 'budget', 'livebench', 'sources'].includes(name)) usageError(`unknown flag ${a}`);
    }
  }
  return opts;
}

function printSourceReport(result: SourceResult): void {
  const label = result.source === 'aa' ? 'AA' : result.source === 'benchlm' ? 'BenchLM' : 'LiveBench';
  console.log(
    `  ${label}: ${result.rawCount} rows, ${result.matchedCount} catalog models scored` +
      (result.partial ? ' (PARTIAL — source paginated past the single request; see ranking-fetch.ts)' : '') +
      (result.fromCache ? ' (from cache, no network)' : '') +
      ` [${result.version}, fetched ${result.fetchedAt}]`,
  );
  if (result.unmatched.length > 0) {
    const shown = result.unmatched.slice(0, 50);
    console.log(`    unmatched source rows (${result.unmatched.length}): ${shown.join('; ')}${result.unmatched.length > 50 ? '; …' : ''}`);
    console.log('    (Add exact mappings for these to the model map — never guess. Unmatched stays Unranked.)');
  }
  if (result.unscored.length > 0) {
    console.log(`    rows with no parseable score (${result.unscored.length}): ${result.unscored.slice(0, 20).join('; ')}`);
  }
}

async function main(): Promise<number> {
  loadDotEnv();
  const opts = parseArgs(process.argv.slice(2));
  const paths = defaultPaths();

  let seed: SeedCatalog;
  try {
    seed = loadSeed(opts.seedPath);
  } catch (err) {
    console.error(`error: cannot load seed catalog at ${opts.seedPath}: ${(err as Error).message}`);
    return 1;
  }
  let map: ModelMap;
  try {
    map = loadModelMap(opts.mapPath);
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    return 1;
  }
  const catalogKeys = new Set(seed.models.map((m) => `${m.platform}:${m.modelId}`));
  const unknownTargets = validateModelMapTargets(map, catalogKeys);
  if (unknownTargets.length > 0) {
    console.warn(`warning: model map targets ${unknownTargets.length} catalog key(s) not in the seed: ${unknownTargets.join(', ')} (stale entries — inert, but clean them up)`);
  }

  const results: SourceResult[] = [];
  const skipped: string[] = [];
  let failed = false;

  for (const source of opts.sources) {
    try {
      if (source === 'aa') {
        const key = process.env[ENV_AA_KEY] ?? '';
        if (opts.offline) {
          const cached = fetchFromCache('aa', paths.cacheAa, map);
          if (!cached) { skipped.push('aa (offline: no cache at data/catalog.ranking-cache-aa.json)'); continue; }
          results.push(cached);
          continue;
        }
        if (!key) { skipped.push(`aa (no ${ENV_AA_KEY} in environment)`); continue; }
        results.push(await fetchAa(key, map, { budgetPath: opts.budgetPath, cachePath: paths.cacheAa }));
      } else if (source === 'benchlm') {
        const key = process.env[ENV_BENCHLM_KEY] ?? '';
        if (opts.offline) {
          const cached = fetchFromCache('benchlm', paths.cacheBenchlm, map);
          if (!cached) { skipped.push('benchlm (offline: no cache at data/catalog.ranking-cache-benchlm.json)'); continue; }
          results.push(cached);
          continue;
        }
        if (!key) { skipped.push(`benchlm (no ${ENV_BENCHLM_KEY} in environment)`); continue; }
        results.push(await fetchBenchlm(key, map, { budgetPath: opts.budgetPath, cachePath: paths.cacheBenchlm }));
      } else {
        const snapshot = loadLivebenchSnapshot(opts.livebenchPath, map);
        if (!snapshot) { skipped.push(`livebench (no snapshot file at ${opts.livebenchPath})`); continue; }
        results.push(snapshot);
      }
    } catch (err) {
      failed = true;
      if (err instanceof RankingFetchError) {
        console.error(`error: ${source} fetch failed [${err.code}]: ${err.message}`);
      } else {
        console.error(`error: ${source} fetch failed: ${(err as Error).message}`);
      }
    }
  }

  console.log(`\nRanking fetch — ${opts.dryRun ? 'DRY RUN (seed untouched)' : 'APPLY'} — seed ${opts.seedPath}`);
  for (const r of results) printSourceReport(r);
  for (const s of skipped) console.log(`  skipped: ${s}`);
  if (results.length === 0) {
    console.log('nothing fetched — no changes.');
    return failed ? 1 : 0;
  }

  const merged = mergeBenchmarks(seed, results);
  const chatTotal = seed.models.filter((m) => (m.modality ?? 'text') === 'text').length;
  const scoredAfter = seed.models.filter((m) => {
    const key = `${m.platform}:${m.modelId}`;
    const b = merged.seed.models.find((x) => `${x.platform}:${x.modelId}` === key)?.benchmarks;
    return b && (b.aa != null || b.livebench != null || b.benchlm != null);
  }).length;
  console.log(`\nmerge: ${merged.changed.length} model(s) would change benchmarks, ${merged.matched.length} matched this run`);
  console.log(`coverage after merge: ${scoredAfter}/${chatTotal} chat models carry ≥1 benchmark source (${chatTotal - scoredAfter} Unranked)`);
  for (const key of merged.changed) {
    const before = seed.models.find((m) => `${m.platform}:${m.modelId}` === key)?.benchmarks;
    const after = merged.seed.models.find((m) => `${m.platform}:${m.modelId}` === key)?.benchmarks;
    console.log(`  ${key}: ${JSON.stringify(before ?? null)} -> ${JSON.stringify(after)}`);
  }
  if (merged.changed.length === 0) console.log('  (no benchmark values changed — seed already up to date)');

  // Budget state after the run (budget + cache files ARE written even on a
  // dry run — they record quota actually consumed; only the seed is untouched).
  try {
    const budget = loadBudget(opts.budgetPath);
    const nowMs = Date.now();
    for (const source of ['aa', 'benchlm'] as const) {
      const status = budgetStatus(budget, source, nowMs);
      console.log(`budget ${source}: ${status.used}/${status.limit} used, ${status.remaining} remaining, resets ${status.resetsAt}`);
    }
  } catch (err) {
    console.warn(`warning: could not read budget file: ${(err as Error).message}`);
  }

  if (opts.dryRun) {
    console.log('\ndry run — seed NOT written. Re-run with --apply to write it (a .bak backup is written first).');
    return failed ? 1 : 0;
  }

  if (merged.changed.length === 0) {
    console.log('no changes — seed untouched, no backup written.');
    return failed ? 1 : 0;
  }
  const backupPath = `${opts.seedPath}.bak`;
  fs.copyFileSync(opts.seedPath, backupPath);
  fs.writeFileSync(opts.seedPath, JSON.stringify(merged.seed, null, 2) + '\n');
  console.log(`\nwrote ${opts.seedPath} (${merged.changed.length} models changed; backup at ${backupPath})`);
  return failed ? 1 : 0;
}

process.exitCode = await main();
