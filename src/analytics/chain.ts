/**
 * Futures-options chain reducer.
 *
 * Node port of the Python reference (market_data_skill/scripts/databento_live.py). Folds a
 * stream of NORMALIZED Databento records (definition / quote / statistics; prices already
 * /1e9, UNDEF -> null) into a compact chain object, solving IV per strike via Black-76
 * (warm-started from the previous chain so unchanged strikes re-solve in one iteration).
 *
 * Used now by the snapshot smile MCP tool (apply all pulled records once, then buildChain),
 * and later by the live backend (apply incrementally, buildChain per flush).
 */
import { black76, impliedVol } from './black76.js';

export type InstrumentClass = 'C' | 'P' | 'F';

export interface DefinitionRec {
  type: 'definition';
  instrument_id: number;
  instrument_class: InstrumentClass;
  strike: number | null;
  expiration: string;
  underlying?: string;
  raw_symbol?: string;
  underlying_symbol?: string;
}
export interface QuoteRec {
  type: 'quote';
  instrument_id: number;
  bid: number | null;
  ask: number | null;
  ts?: string | null;
}
export interface StatisticsRec {
  type: 'statistics';
  instrument_id: number;
  stat_type: string;
  value: number;
}
export type ChainRec = DefinitionRec | QuoteRec | StatisticsRec;

interface DefEntry {
  cls: InstrumentClass;
  strike: number | null;
  expiration: string;
}
interface QuoteEntry {
  bid: number | null;
  ask: number | null;
  mid: number;
}

export interface ChainState {
  defs: Map<number, DefEntry>;
  quotes: Map<number, QuoteEntry>;
  oi: Map<number, number>;
  futureId: number | null;
  lastTs: string | null;
}

export function newState(): ChainState {
  return { defs: new Map(), quotes: new Map(), oi: new Map(), futureId: null, lastTs: null };
}

function mid(bid: number | null, ask: number | null): number | null {
  if (bid != null && ask != null) return (bid + ask) / 2;
  return bid != null ? bid : ask; // one-sided fallback; null if both UNDEF
}

/** Fold one normalized record into the buffer (mutates + returns state). */
export function applyTick(state: ChainState, rec: ChainRec): ChainState {
  if (rec.type === 'definition') {
    state.defs.set(rec.instrument_id, { cls: rec.instrument_class, strike: rec.strike, expiration: rec.expiration });
    if (rec.instrument_class === 'F') state.futureId = rec.instrument_id;
  } else if (rec.type === 'quote') {
    const m = mid(rec.bid, rec.ask);
    if (m != null) {
      state.quotes.set(rec.instrument_id, { bid: rec.bid, ask: rec.ask, mid: m });
      if (rec.ts) state.lastTs = rec.ts;
    }
  } else if (rec.type === 'statistics' && rec.stat_type === 'open_interest') {
    state.oi.set(rec.instrument_id, rec.value);
  }
  return state;
}

/** The underlying future's mid (the Black-76 forward), or null if not seen yet. */
export function forward(state: ChainState): number | null {
  if (state.futureId == null) return null;
  const q = state.quotes.get(state.futureId);
  return q ? q.mid : null;
}

export interface Chain {
  symbol: string;
  expiration: string;
  dte: number;
  asOf: string | null;
  selection?: string; // how the expiration was chosen: 'most-liquid' | 'nearest' | 'quarterly' | explicit date
  spot: number;
  spotEstimated: boolean;
  atmStrike: number;
  atmIV: number | null;
  skew25: number | null;
  call25IV: number | null;
  put25IV: number | null;
  call25Strike: number | null;
  put25Strike: number | null;
  pcrOI: number | null;
  pcrVol: number | null;
  callOItotal: number;
  putOItotal: number;
  maxPain: number;
  nContracts: number;
  nExpirations: number;
  expirations: string[];
  window: number;
  strikes: number[];
  callIV: (number | null)[];
  putIV: (number | null)[];
  callOI: (number | null)[];
  putOI: (number | null)[];
  callDelta: (number | null)[];
  putDelta: (number | null)[];
  callVol: (number | null)[];
  putVol: (number | null)[];
}

export interface BuildChainOpts {
  window?: number;
  r?: number;
  prev?: Chain | null;
  /**
   * The FULL option-expiration universe for `nExpirations`/`expirations`. The reducer state
   * only holds the ONE expiration we pulled/streamed, so left to itself buildChain would
   * always report 1. Callers that know the whole chain (the snapshot pull) pass it here so a
   * consumer can see the other expirations and offer to switch. Omitted -> derive from state.
   */
  allExpirations?: string[];
}

function delta25(strikeKeys: Iterable<number>, dl: Map<number, number | null>, target: number, lo: number, hi: number): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  for (const K of strikeKeys) {
    const d = dl.get(K);
    if (d == null || d <= lo || d >= hi) continue;
    const dist = Math.abs(d - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = K;
    }
  }
  return best;
}

/**
 * Reduce the buffer into a compact chain for one expiration. IV is solved per strike from
 * the quote mid via Black-76, warm-started from `prev` (the previous chain). Mirrors the
 * Python build_chain() output keys.
 */
