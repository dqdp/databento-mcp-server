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
    expect(() => buildChain('OH', s, '2026-08-26', T_HO)).toThrow(/usable option quote/);
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
    expect(() => buildChain('OH', s, '2026-08-26', T_HO)).toThrow(/usable option quote/);
  });

  it('a crossed book (auction/indicative state) is not usable', () => {
    const s = hoState([{ type: 'quote', instrument_id: 42658626, bid: 0.4, ask: 0.3 }]);
    expect(() => buildChain('OH', s, '2026-08-26', T_HO)).toThrow(/usable option quote/);
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

  it('the spread cap is relative to the forward: <=10% of F passes, wider is gated', () => {
    const mk = (ask: number) => {
      const s = newState();
      const recs: ChainRec[] = [
        { type: 'definition', instrument_id: 1, instrument_class: 'F', strike: null, expiration: EXP },
        { type: 'quote', instrument_id: 1, bid: 99.5, ask: 100.5 }, // F = 100
        { type: 'definition', instrument_id: 10, instrument_class: 'C', strike: 100, expiration: EXP },
        { type: 'quote', instrument_id: 10, bid: 2, ask },
      ];
      for (const r of recs) applyTick(s, r);
      return s;
    };
    expect(buildChain('ES', mk(12), EXP, T0).callIV[0]).not.toBeNull(); // spread 10 = 10% of F
    expect(() => buildChain('ES', mk(12.5), EXP, T0)).toThrow(/usable option quote/); // 10.5%
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
