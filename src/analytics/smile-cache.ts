/**
 * smile-cache — memoize the STATIC half of a futures-options smile: the parent `definition`
 * set and the open-interest map. Both are daily-settlement reference data (strike/expiration/
 * underlying and OI don't change intraday), so a client refreshing the same root's smile
 * through the day reuses them instead of re-pulling the whole parent (two metered pulls) every
 * call. Keyed by (dataset, root, asOf) so a new trading day reloads. Bounded FIFO so stale days
 * don't accumulate.
 */
import type { DefinitionRec } from './chain.js';
import {
  INTERACTIVE_PULL_TIMEOUT_MS,
  loadDailyStats,
  loadDefinitions,
  resolveOptionsRoot,
  type TimeseriesSource,
} from './pull-chain.js';

export interface SmileStatic {
  defs: DefinitionRec[];
  oi: Map<number, number>;
  /** settlement price per instrument (stat 3, human units) — same pull as OI, kept for --term */
  settle: Map<number, number>;
}

const DEFAULT_DATASET = 'GLBX.MDP3';
const MAX_ENTRIES = 64;
const LOOKBACK_DAYS = 5;   // longest realistic exchange-holiday cluster
const cache = new Map<string, SmileStatic>();
const defsCache = new Map<string, Promise<DefinitionRec[]>>();

/** Definitions ONLY, day-cached with the closed-day walk. The 40-60s parent-definitions pull is
 * the expensive shared half; the smile path adds whole-root stats on top, the term path pulls a
 * scoped near-the-money stats window instead — both reuse this so the defs pull happens once/day. */
export async function loadDefsCached(
  src: TimeseriesSource,
  root: string,
  opts: { asOf: string; end?: string; dataset?: string; timeoutMs?: number },
): Promise<DefinitionRec[]> {
  root = resolveOptionsRoot(root);
  const key = `${opts.dataset ?? DEFAULT_DATASET}|${root}|${opts.asOf}`;
  const hit = defsCache.get(key);
  if (hit) return hit;
  // PROMISE-keyed (mirrors term-data's cache): two concurrent same-day callers — the realistic
  // case being a /smile poll and a /term cold pull for the same root — coalesce onto ONE 40-60s
  // parent-definitions pull instead of each running its own.
  const work = (async () => {
    // Closed-day lookback: a Saturday after a holiday has an EMPTY [asOf, end) definitions window;
    // walk asOf back (<= 5 days) to the last day that actually published definitions.
    let defs = await loadDefinitions(src, root, opts);
    for (let back = 1; defs.length === 0 && back <= LOOKBACK_DAYS; back++) {
      const day = new Date(Date.parse(`${opts.asOf}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
      defs = await loadDefinitions(src, root, { ...opts, asOf: day });
    }
    return defs;
  })();
  if (defsCache.size >= MAX_ENTRIES) {
    const oldest = defsCache.keys().next().value;
    if (oldest !== undefined) defsCache.delete(oldest);
  }
  defsCache.set(key, work);
  work.catch(() => { if (defsCache.get(key) === work) defsCache.delete(key); }); // don't cache a failed pull
  return work;
}

/** Load (or reuse) the static definitions + whole-root OI/settlement for a root as-of a day
 * (the SMILE path — most-liquid ranking needs OI across every series). */
export async function loadSmileStatic(
  src: TimeseriesSource,
  root: string,
  opts: { asOf: string; end?: string; dataset?: string },
): Promise<SmileStatic> {
  root = resolveOptionsRoot(root); // key + pulls on the options-chain parent root ("CL" -> "LO")
  const key = `${opts.dataset ?? DEFAULT_DATASET}|${root}|${opts.asOf}`;
  const hit = cache.get(key);
  if (hit) return hit;

  // interactive path: cap the pulls at INTERACTIVE_TIMEOUT so a degraded Databento day fails a
  // user-facing smile fast, rather than the 8-min term ceiling.
  const defs = await loadDefsCached(src, root, { ...opts, timeoutMs: INTERACTIVE_PULL_TIMEOUT_MS });
  const { oi, settle } = await loadDailyStats(src, root, { ...opts, timeoutMs: INTERACTIVE_PULL_TIMEOUT_MS });
  const value: SmileStatic = { defs, oi, settle };

  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
  return value;
}

/** Test hook: drop all cached static pulls. */
export function clearSmileStaticCache(): void {
  cache.clear();
  defsCache.clear();
}
