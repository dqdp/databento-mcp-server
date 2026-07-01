/**
 * pull-chain — orchestrate the Databento pulls behind the futures-options smile.
 *
 * STATIC half (this file, for now): `loadDefinitions` pulls the whole ROOT.OPT parent
 * `definition` set ONCE (it's reference data — strike/expiration/underlying don't change
 * intraday, so callers cache it per root/day), and pure selectors pick the target
 * expiration. The DYNAMIC quote snapshot (narrow bbo + statistics per refresh) is a later
 * step and composes on top of this.
 */
import type { DefinitionRec } from './chain.js';
import { normalizeDefinitions, normalizeStatistics } from './databento-normalize.js';

const DATASET = 'GLBX.MDP3';

/** The subset of the Databento timeseries client this module needs (injected for testing). */
export interface TimeseriesSource {
  getRange(req: {
    dataset: string;
    symbols: string;
    schema: string;
    start: string;
    end?: string;
    stype_in?: string;
    stype_out?: string;
    encoding?: string;
    limit?: number;
  }): Promise<{ data: string }>;
}

/**
 * Pull the whole option-chain `definition` set for a root (e.g. "ES") via parent symbology.
 * This is the ONE-TIME/cached reference pull; the per-refresh quote pull narrows to one
 * expiration. Returns the normalized C/P/F definitions (spreads dropped).
 */
export async function loadDefinitions(
  src: TimeseriesSource,
  root: string,
  opts: { asOf: string; dataset?: string },
): Promise<DefinitionRec[]> {
  const resp = await src.getRange({
    dataset: opts.dataset ?? DATASET,
    symbols: `${root}.OPT`,
    stype_in: 'parent',
    stype_out: 'instrument_id',
    schema: 'definition',
    start: opts.asOf,
    encoding: 'csv',
  });
  return normalizeDefinitions(resp.data);
}

/** Distinct OPTION expirations (C/P only — futures excluded), sorted ascending. */
export function listExpirations(defs: DefinitionRec[]): string[] {
  const exps = new Set<string>();
  for (const d of defs) {
    if ((d.instrument_class === 'C' || d.instrument_class === 'P') && d.expiration) exps.add(d.expiration);
  }
  return [...exps].sort();
}

function dteDays(exp: string, today: string): number {
  return Math.round((Date.parse(`${exp}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** A quarterly expiration lands in Mar/Jun/Sep/Dec (the CME quarterly cycle). */
function isQuarterly(exp: string): boolean {
  const m = Number(exp.slice(5, 7));
  return m === 3 || m === 6 || m === 9 || m === 12;
}

export type ExpirationMode = 'nearest' | 'quarterly';

/**
 * Pick the target expiration: an explicit `expiry` (must exist), else the nearest expiration
 * with DTE >= 1 (a 0-DTE chain is mostly intrinsic with degenerate IV), else the soonest.
 * `mode: 'quarterly'` restricts to the Mar/Jun/Sep/Dec cycle. (The MODEL maps the user's
 * phrasing — "nearest", "nearest quarterly" — to a mode; `most-liquid` is chooseMostLiquid.)
 */
export function chooseExpiration(
  defs: DefinitionRec[],
  opts: { expiry?: string; today: string; mode?: ExpirationMode },
): string {
  const all = listExpirations(defs);
  if (all.length === 0) throw new Error('no option expirations in the definitions');
  if (opts.expiry) {
    if (!all.includes(opts.expiry)) {
      throw new Error(`no expiration ${opts.expiry} (available: ${all.join(', ')})`);
    }
    return opts.expiry;
  }
  const pool = opts.mode === 'quarterly' ? all.filter(isQuarterly) : all;
  const usable = pool.length ? pool : all;
  const future = usable.filter((e) => dteDays(e, opts.today) >= 1);
  const from = future.length ? future : usable;
  return from.reduce((best, e) => (dteDays(e, opts.today) < dteDays(best, opts.today) ? e : best));
}

/**
 * Pick the MOST LIQUID expiration by summed open interest (the honest liquidity proxy: where
 * positions actually stand — distinct from daily volume). Ranks only DTE >= 1 expirations.
 */
export function chooseMostLiquid(defs: DefinitionRec[], oi: Map<number, number>, opts: { today: string }): string {
  const totals = new Map<string, number>();
  for (const d of defs) {
    if (d.instrument_class !== 'C' && d.instrument_class !== 'P') continue;
    if (dteDays(d.expiration, opts.today) < 1) continue;
    totals.set(d.expiration, (totals.get(d.expiration) ?? 0) + (oi.get(d.instrument_id) ?? 0));
  }
  if (totals.size === 0) throw new Error('no DTE>=1 expiration to rank by open interest');
  let best = '';
  let bestOi = -1;
  for (const [exp, total] of totals) {
    if (total > bestOi) {
      bestOi = total;
      best = exp;
    }
  }
  return best;
}

/**
 * Pull the whole ROOT.OPT parent `statistics` set and reduce it to open interest by
 * instrument (stat_type 9). One-time / cached alongside the definitions (OI is a daily
 * settlement stat), used to rank expirations for `most-liquid` selection.
 */
export async function loadOpenInterest(
  src: TimeseriesSource,
  root: string,
  opts: { asOf: string; dataset?: string },
): Promise<Map<number, number>> {
  const resp = await src.getRange({
    dataset: opts.dataset ?? DATASET,
    symbols: `${root}.OPT`,
    stype_in: 'parent',
    stype_out: 'instrument_id',
    schema: 'statistics',
    start: opts.asOf,
    encoding: 'csv',
  });
  const oi = new Map<number, number>();
  for (const rec of normalizeStatistics(resp.data)) oi.set(rec.instrument_id, rec.value);
  return oi;
}
