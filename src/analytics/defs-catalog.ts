/**
 * defs-catalog — the LONG-LIVED security-definition catalog for an options root.
 *
 * Security definitions are STABLE reference data: a listed strike/expiration never changes, only
 * NEW listings are added (as spot moves, or a new expiration lists). Databento re-publishes the
 * full ~37k-instrument snapshot at each SOD, but a live probe (2026-07-06) shows only tens of rows
 * trickle in intraday (full day 37,361 vs a 1h intraday window 9-43). So instead of the old
 * day-keyed cache that re-pulled the whole snapshot EVERY trading day, we:
 *   - pull the full snapshot ONCE, reduce + persist it root-keyed (NOT day-keyed) so it survives
 *     connector restarts and is served INSTANTLY;
 *   - refresh with cheap intraday-DELTA merges (a window clamped past SOD -> only new listings);
 *   - reconcile fully on a slow cadence (new expirations that appear only at SOD, + prune expired).
 * The daily settlement/OI data stays day-keyed elsewhere — only the stable catalog lives here.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { DefinitionRec } from './chain.js';
import { loadDefinitions, resolveOptionsRoot, type TimeseriesSource } from './pull-chain.js';

const DATASET = 'GLBX.MDP3';
const LOOKBACK_DAYS = 5; // the full snapshot's closed-day walk (holiday cluster)

interface Catalog {
  instruments: Record<string, DefinitionRec>;
  lastFull: string; // ISO of the last full snapshot
  lastDelta: string; // ISO of the last delta/refresh window end
}

// Resolve the cache dir LAZILY (env read at call-time, not module-load) so a test/harness that sets
// DEFS_CACHE_DIR always wins regardless of import ordering — a module-load read let the real
// ~/.cache get polluted by an unisolated test run.
let cacheDirOverride: string | null = null;
function cacheDir(): string {
  return cacheDirOverride ?? process.env.DEFS_CACHE_DIR ?? path.join(os.homedir(), '.cache', 'databento-mcp', 'defs');
}
// PROMISE-keyed so two concurrent first-callers (a /smile poll + a /term pull) coalesce onto ONE
// full pull instead of each re-pulling the whole snapshot.
const mem = new Map<string, Promise<DefinitionRec[]>>();

export function setDefsCacheDir(dir: string): void {
  cacheDirOverride = dir;
}
export function clearDefsCatalog(): void {
  mem.clear();
}

function memKey(dataset: string, optRoot: string): string {
  return `${dataset}|${optRoot}`;
}
function diskPath(dataset: string, optRoot: string): string {
  return path.join(cacheDir(), `${dataset}_${optRoot}.json`.replace(/[^A-Za-z0-9._-]/g, '_'));
}

export interface SeriesSummary {
  stem: string;
  expiration: string; // YYYY-MM-DD
  dte: number;
  quarterly: boolean; // a Mar/Jun/Sep/Dec expiration
  strikes: number; // distinct strike count
  under: string | null;
  oi?: number; // total OI across the series (only when an OI map is supplied)
}
export interface SeriesListing {
  root: string;
  optionsRoot: string;
  asOf: string;
  count: number;
  nearest: string | null; // stem of the nearest FUTURE expiration
  mostLiquid: string | null; // stem of the highest-OI series (null unless OI was supplied)
  series: SeriesSummary[]; // ascending by expiration
}

/** Reduce the catalog defs to a per-series summary for the "first question" (what expirations
 * exist, how many strikes, which is nearest / most-liquid). OI is optional and may come from either
 * of two sources: `oi` — a whole-root instrument→OI map (the loadSmileStatic path), summed per
 * series here; or `seriesOi` — a per-series total OI keyed by `${stem}|${expiration}` (the
 * day-cached term path, PREFERRED because it's already windowed + cached, so it never needs the
 * whole-root pull that times out on wide roots). When either is supplied a covered series' total OI
 * is filled and mostLiquid is chosen among covered series; `seriesOi` wins when both are given.
 * `seriesOi` covers only the windowed subset, so a series absent from it is left OI-UNKNOWN (no oi
 * field, excluded from the ranking) rather than shown as 0. */
