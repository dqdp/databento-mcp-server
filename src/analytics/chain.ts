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
  /** This book's own timestamp. Carried per quote because the chain's `asOf` must be the
   * vintage of the books that were USED: a gated shell ticking hours later moved the global
   * clock while the IVs stayed frozen on old prints, so the smile advertised a freshness it
   * did not have. */
  ts: string | null;
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
      state.quotes.set(rec.instrument_id, { bid: rec.bid, ask: rec.ask, mid: m, ts: rec.ts ?? null });
      if (rec.ts) state.lastTs = rec.ts;
    }
    // A both-UNDEF row is deliberately a NON-EVENT here. It looks like a withdrawal, but on the
    // only path that produces it — normalizeQuotes over a multi-row bbo window — it is a quiet
    // MINUTE, and deleting on it erased the real print that came before (wiping the forward
    // outright when the quiet minute was the future's). A genuine live withdrawal never reaches
    // applyTick: decodeL1Quote returns null for a both-UNDEF book and live-feed drops nulls.
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

/**
 * A build failure is not an internal detail any more: it is the 503 body and the text the live
 * badge paints (which slices at 80 chars). So the message is kept short and free of function
 * names, and the REASON travels as a code — a poller must be able to tell "seeding, try again
 * in a second" from "every book is a shell and will be for the next three hours".
 */
export type ChainBuildCode = 'no-forward' | 'no-quotes' | 'all-gated';

export class ChainBuildError extends Error {
  constructor(readonly code: ChainBuildCode, message: string) {
    super(message);
    this.name = 'ChainBuildError';
  }
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
  /** Whether `atmStrike` is genuinely AT the money — i.e. the nearest usable strike sits
   * within one listed strike-step of the forward. False means the near-money books were gated
   * and only a wing survived: `atmStrike` is then merely the nearest survivor, and the
   * at-the-money figures below are withheld rather than filled from that wing. */
  atmNearForward: boolean;
  /** True when this chain carries NO priceable strike — the quote-independent half (OI, PCR,
   * max pain, expirations) is real, everything IV-derived is absent. Set by the reducer, not by
   * a transport, so every consumer sees it and nobody has to infer the reason from an empty
   * array. `degradedCode` says WHICH emptiness it is: books refused by the gate ('all-gated')
   * or simply never quoted ('no-quotes'). */
  degraded: boolean;
  degradedCode: ChainBuildCode | null;
  /** Option books excluded by the usability gate (one-sided, crossed, cabinet-bid, or wider
   * than the forward cap). A thin smile and a gate-thinned smile look identical without it. */
  nGated: number;
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
  /**
   * Return a DEGRADED chain (no strikes, null IVs) instead of throwing when every option book
   * is unusable. The quote-independent half — OI totals, PCR, max pain, the expirations list —
   * comes from definitions and settlement statistics, which the gate has nothing to say about;
   * failing the whole call threw it away too. The LIVE path leaves this off on purpose: there
   * a flush that cannot be built must be skipped and retried, not published.
   */
  allowUnquoted?: boolean;
}

/**
 * An option book is IV-usable only when it is a genuine two-sided market whose width is small
 * against WHAT IS BEING PRICED. Live-probed failure class (HO, 2026-07-17 ~10:07Z): outside the
 * liquid session every strike's book was bid $0.0001 (the cabinet minimum) x ask ~$3 (a
 * market-maker safety quote ~80% of the forward away); the mid of that shell (~$1.58 on a ~$0.35
 * option) solved to a uniform ~314% "smile". Such a book carries no price information — the
 * strike must read as UNQUOTED, at the source, not clamped downstream.
 *
 * Three independent tests, because the class has three signatures:
 *
 *  - ONE-SIDED or CROSSED. A missing side is a bound, not a value; a crossed book is an
 *    auction/indicative state.
 *  - A CABINET BID against a safety ask — a market in name only. Scale-free by construction,
 *    which is why it catches the shell on a $4 underlying and on an $82 one alike.
 *  - WIDTH against the option's own value. The first cut capped the spread at 10% of the
 *    FORWARD, which is the wrong quantity: a fair ATM premium is ~0.4·F·sigma·sqrt(T), so on a
 *    high-priced or low-vol series that cap sits 10-30x above any honest price and a wide but
 *    non-cabinet book (1.00 x 5.00 on an option worth ~3) passes and prints an inflated IV.
 *    The width is measured against the MID instead: spread <= mid, i.e. the bid is at least a
 *    third of the ask. That still admits the genuinely wide wings a thin series legitimately
 *    quotes (a 60%-of-mid spread on a small real premium) while refusing a book whose own
 *    width exceeds what it claims to price. The absolute escape below keeps a near-zero book
 *    the ratio would decide by rounding: a spread a tenth of a percent of the forward is
 *    precise in absolute terms whatever its ratio says.
 *
 * The FUTURE is deliberately outside this gate (its one-sided mid still anchors the forward);
 * `spotEstimated` reports when that exemption was actually used.
 */
