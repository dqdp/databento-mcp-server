/**
 * term-data — the day-cached CROSS-EXPIRATION payload for options on futures, served keyless
 * at GET /term/:root.json for the market-data skill's `--term` (and any local consumer).
 *
 * Why here and not in the skill: the inputs are LONG-DATED reference data (parent definitions,
 * parent statistics, per-underlying settlements) that Databento generates slowly server-side —
 * live probes (2026-07-05) measured 40-60s per OG.OPT definitions parent pull (an EMPTY
 * closed-day pull costs the same) and MINUTES for the whole-root statistics parent, with big
 * weekend variance. All of it is daily-static, so this module computes the reduction once per
 * (dataset, root, trading day) and every later call is a pure cache hit.
 *
 * The payload is the compact per-series shape the skill's gather_term consumes through a fetch
 * shim: REAL stems (weekly-vs-quarterly stays honest), the definition's own `underlying` SYMBOL
 * (never reconstructed — the NG year-width bug class), settlements in HUMAN units, and nulls for
 * unknowns (no OI record ≠ 0). Analytics stay in the skill; this is data hosting + caching.
 */
import { loadSmileStatic } from './smile-cache.js';
import { resolveOptionsRoot, type TimeseriesSource } from './pull-chain.js';
import { normalizeSettlements } from './databento-normalize.js';

export interface TermStrike {
  k: number;
  cSettle: number | null;
  pSettle: number | null;
  cOi: number | null;
  pOi: number | null;
}
export interface TermSeries {
  stem: string;
  expiration: string; // YYYY-MM-DD
  under: string | null;
  fwdSettle: number | null;
  strikes: TermStrike[];
}
export interface TermData {
  root: string;
  optionsRoot: string;
  dataset: string;
  asOf: string; // the requested trading day (cache key day)
  generatedAt: string;
  series: TermSeries[];
}

const DEFAULT_DATASET = 'GLBX.MDP3';
const MAX_ENTRIES = 32;
const STATIC_PULL_TIMEOUT_MS = 180_000; // per-symbol settle pulls are tiny; 3 min is generous
const cache = new Map<string, Promise<TermData>>(); // PROMISE-keyed: concurrent same-key misses
                                                    // coalesce into ONE slow pull set

export function clearTermDataCache(): void {
  cache.clear();
}

/** Settlement for one raw symbol (the underlying future) — tiny; ONE retry after a short
 * backoff (a transient 429 on a degraded day must not bake a null forward into the day-cache;
 * a series dropped for a missing forward would stay dropped all day). */
async function loadSymbolSettle(
  src: TimeseriesSource,
  symbol: string,
  opts: { asOf: string; end?: string; dataset?: string },
  attempt = 1,
): Promise<number | null> {
  try {
    const resp = await src.getRange({
      dataset: opts.dataset ?? DEFAULT_DATASET,
      symbols: symbol,
      stype_in: 'raw_symbol',
      stype_out: 'instrument_id',
      schema: 'statistics',
      // same 4-day lookback as loadDailyStats: a settlement is "last known <= asOf"
      start: new Date(Date.parse(`${opts.asOf}T00:00:00Z`) - 4 * 86_400_000).toISOString().slice(0, 10),
      end: opts.end,
      encoding: 'csv',
      timeout: STATIC_PULL_TIMEOUT_MS,
    });
    const m = normalizeSettlements(resp.data);
    // one symbol per pull -> every row is ours; last (any) value is the day's settlement
    let out: number | null = null;
    for (const v of m.values()) out = v;
    return out;
  } catch (e) {
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 2000));
      return loadSymbolSettle(src, symbol, opts, attempt + 1);
    }
    console.error(`[term] settle pull failed twice for ${symbol}: ${(e as Error).message}`);
    return null; // the consumer drops a forward-less series LOUDLY on its side; never a guess here
  }
}

