/**
 * term-data — the DAY-CACHED cross-expiration payload behind GET /term/:root.json. Long-dated
 * inputs (parent definitions, parent statistics, per-underlying settlements) are daily-static;
 * live probes (2026-07-05) put one OG.OPT defs parent pull at 40-60s and the whole-root stats
 * parent at MINUTES server-side — so the reduction is computed once per (dataset, root, day)
 * and every later /term poll is instant. The payload is the compact per-series shape the
 * skill's gather_term(fetch=shim) consumes (real stems, real underlying symbols, settlements
 * in HUMAN units).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getTermData, clearTermDataCache } from '../../../src/analytics/term-data.js';
import { clearSmileStaticCache } from '../../../src/analytics/smile-cache.js';

const ns = (d: string) => (BigInt(Date.parse(`${d}T20:00:00Z`)) * 1_000_000n).toString();
const NS = 1_000_000_000;

// REAL definition CSV shape (header-driven; includes the `underlying` SYMBOL column the live
// feed carries — the NG-width class of bug means it must be read, never reconstructed).
const defCsv =
  `instrument_id,raw_symbol,instrument_class,expiration,underlying_id,strike_price,underlying\n` +
  `100,OGQ6 C4100,C,${ns('2026-07-28')},77,${4100 * NS},GCQ26\n` +
  `101,OGQ6 P4100,P,${ns('2026-07-28')},77,${4100 * NS},GCQ26\n` +
  `102,OGQ6 C4200,C,${ns('2026-07-28')},77,${4200 * NS},GCQ26\n` +
  `200,OGU6 C4150,C,${ns('2026-08-26')},78,${4150 * NS},GCU26\n` +
  `201,OGU6 P4150,P,${ns('2026-08-26')},78,${4150 * NS},GCU26\n` +
  `300,OGZ8 C4400,C,${ns('2028-11-27')},99,${4400 * NS},GCZ28\n` + // beyond maxDays -> excluded
  `400,OGK6 C4000,C,${ns('2026-04-27')},60,${4000 * NS},GCK26\n` + // expired -> excluded
  `500,SPREAD,T,${ns('2026-07-28')},0,0,\n`; // non-C/P class -> dropped by normalize

// One statistics parent pull carries BOTH settlements (stat_type 3, price) and OI (9, quantity).
const statCsv =
  `instrument_id,ts_ref,price,quantity,stat_type\n` +
  `100,0,${52.4 * NS},0,3\n` +
  `100,0,0,150,9\n` +
  `101,0,${48.1 * NS},0,3\n` +
  `102,0,${15.2 * NS},0,3\n` +
  `102,0,0,2147483647,9\n` + // UNDEF_I32 OI sentinel -> treated as absent
  `200,0,${60.0 * NS},0,3\n` +
  `201,0,${58.5 * NS},0,3\n` +
  `201,0,0,44,9\n`;

const futSettle = (sym: string, px: number) =>
  `instrument_id,ts_ref,price,quantity,stat_type\n9,0,${px * NS},0,3\n`;

function source() {
  const calls: Array<{ schema: string; symbols: string; stype_in?: string }> = [];
  const getRange = vi.fn(async (req: { schema: string; symbols: string; stype_in?: string }) => {
    calls.push({ schema: req.schema, symbols: req.symbols, stype_in: req.stype_in });
    if (req.schema === 'definition') return { data: defCsv };
    if (req.schema === 'statistics' && req.symbols === 'OG.OPT') return { data: statCsv };
    if (req.schema === 'statistics' && req.symbols === 'GCQ26') return { data: futSettle('GCQ26', 4126.0) };
    if (req.schema === 'statistics' && req.symbols === 'GCU26') return { data: futSettle('GCU26', 4155.0) };
    if (req.schema === 'statistics') return { data: 'instrument_id,ts_ref,price,quantity,stat_type\n' };
    throw new Error(`unexpected schema ${req.schema}`);
  });
  return { getRange, calls };
}

describe('getTermData', () => {
  beforeEach(() => {
    clearTermDataCache();
    clearSmileStaticCache();
  });

  it('reduces defs+stats to per-series strikes with settlements in HUMAN units + real stems/underlyings', async () => {
    const { getRange } = source();
    const t = await getTermData({ getRange }, 'GC', { asOf: '2026-07-05', maxDays: 400, maxSeries: 10 });
    expect(t.root).toBe('GC');
    expect(t.optionsRoot).toBe('OG');
    expect(t.series.map((s) => s.stem)).toEqual(['OGQ6', 'OGU6']); // expired + >400d excluded, ascending
    const q6 = t.series[0];
    expect(q6.expiration).toBe('2026-07-28');
    expect(q6.under).toBe('GCQ26');
    expect(q6.fwdSettle).toBeCloseTo(4126.0, 9);
    const k4100 = q6.strikes.find((s) => s.k === 4100)!;
    expect(k4100.cSettle).toBeCloseTo(52.4, 9);
    expect(k4100.pSettle).toBeCloseTo(48.1, 9);
    expect(k4100.cOi).toBe(150);
    expect(k4100.pOi).toBeNull(); // no OI record -> null (unknown), never 0
    const k4200 = q6.strikes.find((s) => s.k === 4200)!;
    expect(k4200.cOi).toBeNull(); // UNDEF_I32 sentinel -> null
  });

  it('caches the whole payload per (dataset, root, day): a second call makes ZERO new pulls', async () => {
    const { getRange } = source();
    await getTermData({ getRange }, 'GC', { asOf: '2026-07-05' });
    const n = getRange.mock.calls.length;
    const again = await getTermData({ getRange }, 'GC', { asOf: '2026-07-05' });
    expect(getRange.mock.calls.length).toBe(n); // pure cache hit
    expect(again.series.length).toBe(2);
  });

  it('makes ONE options-stats pull (settlements ride the same parent pull as OI) + one per DISTINCT underlying', async () => {
    const { getRange, calls } = source();
    await getTermData({ getRange }, 'GC', { asOf: '2026-07-05' });
    const statCalls = calls.filter((c) => c.schema === 'statistics');
    expect(statCalls.filter((c) => c.symbols === 'OG.OPT').length).toBe(1);
    expect(statCalls.filter((c) => c.symbols === 'GCQ26').length).toBe(1);
    expect(statCalls.filter((c) => c.symbols === 'GCU26').length).toBe(1);
  });

  it('a missing underlying settlement -> fwdSettle null (the consumer drops the series loudly, never a guess)', async () => {
    const { getRange } = source();
    const orig = getRange.getMockImplementation()!;
    getRange.mockImplementation(async (req: { schema: string; symbols: string }) => {
      if (req.schema === 'statistics' && req.symbols === 'GCU26')
        return { data: 'instrument_id,ts_ref,price,quantity,stat_type\n' };
      return orig(req);
    });
    const t = await getTermData({ getRange }, 'GC', { asOf: '2026-07-05' });
    expect(t.series.find((s) => s.stem === 'OGU6')!.fwdSettle).toBeNull();
  });

  it('honors maxSeries', async () => {
    const { getRange } = source();
    const t = await getTermData({ getRange }, 'GC', { asOf: '2026-07-05', maxSeries: 1 });
    expect(t.series.map((s) => s.stem)).toEqual(['OGQ6']);
  });
});
