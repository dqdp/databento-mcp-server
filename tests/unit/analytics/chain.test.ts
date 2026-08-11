/**
 * Futures-options chain reducer — unit tests.
 *
 * Node port of the Python reducer (market_data_skill/scripts/databento_live.py +
 * test_databento_live.py). Folds NORMALIZED Databento records (definition / quote /
 * statistics; prices already /1e9, UNDEF -> null) into a compact chain object, solving IV
 * per strike via Black-76 (warm-started from the previous chain). Used by the snapshot
 * MCP tool now, and the live backend later.
 */
import { describe, it, expect } from 'vitest';
import { black76 } from '../../../src/analytics/black76.js';
import { newState, applyTick, forward, buildChain, type ChainRec } from '../../../src/analytics/chain.js';

const F0 = 7467;
const T0 = 0.05;
const SIG = 0.15;
const EXP = '2026-09-19';
const STRIKES = [7420, 7440, 7460, 7480, 7500];
const optMid = (K: number, sig: number, isCall: boolean) => black76(F0, K, T0, sig, { isCall }).price;

function buildRecs(): { recs: ChainRec[]; iid: Record<string, number> } {
  const recs: ChainRec[] = [
    { type: 'definition', instrument_id: 1, instrument_class: 'F', strike: null, expiration: EXP, underlying: 'ES' },
    { type: 'quote', instrument_id: 1, bid: 7466, ask: 7468 }, // future mid = 7467
  ];
  const iid: Record<string, number> = {};
  let id = 10;
  for (const K of STRIKES) {
    for (const right of ['C', 'P'] as const) {
      recs.push({ type: 'definition', instrument_id: id, instrument_class: right, strike: K, expiration: EXP, underlying: 'ES' });
      const m = optMid(K, SIG, right === 'C');
      recs.push({ type: 'quote', instrument_id: id, bid: m - 0.5, ask: m + 0.5 });
      iid[`${K}${right}`] = id;
      id++;
    }
  }
  recs.push({ type: 'statistics', instrument_id: iid['7460C'], stat_type: 'open_interest', value: 5000 });
  recs.push({ type: 'statistics', instrument_id: iid['7480P'], stat_type: 'open_interest', value: 3000 });
  return { recs, iid };
}

describe('futures-options chain reducer', () => {
  const { recs, iid } = buildRecs();
  const st = newState();
  for (const r of recs) applyTick(st, r);

  it('forward = future mid (7467)', () => {
    expect(forward(st)).toBe(7467);
  });

  it('an UNDEF quote is ignored (no crash)', () => {
    expect(() => applyTick(st, { type: 'quote', instrument_id: 999, bid: null, ask: null })).not.toThrow();
  });

  const chain = buildChain('ES', st, EXP, T0, { window: 20 });

  it('strikes + expiration + symbol', () => {
    expect(chain.strikes).toEqual([7420, 7440, 7460, 7480, 7500]);
    expect(chain.expiration).toBe(EXP);
    expect(chain.symbol).toBe('ES');
  });

  it('spot = forward, ATM nearest forward', () => {
    expect(chain.spot).toBe(7467);
    expect(chain.atmStrike).toBe(7460);
  });

  it('recovers IV ~0.15 on both legs', () => {
    for (const v of chain.callIV) if (v != null) expect(v).toBeCloseTo(0.15, 2);
    for (const v of chain.putIV) if (v != null) expect(v).toBeCloseTo(0.15, 2);
  });

  it('delta signs (call > 0, put < 0)', () => {
    for (const d of chain.callDelta) if (d != null) expect(d).toBeGreaterThan(0);
    for (const d of chain.putDelta) if (d != null) expect(d).toBeLessThan(0);
  });

  it('OI from statistics flows through', () => {
    expect(chain.callOItotal).toBeGreaterThanOrEqual(5000);
    expect(chain.putOItotal).toBeGreaterThanOrEqual(3000);
  });

  it('one new quote tick updates ONLY that strike (warm-start exact elsewhere)', () => {
    const newMid = optMid(7480, 0.2, true); // 7480 call now implies 0.20
    applyTick(st, { type: 'quote', instrument_id: iid['7480C'], bid: newMid - 0.5, ask: newMid + 0.5 });
    const chain2 = buildChain('ES', st, EXP, T0, { window: 20, prev: chain });
    const i = chain2.strikes.indexOf(7480);
    expect(chain2.callIV[i]!).toBeCloseTo(0.2, 2);
    for (let j = 0; j < chain.strikes.length; j++) {
      if (j !== i) expect(chain2.callIV[j]).toBe(chain.callIV[j]); // unchanged strikes identical
    }
  });
});

