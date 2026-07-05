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
 * for a PROGRESSIVE strike grid (selectWindowStrikes) — coarsened near the money (drops an over-fine
 * exchange grid like gold's $5), widening into the wings, capped at MAX_STRIKES per series, spanning
 * the full ±`band` width. Fewer strikes -> a faster scoped stats pull, without narrowing the width.
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
const DEFAULT_BAND = 0.25; // moneyness half-width the strikes span (±25% -> covers the 80-120% surface)
// The skill's IV-surface moneyness columns (must match futures_options.TERM_BUCKETS): guaranteed a
// nearest-listed strike each, so the surface stays whole even where the progressive walk skipped one.
const SURFACE_BUCKETS = [0.8, 0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15, 1.2];
const STRIKE_FLOOR_PCT = 0.0024; // min gap NEAR the money ~0.25% of F (gold ~$10 -> drops the $5 grid)
const STRIKE_GROWTH = 0.2; // wing gap grows to ~20% of the distance from ATM (progressive: dense->sparse)
const MAX_STRIKES = 45; // hard cap per series (user rule 2026-07-05): fewer strikes -> faster stats pull,
                        // full ±band width kept (the point was to coarsen the grid, NOT narrow it)

/** Strikes to pull for one series — a PROGRESSIVE grid anchored on the ATM: a min gap near the money
 * (drops an over-fine exchange grid like gold's $5) that WIDENS toward the wings, so the full ±band
 * moneyness width is covered by few points. The ATM is always kept; the surface buckets are
 * guaranteed; a hard MAX_STRIKES cap thins the densest interior (never the ATM, the extremes, or a
 * bucket strike) so a series never balloons the pull regardless of how fine the grid is. */
function selectWindowStrikes(allStrikes: number[], F: number, band = DEFAULT_BAND): number[] {
  const sorted = [...new Set(allStrikes)].sort((a, b) => a - b);
  if (sorted.length === 0 || !(F > 0)) return sorted;
  let atm = 0;
  for (let i = 1; i < sorted.length; i++) if (Math.abs(sorted[i] - F) < Math.abs(sorted[atm] - F)) atm = i;
  const lo = F * (1 - band);
  const hi = F * (1 + band);
  const floorGap = STRIKE_FLOOR_PCT * F;
  const kept = new Set<number>([sorted[atm]]);
  let last = sorted[atm]; // walk UP: keep a strike once it clears max(floor, growth*distance-from-ATM)
  for (let i = atm + 1; i < sorted.length && sorted[i] <= hi; i++) {
    if (sorted[i] - last >= Math.max(floorGap, STRIKE_GROWTH * (sorted[i] - F))) {
      kept.add(sorted[i]);
      last = sorted[i];
    }
  }
  last = sorted[atm]; // walk DOWN
  for (let i = atm - 1; i >= 0 && sorted[i] >= lo; i--) {
    if (last - sorted[i] >= Math.max(floorGap, STRIKE_GROWTH * (F - sorted[i]))) {
      kept.add(sorted[i]);
      last = sorted[i];
    }
  }
  // guarantee each surface bucket has a strike within the skill's ±2.5% tolerance
  const bucketK = new Set<number>();
  for (const m of SURFACE_BUCKETS) {
    const target = m * F;
    let inside = false;
    for (const k of kept) if (Math.abs(k - target) <= 0.025 * F) { inside = true; break; }
    if (inside) continue;
    let best: number | null = null;
    for (const k of sorted) if (k >= lo && k <= hi && (best === null || Math.abs(k - target) < Math.abs(best - target))) best = k;
    if (best !== null) { kept.add(best); bucketK.add(best); }
  }
  // hard cap: thin the DENSEST interior first (smallest neighbour gap), preserving the ATM, the two
  // width-defining extremes, and every bucket strike — so the cap costs detail near the money, never width.
  let arr = [...kept].sort((a, b) => a - b);
  while (arr.length > MAX_STRIKES) {
    let victim = -1;
    let bestGap = Infinity;
    for (let i = 1; i < arr.length - 1; i++) {
      if (arr[i] === sorted[atm] || bucketK.has(arr[i])) continue;
      const gap = Math.min(arr[i] - arr[i - 1], arr[i + 1] - arr[i]);
      if (gap < bestGap) { bestGap = gap; victim = i; }
    }
    if (victim < 0) break; // everything left is protected
    arr.splice(victim, 1);
  }
  return arr;
}
const cache = new Map<string, Promise<TermData>>(); // PROMISE-keyed: concurrent same-key misses
                                                    // coalesce into ONE slow pull set
const ready = new Set<string>(); // keys whose promise has RESOLVED — the probe reports THESE, not
                                 // the mere presence of an in-flight promise (that would say "no
                                 // wait" while a multi-minute cold pull is still running)

export function clearTermDataCache(): void {
  cache.clear();
  ready.clear();
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
  return ready.has(termKey(dataset, resolveOptionsRoot(root.toUpperCase()), opts.asOf, maxSeries, maxDays, band));
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
    const lap = (m: string) => console.error(`[term] ${optionsRoot} ${m} @ ${Math.round((Date.now() - started) / 1000)}s`);
    // defs ONLY (cached) — never the whole-root stats pull.
    const defs = await loadDefsCached(src, rootUpper, { asOf: opts.asOf, end: opts.end, dataset });
    lap(`defs (${defs.length} rows)`);

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
    lap(`forwards (${underIds.length} underlyings, ${eligible.length} series)`);

    // window each series: dense ±DENSE_HALF strikes around its forward + one strike per surface
    // bucket (sparse wings). Bounds the pull on fine strike grids (gold $5) — the whole ±25% band
    // there is hundreds of strikes we never display.
    const plan = eligible.map((b) => {
      const F = b.underId != null ? fwdById.get(b.underId) ?? null : null;
      if (F == null || F <= 0) return { b, F: null as number | null, keptK: [] as number[] };
      return { b, F, keptK: selectWindowStrikes([...b.byK.keys()], F) };
    });
    const wantIds: number[] = [];
    for (const p of plan) {
      for (const k of p.keptK) {
        const row = p.b.byK.get(k)!;
        if (row.cId != null) wantIds.push(row.cId);
        if (row.pId != null) wantIds.push(row.pId);
      }
    }

    lap(`windowed ${wantIds.length} strike-ids — pulling stats`);
    const { oi, settle } = await loadStatsForIds(src, wantIds, { asOf: opts.asOf, end: opts.end, dataset });
    lap(`stats done`);

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
    if (oldest !== undefined) {
      cache.delete(oldest);
      ready.delete(oldest);
    }
  }
  cache.set(key, work);
  work.then(
    () => ready.add(key), // mark READY only when the (slow) pull actually resolved
    () => {
      cache.delete(key); // a failed pull must not poison the day, and is never "ready"
      ready.delete(key);
    },
  );
  return work;
}
