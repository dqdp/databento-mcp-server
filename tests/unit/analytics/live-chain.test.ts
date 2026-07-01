/**
 * live-chain — the in-memory chain buffer for the LIVE smile: seed the static half (defs + OI +
 * an initial quote snapshot from the Historical pull) once, then fold streamed quote ticks in
 * and rebuild. Tracks which instrument_ids changed so the coalescer/scoped re-solve can be cheap.
 */
import { describe, it, expect } from 'vitest';
import { black76 } from '../../../src/analytics/black76.js';
import type { DefinitionRec, QuoteRec } from '../../../src/analytics/chain.js';
import { seedLiveChain, onLiveQuote, buildLiveChain } from '../../../src/analytics/live-chain.js';

const EXP = '2026-09-18';
const FUT = 100;
const F = 7467;
const SIG = 0.2;
const T = 0.2;
const def = (id: number, cls: 'C' | 'P' | 'F', K: number | null): DefinitionRec => ({
  type: 'definition', instrument_id: id, instrument_class: cls, strike: K, expiration: EXP, underlying: cls === 'F' ? '' : String(FUT),
});
const q = (id: number, mid: number): QuoteRec => ({ type: 'quote', instrument_id: id, bid: mid - 0.5, ask: mid + 0.5, ts: null });

// strikes 7400/7500, C(201/203) + P(202/204), future 100
const expDefs = [def(201, 'C', 7400), def(202, 'P', 7400), def(203, 'C', 7500), def(204, 'P', 7500)];
const futureDef = def(FUT, 'F', null);
const oi = new Map([[201, 1000], [202, 1200], [203, 900], [204, 800]]);
const seedQuotes: QuoteRec[] = [
  q(FUT, F),
  q(201, black76(F, 7400, T, SIG, { isCall: true }).price),
  q(202, black76(F, 7400, T, SIG, { isCall: false }).price),
  q(203, black76(F, 7500, T, SIG, { isCall: true }).price),
  q(204, black76(F, 7500, T, SIG, { isCall: false }).price),
];

function seed() {
  return seedLiveChain({ symbol: 'ES', expiration: EXP, T, window: 20, allExpirations: [EXP], futureDef, expDefs, oi, quotes: seedQuotes });
}

describe('live-chain buffer', () => {
  it('seeds from defs/OI/quotes and builds a full chain immediately (no waiting for live ticks)', () => {
    const chain = buildLiveChain(seed());
    expect(chain.spot).toBe(F);
    expect(chain.strikes).toEqual([7400, 7500]);
    for (const v of chain.callIV) if (v != null) expect(v).toBeCloseTo(SIG, 2);
    expect(chain.callOItotal).toBe(1900); // OI from the seed (whole expiration)
  });

  it('a streamed quote tick updates only that strike and marks it changed', () => {
    const lc = seed();
    buildLiveChain(lc); // initial
    lc.changed.clear();
    // 7500 call now implies 0.30
    onLiveQuote(lc, q(203, black76(F, 7500, T, 0.3, { isCall: true }).price));
    expect(lc.changed.has(203)).toBe(true);
    expect(lc.changed.size).toBe(1);
    const chain = buildLiveChain(lc);
    const i = chain.strikes.indexOf(7500);
    expect(chain.callIV[i]!).toBeCloseTo(0.3, 2);
    // the other strike's call IV is unchanged
    const j = chain.strikes.indexOf(7400);
    expect(chain.callIV[j]!).toBeCloseTo(SIG, 2);
  });

  it('a new forward (future) tick moves spot', () => {
    const lc = seed();
    buildLiveChain(lc);
    onLiveQuote(lc, q(FUT, 7480));
    expect(buildLiveChain(lc).spot).toBe(7480);
  });
});
