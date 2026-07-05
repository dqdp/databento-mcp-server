/**
 * term-data — the day-cached CROSS-EXPIRATION payload for options on futures, served keyless
 * at GET /term/:root.json for the market-data skill's `--term` (and any local consumer).
 *
 * Why here and not in the skill: the inputs are LONG-DATED reference data that Databento
 * generates slowly server-side. All of it is daily-static, so this module computes the reduction
 * once per (dataset, root, trading day) and every later call is a pure cache hit.
 *
 * PAYLOAD BOUND (2026-07-05): we do NOT pull the whole-root statistics parent (GC = ~37k
 * instruments, minutes -> 503). Instead: cached definitions give every series' strike ladder; a
 * tiny per-underlying settlement pull gives each series' forward; then statistics are pulled ONLY
 * for the strikes within a MONEYNESS BAND (±`band`) of each series' forward. That band covers the
 * 80-120% IV surface and the ±25-strike switcher; the far tails (all-n/a anyway) are never pulled.
 *
 * The payload is the compact per-series shape the skill's gather_term consumes through a fetch
 * shim: REAL stems (weekly-vs-quarterly honest), the definition's own `underlying` SYMBOL (never
 * reconstructed — the NG year-width bug class), settlements in HUMAN units, nulls for unknowns.
 */
import { loadDefsCached } from './smile-cache.js';
import { loadStatsForIds, resolveOptionsRoot, type TimeseriesSource } from './pull-chain.js';

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
  band: number; // the moneyness half-width the strikes were pulled within
  series: TermSeries[];
}

const DEFAULT_DATASET = 'GLBX.MDP3';
const MAX_ENTRIES = 32;
const DEFAULT_BAND = 0.25; // ±25% moneyness — covers the 80-120% surface + the ±25-strike switcher
const cache = new Map<string, Promise<TermData>>(); // PROMISE-keyed: concurrent same-key misses
                                                    // coalesce into ONE slow pull set

export function clearTermDataCache(): void {
  cache.clear();
}

function termKey(dataset: string, optionsRoot: string, asOf: string, maxSeries: number, maxDays: number, band: number): string {
  return `${dataset}|${optionsRoot}|${asOf}|${maxSeries}|${maxDays}|${band}`;
}

/** Is a (root, day) payload already reduced & cached? Instant, pulls NOTHING — the /term?probe
 * path uses it so the skill can say "in cache, no wait" BEFORE committing to a slow cold pull. */
export function isTermCached(
  root: string,
  opts: { asOf: string; dataset?: string; maxSeries?: number; maxDays?: number; band?: number },
): boolean {
  const dataset = opts.dataset ?? DEFAULT_DATASET;
  const maxSeries = Math.min(24, Math.max(1, opts.maxSeries ?? 10));
  const maxDays = Math.min(800, Math.max(30, opts.maxDays ?? 400));
  const band = opts.band ?? DEFAULT_BAND;
  return cache.has(termKey(dataset, resolveOptionsRoot(root.toUpperCase()), opts.asOf, maxSeries, maxDays, band));
}

