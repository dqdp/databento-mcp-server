/**
 * pull-chain — orchestrate the Databento pulls behind the futures-options smile.
 *
 * STATIC half (this file, for now): `loadDefinitions` pulls the whole ROOT.OPT parent
 * `definition` set ONCE (it's reference data — strike/expiration/underlying don't change
 * intraday, so callers cache it per root/day), and pure selectors pick the target
 * expiration. The DYNAMIC quote snapshot (narrow bbo + statistics per refresh) is a later
 * step and composes on top of this.
 */
import type { Chain, ChainRec, DefinitionRec, QuoteRec } from './chain.js';
import { applyTick, buildChain, newState } from './chain.js';
import { normalizeDefinitions, normalizeQuotes, normalizeStatistics } from './databento-normalize.js';

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
  opts: { asOf: string; end?: string; dataset?: string },
): Promise<DefinitionRec[]> {
  // Intentionally NO `limit`: this reference set must be COMPLETE (a truncated definition set
  // silently drops strikes/expirations). We reduce it internally to a compact chain — it never
  // lands in the model's context — so the 10k direct-response cap (a context-size guard) does
  // not apply. The per-refresh bbo pull IS bounded: its instrument_id list is checked against
  // the client's 2000-symbol cap, which throws cleanly for an over-large single expiration.
  // `end` MUST be supplied for a live pull and clamped to the dataset's available_end — a
  // date-only `start` with no `end` expands to [start, start+1d), whose end is in the future
  // relative to the historical API's (lagged) available range and 422s.
  const resp = await src.getRange({
    dataset: opts.dataset ?? DATASET,
    symbols: `${root}.OPT`,
    stype_in: 'parent',
    stype_out: 'instrument_id',
    schema: 'definition',
    start: opts.asOf,
    end: opts.end,
    encoding: 'csv',
  });
  return normalizeDefinitions(resp.data);
}

/**
 * The earlier of `nowIso` and the dataset's `availableEndIso` (the historical API lags wall
 * clock by minutes, so an `end` at wall-now 422s). Returns `nowIso` when the available end is
 * missing/unparseable. Pure, so the handler's clamp is unit-tested.
 */
export function clampNowToAvailable(nowIso: string, availableEndIso?: string): string {
  if (!availableEndIso) return nowIso;
  const avail = Date.parse(availableEndIso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(avail) || Number.isNaN(now)) return nowIso;
  return avail < now ? new Date(avail).toISOString() : nowIso;
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
export type SmileMode = ExpirationMode | 'most-liquid';

const SMILE_MODES: readonly SmileMode[] = ['nearest', 'quarterly', 'most-liquid'];

/**
 * Disambiguate the tool's single `expiry` arg into a selection: a mode keyword
 * ('nearest'|'quarterly'|'most-liquid', case-insensitive) or an explicit date string. Blank/
 * undefined -> {} (defaults to nearest downstream). An unrecognized string passes through as
 * an `expiry` and is rejected by chooseExpiration with the available list. Pure, so the
 * handler's parsing is unit-tested rather than hidden in the switch.
 */
export function resolveExpirySelector(expiry?: string): { mode?: SmileMode; expiry?: string } {
  const trimmed = expiry?.trim();
  if (!trimmed) return {};
  const norm = trimmed.toLowerCase();
  if (SMILE_MODES.includes(norm as SmileMode)) return { mode: norm as SmileMode };
  return { expiry: trimmed };
}

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
  // Every expiration tied at 0 (statistics not settled yet) is not a liquidity signal — the
  // "winner" would be an arbitrary iteration-order pick. Fail cleanly instead of silently.
  if (bestOi <= 0) throw new Error('no open interest to rank expirations by (statistics may not have settled yet)');
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
  opts: { asOf: string; end?: string; dataset?: string },
): Promise<Map<number, number>> {
  const resp = await src.getRange({
    dataset: opts.dataset ?? DATASET,
    symbols: `${root}.OPT`,
    stype_in: 'parent',
    stype_out: 'instrument_id',
    schema: 'statistics',
    start: opts.asOf,
    end: opts.end,
    encoding: 'csv',
  });
  const oi = new Map<number, number>();
  for (const rec of normalizeStatistics(resp.data)) oi.set(rec.instrument_id, rec.value);
  return oi;
}

const BBO_WINDOW_MS = 15 * 60 * 1000; // last ~15 min of 1-min BBO; last record per instrument = the snapshot

export interface QuoteSnapshot {
  quotes: QuoteRec[];
  futureDef: DefinitionRec; // synthesized: the underlying future isn't in ROOT.OPT (it's ROOT.FUT)
  expirationDefs: DefinitionRec[];
}

