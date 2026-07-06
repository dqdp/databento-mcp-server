/**
 * smile-cache — memoize the STATIC half of a futures-options smile: the parent `definition`
 * set and the open-interest map. Both are daily-settlement reference data (strike/expiration/
 * underlying and OI don't change intraday), so a client refreshing the same root's smile
 * through the day reuses them instead of re-pulling the whole parent (two metered pulls) every
 * call. Keyed by (dataset, root, asOf) so a new trading day reloads. Bounded FIFO so stale days
 * don't accumulate.
 */
import type { DefinitionRec } from './chain.js';
import { INTERACTIVE_PULL_TIMEOUT_MS, loadDailyStats, resolveOptionsRoot, type TimeseriesSource } from './pull-chain.js';
import { clearDefsCatalog, loadDefsCatalog } from './defs-catalog.js';

export interface SmileStatic {
  defs: DefinitionRec[];
  oi: Map<number, number>;
  /** settlement price per instrument (stat 3, human units) — same pull as OI, kept for --term */
  settle: Map<number, number>;
}

const DEFAULT_DATASET = 'GLBX.MDP3';
const MAX_ENTRIES = 64;
const cache = new Map<string, SmileStatic>();

/** Definitions ONLY for a root. Delegates to the LONG-LIVED, root-keyed defs-catalog (persisted +
 * incrementally refreshed) — definitions are stable reference data, so a new trading day no longer
 * re-pulls the whole ~37k snapshot; it's served instantly from the catalog. The closed-day walk and
 * promise-coalescing live in the catalog. Kept as a thin alias so existing callers don't change. */
export function loadDefsCached(
  src: TimeseriesSource,
  root: string,
  opts: { asOf: string; end?: string; dataset?: string; timeoutMs?: number },
): Promise<DefinitionRec[]> {
  return loadDefsCatalog(src, root, opts);
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
  clearDefsCatalog();
}