describe('buildChain edge branches', () => {
  const freshState = () => {
    const { recs } = buildRecs();
    const s = newState();
    for (const r of recs) applyTick(s, r);
    return s;
  };

  it('throws when there is no future quote', () => {
    const s = newState();
    applyTick(s, { type: 'definition', instrument_id: 10, instrument_class: 'C', strike: 7460, expiration: EXP });
    applyTick(s, { type: 'quote', instrument_id: 10, bid: 9, ask: 11 });
    expect(() => buildChain('ES', s, EXP, T0)).toThrow(/forward/);
  });

  it('throws when the future quotes but there are no option quotes', () => {
    const s = newState();
    applyTick(s, { type: 'definition', instrument_id: 1, instrument_class: 'F', strike: null, expiration: EXP });
    applyTick(s, { type: 'quote', instrument_id: 1, bid: 7466, ask: 7468 });
    expect(() => buildChain('ES', s, EXP, T0)).toThrow();
  });

  const chain = buildChain('ES', freshState(), EXP, T0, { window: 20 });

  it('PCR(OI) = putOI / callOI', () => {
    expect(chain.pcrOI).not.toBeNull();
    expect(chain.pcrOI!).toBeCloseTo(3000 / 5000, 9);
  });

  it('max pain is one of the listed strikes', () => {
    expect(chain.strikes).toContain(chain.maxPain);
  });

  it('25-delta skew is ~flat for a flat smile, with both wings found', () => {
    expect(chain.skew25).not.toBeNull();
    expect(Math.abs(chain.skew25!)).toBeLessThan(0.02);
    expect(chain.call25Strike).not.toBeNull();
    expect(chain.put25Strike).not.toBeNull();
  });

  it('callVol/putVol are null arrays (reference parity)', () => {
    expect(chain.callVol).toHaveLength(chain.strikes.length);
    expect(chain.callVol.every((v) => v === null)).toBe(true);
    expect(chain.putVol.every((v) => v === null)).toBe(true);
  });

  it('window slicing narrows the strike set around ATM', () => {
    const c = buildChain('ES', freshState(), EXP, T0, { window: 1 });
    expect(c.strikes).toEqual([7440, 7460, 7480]); // ATM 7460 +/- 1
  });

  it('OI aggregates + max pain span the WHOLE expiration, not just the quoted band', () => {
    // The snapshot pull narrows QUOTES to a band around the forward, but OI is loaded whole —
    // max pain / PCR / OI totals must still reflect strikes with NO quote (the wings).
    const cMid = optMid(7460, SIG, true);
    const pMid = optMid(7460, SIG, false);
    const recs: ChainRec[] = [
      { type: 'definition', instrument_id: 1, instrument_class: 'F', strike: null, expiration: EXP },
      { type: 'quote', instrument_id: 1, bid: 7466, ask: 7468 }, // forward 7467
      // one quoted ATM strike (the narrowed band)
      { type: 'definition', instrument_id: 10, instrument_class: 'C', strike: 7460, expiration: EXP },
      { type: 'quote', instrument_id: 10, bid: cMid - 0.5, ask: cMid + 0.5 },
      { type: 'statistics', instrument_id: 10, stat_type: 'open_interest', value: 1000 },
      { type: 'definition', instrument_id: 11, instrument_class: 'P', strike: 7460, expiration: EXP },
      { type: 'quote', instrument_id: 11, bid: pMid - 0.5, ask: pMid + 0.5 },
      { type: 'statistics', instrument_id: 11, stat_type: 'open_interest', value: 1000 },
      // an UNQUOTED deep-OTM wing put with dominant OI (outside the quoted band)
      { type: 'definition', instrument_id: 20, instrument_class: 'P', strike: 8000, expiration: EXP },
      { type: 'statistics', instrument_id: 20, stat_type: 'open_interest', value: 1_000_000 },
    ];
    const s = newState();
    for (const r of recs) applyTick(s, r);
    const c = buildChain('ES', s, EXP, T0, { window: 20 });

    expect(c.strikes).toEqual([7460]); // smile is over the quoted band only
    expect(c.callOItotal).toBe(1000);
    expect(c.putOItotal).toBe(1_001_000); // 1000 band + 1_000_000 wing
    expect(c.maxPain).toBe(8000); // the wing strike — impossible under band-limited OI
  });
});