/**
 * DYNAMIC per-refresh pull: narrow bbo-1m for one expiration's options + the underlying future
 * (from `underlying_id`). The future's definition isn't in ROOT.OPT, so synthesize a class-F
 * definition (id = underlying_id) — that's all the reducer needs to set the forward.
 */
export async function pullQuotesSnapshot(
  src: TimeseriesSource,
  defs: DefinitionRec[],
  expiration: string,
  opts: { now: string; dataset?: string },
): Promise<QuoteSnapshot> {
  const expirationDefs = defs.filter(
    (d) => (d.instrument_class === 'C' || d.instrument_class === 'P') && d.expiration === expiration,
  );
  if (expirationDefs.length === 0) throw new Error(`no options for expiration ${expiration}`);
  const futureId = Number(expirationDefs[0].underlying);
  const symbols = [...expirationDefs.map((d) => d.instrument_id), futureId].join(',');
  const resp = await src.getRange({
    dataset: opts.dataset ?? DATASET,
    symbols,
    stype_in: 'instrument_id',
    stype_out: 'instrument_id',
    schema: 'bbo-1m',
    start: new Date(Date.parse(opts.now) - BBO_WINDOW_MS).toISOString(),
    end: opts.now,
    encoding: 'csv',
  });
  const futureDef: DefinitionRec = {
    type: 'definition',
    instrument_id: futureId,
    instrument_class: 'F',
    strike: null,
    expiration,
    underlying: '',
  };
  return { quotes: normalizeQuotes(resp.data), futureDef, expirationDefs };
}

export interface BuildSmileOpts {
  today: string; // YYYY-MM-DD (DTE / T)
  now: string; // ISO (bbo window end)
  expiry?: string;
  mode?: ExpirationMode | 'most-liquid';
  window?: number;
  r?: number;
  asOf?: string; // definition/statistics as-of (default today)
  dataset?: string;
  cachedDefs?: DefinitionRec[]; // reuse the once/day static pulls across refreshes
  cachedOi?: Map<number, number>;
}

/**
 * Compose the whole snapshot: static definitions + OI (loaded or cached), pick the expiration
 * per the requested mode, pull the narrow quote snapshot, and reduce to a chain (IV via
 * Black-76). T = DTE / 365.
 */
export async function buildSmile(src: TimeseriesSource, root: string, opts: BuildSmileOpts): Promise<Chain> {
  const asOf = opts.asOf ?? opts.today;
  // Clamp the static pulls' `end` to `now` (already clamped to the dataset's available_end by
  // the caller) so a date-only start doesn't expand into the future and 422.
  const defs = opts.cachedDefs ?? (await loadDefinitions(src, root, { asOf, end: opts.now, dataset: opts.dataset }));
  const oi = opts.cachedOi ?? (await loadOpenInterest(src, root, { asOf, end: opts.now, dataset: opts.dataset }));

  let expiration: string;
  if (opts.mode === 'most-liquid') {
    expiration = chooseMostLiquid(defs, oi, { today: opts.today });
  } else {
    expiration = chooseExpiration(defs, { expiry: opts.expiry, today: opts.today, mode: opts.mode });
  }

  const snap = await pullQuotesSnapshot(src, defs, expiration, { now: opts.now, dataset: opts.dataset });
  if (snap.quotes.length === 0) {
    // No BBO in the recent window: almost always the market is closed (overnight/weekend) or
    // the window is too narrow. Surface that explicitly rather than letting the reducer throw
    // an opaque "no future quote" deep inside buildChain.
    throw new Error(
      `no BBO for ${root} ${expiration} in the last ${Math.round(BBO_WINDOW_MS / 60000)} min — market may be closed or the window too narrow`,
    );
  }
  const recs: ChainRec[] = [snap.futureDef, ...snap.expirationDefs, ...snap.quotes];
  for (const d of snap.expirationDefs) {
    const v = oi.get(d.instrument_id);
    if (v != null) recs.push({ type: 'statistics', instrument_id: d.instrument_id, stat_type: 'open_interest', value: v });
  }
  const state = newState();
  for (const rec of recs) applyTick(state, rec);
  const T = Math.max(1, dteDays(expiration, opts.today)) / 365;
  // Pass the FULL expiration universe so nExpirations/expirations reflect the whole chain, not
  // just the one expiration we pulled quotes for (state only holds the selected expiration).
  return buildChain(root, state, expiration, T, {
    window: opts.window ?? 20,
    r: opts.r ?? 0,
    allExpirations: listExpirations(defs),
  });
}
