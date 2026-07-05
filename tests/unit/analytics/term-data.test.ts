/**
 * term-data — the DAY-CACHED cross-expiration payload behind GET /term/:root.json. Long-dated
 * inputs are daily-static; the reduction runs once per (dataset, root, day) and every later poll
 * is instant. PAYLOAD BOUND: statistics are pulled ONLY for the strikes within a moneyness band of
 * each series' forward (never the whole-root parent, which times out on big roots), scoped by
 * instrument_id.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getTermData, clearTermDataCache, isTermCached } from '../../../src/analytics/term-data.js';
import { clearSmileStaticCache } from '../../../src/analytics/smile-cache.js';

const ns = (d: string) => (BigInt(Date.parse(`${d}T20:00:00Z`)) * 1_000_000n).toString();
const NS = 1_000_000_000;

// REAL definition CSV: raw_symbol + the `underlying` SYMBOL column. OGQ6 spans 3000..4200 so a
// ±25% band around a 4126 forward keeps 4100..4200 and DROPS 3000 (far tail — never pulled).
const defCsv =
  `instrument_id,raw_symbol,instrument_class,expiration,underlying_id,strike_price,underlying\n` +
  `10,OGQ6 C3000,C,${ns('2026-07-28')},77,${3000 * NS},GCQ26\n` +
  `11,OGQ6 P3000,P,${ns('2026-07-28')},77,${3000 * NS},GCQ26\n` +
  `12,OGQ6 C4100,C,${ns('2026-07-28')},77,${4100 * NS},GCQ26\n` +
  `13,OGQ6 P4100,P,${ns('2026-07-28')},77,${4100 * NS},GCQ26\n` +
  `14,OGQ6 C4200,C,${ns('2026-07-28')},77,${4200 * NS},GCQ26\n` +
  `20,OGU6 C4150,C,${ns('2026-08-26')},78,${4150 * NS},GCU26\n` +
  `21,OGU6 P4150,P,${ns('2026-08-26')},78,${4150 * NS},GCU26\n` +
  `30,OGZ8 C4400,C,${ns('2028-11-27')},99,${4400 * NS},GCZ28\n` + // beyond maxDays -> excluded
  `40,OGK6 C4000,C,${ns('2026-04-27')},60,${4000 * NS},GCK26\n` + // expired -> excluded
  `50,SPREAD,T,${ns('2026-07-28')},0,0,\n`; // non-C/P -> dropped by normalize

// scoped statistics response keyed by the instrument_ids asked for. 77/78 are the underlying
// FUTURE ids (from each def's underlying_id) — forwards are pulled by id in the SAME mechanism.
const STAT: Record<number, { settle?: number; oi?: number }> = {
  77: { settle: 4126.0 }, // GCQ26 forward
  78: { settle: 4155.0 }, // GCU26 forward
  12: { settle: 52.4, oi: 150 },
  13: { settle: 48.1 },
  14: { settle: 15.2, oi: 2147483647 }, // UNDEF_I32 OI -> absent
  20: { settle: 60.0 },
  21: { settle: 58.5, oi: 44 },
};
function statCsvFor(ids: number[]): string {
  let out = `instrument_id,ts_ref,price,quantity,stat_type\n`;
  for (const id of ids) {
    const s = STAT[id];
    if (!s) continue;
    if (s.settle != null) out += `${id},0,${s.settle * NS},0,3\n`;
    if (s.oi != null) out += `${id},0,0,${s.oi},9\n`;
  }
  return out;
}

function source() {
  const calls: Array<{ schema: string; symbols: string; stype_in?: string }> = [];
  const getRange = vi.fn(async (req: { schema: string; symbols: string; stype_in?: string }) => {
    calls.push({ schema: req.schema, symbols: req.symbols, stype_in: req.stype_in });
    if (req.schema === 'definition') return { data: defCsv };
    if (req.schema === 'statistics' && req.stype_in === 'instrument_id') {
      return { data: statCsvFor(req.symbols.split(',').map(Number)) };
    }
    throw new Error(`unexpected ${req.schema}/${req.stype_in}`);
  });
  return { getRange, calls };
}

describe('getTermData', () => {
  beforeEach(() => {
    clearTermDataCache();
    clearSmileStaticCache();
  });

  it('reduces to per-series strikes with settlements in HUMAN units + real stems/underlyings', async () => {
    const { getRange } = source();
    const t = await getTermData({ getRange }, 'GC', { asOf: '2026-07-05', maxDays: 400, maxSeries: 10 });
    expect(t.optionsRoot).toBe('OG');
    expect(t.series.map((s) => s.stem)).toEqual(['OGQ6', 'OGU6']); // expired + >400d excluded, ascending
    const q6 = t.series[0];
    expect(q6.under).toBe('GCQ26');
    expect(q6.fwdSettle).toBeCloseTo(4126.0, 9);
    const k4100 = q6.strikes.find((s) => s.k === 4100)!;
    expect(k4100.cSettle).toBeCloseTo(52.4, 9);
    expect(k4100.pSettle).toBeCloseTo(48.1, 9);
    expect(k4100.cOi).toBe(150);
    expect(k4100.pOi).toBeNull(); // no OI record -> null (unknown), never 0
    expect(q6.strikes.find((s) => s.k === 4200)!.cOi).toBeNull(); // UNDEF_I32 sentinel -> null
  });

  it('NEVER pulls the whole-root statistics parent — every stats pull is scoped by instrument_id', async () => {
    const { getRange, calls } = source();
    await getTermData({ getRange }, 'GC', { asOf: '2026-07-05' });
    const stat = calls.filter((c) => c.schema === 'statistics');
    expect(stat.length).toBeGreaterThan(0);
    expect(stat.every((c) => c.stype_in === 'instrument_id')).toBe(true); // forwards AND strikes by id
    // the forwards pull carries the underlying FUTURE ids (77/78), not a whole-root parent symbol
    expect(calls.some((c) => c.schema === 'statistics' && c.symbols.split(',').includes('77'))).toBe(true);
  });

  it('WINDOWS strikes to the ±band moneyness of each forward (far tails are never pulled)', async () => {
    const { getRange, calls } = source();
    const t = await getTermData({ getRange }, 'GC', { asOf: '2026-07-05', band: 0.25 });
    // 3000 is < 0.75*4126 (=3094.5) -> dropped; 4100/4200 kept
    const ks = t.series.find((s) => s.stem === 'OGQ6')!.strikes.map((s) => s.k);
    expect(ks).toEqual([4100, 4200]);
    expect(ks).not.toContain(3000);
    // and the dropped strike's ids (10/11) were never in any instrument_id pull
    const idCalls = calls.filter((c) => c.stype_in === 'instrument_id').flatMap((c) => c.symbols.split(','));
    expect(idCalls).not.toContain('10');
    expect(idCalls).not.toContain('11');
    expect(idCalls).toContain('12');
  });

  it('caches per (dataset, root, day, caps, band): a second call makes ZERO new pulls', async () => {
    const { getRange } = source();
    await getTermData({ getRange }, 'GC', { asOf: '2026-07-05' });
    const n = getRange.mock.calls.length;
    const again = await getTermData({ getRange }, 'GC', { asOf: '2026-07-05' });
    expect(getRange.mock.calls.length).toBe(n);
    expect(again.series.length).toBe(2);
  });

  it('isTermCached: false before, true after (the probe the skill uses to warn "no wait")', async () => {
    const { getRange } = source();
    expect(isTermCached('GC', { asOf: '2026-07-05' })).toBe(false);
    await getTermData({ getRange }, 'GC', { asOf: '2026-07-05' });
    expect(isTermCached('GC', { asOf: '2026-07-05' })).toBe(true);
    expect(isTermCached('GC', { asOf: '2026-07-06' })).toBe(false); // a new day is a miss
  });

  it('COALESCES concurrent same-key calls into one pull set', async () => {
    const { getRange } = source();
    const [a, b] = await Promise.all([
      getTermData({ getRange }, 'GC', { asOf: '2026-07-05' }),
      getTermData({ getRange }, 'GC', { asOf: '2026-07-05' }),
    ]);
    expect(b).toBe(a);
    expect(getRange.mock.calls.filter((c) => c[0].schema === 'definition').length).toBe(1);
  });

  it('does NOT cache a failed pull (next call retries)', async () => {
    const good = source();
    const getRange = vi.fn().mockRejectedValueOnce(new Error('boom')).mockImplementation(good.getRange);
    await expect(getTermData({ getRange }, 'GC', { asOf: '2026-07-05' })).rejects.toThrow('boom');
    const t = await getTermData({ getRange }, 'GC', { asOf: '2026-07-05' });
    expect(t.series.length).toBe(2);
  });

  it('a missing underlying settlement -> series dropped (never keyed to a guessed forward)', async () => {
    const { getRange } = source();
    const orig = getRange.getMockImplementation()!;
    getRange.mockImplementation(async (req: { schema: string; symbols: string; stype_in?: string }) => {
      const r = await orig(req);
      // strip the OGU6 underlying (id 78) forward from whatever pull carried it
      if (req.schema === 'statistics' && req.symbols.split(',').includes('78')) {
        r.data = (r.data as string).split('\n').filter((ln) => !ln.startsWith('78,')).join('\n');
      }
      return r;
    });
    const t = await getTermData({ getRange }, 'GC', { asOf: '2026-07-05' });
    expect(t.series.map((s) => s.stem)).toEqual(['OGQ6']); // OGU6 forward-less -> dropped
  });

  it('honors maxSeries', async () => {
    const { getRange } = source();
    const t = await getTermData({ getRange }, 'GC', { asOf: '2026-07-05', maxSeries: 1 });
    expect(t.series.map((s) => s.stem)).toEqual(['OGQ6']);
  });
});