describe('option quote-quality gate (the HO 6am shell-book class)', () => {
  // Live-probed 2026-07-17 ~10:07Z (GLBX.MDP3 bbo-1m, raw /1e9): HOU6 quoted a tight, sane book
  // while EVERY OHU6 2026-08-26 option showed bid $0.0001 (the cabinet minimum) x ask ~$3 (a
  // market-maker safety quote ~80% of the forward away). The mid of that shell (~$1.58 on a
  // ~$0.35 option) solved to a uniform ~314% "smile" served verbatim by /smile/:root.json.
  // A book that wide carries no price information: the strike must read as UNQUOTED.
  const F_HO = 3.9651; // future bid 3.9640 x ask 3.9662 (tight — mid is the honest forward)
  const T_HO = 40 / 365; // 2026-07-17 -> 2026-08-26

  const hoState = (optionQuotes: ChainRec[]) => {
    const s = newState();
    const base: ChainRec[] = [
      { type: 'definition', instrument_id: 486417, instrument_class: 'F', strike: null, expiration: '2026-08-26' },
      { type: 'quote', instrument_id: 486417, bid: 3.964, ask: 3.9662 },
      { type: 'definition', instrument_id: 42658626, instrument_class: 'C', strike: 3.97, expiration: '2026-08-26' },
      { type: 'definition', instrument_id: 42831140, instrument_class: 'P', strike: 3.97, expiration: '2026-08-26' },
      { type: 'definition', instrument_id: 42506345, instrument_class: 'C', strike: 4.17, expiration: '2026-08-26' },
    ];
    for (const r of [...base, ...optionQuotes]) applyTick(s, r);
    return s;
  };

  it('a shell-wide book (cabinet bid x safety ask) is NOT solved to an IV', () => {
    // the exact probed books: C39700 0.0001x3.1588, P39700 0.0001x3.1438, C41700 0.0001x3.0647
    const s = hoState([
      { type: 'quote', instrument_id: 42658626, bid: 0.0001, ask: 3.1588 },
      { type: 'quote', instrument_id: 42831140, bid: 0.0001, ask: 3.1438 },
      { type: 'quote', instrument_id: 42506345, bid: 0.0001, ask: 3.0647 },
    ]);
    // pre-fix this "built" a chain whose every IV was ~3.1 (314%); post-fix there is no usable
    // quote at all and the build fails loud with a message DISTINCT from "no option quotes yet"
    expect(() => buildChain('OH', s, '2026-08-26', T_HO)).toThrow(/usable option book/);
  });

  it('a real tight book still solves; shell-quoted strikes read as unquoted beside it', () => {
    const m = black76(F_HO, 3.97, T_HO, 0.66, { isCall: true }).price; // ~the settlement-path IV
    const s = hoState([
      { type: 'quote', instrument_id: 42658626, bid: m - 0.005, ask: m + 0.005 },
      { type: 'quote', instrument_id: 42831140, bid: 0.0001, ask: 3.1438 }, // shell put, same strike
      { type: 'quote', instrument_id: 42506345, bid: 0.0001, ask: 3.0647 }, // shell wing call
    ]);
    const c = buildChain('OH', s, '2026-08-26', T_HO);
    expect(c.strikes).toEqual([3.97]); // the shell-quoted 4.17 wing is not a quoted strike
    expect(c.callIV[0]!).toBeCloseTo(0.66, 2);
    expect(c.putIV[0]).toBeNull(); // the shell put did not fabricate an IV
    expect(c.atmIV!).toBeCloseTo(0.66, 2); // atmIV falls back to the one honest leg
  });

  it('a one-sided book is a bound, not a value — no IV from it', () => {
    const s = hoState([
      { type: 'quote', instrument_id: 42658626, bid: null, ask: 3.1588 }, // ask-only
      { type: 'quote', instrument_id: 42831140, bid: 0.0001, ask: null }, // cabinet bid-only
    ]);
    expect(() => buildChain('OH', s, '2026-08-26', T_HO)).toThrow(/usable option book/);
  });

  it('a crossed book (auction/indicative state) is not usable', () => {
    const s = hoState([{ type: 'quote', instrument_id: 42658626, bid: 0.4, ask: 0.3 }]);
    expect(() => buildChain('OH', s, '2026-08-26', T_HO)).toThrow(/usable option book/);
  });

  it('a genuine wide-but-tiny deep-OTM book is KEPT (wings stay honest)', () => {
    const m = black76(F_HO, 4.17, T_HO, 0.7, { isCall: true }).price; // small, real premium
    const s = hoState([{ type: 'quote', instrument_id: 42506345, bid: m * 0.7, ask: m * 1.3 }]);
    const c = buildChain('OH', s, '2026-08-26', T_HO);
    expect(c.strikes).toEqual([4.17]);
    expect(c.callIV[0]!).toBeCloseTo(0.7, 1); // 100%-of-mid spread but tiny vs F — usable
  });

  it('a truly-tiny cabinet book (0.0001 x 0.0003) passes — the cap scales with F, not the mid', () => {
    const s = hoState([{ type: 'quote', instrument_id: 42506345, bid: 0.0001, ask: 0.0003 }]);
    const c = buildChain('OH', s, '2026-08-26', T_HO);
    expect(c.strikes).toEqual([4.17]);
    expect(c.callIV[0]).not.toBeNull(); // 100%-of-mid spread, but honest price discovery at the wing
  });

  it("a GATED strike's OI still feeds the whole-expiration aggregates", () => {
    // OI is settlement data, independent of the book's quality — gating a shell QUOTE must not
    // erase the strike from totals / PCR / max pain (the reducer's whole-expiration invariant).
    const m = black76(F_HO, 3.97, T_HO, 0.66, { isCall: true }).price;
    const s = hoState([
      { type: 'quote', instrument_id: 42658626, bid: m - 0.005, ask: m + 0.005 }, // real ATM call
      { type: 'quote', instrument_id: 42506345, bid: 0.0001, ask: 3.0647 }, // shell wing call
    ]);
    applyTick(s, { type: 'statistics', instrument_id: 42658626, stat_type: 'open_interest', value: 10 });
    applyTick(s, { type: 'statistics', instrument_id: 42506345, stat_type: 'open_interest', value: 5000 });
    applyTick(s, { type: 'statistics', instrument_id: 42831140, stat_type: 'open_interest', value: 7000 }); // shell put, unquoted here
    const c = buildChain('OH', s, '2026-08-26', T_HO);
    expect(c.strikes).toEqual([3.97]); // the shell strike is unquoted for DISPLAY...
    expect(c.callOItotal).toBe(5010); // ...but gated/unquoted OI still counts
    expect(c.putOItotal).toBe(7000);
    expect(c.pcrOI!).toBeCloseTo(7000 / 5010, 9); // impossible if gating ate the OI maps
  });

  it('the width cap is keyed to the OPTION\'s own value, not to the forward alone', () => {
    // 10% of F is the wrong yardstick: a fair ATM premium is ~0.4·F·sigma·sqrt(T), so on a
    // high-priced underlying the F-cap sits many times above any honest price and a wide
    // non-cabinet book (bid 1 x ask 5 on an option worth ~3) walks under it and prints an
    // inflated IV. The width is measured against the mid instead, with an absolute escape for
    // books whose whole spread is a rounding error against F.
    const mk = (bid: number, ask: number) => {
      const s = newState();
      const recs: ChainRec[] = [
        { type: 'definition', instrument_id: 1, instrument_class: 'F', strike: null, expiration: EXP },
        { type: 'quote', instrument_id: 1, bid: 99.5, ask: 100.5 }, // F = 100
        { type: 'definition', instrument_id: 10, instrument_class: 'C', strike: 100, expiration: EXP },
        { type: 'quote', instrument_id: 10, bid, ask },
      ];
      for (const r of recs) applyTick(s, r);
      return s;
    };
    expect(buildChain('ES', mk(3.9, 4.1), EXP, T0).callIV[0]).not.toBeNull();  // a real market
    // wide but NOT a cabinet bid: passes the bid-ratio test and the old 10%-of-F cap alike
    expect(() => buildChain('ES', mk(1, 5), EXP, T0)).toThrow(/usable option book/);
    // ...and a genuinely tiny two-sided book stays, because its whole width is negligible vs F
    expect(buildChain('ES', mk(0.02, 0.04), EXP, T0).callIV[0]).not.toBeNull();
  });

  it('zero quotes at all still reads "no option quotes yet" (distinct from all-gated)', () => {
    const s = hoState([]);
    expect(() => buildChain('OH', s, '2026-08-26', T_HO)).toThrow(/no option quotes yet/);
  });

  it('the FUTURE is deliberately outside the gate: a one-sided future still anchors the forward', () => {
    const s = newState();
    const recs: ChainRec[] = [
      { type: 'definition', instrument_id: 1, instrument_class: 'F', strike: null, expiration: EXP },
      { type: 'quote', instrument_id: 1, bid: 7467, ask: null }, // bid-only future
      { type: 'definition', instrument_id: 10, instrument_class: 'C', strike: 7460, expiration: EXP },
      { type: 'quote', instrument_id: 10, bid: optMid(7460, SIG, true) - 0.5, ask: optMid(7460, SIG, true) + 0.5 },
    ];
    for (const r of recs) applyTick(s, r);
    const c = buildChain('ES', s, EXP, T0);
    expect(c.spot).toBe(7467);
    expect(c.callIV[0]!).toBeCloseTo(SIG, 2);
  });
});