export async function getTermData(
  src: TimeseriesSource,
  root: string,
  opts: { asOf: string; end?: string; dataset?: string; maxSeries?: number; maxDays?: number; band?: number },
): Promise<TermData> {
  const rootUpper = root.toUpperCase();
  const optionsRoot = resolveOptionsRoot(rootUpper);
  const dataset = opts.dataset ?? DEFAULT_DATASET;
  const maxSeries = Math.min(24, Math.max(1, opts.maxSeries ?? 10));
  const maxDays = Math.min(800, Math.max(30, opts.maxDays ?? 400));
  const band = opts.band ?? DEFAULT_BAND;
  const key = termKey(dataset, optionsRoot, opts.asOf, maxSeries, maxDays, band);
  const hit = cache.get(key);
  if (hit) return hit;
  const started = Date.now();
  const work = (async () => {
    // defs ONLY (cached) — never the whole-root stats pull.
    const defs = await loadDefsCached(src, rootUpper, { asOf: opts.asOf, end: opts.end, dataset });

    // group C/P defs by REAL stem (raw_symbol before the space) + expiration.
    type Bucket = {
      stem: string;
      expiration: string;
      under: string | null; // the underlying future SYMBOL (for the payload)
      underId: number | null; // its instrument_id (from the def's underlying_id) — forwards are pulled by it
      byK: Map<number, { cId?: number; pId?: number }>;
    };
    const buckets = new Map<string, Bucket>();
    for (const d of defs) {
      if (d.instrument_class !== 'C' && d.instrument_class !== 'P') continue;
      if (!d.raw_symbol || !d.raw_symbol.includes(' ') || d.strike == null || !d.expiration) continue;
      const stem = d.raw_symbol.split(' ', 1)[0];
      const bkey = `${stem}|${d.expiration}`;
      let b = buckets.get(bkey);
      if (!b) {
        const uid = Number(d.underlying);
        b = {
          stem,
          expiration: d.expiration,
          under: d.underlying_symbol ?? null,
          underId: Number.isFinite(uid) && uid > 0 ? uid : null,
          byK: new Map(),
        };
        buckets.set(bkey, b);
      }
      if (!b.under && d.underlying_symbol) b.under = d.underlying_symbol;
      let row = b.byK.get(d.strike);
      if (!row) {
        row = {};
        b.byK.set(d.strike, row);
      }
      if (d.instrument_class === 'C') row.cId = d.instrument_id;
      else row.pId = d.instrument_id;
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

    // forwards FIRST (needed to window strikes). Each series' underlying future is identified by
    // its instrument_id (the def's underlying_id), so ALL forwards come from ONE statistics pull by
    // id instead of N per-symbol pulls — the per-pull latency, not the byte volume, is the cost.
    const underIds = [...new Set(eligible.map((b) => b.underId).filter((u): u is number => u != null))];
    const fwdById = (await loadStatsForIds(src, underIds, { asOf: opts.asOf, end: opts.end, dataset })).settle;

    // window each series to the moneyness band around ITS forward; collect only those ids.
    const plan = eligible.map((b) => {
      const F = b.underId != null ? fwdById.get(b.underId) ?? null : null;
      if (F == null || F <= 0) return { b, F: null as number | null, keptK: [] as number[] };
      const lo = F * (1 - band);
      const hi = F * (1 + band);
      const keptK = [...b.byK.keys()].filter((k) => k >= lo && k <= hi).sort((x, y) => x - y);
      return { b, F, keptK };
    });
    const wantIds: number[] = [];
    for (const p of plan) {
      for (const k of p.keptK) {
        const row = p.b.byK.get(k)!;
        if (row.cId != null) wantIds.push(row.cId);
        if (row.pId != null) wantIds.push(row.pId);
      }
    }

    const { oi, settle } = await loadStatsForIds(src, wantIds, { asOf: opts.asOf, end: opts.end, dataset });

    const value: TermData = {
      root: rootUpper,
      optionsRoot,
      dataset,
      asOf: opts.asOf,
      generatedAt: new Date().toISOString(),
      band,
      series: plan
        .filter((p) => p.F != null)
        .map((p) => ({
          stem: p.b.stem,
          expiration: p.b.expiration,
          under: p.b.under,
          fwdSettle: p.F,
          strikes: p.keptK.map((k) => {
            const row = p.b.byK.get(k)!;
            return {
              k,
              cSettle: row.cId != null ? settle.get(row.cId) ?? null : null,
              pSettle: row.pId != null ? settle.get(row.pId) ?? null : null,
              cOi: row.cId != null ? oi.get(row.cId) ?? null : null,
              pOi: row.pId != null ? oi.get(row.pId) ?? null : null,
            };
          }),
        })),
    };
    console.error(
      `[term] ${key} reduced in ${Math.round((Date.now() - started) / 1000)}s ` +
        `(${value.series.length} series, ${wantIds.length} strikes pulled)`,
    );
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