export function summarizeSeries(
  root: string,
  optRoot: string,
  defs: DefinitionRec[],
  today: string,
  oi?: Map<number, number>,
  seriesOi?: Map<string, number>,
): SeriesListing {
  const t0 = Date.parse(`${today}T00:00:00Z`);
  type Acc = { stem: string; expiration: string; under: string | null; strikes: Set<number>; oi: number };
  const by = new Map<string, Acc>();
  for (const d of defs) {
    if (d.instrument_class !== 'C' && d.instrument_class !== 'P') continue;
    if (!d.raw_symbol || !d.raw_symbol.includes(' ') || d.strike == null || !d.expiration) continue;
    const stem = d.raw_symbol.split(' ', 1)[0];
    const key = `${stem}|${d.expiration}`;
    let a = by.get(key);
    if (!a) {
      a = { stem, expiration: d.expiration, under: d.underlying_symbol ?? null, strikes: new Set(), oi: 0 };
      by.set(key, a);
    }
    a.strikes.add(d.strike);
    if (oi) a.oi += oi.get(d.instrument_id) ?? 0;
  }
  const series: SeriesSummary[] = [...by.values()]
    .sort((x, y) => x.expiration.localeCompare(y.expiration))
    .map((a) => {
      // OI per series. `seriesOi` (day-cached term totals) covers only the windowed subset of
      // series (nearest maxSeries within maxDays, forwards present), so a series ABSENT from it is
      // OI-UNKNOWN — it gets NO oi field, NOT a fabricated 0: a 0 would both show a wrong column and
      // let an uncovered series be (mis)ranked. The whole-root `oi` map covers every series, so
      // there `a.oi` is always the real total.
      const total = seriesOi ? seriesOi.get(`${a.stem}|${a.expiration}`) : oi ? a.oi : undefined;
      return {
        stem: a.stem,
        expiration: a.expiration,
        dte: Math.round((Date.parse(`${a.expiration}T00:00:00Z`) - t0) / 86_400_000),
        quarterly: [3, 6, 9, 12].includes(Number(a.expiration.slice(5, 7))),
        strikes: a.strikes.size,
        under: a.under,
        ...(total !== undefined ? { oi: total } : {}),
      };
    });
  const future = series.filter((s) => s.dte >= 0);
  const nearest = future.length ? future[0].stem : null;
  // Rank ONLY series whose OI is known; a series the term window didn't cover is unknown, not 0, so
  // it can neither be starred nor block a covered series from being starred.
  const ranked = future.filter((s) => s.oi !== undefined);
  const mostLiquid = ranked.length
    ? ranked.reduce((best, s) => ((s.oi ?? 0) > (best.oi ?? 0) ? s : best)).stem
    : null;
  return { root: root.toUpperCase(), optionsRoot: optRoot, asOf: today, count: series.length, nearest, mostLiquid, series };
}

/** Drop expired series (their expiration is before `asOf`); futures (no strike) are kept. */
function prune(defs: DefinitionRec[], asOf: string): DefinitionRec[] {
  const t0 = Date.parse(`${asOf}T00:00:00Z`);
  return defs.filter(
    (d) => d.instrument_class === 'F' || !d.expiration || Date.parse(`${d.expiration}T00:00:00Z`) >= t0,
  );
}

async function readDisk(dataset: string, optRoot: string): Promise<Catalog | null> {
  try {
    const raw = await fs.readFile(diskPath(dataset, optRoot), 'utf8');
    const c = JSON.parse(raw) as Catalog;
    if (c && c.instruments && Object.keys(c.instruments).length > 0) return c;
  } catch {
    /* missing / corrupt -> a miss */
  }
  return null;
}