// The gate introduced states the surrounding code did not model: a chain whose clock keeps
// advancing on quotes the gate threw away, an all-gated build that discards the
// quote-independent half of the chain, an "ATM" that drifted onto a surviving wing, and a
// cap keyed to the forward that a cheap option's shell slips straight under.
describe('buildChain — what the gate must not break', () => {
  const F_HO = 3.9651;
  const T_HO = 40 / 365;
  const EXP_HO = '2026-08-26';
  const hoState = (optionQuotes: ChainRec[]) => {
    const s = newState();
    const base: ChainRec[] = [
      { type: 'definition', instrument_id: 486417, instrument_class: 'F', strike: null, expiration: EXP_HO },
      { type: 'quote', instrument_id: 486417, bid: 3.964, ask: 3.9662, ts: '2026-07-17T10:00:00Z' },
      { type: 'definition', instrument_id: 42658626, instrument_class: 'C', strike: 3.97, expiration: EXP_HO },
      { type: 'definition', instrument_id: 42831140, instrument_class: 'P', strike: 3.97, expiration: EXP_HO },
      { type: 'definition', instrument_id: 42506345, instrument_class: 'C', strike: 4.17, expiration: EXP_HO },
      { type: 'statistics', instrument_id: 42658626, stat_type: 'open_interest', value: 400 },
      { type: 'statistics', instrument_id: 42831140, stat_type: 'open_interest', value: 900 },
    ];
    for (const r of [...base, ...optionQuotes]) applyTick(s, r);
    return s;
  };
  const tightCall = (sig = 0.66) => black76(F_HO, 3.97, T_HO, sig, { isCall: true }).price;

  it('asOf is the vintage of the quotes that were USED, not of a gated shell that ticked later', () => {
    const m = tightCall();
    const s = hoState([
      { type: 'quote', instrument_id: 42658626, bid: m - 0.005, ask: m + 0.005, ts: '2026-07-17T09:55:00Z' },
      // the shell ticks HOURS later and is gated — it must not pass for freshness
      { type: 'quote', instrument_id: 42506345, bid: 0.0001, ask: 3.0647, ts: '2026-07-17T13:40:00Z' },
    ]);
    const c = buildChain('OH', s, EXP_HO, T_HO);
    // the option print that actually set the smile — neither the 13:40 shell that was gated,
    // nor the future's own 10:00 tick (see the round-2 test: the forward's clock is not the
    // options' clock, and folding it in re-dates a stale smile just as the shell did)
    expect(c.asOf).toBe('2026-07-17T09:55:00Z');
  });

  it('an all-gated build can DEGRADE instead of failing the whole call', () => {
    const s = hoState([
      { type: 'quote', instrument_id: 42658626, bid: 0.0001, ask: 3.1588 },
      { type: 'quote', instrument_id: 42831140, bid: 0.0001, ask: 3.1438 },
    ]);
    expect(() => buildChain('OH', s, EXP_HO, T_HO)).toThrow(/usable option book/); // live: unchanged
    const c = buildChain('OH', s, EXP_HO, T_HO, { allowUnquoted: true });
    expect(c.strikes).toEqual([]);
    expect(c.atmIV).toBeNull();
    expect(c.nContracts).toBe(0);
    // the half the gate has nothing to say about survives: it comes from defs + statistics
    expect(c.callOItotal).toBe(400);
    expect(c.putOItotal).toBe(900);
    expect(c.pcrOI).toBeCloseTo(900 / 400, 6);
    expect(c.maxPain).toBeGreaterThan(0);
    expect(c.expirations).toContain(EXP_HO);
    expect(c.nGated).toBe(2);
  });

  it('a surviving WING is not published as ATM when the near-money books were gated', () => {
    const wing = black76(F_HO, 4.17, T_HO, 0.7, { isCall: true }).price;
    const s = hoState([
      { type: 'quote', instrument_id: 42658626, bid: 0.20, ask: 0.70 },  // near-money, gated (wide)
      { type: 'quote', instrument_id: 42831140, bid: 0.20, ask: 0.70 },  // ditto
      { type: 'quote', instrument_id: 42506345, bid: wing - 0.002, ask: wing + 0.002 }, // wing survives
    ]);
    const c = buildChain('OH', s, EXP_HO, T_HO);
    expect(c.strikes).toEqual([4.17]);
    expect(c.atmNearForward).toBe(false);
    expect(c.atmIV).toBeNull();   // 4.17 is 5% out — its IV is a wing IV, not "ATM IV"
    expect(c.skew25).toBeNull();
  });

  it('a survivor one strike-step from the forward still reports a real ATM', () => {
    const m = tightCall();
    const s = hoState([{ type: 'quote', instrument_id: 42658626, bid: m - 0.005, ask: m + 0.005 }]);
    const c = buildChain('OH', s, EXP_HO, T_HO);
    expect(c.atmNearForward).toBe(true);
    expect(c.atmIV!).toBeCloseTo(0.66, 2);
  });

  it('a cabinet bid is gated even when the spread fits UNDER the forward cap', () => {
    // WTI scale: F=82 -> the 10%-of-F cap is $8.20, while a fair 40-DTE ATM premium is ~$2.5.
    // A 0.0001 x 5.00 shell slips under the cap; it is still a bid of nothing.
    const s = newState();
    for (const r of [
      { type: 'definition', instrument_id: 1, instrument_class: 'F', strike: null, expiration: EXP_HO },
      { type: 'quote', instrument_id: 1, bid: 81.99, ask: 82.01 },
      { type: 'definition', instrument_id: 2, instrument_class: 'C', strike: 82, expiration: EXP_HO },
      { type: 'quote', instrument_id: 2, bid: 0.0001, ask: 5.0 },
    ] as ChainRec[]) applyTick(s, r);
    expect(() => buildChain('LO', s, EXP_HO, T_HO)).toThrow(/usable option book/);
  });

  it('a genuinely tiny two-sided wing still passes (the cap is not a bid floor in dollars)', () => {
    const s = hoState([{ type: 'quote', instrument_id: 42506345, bid: 0.0001, ask: 0.0003 }]);
    const c = buildChain('OH', s, EXP_HO, T_HO, { allowUnquoted: true });
    expect(c.strikes).toEqual([4.17]); // kept: 0.0001 is 33% of the ask, a real market
    expect(c.nGated).toBe(0);
  });
});