export async function getTermData(
  src: TimeseriesSource,
  root: string,
  opts: { asOf: string; end?: string; dataset?: string; maxSeries?: number; maxDays?: number },
): Promise<TermData> {
  const rootUpper = root.toUpperCase();
  const optionsRoot = resolveOptionsRoot(rootUpper);
  const dataset = opts.dataset ?? DEFAULT_DATASET;
  const maxSeries = Math.min(24, Math.max(1, opts.maxSeries ?? 10));
  const maxDays = Math.min(800, Math.max(30, opts.maxDays ?? 400));
  const key = `${dataset}|${optionsRoot}|${opts.asOf}|${maxSeries}|${maxDays}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const started = Date.now();
  const work = (async () => {

  // defs + OI + SETTLEMENTS ride the existing day-cache (one defs parent + one stats parent,
  // shared with the smile path — a smile warm-up earlier in the day makes this half free).
  const { defs, oi, settle } = await loadSmileStatic(src, rootUpper, {
    asOf: opts.asOf,
    end: opts.end,
    dataset,
  });

  // group C/P defs by REAL stem (raw_symbol before the space) + expiration — two listings
  // sharing an expiration must never merge (stem uniqueness is a convention, not an invariant).
  type Bucket = { stem: string; expiration: string; under: string | null; byK: Map<number, TermStrike> };
  const buckets = new Map<string, Bucket>();
  for (const d of defs) {
    if (d.instrument_class !== 'C' && d.instrument_class !== 'P') continue;
    if (!d.raw_symbol || !d.raw_symbol.includes(' ') || d.strike == null || !d.expiration) continue;
    const stem = d.raw_symbol.split(' ', 1)[0];
    const bkey = `${stem}|${d.expiration}`;
    let b = buckets.get(bkey);
    if (!b) {
      b = { stem, expiration: d.expiration, under: d.underlying_symbol ?? null, byK: new Map() };
      buckets.set(bkey, b);
    }
    if (!b.under && d.underlying_symbol) b.under = d.underlying_symbol;
    let row = b.byK.get(d.strike);
    if (!row) {
      row = { k: d.strike, cSettle: null, pSettle: null, cOi: null, pOi: null };
      b.byK.set(d.strike, row);
    }
    const st = settle.get(d.instrument_id) ?? null;
    const o = oi.get(d.instrument_id) ?? null;
    if (d.instrument_class === 'C') {
      row.cSettle = st;
      row.cOi = o;
    } else {
      row.pSettle = st;
      row.pOi = o;
    }
  }

  const dayMs = 86_400_000;
  const t0 = Date.parse(`${opts.asOf}T00:00:00Z`);
  const eligible = [...buckets.values()]
    .filter((b) => {
      const e = Date.parse(`${b.expiration}T00:00:00Z`);
      return Number.isFinite(e) && e >= t0 && e <= t0 + maxDays * dayMs;
    })
    .sort((a, b) => a.expiration.localeCompare(b.expiration) || a.stem.localeCompare(b.stem))
    .slice(0, maxSeries);

  const unders = [...new Set(eligible.map((b) => b.under).filter((u): u is string => Boolean(u)))];
  const settles = new Map<string, number | null>();
  // <=3 concurrent symbol pulls: full fan-out trips the throttle on degraded days
  for (let i = 0; i < unders.length; i += 3) {
    await Promise.all(
      unders.slice(i, i + 3).map(async (u) => {
        settles.set(u, await loadSymbolSettle(src, u, { asOf: opts.asOf, end: opts.end, dataset }));
      }),
    );
  }

  const value: TermData = {
    root: rootUpper,
    optionsRoot,
    dataset,
    asOf: opts.asOf,
    generatedAt: new Date().toISOString(),
    series: eligible.map((b) => ({
      stem: b.stem,
      expiration: b.expiration,
      under: b.under,
      fwdSettle: b.under ? (settles.get(b.under) ?? null) : null,
      strikes: [...b.byK.values()].sort((x, y) => x.k - y.k),
    })),
  };

    console.error(`[term] ${key} reduced in ${Math.round((Date.now() - started) / 1000)}s ` +
      `(${value.series.length} series)`);
    return value;
  })();
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, work);
  work.catch(() => cache.delete(key)); // a failed pull must not poison the day
  return work;
}
