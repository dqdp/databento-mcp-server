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
import { normalizeDefinitions, normalizeQuotes, normalizeSettlements, normalizeStatistics } from './databento-normalize.js';

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
    timeout?: number;
  }): Promise<{ data: string }>;
}

// Full-chain parent definition/statistics sets for a big root (crude LO ~3.7k+ defs) take
// longer than the client's 15s default — give the STATIC pulls a generous ceiling.
const STATIC_PULL_TIMEOUT_MS = 90_000;

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
    timeout: STATIC_PULL_TIMEOUT_MS,
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

/**
 * CME futures root -> options-chain PARENT root on GLBX.MDP3. Live-verified 2026-07 (every
 * entry has resolved definition rows tying the options back to the future). The options parent
 * usually DIFFERS from the futures symbol and is NOT algorithmic (crude CL->LO, gold GC->OG,
 * copper HG->HXE, EUR FX 6E->EUU, Henry Hub NG->ON — NOT LN), so it's a lookup, not a rule.
 * Equity-index products (ES, NQ) resolve directly and are intentionally absent — an unlisted
 * root falls through to `<root>.OPT` unchanged.
 */
const OPTIONS_ROOT: Record<string, string> = {
  // NYMEX / COMEX energy & metals
  CL: 'LO', NG: 'ON', RB: 'OB', HO: 'OH', GC: 'OG', SI: 'SO', HG: 'HXE', PL: 'PO',
  PA: 'PAO', // palladium — asset != root, so the <root>.OPT passthrough returned an EMPTY chain
  // CBOT grains + rates (O-prefix)
  ZC: 'OZC', ZS: 'OZS', ZW: 'OZW', ZL: 'OZL', ZN: 'OZN', ZB: 'OZB',
  // CME FX
  '6E': 'EUU', '6J': 'JPU',
  // 2026-07-04 GLBX full-universe audit (market_data_skill docs/databento-audit-2026-07-04.md):
  // only roots whose option ASSET differs from the futures root need entries — LE/HE/GF/DC/CB/
  // BTC/ETH/SR3 pass through correctly (asset == root).
  BZ: 'BZO', MGC: 'OMG', MCL: 'MCO', MNG: 'MNO',       // NYMEX/COMEX (incl. micros)
  ZM: 'OZM', KE: 'OKE', TN: 'OTN',                     // CBOT (live venue-license caveat)
  MES: 'EX', MNQ: 'MQE',                               // CME micro equity index (monthly asset)
};

/**
 * Resolve a user-supplied root to the options-chain parent root. Accepts either the FUTURES
 * root (e.g. "CL", mapped to "LO") or an options root already (idempotent — "LO" -> "LO");
 * unlisted roots (ES, NQ, or anything not in the table) pass through unchanged so `<root>.OPT`
 * is tried directly. Case/space-insensitive.
 */
export function resolveOptionsRoot(root: string): string {
  const r = root.trim().toUpperCase();
  return OPTIONS_ROOT[r] ?? r;
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
  return (await loadDailyStats(src, root, opts)).oi;
}

/**
 * ONE whole-root statistics parent pull -> BOTH daily maps: open interest (stat 9) and
 * settlement prices (stat 3, human units). The response always carried both; settlements were
 * simply discarded before the term-structure work needed them. Callers that only want OI keep
 * the loadOpenInterest name.
 */
export async function loadDailyStats(
  src: TimeseriesSource,
  root: string,
  opts: { asOf: string; end?: string; dataset?: string },
): Promise<{ oi: Map<number, number>; settle: Map<number, number> }> {
  const resp = await src.getRange({
    dataset: opts.dataset ?? DATASET,
    symbols: `${root}.OPT`,
    stype_in: 'parent',
    stype_out: 'instrument_id',
    schema: 'statistics',
    start: opts.asOf,
    end: opts.end,
    encoding: 'csv',
    timeout: STATIC_PULL_TIMEOUT_MS,
  });
  const oi = new Map<number, number>();
  for (const rec of normalizeStatistics(resp.data)) oi.set(rec.instrument_id, rec.value);
  return { oi, settle: normalizeSettlements(resp.data) };
}

const BBO_WINDOW_MS = 15 * 60 * 1000; // last ~15 min of 1-min BBO; last record per instrument = the snapshot

export interface QuoteSnapshot {
  quotes: QuoteRec[];
  futureDef: DefinitionRec; // synthesized: the underlying future isn't in ROOT.OPT (it's ROOT.FUT)
  expirationDefs: DefinitionRec[];
}

/** A quote's mid (the forward when it's the underlying future), or null if fully UNDEF. */
function midOf(quotes: QuoteRec[], instrumentId: number): number | null {
  const q = quotes.find((x) => x.instrument_id === instrumentId);
  if (!q) return null;
  if (q.bid != null && q.ask != null) return (q.bid + q.ask) / 2;
  return q.bid != null ? q.bid : q.ask;
}

/** Keep only the `pullWindow` strikes each side of the strike nearest the forward. */
function narrowByStrike(defs: DefinitionRec[], F: number, pullWindow?: number): DefinitionRec[] {
  if (pullWindow == null) return defs;
  const strikes = [...new Set(defs.map((d) => d.strike).filter((s): s is number => s != null))].sort((a, b) => a - b);
  if (strikes.length === 0) return defs;
  const atm = strikes.reduce((b, k) => (Math.abs(k - F) < Math.abs(b - F) ? k : b), strikes[0]);
  const ai = strikes.indexOf(atm);
  const keep = new Set(strikes.slice(Math.max(0, ai - pullWindow), ai + pullWindow + 1));
  return defs.filter((d) => d.strike != null && keep.has(d.strike));
}