// The build failure now leaves the process: it is the 503 body and the live badge's text. That
// makes the message a CONTRACT — short enough to survive the page's 80-char slice — and the
// reason machine-readable, since "warming up" and "every book is a shell for the next 3 hours"
// deserve different handling from a polling client.
describe('buildChain — failures are a public contract, not a stack trace', () => {
  const EXP_HO = '2026-08-26';
  const T_HO = 40 / 365;
  const st = (recs: ChainRec[]) => { const s = newState(); for (const r of recs) applyTick(s, r); return s; };
  const base: ChainRec[] = [
    { type: 'definition', instrument_id: 1, instrument_class: 'F', strike: null, expiration: EXP_HO },
    { type: 'definition', instrument_id: 2, instrument_class: 'C', strike: 3.97, expiration: EXP_HO },
  ];

  it('every build failure carries a machine-readable code', () => {
    const noFwd = st([base[1]]);
    expect(() => buildChain('OH', noFwd, EXP_HO, T_HO)).toThrow(
      expect.objectContaining({ code: 'no-forward' }),
    );
    const noQuotes = st([...base, { type: 'quote', instrument_id: 1, bid: 3.964, ask: 3.9662 }]);
    expect(() => buildChain('OH', noQuotes, EXP_HO, T_HO)).toThrow(
      expect.objectContaining({ code: 'no-quotes' }),
    );
    const gated = st([...base,
      { type: 'quote', instrument_id: 1, bid: 3.964, ask: 3.9662 },
      { type: 'quote', instrument_id: 2, bid: 0.0001, ask: 3.1588 }]);
    expect(() => buildChain('OH', gated, EXP_HO, T_HO)).toThrow(
      expect.objectContaining({ code: 'all-gated' }),
    );
  });

  it('the message survives the page slice that renders it (80 chars)', () => {
    const gated = st([...base,
      { type: 'quote', instrument_id: 1, bid: 3.964, ask: 3.9662 },
      { type: 'quote', instrument_id: 2, bid: 0.0001, ask: 3.1588 }]);
    let msg = '';
    try { buildChain('OH', gated, EXP_HO, T_HO); } catch (e) { msg = (e as Error).message; }
    expect(msg.length).toBeLessThanOrEqual(80);
    expect(msg).not.toMatch(/buildChain:/);   // the function name is not the client's business
    expect(msg).toMatch(/shell|one-sided|usable/);
  });

  it('a one-sided FUTURE still anchors the forward, but the chain says so', () => {
    // The future is exempt from the gate on purpose — its mid is the only forward there is —
    // but a bid-only book is a bound, not a price, and it also SETS the gate threshold.
    const s = st([...base,
      { type: 'quote', instrument_id: 1, bid: 3.964, ask: null },
      { type: 'quote', instrument_id: 2, bid: 0.30, ask: 0.32 }]);
    const c = buildChain('OH', s, EXP_HO, T_HO);
    expect(c.spot).toBe(3.964);
    expect(c.spotEstimated).toBe(true);
  });

  it('a two-sided future reports an exact forward', () => {
    const s = st([...base,
      { type: 'quote', instrument_id: 1, bid: 3.964, ask: 3.9662 },
      { type: 'quote', instrument_id: 2, bid: 0.30, ask: 0.32 }]);
    expect(buildChain('OH', s, EXP_HO, T_HO).spotEstimated).toBe(false);
  });
});