async function writeDisk(dataset: string, optRoot: string, cat: Catalog): Promise<void> {
  try {
    await fs.mkdir(cacheDir(), { recursive: true });
    const p = diskPath(dataset, optRoot);
    const tmp = `${p}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(cat));
    await fs.rename(tmp, p); // atomic
  } catch (e) {
    console.error(`[defs] disk write failed for ${optRoot}: ${(e as Error).message}`);
  }
}

/** The full parent-definitions pull, with the closed-day walk (a Saturday after a holiday has an
 * empty window — step asOf back to the last trading day). */
async function fullPull(
  src: TimeseriesSource,
  optRoot: string,
  opts: { asOf: string; end?: string; dataset?: string; timeoutMs?: number },
): Promise<DefinitionRec[]> {
  let defs = await loadDefinitions(src, optRoot, opts);
  for (let back = 1; defs.length === 0 && back <= LOOKBACK_DAYS; back++) {
    const day = new Date(Date.parse(`${opts.asOf}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
    defs = await loadDefinitions(src, optRoot, { ...opts, asOf: day });
  }
  return defs;
}

/** The catalog for a root: served from memory -> disk -> a one-time full pull. Root-keyed (NOT day),
 * so a new trading day does NOT re-pull the snapshot; refreshDefsCatalog merges the intraday delta. */
export async function loadDefsCatalog(
  src: TimeseriesSource,
  root: string,
  opts: { asOf: string; end?: string; dataset?: string; timeoutMs?: number },
): Promise<DefinitionRec[]> {
  const dataset = opts.dataset ?? DATASET;
  const optRoot = resolveOptionsRoot(root.toUpperCase());
  const mk = memKey(dataset, optRoot);

  const hitm = mem.get(mk);
  if (hitm) return prune(await hitm, opts.asOf);

  const work = (async () => {
    const disk = await readDisk(dataset, optRoot);
    if (disk) return Object.values(disk.instruments); // instant, restart-durable
    const defs = await fullPull(src, optRoot, { asOf: opts.asOf, end: opts.end, dataset, timeoutMs: opts.timeoutMs });
    if (defs.length === 0) throw new Error(`no definitions for ${optRoot} (closed-day window empty)`);
    const pruned = prune(defs, opts.asOf);
    const now = opts.end ?? new Date(Date.parse(`${opts.asOf}T00:00:00Z`)).toISOString();
    await writeDisk(dataset, optRoot, {
      instruments: Object.fromEntries(pruned.map((d) => [String(d.instrument_id), d])),
      lastFull: now,
      lastDelta: now,
    });
    return pruned;
  })();
  mem.set(mk, work);
  work.catch(() => { if (mem.get(mk) === work) mem.delete(mk); }); // don't cache a failed pull
  return prune(await work, opts.asOf);
}

/** Refresh the catalog by MERGING an intraday delta window (deltaStart..end, clamped past SOD so it
 * never re-downloads the full snapshot) into the persisted catalog. New listings are added; expired
 * series pruned. `full: true` re-pulls the whole snapshot (the periodic reconcile). */
export async function refreshDefsCatalog(
  src: TimeseriesSource,
  root: string,
  opts: { asOf: string; end?: string; dataset?: string; deltaStart: string; full?: boolean },
): Promise<DefinitionRec[]> {
  const dataset = opts.dataset ?? DATASET;
  const optRoot = resolveOptionsRoot(root.toUpperCase());
  const disk = (await readDisk(dataset, optRoot)) ?? { instruments: {}, lastFull: '', lastDelta: '' };

  const pulled = opts.full
    ? await fullPull(src, optRoot, { asOf: opts.asOf, end: opts.end, dataset })
    : await loadDefinitions(src, optRoot, { asOf: opts.deltaStart, end: opts.end, dataset });
  for (const d of pulled) disk.instruments[String(d.instrument_id)] = d; // merge: new ids added, existing unchanged

  const pruned = prune(Object.values(disk.instruments), opts.asOf);
  const now = opts.end ?? new Date().toISOString();
  const cat: Catalog = {
    instruments: Object.fromEntries(pruned.map((d) => [String(d.instrument_id), d])),
    lastFull: opts.full ? now : disk.lastFull,
    lastDelta: now,
  };
  await writeDisk(dataset, optRoot, cat);
  mem.set(memKey(dataset, optRoot), Promise.resolve(pruned));
  return pruned;
}