export function buildChain(symbol: string, state: ChainState, expiration: string, T: number, opts: BuildChainOpts = {}): Chain {
  const window = opts.window ?? 20;
  const r = opts.r ?? 0;
  const prev = opts.prev ?? null;
  const F = forward(state);
  if (F == null || F <= 0) throw new Error('buildChain: no future quote yet (forward unknown)');

  const calls = new Map<number, { iid: number; mid: number }>();
  const puts = new Map<number, { iid: number; mid: number }>();
  for (const [iid, d] of state.defs) {
    if ((d.cls !== 'C' && d.cls !== 'P') || d.expiration !== expiration || d.strike == null) continue;
    const q = state.quotes.get(iid);
    if (q) (d.cls === 'C' ? calls : puts).set(d.strike, { iid, mid: q.mid });
  }
  const strikes = [...new Set([...calls.keys(), ...puts.keys()])].sort((a, b) => a - b);
  if (strikes.length === 0) throw new Error('buildChain: no option quotes yet');

  // warm-start seeds from the previous chain, per strike
  const seedC = new Map<number, number | null>();
  const seedP = new Map<number, number | null>();
  if (prev) {
    prev.strikes.forEach((K, j) => {
      seedC.set(K, prev.callIV[j]);
      seedP.set(K, prev.putIV[j]);
    });
  }

  const solve = (K: number, m: number, isCall: boolean, seed: number | null | undefined): [number | null, number | null] => {
    const iv = impliedVol(m, K, T, { F, r, isCall, guess: seed ?? null }).sigma;
    const d = iv != null ? black76(F, K, T, iv, { r, isCall }).delta : null;
    return [iv, d];
  };

  const civ = new Map<number, number | null>();
  const piv = new Map<number, number | null>();
  const cdl = new Map<number, number | null>();
  const pdl = new Map<number, number | null>();
  const coiL = new Map<number, number | null>();
  const poiL = new Map<number, number | null>();
  for (const K of strikes) {
    const c = calls.get(K);
    if (c) {
      const [iv, d] = solve(K, c.mid, true, seedC.get(K));
      civ.set(K, iv);
      cdl.set(K, d);
      coiL.set(K, state.oi.get(c.iid) ?? null);
    }
    const p = puts.get(K);
    if (p) {
      const [iv, d] = solve(K, p.mid, false, seedP.get(K));
      piv.set(K, iv);
      pdl.set(K, d);
      poiL.set(K, state.oi.get(p.iid) ?? null);
    }
  }

  const atm = strikes.reduce((best, k) => (Math.abs(k - F) < Math.abs(best - F) ? k : best), strikes[0]);
  const ai = strikes.indexOf(atm);
  const win = strikes.slice(Math.max(0, ai - window), Math.min(strikes.length, ai + window + 1));

  const atmCiv = civ.get(atm) ?? null;
  const atmPiv = piv.get(atm) ?? null;
  const atmIV = atmCiv != null && atmPiv != null ? (atmCiv + atmPiv) / 2 : (atmCiv ?? atmPiv);

  // 25-delta skew over the whole expiration
  const c25 = delta25(calls.keys(), cdl, 0.25, 0, 1);
  const p25 = delta25(puts.keys(), pdl, -0.25, -1, 0);
  const call25IV = c25 != null ? civ.get(c25) ?? null : null;
  const put25IV = p25 != null ? piv.get(p25) ?? null : null;
  const skew25 = call25IV != null && put25IV != null ? put25IV - call25IV : null;

  // OI aggregates (totals, PCR, max pain) over the FULL expiration, independent of which
  // strikes were quoted — the quote pull may be narrowed to a band around the forward, but OI
  // is loaded for the whole chain. Deriving these from the quoted band only would band-clamp
  // max pain and skew PCR. Per-strike display arrays (callOI/putOI, below) stay windowed.
  const allCoi = new Map<number, number>();
  const allPoi = new Map<number, number>();
  for (const [iid, d] of state.defs) {
    if ((d.cls !== 'C' && d.cls !== 'P') || d.expiration !== expiration || d.strike == null) continue;
    const v = state.oi.get(iid);
    if (v == null) continue;
    const m = d.cls === 'C' ? allCoi : allPoi;
    m.set(d.strike, (m.get(d.strike) ?? 0) + v);
  }
  let coi = 0;
  let poi = 0;
  for (const v of allCoi.values()) coi += v;
  for (const v of allPoi.values()) poi += v;
  const pcrOI = coi ? poi / coi : null;

  const oiStrikes = [...new Set([...allCoi.keys(), ...allPoi.keys()])].sort((a, b) => a - b);
  const payout = (Kp: number): number => {
    let total = 0;
    for (const [K, v] of allCoi) if (K < Kp) total += v * (Kp - K);
    for (const [K, v] of allPoi) if (K > Kp) total += v * (K - Kp);
    return total;
  };
  const maxPain = oiStrikes.length ? oiStrikes.reduce((best, k) => (payout(k) < payout(best) ? k : best), oiStrikes[0]) : atm;

  const exps =
    opts.allExpirations ??
    [...new Set([...state.defs.values()].filter((d) => d.cls === 'C' || d.cls === 'P').map((d) => d.expiration))].sort();
  const col = (m: Map<number, number | null>): (number | null)[] => win.map((K) => m.get(K) ?? null);

  return {
    symbol,
    expiration,
    dte: Math.max(0, Math.round(T * 365)),
    asOf: state.lastTs,
    spot: F,
    spotEstimated: false,
    atmStrike: atm,
    atmIV,
    skew25,
    call25IV,
    put25IV,
    call25Strike: c25,
    put25Strike: p25,
    pcrOI,
    pcrVol: null,
    callOItotal: coi,
    putOItotal: poi,
    maxPain,
    nContracts: calls.size + puts.size,
    nExpirations: exps.length,
    expirations: exps,
    window,
    strikes: win,
    callIV: col(civ),
    putIV: col(piv),
    callOI: col(coiL),
    putOI: col(poiL),
    callDelta: col(cdl),
    putDelta: col(pdl),
    callVol: win.map(() => null), // no volume in quote/stat records (parity with the Python reference)
    putVol: win.map(() => null),
  };
}