describe('applyTick — an empty bbo row is not a withdrawal', () => {
  const EXP = '2026-09-18';
  const T = 0.2;

  it('a both-UNDEF row must NOT erase the quote it follows', () => {
    // bbo-1m over a 15-minute window emits one row per instrument per MINUTE, and a quiet
    // minute publishes UNDEF/UNDEF. Treating that as a withdrawal deletes the earlier real
    // print — and when the quiet minute belongs to the FUTURE it wipes the forward, which
    // fails the whole call before allowUnquoted can degrade anything. (A genuine live
    // withdrawal never reaches here at all: decodeL1Quote returns null for a both-UNDEF book
    // and live-feed drops nulls, so this path only ever sees historical window artefacts.)
    const s = newState();
    for (const r of [
      { type: 'definition', instrument_id: 100, instrument_class: 'F', strike: null, expiration: EXP },
      { type: 'definition', instrument_id: 201, instrument_class: 'C', strike: 7500, expiration: EXP },
      { type: 'quote', instrument_id: 100, bid: 7466, ask: 7468 },
      { type: 'quote', instrument_id: 201, bid: 100, ask: 110 },
      { type: 'quote', instrument_id: 100, bid: null, ask: null },   // the quiet minute
      { type: 'quote', instrument_id: 201, bid: null, ask: null },
    ] as ChainRec[]) applyTick(s, r);

    const c = buildChain('ES', s, EXP, T);
    expect(c.spot).toBe(7467);        // the forward survived the quiet minute
    expect(c.strikes).toEqual([7500]);
  });
});

