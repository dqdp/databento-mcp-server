/**
 * smile-cache — memoize the STATIC half of a futures-options smile: the parent `definition`
 * set and the open-interest map. Both are daily-settlement reference data (strike/expiration/
 * underlying and OI don't change intraday), so a client refreshing the same root's smile
 * through the day reuses them instead of re-pulling the whole parent (two metered pulls) every
 * call. Keyed by (dataset, root, asOf) so a new trading day reloads. Bounded FIFO so stale days
 * don't accumulate.
 */
import type { DefinitionRec } from './chain.js';
import { loadDefinitions, loadOpenInterest, type TimeseriesSource } from './pull-chain.js';

export interface SmileStatic {
  defs: DefinitionRec[];
  oi: Map<number, number>;
}

const DEFAULT_DATASET = 'GLBX.MDP3';
const MAX_ENTRIES = 64;
const cache = new Map<string, SmileStatic>();

/** Load (or reuse) the static definitions + OI for a root as-of a day. */
export async function loadSmileStatic(
  src: TimeseriesSource,
  root: string,
  opts: { asOf: string; end?: string; dataset?: string },
): Promise<SmileStatic> {
  // Keyed by (dataset, root, asOf) only — NOT `end`. `end` is just the query ceiling (it
  // advances every call as the historical feed catches up); the definitions/OI for a day are
  // static, so a later same-day call safely reuses the first pull's result.
  const key = `${opts.dataset ?? DEFAULT_DATASET}|${root}|${opts.asOf}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const defs = await loadDefinitions(src, root, opts);
  const oi = await loadOpenInterest(src, root, opts);
  const value: SmileStatic = { defs, oi };

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
}