const MIN_BID_FRAC_OF_ASK = 0.01;
const MAX_SPREAD_FRAC_OF_MID = 1.0;
const NEGLIGIBLE_SPREAD_FRAC_OF_F = 0.001;

function usableOptionQuote(q: QuoteEntry, F: number): boolean {
  if (q.bid == null || q.ask == null) return false;
  if (q.ask < q.bid) return false;
  if (q.ask > 0 && q.bid < MIN_BID_FRAC_OF_ASK * q.ask) return false;
  const spread = q.ask - q.bid;
  if (spread <= NEGLIGIBLE_SPREAD_FRAC_OF_F * F) return true;
  return q.mid > 0 && spread <= MAX_SPREAD_FRAC_OF_MID * q.mid;
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
  if (F == null || F <= 0) throw new ChainBuildError('no-forward', 'no future quote yet — forward unknown');

  const calls = new Map<number, { iid: number; mid: number }>();
  const puts = new Map<number, { iid: number; mid: number }>();
  const listedStrikes: number[] = [];
  let sawOptionQuote = false;
  let nGated = 0;
  // `asOf` is built from the books that ACTUALLY entered the chain — the forward's, plus each
  // surviving option's. A gated shell must not lend its clock to prices it did not set.
  // ...and it is built from the OPTION books only. The forward is used by every chain and ticks
  // whenever the underlying does, so folding its clock in re-dates a smile whose option prints
  // are hours old — the same false freshness, moved from the gated shell onto the future.
  const usedTs: string[] = [];
  const fq = state.futureId != null ? state.quotes.get(state.futureId) : undefined;
  // The future is exempt from the gate on purpose — its mid is the only forward there is, and
  // refusing it would leave nothing to price against. But a one-sided or shell-wide future book
  // is a BOUND, not a price: it biases every IV and it sets the gate's own threshold. Exempt is
  // not the same as trustworthy, so the chain says which one it got.
  const fwdEstimated = !fq || fq.bid == null || fq.ask == null || !usableOptionQuote(fq, F);
  for (const [iid, d] of state.defs) {
    if ((d.cls !== 'C' && d.cls !== 'P') || d.expiration !== expiration || d.strike == null) continue;
    listedStrikes.push(d.strike);
    const q = state.quotes.get(iid);
    if (!q) continue;
    sawOptionQuote = true;
    if (usableOptionQuote(q, F)) {
      (d.cls === 'C' ? calls : puts).set(d.strike, { iid, mid: q.mid });
      if (q.ts) usedTs.push(q.ts);
    } else {
      nGated++;
    }
  }
  // state.lastTs is deliberately NOT a fallback: it is stamped by every stored quote, gated
  // shells included, so reaching for it lets a book the gate threw away date the chain — the
  // original defect, surviving in a narrower branch. Unknown is reported as unknown.
  const asOf = usedTs.length
    ? usedTs.reduce((a, b) => (a >= b ? a : b))
    : (fq?.ts ?? null); // no option book priced this chain — the forward's clock, or nothing
  const strikes = [...new Set([...calls.keys(), ...puts.keys()])].sort((a, b) => a - b);
  // The LISTED strike nearest the forward — a fact about the definitions, independent of any
  // quote. Stands in for the at-the-money anchor wherever the quoted set cannot supply one.
  const atmListed = listedStrikes.length
    ? listedStrikes.reduce((best, k) => (Math.abs(k - F) < Math.abs(best - F) ? k : best), listedStrikes[0])
    : F;

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
  const maxPain = oiStrikes.length ? oiStrikes.reduce((best, k) => (payout(k) < payout(best) ? k : best), oiStrikes[0]) : atmListed;

  const exps =
    opts.allExpirations ??
    [...new Set([...state.defs.values()].filter((d) => d.cls === 'C' || d.cls === 'P').map((d) => d.expiration))].sort();

  if (strikes.length === 0) {
    const err = sawOptionQuote
      ? new ChainBuildError('all-gated', 'no usable option book — every quote is one-sided, crossed or a shell')
      : new ChainBuildError('no-quotes', 'no option quotes yet');
    if (!opts.allowUnquoted) throw err;
    // Degraded: everything the gate cannot speak to is still true and still worth returning.
    return {
      symbol, expiration, dte: Math.max(0, Math.round(T * 365)), asOf, spot: F, spotEstimated: fwdEstimated,
      degraded: true, degradedCode: err.code,
      atmStrike: atmListed, atmNearForward: false, nGated, atmIV: null, skew25: null,
      call25IV: null, put25IV: null, call25Strike: null, put25Strike: null,
      pcrOI, pcrVol: null, callOItotal: coi, putOItotal: poi, maxPain,
      nContracts: 0, nExpirations: exps.length, expirations: exps, window,
      strikes: [], callIV: [], putIV: [], callOI: [], putOI: [],
      callDelta: [], putDelta: [], callVol: [], putVol: [],
    };
  }

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

  // Absolute spreads are widest AT the money, so a thin session gates the near-money books
  // first and leaves a wing standing. Picking the nearest SURVIVOR then publishes a deep-OTM
  // IV in a card labelled "ATM IV". The yardstick is the product's OWN strike grid, not a
  // percentage: you can never be closer to F than the nearest listed strike, so one step is
  // the tightest honest tolerance — and anything beyond it is a wing, not the money.
  // The step is measured AROUND THE FORWARD, not across the whole ladder: chains mix increments
  // (weekly strips, legacy fine ranges), and the finest gap anywhere would shrink the tolerance
  // at the money and disqualify a survivor that genuinely is the money.
  const grid = [...new Set(listedStrikes)].sort((a, b) => a - b);
  const hi = grid.findIndex((k) => k >= F);
  // ONLY the gap the forward sits inside. Taking the widest of the neighbouring gaps re-admitted
  // the defect on a mixed-increment ladder (fine near the money, coarse beyond): the tolerance
  // inflated and a wing was published as ATM again. And when F is outside the listed range
  // altogether there is no bracketing gap at all — that is not a case for a 2%-of-F guess, it
  // is a chain whose money is off the ladder, so nothing may be called at-the-money.
  // When F sits outside the listed range the bracketing gap does not exist; the increment at
  // the nearest END of the ladder is the honest stand-in (and is what "one strike step" means
  // there). With a single listed strike there is no increment at all — then nothing may be
  // called at-the-money, rather than falling back to a percentage guess.
  const gi = hi === -1 ? grid.length - 1 : Math.max(1, hi);
  const step = grid.length >= 2 ? grid[gi] - grid[gi - 1] : null;
  const atmNearForward = step != null && Math.abs(atm - F) <= step;

  const atmCiv = civ.get(atm) ?? null;
  const atmPiv = piv.get(atm) ?? null;
  const atmIVraw = atmCiv != null && atmPiv != null ? (atmCiv + atmPiv) / 2 : (atmCiv ?? atmPiv);
  const atmIV = atmNearForward ? atmIVraw : null;

  // 25-delta skew over the whole expiration
  // Withholding only the DIFFERENCE would be theatre: a consumer subtracts the two legs and
  // recovers the number the chain says it is not reporting. When the near-money books are gone,
  // the 25-delta reference points are as unanchored as the ATM one — withhold the whole set.
  const c25 = atmNearForward ? delta25(calls.keys(), cdl, 0.25, 0, 1) : null;
  const p25 = atmNearForward ? delta25(puts.keys(), pdl, -0.25, -1, 0) : null;
  const call25IV = c25 != null ? civ.get(c25) ?? null : null;
  const put25IV = p25 != null ? piv.get(p25) ?? null : null;
  const skew25 = call25IV != null && put25IV != null ? put25IV - call25IV : null;

  const col = (m: Map<number, number | null>): (number | null)[] => win.map((K) => m.get(K) ?? null);

  return {
    symbol,
    expiration,
    dte: Math.max(0, Math.round(T * 365)),
    asOf,
    spot: F,
    spotEstimated: fwdEstimated,
    atmStrike: atm,
    degraded: false,
    degradedCode: null,
    atmNearForward,
    nGated,
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