describe('buildChain — round-2 corrections to the gate reporting', () => {
  const EXP = '2026-09-18';
  const T = 0.2;
  const st = (recs: ChainRec[]) => { const s = newState(); for (const r of recs) applyTick(s, r); return s; };

  it('a ticking FUTURE does not re-date a smile whose option prints are hours old', () => {
    // asOf was moved off the global clock onto "the books that were used" — but the future is
    // always one of those, so the freshness lie simply moved from the gated shell to the
    // forward. The smile is a statement about OPTION prices; the forward's clock is not theirs.
    const s = st([
      { type: 'definition', instrument_id: 100, instrument_class: 'F', strike: null, expiration: EXP },
      { type: 'definition', instrument_id: 201, instrument_class: 'C', strike: 7500, expiration: EXP },
      { type: 'quote', instrument_id: 201, bid: 100, ask: 110, ts: '2026-06-30T09:55:00Z' },
      { type: 'quote', instrument_id: 100, bid: 7466, ask: 7468, ts: '2026-06-30T13:40:00Z' },
    ]);
    expect(buildChain('ES', s, EXP, T).asOf).toBe('2026-06-30T09:55:00Z');
  });

  it('with no option book at all, the forward\'s clock is the only one there is', () => {
    const s = st([
      { type: 'definition', instrument_id: 100, instrument_class: 'F', strike: null, expiration: EXP },
      { type: 'definition', instrument_id: 201, instrument_class: 'C', strike: 7500, expiration: EXP },
      { type: 'quote', instrument_id: 100, bid: 7466, ask: 7468, ts: '2026-06-30T13:40:00Z' },
    ]);
    expect(buildChain('ES', s, EXP, T, { allowUnquoted: true }).asOf).toBe('2026-06-30T13:40:00Z');
  });

  it('withholding the skew withholds the legs it is computed from', () => {
    // Publishing call25IV/put25IV while nulling skew25 lets any consumer subtract them back:
    // the number is "withheld" in name only.
    const wingC = black76(7467, 8200, T, 0.4, { isCall: true }).price;
    const s = st([
      { type: 'definition', instrument_id: 100, instrument_class: 'F', strike: null, expiration: EXP },
      { type: 'quote', instrument_id: 100, bid: 7466, ask: 7468 },
      { type: 'definition', instrument_id: 201, instrument_class: 'C', strike: 7500, expiration: EXP },
      { type: 'quote', instrument_id: 201, bid: 0.0001, ask: 3000 },              // near-money, gated
      { type: 'definition', instrument_id: 202, instrument_class: 'C', strike: 8200, expiration: EXP },
      { type: 'quote', instrument_id: 202, bid: wingC - 0.5, ask: wingC + 0.5 },  // wing survives
    ]);
    const c = buildChain('ES', s, EXP, T);
    expect(c.atmNearForward).toBe(false);
    expect(c.skew25).toBeNull();
    expect(c.call25IV).toBeNull();
    expect(c.put25IV).toBeNull();
    expect(c.call25Strike).toBeNull();
    expect(c.put25Strike).toBeNull();
  });

  it('the ATM tolerance is the LOCAL strike step, not the finest gap anywhere in the grid', () => {
    // Chains mix increments: a fine strip somewhere (weeklies, a legacy range) must not shrink
    // the tolerance around the money and disqualify a legitimately at-the-money survivor.
    const F = 7467;
    const atmC = black76(F, 7475, T, 0.2, { isCall: true }).price;
    const recs: ChainRec[] = [
      { type: 'definition', instrument_id: 100, instrument_class: 'F', strike: null, expiration: EXP },
      { type: 'quote', instrument_id: 100, bid: 7466, ask: 7468 },
      { type: 'definition', instrument_id: 201, instrument_class: 'C', strike: 7475, expiration: EXP },
      { type: 'quote', instrument_id: 201, bid: atmC - 0.5, ask: atmC + 0.5 },
      { type: 'definition', instrument_id: 202, instrument_class: 'C', strike: 7450, expiration: EXP },
      { type: 'definition', instrument_id: 203, instrument_class: 'C', strike: 7500, expiration: EXP },
      // a fine 1-point strip far away — 25 points from the money, but 1 point apart
      { type: 'definition', instrument_id: 204, instrument_class: 'C', strike: 9000, expiration: EXP },
      { type: 'definition', instrument_id: 205, instrument_class: 'C', strike: 9001, expiration: EXP },
    ];
    const c = buildChain('ES', st(recs), EXP, T);
    expect(c.atmStrike).toBe(7475);
    expect(c.atmNearForward).toBe(true);   // 8 points out on a 25-point local grid IS the money
    expect(c.atmIV).not.toBeNull();
  });
});
