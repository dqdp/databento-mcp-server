/**
 * term-data — the DAY-CACHED cross-expiration payload behind GET /term/:root.json. Long-dated
 * inputs are daily-static; the reduction runs once per (dataset, root, day) and every later poll
 * is instant. PAYLOAD BOUND: statistics are pulled ONLY for the strikes within a moneyness band of
 * each series' forward (never the whole-root parent, which times out on big roots), scoped by
 * instrument_id.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getTermData,
  clearTermDataCache,
  isTermCached,
  setTermCacheDir,
  prewarmTerm,
  prewarmRootsFromEnv,
} from '../../../src/analytics/term-data.js';
import { clearSmileStaticCache } from '../../../src/analytics/smile-cache.js';
import { setDefsCacheDir } from '../../../src/analytics/defs-catalog.js';

const DISK = path.join(os.tmpdir(), `term-disk-${process.pid}`);
setTermCacheDir(DISK);
setDefsCacheDir(DISK + '-defs');
afterAll(async () => { await fs.rm(DISK, { recursive: true, force: true }); });

const ns = (d: string) => (BigInt(Date.parse(`${d}T20:00:00Z`)) * 1_000_000n).toString();
const NS = 1_000_000_000;

// REAL definition CSV. OGQ6 has a FINE $5 grid 3000..5300 (461 strikes, like gold): the progressive
// selector must COARSEN it to a ~$10 grid near ATM widening into the wings, keep <=MAX_STRIKES, keep
// the ATM + the surface buckets, and still reach the full ±band width.
// call id = strike, put id = strike + 100000 (deterministic, so assertions can address a strike).
const cId = (k: number) => k;
const pId = (k: number) => k + 100000;
const OGQ6_STRIKES: number[] = [];
for (let k = 3000; k <= 5300; k += 5) OGQ6_STRIKES.push(k); // 461 strikes — a FINE $5 grid (like gold)
const defCsv =
  `instrument_id,raw_symbol,instrument_class,expiration,underlying_id,strike_price,underlying\n` +
  OGQ6_STRIKES.flatMap((k) => [
    `${cId(k)},OGQ6 C${k},C,${ns('2026-07-28')},77,${k * NS},GCQ26`,
    `${pId(k)},OGQ6 P${k},P,${ns('2026-07-28')},77,${k * NS},GCQ26`,
  ]).join('\n') +
  `\n300001,OGU6 C4150,C,${ns('2026-08-26')},78,${4150 * NS},GCU26\n` +
  `300002,OGU6 P4150,P,${ns('2026-08-26')},78,${4150 * NS},GCU26\n` +
  `400001,OGZ8 C4400,C,${ns('2028-11-27')},99,${4400 * NS},GCZ28\n` + // beyond maxDays -> excluded
  `400002,OGK6 C4000,C,${ns('2026-04-27')},60,${4000 * NS},GCK26\n` + // expired -> excluded
  `400003,SPREAD,T,${ns('2026-07-28')},0,0,\n`; // non-C/P -> dropped by normalize

// forwards (77/78) + specific option settlements/OI; every OTHER requested option id gets a
// generic settlement so the reduction has data to keep.
const SPECIAL: Record<number, { settle?: number; oi?: number }> = {
  77: { settle: 4100.0 }, // GCQ26 forward -> ATM lands ON 4100 (so the $10 grid keeps 4100 & 4200)
  78: { settle: 4150.0 }, // GCU26 forward
  [cId(4100)]: { settle: 52.4, oi: 150 },
  [pId(4100)]: { settle: 48.1 },
  [cId(4130)]: { settle: 15.2, oi: 2147483647 }, // UNDEF_I32 OI -> absent (4130 is on the $10 grid)
  300001: { settle: 60.0 },
  300002: { settle: 58.5, oi: 44 },
};
function statCsvFor(ids: number[]): string {
  let out = `instrument_id,ts_ref,price,quantity,stat_type\n`;
  for (const id of ids) {
    const s = SPECIAL[id];
    if (s) {
      if (s.settle != null) out += `${id},0,${s.settle * NS},0,3\n`;
      if (s.oi != null) out += `${id},0,0,${s.oi},9\n`;
    } else if (id === 77 || id === 78) {
      continue; // an underlying with no special -> no forward (drops its series)
    } else {
      out += `${id},0,${10 * NS},0,3\n`; // generic option settlement
    }
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
  beforeEach(async () => {
    clearTermDataCache();
    clearSmileStaticCache();
    await fs.rm(DISK, { recursive: true, force: true });
    await fs.rm(DISK + '-defs', { recursive: true, force: true }); // and the defs catalog dir
  });

  it('reduces to per-series strikes with settlements in HUMAN units + real stems/underlyings', async () => {
    const { getRange } = source();
    const t = await getTermData({ getRange }, 'GC', { asOf: '2026-07-05', maxDays: 400, maxSeries: 10 });
    expect(t.optionsRoot).toBe('OG');
    expect(t.series.map((s) => s.stem)).toEqual(['OGQ6', 'OGU6']); // expired + >400d excluded, ascending
    const q6 = t.series[0];
    expect(q6.under).toBe('GCQ26');
    expect(q6.fwdSettle).toBeCloseTo(4100.0, 9);
    const k4100 = q6.strikes.find((s) => s.k === 4100)!;
    expect(k4100.cSettle).toBeCloseTo(52.4, 9);
    expect(k4100.pSettle).toBeCloseTo(48.1, 9);
    expect(k4100.cOi).toBe(150);
    expect(k4100.pOi).toBeNull(); // no OI record -> null (unknown), never 0
    expect(q6.strikes.find((s) => s.k === 4130)!.cOi).toBeNull(); // UNDEF_I32 sentinel -> null
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

  it('PROGRESSIVE grid + hard cap on a FINE $5 grid: <=45 strikes, $10 near ATM, full ±band width', async () => {
    const { getRange } = source();
    const t = await getTermData({ getRange }, 'GC', { asOf: '2026-07-05' });
    const ks = t.series.find((s) => s.stem === 'OGQ6')!.strikes.map((s) => s.k).sort((a, b) => a - b);
    expect(ks.length).toBeLessThanOrEqual(45); // the hard cap holds even though 461 strikes are listed
    expect(ks.length).toBeGreaterThan(20); // but not so few that the smile is starved
    expect(ks).toContain(4100); // ATM (forward 4100) always kept
    // near the money the $5 grid is COARSENED to ~$10 (the floor): no adjacent kept pair is $5 apart
    // within ±3% of the forward, and the ATM's neighbours are ~$10 away
    const nearGaps = ks.filter((k) => Math.abs(k - 4100) <= 120).sort((a, b) => a - b);
    for (let i = 1; i < nearGaps.length; i++) expect(nearGaps[i] - nearGaps[i - 1]).toBeGreaterThanOrEqual(10);
    // WIDTH is not lost: strikes reach out toward ±20% (3280 = 80%, 4920 = 120% region)
    expect(ks.some((k) => k <= 3300)).toBe(true);
    expect(ks.some((k) => k >= 4900)).toBe(true);
    // the wings are SPARSER than the centre (progressive): the biggest gap is in the wings
    const gaps = ks.slice(1).map((k, i) => k - ks[i]);
    expect(Math.max(...gaps)).toBeGreaterThan(20);
    expect(t.band).toBe(0.25);
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

  it('isTermCached stays FALSE while the pull is still IN-FLIGHT (never "no wait" mid-cold-pull)', async () => {
    // gate the FIRST definition pull so the promise is cached-but-unresolved when we probe
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const good = source();
    let first = true;
    const getRange = vi.fn(async (req: { schema: string; symbols: string; stype_in?: string }) => {
      if (first && req.schema === 'definition') {
        first = false;
        await gate;
      }
      return good.getRange(req);
    });
    const p = getTermData({ getRange }, 'GC', { asOf: '2026-07-05' });
    await Promise.resolve(); // let the work() microtask start and cache the (unresolved) promise
    expect(isTermCached('GC', { asOf: '2026-07-05' })).toBe(false); // in-flight -> probe says NOT ready
    release();
    await p;
    expect(isTermCached('GC', { asOf: '2026-07-05' })).toBe(true); // resolved -> ready
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

  it('BAND is passed to selectWindowStrikes: a wider band reaches wider strikes (not the default 0.25)', async () => {
    const wide = await getTermData({ getRange: source().getRange }, 'GC', { asOf: '2026-07-05', band: 0.5 });
    clearTermDataCache();
    await fs.rm(DISK, { recursive: true, force: true });
    const narrow = await getTermData({ getRange: source().getRange }, 'GC', { asOf: '2026-07-05', band: 0.25 });
    const wk = wide.series.find((s) => s.stem === 'OGQ6')!.strikes.map((s) => s.k);
    const nk = narrow.series.find((s) => s.stem === 'OGQ6')!.strikes.map((s) => s.k);
    expect(wide.band).toBe(0.5);
    expect(Math.max(...wk)).toBeGreaterThan(Math.max(...nk)); // band 0.5 walked out past band 0.25's ceiling
  });

  it('all-forwards-missing -> REJECTS and persists NOTHING (b7f0096 class, disk edition)', async () => {
    const { getRange } = source();
    const orig = getRange.getMockImplementation()!;
    getRange.mockImplementation(async (req: { schema: string; symbols: string; stype_in?: string }) => {
      const r = await orig(req);
      // strip BOTH underlyings' forwards (77, 78) -> every series drops
      if (req.schema === 'statistics') {
        r.data = (r.data as string).split('\n').filter((ln) => !ln.startsWith('77,') && !ln.startsWith('78,')).join('\n');
      }
      return r;
    });
    await expect(getTermData({ getRange }, 'GC', { asOf: '2026-07-05' })).rejects.toThrow(/no priceable/);
    expect(isTermCached('GC', { asOf: '2026-07-05' })).toBe(false); // nothing cached in memory OR on disk
    const files = await fs.readdir(DISK).catch(() => []);
    expect(files.filter((f) => f.endsWith('.json'))).toEqual([]);
  });

  it('disk read rejects a STALE schema / empty-series file (self-heals junk) -> re-pulls fresh', async () => {
    await fs.mkdir(DISK, { recursive: true });
    // a junk file at the exact GC key: old schema + empty series
    const junk = path.join(DISK, 'GLBX.MDP3_OG_2026-07-05_10_400_0.25.json');
    await fs.writeFile(junk, JSON.stringify({ schemaVersion: 0, root: 'GC', series: [] }));
    const { getRange } = source();
    const t = await getTermData({ getRange }, 'GC', { asOf: '2026-07-05' });
    expect(t.series.length).toBe(2); // the junk was ignored and a real reduction ran
    expect(getRange.mock.calls.length).toBeGreaterThan(0);
  });

  it('honors maxSeries', async () => {
    const { getRange } = source();
    const t = await getTermData({ getRange }, 'GC', { asOf: '2026-07-05', maxSeries: 1 });
    expect(t.series.map((s) => s.stem)).toEqual(['OGQ6']);
  });

  it('PERSISTS the payload to disk: a fresh process (cleared memory) serves it WITHOUT re-pulling', async () => {
    const { getRange } = source();
    await getTermData({ getRange }, 'GC', { asOf: '2026-07-05' }); // cold -> pulls + writes disk
    const pulls = getRange.mock.calls.length;
    expect(pulls).toBeGreaterThan(0);
    clearTermDataCache(); // simulate a connector RESTART (in-memory cache gone, disk file remains)
    const t2 = await getTermData({ getRange }, 'GC', { asOf: '2026-07-05' });
    expect(getRange.mock.calls.length).toBe(pulls); // ZERO new pulls — served from disk
    expect(t2.series.length).toBe(2);
  });

  it('isTermCached is TRUE across a restart when the disk file exists (the probe reads disk)', async () => {
    const { getRange } = source();
    await getTermData({ getRange }, 'GC', { asOf: '2026-07-05' });
    clearTermDataCache(); // memory gone
    expect(isTermCached('GC', { asOf: '2026-07-05' })).toBe(true); // still cached ON DISK
    expect(isTermCached('GC', { asOf: '2026-07-06' })).toBe(false); // a different day: no file
  });

  it('prewarmTerm warms each hot root sequentially; a re-run serves the TERM from disk (only the cheap catalog delta re-pulls)', async () => {
    const meta = { getDatasetRange: vi.fn(async () => ({ end: '2026-07-05T14:00:00Z' })) };
    const { getRange, calls } = source();
    await prewarmTerm({ getRange }, meta, ['GC']);
    expect(isTermCached('GC', { asOf: '2026-07-05' })).toBe(true); // term is disk-cached
    const statsBefore = calls.filter((c) => c.schema === 'statistics').length;
    await prewarmTerm({ getRange }, meta, ['GC']);
    // the TERM structure is served from disk — no new STATISTICS pull (the expensive part). Only the
    // catalog's cheap intraday-delta definition pull re-runs to keep the catalog fresh.
    expect(calls.filter((c) => c.schema === 'statistics').length).toBe(statsBefore);
  });

  it('prewarmRootsFromEnv: default hot list vs env override vs empty (off)', () => {
    const save = process.env.TERM_PREWARM_ROOTS;
    delete process.env.TERM_PREWARM_ROOTS;
    expect(prewarmRootsFromEnv()).toContain('GC');
    process.env.TERM_PREWARM_ROOTS = 'cl, es';
    expect(prewarmRootsFromEnv()).toEqual(['CL', 'ES']);
    process.env.TERM_PREWARM_ROOTS = '';
    expect(prewarmRootsFromEnv()).toEqual([]); // empty -> prewarm OFF
    if (save === undefined) delete process.env.TERM_PREWARM_ROOTS;
    else process.env.TERM_PREWARM_ROOTS = save;
  });
});
