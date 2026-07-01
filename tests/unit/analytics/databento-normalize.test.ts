/**
 * databento-normalize — turns raw Databento GLBX.MDP3 CSV (definition / bbo / statistics)
 * into the reducer's normalized ChainRec[]. Fixtures use the REAL column shapes confirmed
 * against the live API (prices/strikes /1e9, expiration = ns timestamp, instrument_class a
 * char incl. spreads to filter out, bbo UNDEF = INT64_MAX, open interest = stat_type 9).
 */
import { describe, it, expect } from 'vitest';
import { black76 } from '../../../src/analytics/black76.js';
import { newState, applyTick, buildChain } from '../../../src/analytics/chain.js';
import {
  normalizeDefinitions,
  normalizeQuotes,
  normalizeStatistics,
  normalizeChain,
} from '../../../src/analytics/databento-normalize.js';

const EXP_NS = (BigInt(Date.UTC(2026, 8, 18)) * 1_000_000n).toString(); // 2026-09-18 UTC, in nanoseconds
const UNDEF = '9223372036854775807'; // INT64_MAX price sentinel

describe('normalizeDefinitions', () => {
  const csv =
    `instrument_id,raw_symbol,instrument_class,expiration,underlying_id,strike_price\n` +
    `100,ESU6,F,${EXP_NS},0,\n` +
    `201,ESU6 C7400,C,${EXP_NS},100,7400000000000\n` +
    `202,ESU6 P7400,P,${EXP_NS},100,7400000000000\n` +
    `900,UD:1V: SPREAD,T,${EXP_NS},100,\n`;
  const recs = normalizeDefinitions(csv);

  it('keeps only C/P/F and drops spreads (class T)', () => {
    expect(recs.map((r) => r.instrument_id).sort((a, b) => a - b)).toEqual([100, 201, 202]);
  });

  it('scales strike_price /1e9 and converts the ns expiration to a date', () => {
    const call = recs.find((r) => r.instrument_id === 201)!;
    expect(call).toMatchObject({
      type: 'definition',
      instrument_class: 'C',
      strike: 7400,
      expiration: '2026-09-18',
      underlying: '100',
    });
  });

  it('a future carries null strike and class F', () => {
    const fut = recs.find((r) => r.instrument_id === 100)!;
    expect(fut.instrument_class).toBe('F');
    expect(fut.strike).toBeNull();
  });
});

describe('normalizeQuotes (bbo)', () => {
  const csv =
    `instrument_id,ts_event,bid_px_00,ask_px_00\n` +
    `100,1789600000000000000,7466000000000,7468000000000\n` +
    `201,1789600000000000000,${UNDEF},${UNDEF}\n`;
  const recs = normalizeQuotes(csv);

  it('scales bid/ask /1e9', () => {
    const fut = recs.find((r) => r.instrument_id === 100)!;
    expect(fut.bid).toBe(7466);
    expect(fut.ask).toBe(7468);
  });

  it('maps the INT64_MAX UNDEF sentinel to null', () => {
    const q = recs.find((r) => r.instrument_id === 201)!;
    expect(q.bid).toBeNull();
    expect(q.ask).toBeNull();
  });
});

describe('normalizeStatistics (open interest = stat_type 9)', () => {
  const csv =
    `instrument_id,ts_ref,price,quantity,stat_type\n` +
    `201,0,975000000000,1500,9\n` + // stat_type 9 = open interest, value in `quantity`
    `100,0,975000000000,2147483647,7\n`; // stat_type 7 (lowest offer) -> ignored
  const recs = normalizeStatistics(csv);

  it('keeps only open interest with the quantity value', () => {
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ type: 'statistics', instrument_id: 201, stat_type: 'open_interest', value: 1500 });
  });
});

describe('normalize -> reducer end to end', () => {
  it('normalized real-shape CSV builds a chain with solved IV', () => {
    const F = 7467;
    const T = 0.05;
    const strikes = [7400, 7500];
    const px = (K: number, isCall: boolean) => Math.round(black76(F, K, T, 0.2, { isCall }).price * 1e9);
    let defRows = `instrument_id,raw_symbol,instrument_class,expiration,underlying_id,strike_price\n100,ESU6,F,${EXP_NS},0,\n`;
    let bboRows = `instrument_id,ts_event,bid_px_00,ask_px_00\n100,1,7466000000000,7468000000000\n`;
    let statRows = `instrument_id,ts_ref,price,quantity,stat_type\n`;
    let id = 200;
    for (const K of strikes) {
      for (const isCall of [true, false]) {
        const cls = isCall ? 'C' : 'P';
        defRows += `${id},ESU6 ${cls}${K},${cls},${EXP_NS},100,${K * 1e9}\n`;
        const p = px(K, isCall);
        bboRows += `${id},1,${p - 500000000},${p + 500000000}\n`;
        statRows += `${id},0,0,1000,9\n`;
        id++;
      }
    }
    const recs = normalizeChain({ definition: defRows, bbo: bboRows, statistics: statRows });
    const st = newState();
    for (const r of recs) applyTick(st, r);
    const chain = buildChain('ES', st, '2026-09-18', T, { window: 20 });

    expect(chain.spot).toBe(7467);
    expect(chain.strikes).toEqual([7400, 7500]);
    for (const v of chain.callIV) if (v != null) expect(v).toBeCloseTo(0.2, 2);
    for (const v of chain.putIV) if (v != null) expect(v).toBeCloseTo(0.2, 2);
    expect(chain.callOItotal).toBeGreaterThanOrEqual(1000);
  });
});