/**
 * DYNAMIC per-refresh pull, in TWO steps so it scales to big chains (crude LO carries ~450
 * strikes per expiration):
 *  1. bbo-1m for the underlying future ALONE (one symbol) → the forward.
 *  2. narrow the option strikes to ±`pullWindow` around that forward, then bbo-1m only those.
 * A single pull of every strike's instrument_id blows the request URI (HTTP 414); the reducer
 * only windows to the display window anyway, and 25-delta lives well inside this band. The
 * future isn't in ROOT.OPT, so its class-F definition is synthesized (id = underlying_id).
 */
export async function pullQuotesSnapshot(
  src: TimeseriesSource,
  defs: DefinitionRec[],
  expiration: string,
  opts: { now: string; dataset?: string; pullWindow?: number },
): Promise<QuoteSnapshot> {
  const dataset = opts.dataset ?? DATASET;
  const startIso = new Date(Date.parse(opts.now) - BBO_WINDOW_MS).toISOString();
  const bbo = (symbols: string) =>
    src.getRange({ dataset, symbols, stype_in: 'instrument_id', stype_out: 'instrument_id', schema: 'bbo-1m', start: startIso, end: opts.now, encoding: 'csv' });

  const allExpDefs = defs.filter(
    (d) => (d.instrument_class === 'C' || d.instrument_class === 'P') && d.expiration === expiration,
  );
  if (allExpDefs.length === 0) throw new Error(`no options for expiration ${expiration}`);
  const futureDef: DefinitionRec = {
    type: 'definition',
    instrument_id: Number(allExpDefs[0].underlying),
    instrument_class: 'F',
    strike: null,
    expiration,
    underlying: '',
  };

  // 1) forward from the underlying future alone
  const futureQuotes = normalizeQuotes((await bbo(String(futureDef.instrument_id))).data);
  const F = midOf(futureQuotes, futureDef.instrument_id);
  if (F == null) {
    throw new Error(
      `no forward: underlying future ${futureDef.instrument_id} has no BBO in the last ` +
        `${Math.round(BBO_WINDOW_MS / 60000)} min for ${expiration} — market may be closed`,
    );
  }

  // 2) narrow to ±pullWindow strikes around the forward, then bbo only those
  const expirationDefs = narrowByStrike(allExpDefs, F, opts.pullWindow);
  const optionQuotes = normalizeQuotes((await bbo(expirationDefs.map((d) => d.instrument_id).join(','))).data);

  return { quotes: [...futureQuotes, ...optionQuotes], futureDef, expirationDefs };
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
  root = resolveOptionsRoot(root); // "CL" -> "LO" etc.; idempotent for options/equity roots
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

  // Pull a band wider than the display window so 25-delta skew has strikes to find, but narrow
  // enough that a big chain's option-id list never blows the request URI. NOTE: at extreme
  // (crisis) implied vol the true 25-delta strike can still fall outside this band, in which
  // case skew25 is computed from the nearest available strike (biased toward ATM); normal
  // commodity/index vol keeps 25-delta well inside +/-(window+40) strikes.
  const outWindow = opts.window ?? 20;
  const pullWindow = Math.max(outWindow, 20) + 40;
  const snap = await pullQuotesSnapshot(src, defs, expiration, { now: opts.now, dataset: opts.dataset, pullWindow });
  if (snap.quotes.length === 0) {
    // No BBO in the recent window: almost always the market is closed (overnight/weekend) or
    // the window is too narrow. Surface that explicitly rather than letting the reducer throw
    // an opaque "no future quote" deep inside buildChain.
    throw new Error(
      `no BBO for ${root} ${expiration} in the last ${Math.round(BBO_WINDOW_MS / 60000)} min — market may be closed or the window too narrow`,
    );
  }
  // Feed the reducer the WHOLE expiration's defs + OI (not just the narrowed, quoted band) so
  // the OI aggregates (max pain / PCR / OI totals) stay whole-chain; only quotes are narrowed.
  const allExpDefs = defs.filter(
    (d) => (d.instrument_class === 'C' || d.instrument_class === 'P') && d.expiration === expiration,
  );
  const recs: ChainRec[] = [snap.futureDef, ...allExpDefs, ...snap.quotes];
  for (const d of allExpDefs) {
    const v = oi.get(d.instrument_id);
    if (v != null) recs.push({ type: 'statistics', instrument_id: d.instrument_id, stat_type: 'open_interest', value: v });
  }
  const state = newState();
  for (const rec of recs) applyTick(state, rec);
  const T = Math.max(1, dteDays(expiration, opts.today)) / 365;
  // Pass the FULL expiration universe so nExpirations/expirations reflect the whole chain, not
  // just the one expiration we pulled quotes for (state only holds the selected expiration).
  const chain = buildChain(root, state, expiration, T, {
    window: opts.window ?? 20,
    r: opts.r ?? 0,
    allExpirations: listExpirations(defs),
  });
  const selection = opts.mode ?? (opts.expiry ? `expiry ${opts.expiry}` : 'nearest');
  return { ...chain, selection };
}
