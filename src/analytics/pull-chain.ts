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
import { normalizeDefinitions } from './databento-normalize.js';

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

/**
 * Pick the target expiration: an explicit `expiry` (must exist), else the nearest expiration
 * with DTE >= 1 (a 0-DTE chain is mostly intrinsic with degenerate IV), else the soonest.
 */
export function chooseExpiration(defs: DefinitionRec[], opts: { expiry?: string; today: string }): string {
  const exps = listExpirations(defs);
  if (exps.length === 0) throw new Error('no option expirations in the definitions');
  if (opts.expiry) {
    if (!exps.includes(opts.expiry)) {
      throw new Error(`no expiration ${opts.expiry} (available: ${exps.join(', ')})`);
    }
    return opts.expiry;
  }
  const future = exps.filter((e) => dteDays(e, opts.today) >= 1);
  if (future.length) return future.reduce((best, e) => (dteDays(e, opts.today) < dteDays(best, opts.today) ? e : best));
  return exps[0];
}
