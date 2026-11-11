import { describe, it, expect, afterEach, vi } from 'vitest';

// #1593: the health pass cadence was a hardcoded 5 minutes, which operators on
// providers that dislike frequent key checks cannot slow down.
// HEALTH_CHECK_INTERVAL_MS now configures it, with a 60s floor so a
// typo can never turn the pass into provider-visible flood. The constants are
// read at module load, so every case re-imports the module with a fresh cache.

const DEFAULT_MS = 5 * 60 * 1000;

async function loadHealth() {
  vi.resetModules();
  return import('../../services/health.js');
}

describe('HEALTH_CHECK_INTERVAL_MS env (#1593)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to 5 minutes when unset', async () => {
    const m = await loadHealth();
    expect(m.HEALTH_CHECK_INTERVAL_MS).toBe(DEFAULT_MS);
  });

  it('honours a slower cadence', async () => {
    vi.stubEnv('HEALTH_CHECK_INTERVAL_MS', '1800000'); // 30 min
    // The scheduler runs at min(default, churn), so a slower default alone
    // would leave the pass on the 2-minute churn cadence — pin the churn
    // interval too so this case still exercises a 30-minute pass.
    vi.stubEnv('HEALTH_CHECK_INTERVAL_MS_CHURN', '1800000');
    const m = await loadHealth();
    expect(m.HEALTH_CHECK_INTERVAL_MS).toBe(1_800_000);
    // The jittered next-pass delay follows the configured cadence.
    expect(m.nextHealthCheckDelayMs(() => 0.5)).toBe(1_800_000);
  });

  it('honours a faster cadence down to the 60s floor', async () => {
    vi.stubEnv('HEALTH_CHECK_INTERVAL_MS', '60000');
    const m = await loadHealth();
    expect(m.HEALTH_CHECK_INTERVAL_MS).toBe(60_000);
    // The recency skip must stay under the interval or passes skip whole keys.
    expect(m.RECENT_CHECK_SKIP_MS).toBeLessThan(m.HEALTH_CHECK_INTERVAL_MS);
  });

  it('falls back to the default below the floor (flood guard)', async () => {
    vi.stubEnv('HEALTH_CHECK_INTERVAL_MS', '1000');
    const m = await loadHealth();
    expect(m.HEALTH_CHECK_INTERVAL_MS).toBe(DEFAULT_MS);
  });

  it('ignores junk values', async () => {
    vi.stubEnv('HEALTH_CHECK_INTERVAL_MS', 'not-a-number');
    const m = await loadHealth();
    expect(m.HEALTH_CHECK_INTERVAL_MS).toBe(DEFAULT_MS);
  });
});

// Phase A live-signal routing: the 16 churn-prone platforms get a faster
// health cadence (HEALTH_CHECK_INTERVAL_MS_CHURN, default 2 min) while every
// other platform keeps the 5-minute default exactly.
describe('HEALTH_CHECK_INTERVAL_MS_CHURN env (Phase A)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const CHURN_MS = 2 * 60 * 1000;
  const EXPECTED_CHURN = [
    'aihubmix', 'nous', 'llmtr', 'airforce', 'tokenharbor', 'mixlayer',
    'openrouter', 'xkiro', 'llm7', 'navy', 'nvidia', 'kilo',
    'routeway', 'bazaarlink', 'requesty', 'orcarouter',
  ];

  it('defaults the churn interval to 2 minutes', async () => {
    const m = await loadHealth();
    expect(m.HEALTH_CHECK_INTERVAL_MS_CHURN).toBe(CHURN_MS);
  });

  it('lists exactly the 16 churn-prone platforms', async () => {
    const m = await loadHealth();
    expect([...m.CHURN_PLATFORMS].sort()).toEqual([...EXPECTED_CHURN].sort());
    for (const slug of EXPECTED_CHURN) expect(m.isChurnPlatform(slug)).toBe(true);
    for (const slug of ['groq', 'openai', 'anthropic', 'custom', '']) {
      expect(m.isChurnPlatform(slug)).toBe(false);
    }
  });

  it('honours a valid churn interval', async () => {
    vi.stubEnv('HEALTH_CHECK_INTERVAL_MS_CHURN', '60000');
    const m = await loadHealth();
    expect(m.HEALTH_CHECK_INTERVAL_MS_CHURN).toBe(60_000);
    expect(m.healthCheckIntervalMsFor('openrouter')).toBe(60_000);
    expect(m.recentCheckSkipMsFor('openrouter')).toBe(42_000); // 60s * 0.7
  });

  it('falls back to the 2-minute default below the 60s floor', async () => {
    vi.stubEnv('HEALTH_CHECK_INTERVAL_MS_CHURN', '1000');
    const m = await loadHealth();
    expect(m.HEALTH_CHECK_INTERVAL_MS_CHURN).toBe(CHURN_MS);
  });

  it('ignores junk churn values', async () => {
    for (const junk of ['not-a-number', '', '0', '-5000', '1.5']) {
      vi.stubEnv('HEALTH_CHECK_INTERVAL_MS_CHURN', junk);
      const m = await loadHealth();
      expect(m.HEALTH_CHECK_INTERVAL_MS_CHURN).toBe(CHURN_MS);
      vi.unstubAllEnvs();
    }
  });

  it('gives churn platforms the churn interval and others the default', async () => {
    const m = await loadHealth();
    for (const slug of EXPECTED_CHURN) {
      expect(m.healthCheckIntervalMsFor(slug)).toBe(CHURN_MS);
    }
    for (const slug of ['groq', 'openai', 'custom']) {
      expect(m.healthCheckIntervalMsFor(slug)).toBe(DEFAULT_MS);
    }
  });

  it('gives churn keys a shorter recency skip, non-churn keys the old one', async () => {
    const m = await loadHealth();
    // Churn: 2 min * 0.7 = 84s. Non-churn: min(3.5 min, 5 min * 0.7) = 3.5 min,
    // exactly RECENT_CHECK_SKIP_MS as before.
    expect(m.recentCheckSkipMsFor('openrouter')).toBe(84_000);
    expect(m.recentCheckSkipMsFor('groq')).toBe(3.5 * 60 * 1000);
    expect(m.recentCheckSkipMsFor('groq')).toBe(m.RECENT_CHECK_SKIP_MS);
  });

  it('schedules the pass at min(default, churn)', async () => {
    // Defaults: min(5 min, 2 min) = 2 min.
    const m = await loadHealth();
    expect(m.HEALTH_CHECK_SCHEDULER_INTERVAL_MS).toBe(CHURN_MS);
    expect(m.nextHealthCheckDelayMs(() => 0.5)).toBe(CHURN_MS);
  });

  it('a faster default interval wins the scheduler when it is below churn', async () => {
    vi.stubEnv('HEALTH_CHECK_INTERVAL_MS', '60000');
    const m = await loadHealth();
    expect(m.HEALTH_CHECK_SCHEDULER_INTERVAL_MS).toBe(60_000);
    expect(m.nextHealthCheckDelayMs(() => 0.5)).toBe(60_000);
  });

  it('a slower churn interval leaves the scheduler on the default', async () => {
    vi.stubEnv('HEALTH_CHECK_INTERVAL_MS_CHURN', '1800000');
    const m = await loadHealth();
    expect(m.HEALTH_CHECK_SCHEDULER_INTERVAL_MS).toBe(DEFAULT_MS);
    expect(m.nextHealthCheckDelayMs(() => 0.5)).toBe(DEFAULT_MS);
    // ...but churn keys still skip on the churn cadence.
    expect(m.recentCheckSkipMsFor('openrouter')).toBe(3.5 * 60 * 1000);
  });
});
