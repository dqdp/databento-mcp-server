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
});
