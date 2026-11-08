/**
 * robots.txt handling for the per-provider scrapers.
 *
 * Before polling a provider's model-list URL, the scraper fetches
 * `<origin>/robots.txt` and skips the poll when the list path is disallowed
 * for the scraper's user-agent. This is the robots.txt exclusion protocol
 * (RFC 9309) as it applies to a polite poller:
 *
 *  - Groups are selected by User-agent: a group naming our user-agent wins
 *    over `User-agent: *`; if no group names us, the `*` groups apply.
 *  - Within the selected groups, Allow/Disallow are prefix rules on the
 *    URL path; the longest matching rule wins (an Allow longer than a
 *    Disallow re-allows that path). An empty Disallow allows everything.
 *  - No robots.txt (404) or a non-2xx fetch of it means "no restriction".
 *  - A network failure fetching robots.txt is treated as DISALLOWED
 *    (fail closed): the poll is skipped and retried on the next run
 *    rather than polling a host whose current rules we could not read.
 *
 * Note on scope: robots.txt governs crawling for indexing. The providers'
 * `/v1/models` endpoints are public, documented APIs that the router itself
 * calls — and several hosts disallow `/v1/` precisely to keep API responses
 * out of search indexes, not to forbid API clients. This module does not
 * second-guess that: a Disallow is a skip, full stop. The per-host
 * consequences are recorded in catalog/docs/scrapers.md; re-enabling a
 * disallowed poll needs a documented operator decision, not a flag.
 */

export const SCRAPER_USER_AGENT = 'LibrePool-scraper/1.0';

/** Thrown by a poll when the provider's robots.txt disallows the list URL. */
export class RobotsDisallowedError extends Error {
  readonly listUrl: string;
  readonly robotsUrl: string;

  constructor(listUrl: string, robotsUrl: string, reason: string) {
    super(`robots.txt disallows polling ${listUrl}: ${reason} (see ${robotsUrl})`);
    this.name = 'RobotsDisallowedError';
    this.listUrl = listUrl;
    this.robotsUrl = robotsUrl;
  }
}

export interface RobotsRules {
  /** Disallow path prefixes that apply to us (in file order). */
  disallows: string[];
  /** Allow path prefixes that apply to us (in file order). */
  allows: string[];
}

/**
 * Parse a robots.txt body into the rules that apply to `userAgent`.
 * Matching is case-insensitive on the agent token; the agent token is
 * matched as a prefix of the User-agent value (per RFC 9309 §2.3.1), so
 * `LibrePool-scraper` matches a `User-agent: LibrePool-scraper` group.
 * Unknown directives, comments (`# …`), and blank lines are ignored.
 */
export function parseRobotsTxt(text: string, userAgent: string = SCRAPER_USER_AGENT): RobotsRules {
  interface Group { agents: string[]; disallows: string[]; allows: string[] }
  const groups: Group[] = [];
  let current: Group | null = null;

  const agentToken = userAgent.split('/')[0].trim().toLowerCase();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent') {
      const token = value.toLowerCase();
      // A new User-agent line after rules starts a new group, unless the
      // previous group has no rules yet (consecutive User-agent lines
      // belong to the same group).
      if (!current || current.disallows.length > 0 || current.allows.length > 0) {
        current = { agents: [], disallows: [], allows: [] };
        groups.push(current);
      }
      current.agents.push(token);
    } else if (field === 'disallow' && current) {
      if (value !== '') current.disallows.push(value);
    } else if (field === 'allow' && current) {
      current.allows.push(value);
    }
    // Crawl-delay, Sitemap, Host, Content-Signal, etc. are ignored.
  }

  const matches = (group: Group): boolean =>
    group.agents.some((a) => a === '*' || a === agentToken || agentToken.startsWith(a));

  const named = groups.filter((g) => g.agents.some((a) => a !== '*' && (a === agentToken || agentToken.startsWith(a))));
  const applicable = named.length > 0 ? named : groups.filter((g) => g.agents.includes('*'));

  const disallows: string[] = [];
  const allows: string[] = [];
  for (const g of applicable) {
    if (matches(g)) {
      disallows.push(...g.disallows);
      allows.push(...g.allows);
    }
  }
  return { disallows, allows };
}

function longestPrefixMatch(pathname: string, prefixes: string[]): number {
  let best = -1;
  for (const p of prefixes) {
    if (p === '') continue;
    if (pathname.startsWith(p) && p.length > best) best = p.length;
  }
  return best;
}

/**
 * Longest-match rule: the longest Allow/Disallow prefix that matches the
 * path wins; ties go to Allow. No matching rule means allowed.
 */
export function isPathAllowed(pathname: string, rules: RobotsRules): boolean {
  const allowLen = longestPrefixMatch(pathname, rules.allows);
  const disallowLen = longestPrefixMatch(pathname, rules.disallows);
  if (allowLen === -1 && disallowLen === -1) return true;
  return allowLen >= disallowLen;
}

export interface RobotsCheckResult {
  allowed: boolean;
  /** Human-readable reason, used in the scrape report. */
  reason: string;
}

/**
 * Fetch `<origin>/robots.txt` for `listUrl` and decide whether the poll may
 * proceed. Returns (never throws) except for a fetch that rejects, which is
 * reported as disallowed (fail closed — see the module docstring).
 */
export async function checkRobotsTxt(
  listUrl: string,
  fetchImpl: typeof fetch = fetch,
  userAgent: string = SCRAPER_USER_AGENT,
): Promise<RobotsCheckResult> {
  const url = new URL(listUrl);
  const robotsUrl = `${url.origin}/robots.txt`;
  let res: Response;
  try {
    res = await fetchImpl(robotsUrl, {
      headers: { 'User-Agent': userAgent, Accept: 'text/plain' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return {
      allowed: false,
      reason: `robots.txt fetch failed (${err instanceof Error ? err.message : String(err)}) — poll skipped, will retry next run`,
    };
  }
  if (!res.ok) {
    // No robots.txt (404) or any other non-2xx: no restriction is published.
    return { allowed: true, reason: `no robots.txt (HTTP ${res.status})` };
  }
  const text = await res.text();
  const rules = parseRobotsTxt(text, userAgent);
  const pathname = url.pathname;
  if (isPathAllowed(pathname, rules)) {
    return { allowed: true, reason: 'robots.txt allows this path' };
  }
  const matched = [...rules.disallows].filter((d) => pathname.startsWith(d)).sort((a, b) => b.length - a.length)[0] ?? '';
  return {
    allowed: false,
    reason: `robots.txt disallows ${pathname} (matched Disallow: ${matched})`,
  };
}
