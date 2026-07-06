/**
 * smile-cache — memoize the STATIC half of a smile pull (definitions + open interest) per
 * (dataset, root, asOf). Definitions and OI are daily-static reference data, so refreshing the
 * same root's smile through the day should reuse them instead of re-pulling the parent twice
 * every call. Keyed by day so a new session day reloads.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadSmileStatic, loadDefsCached, clearSmileStaticCache } from '../../../src/analytics/smile-cache.js';
import { setDefsCacheDir } from '../../../src/analytics/defs-catalog.js';
import * as _os from 'node:os';
import * as _path from 'node:path';
import { promises as _fs } from 'node:fs';
const SMILE_DEFS = _path.join(_os.tmpdir(), `smile-defs-${process.pid}`);
setDefsCacheDir(SMILE_DEFS);

const ns = (d: string) => (BigInt(Date.parse(`${d}T00:00:00Z`)) * 1_000_000n).toString();
const defCsv =
  `instrument_id,raw_symbol,instrument_class,expiration,underlying_id,strike_price\n` +
  `100,ESN6,F,${ns('2026-07-17')},0,\n` +
  `201,ESN6 C6300,C,${ns('2026-07-17')},100,6300000000000\n`;
const statCsv = `instrument_id,ts_ref,price,quantity,stat_type\n201,0,0,1500,9\n`;

function source() {
  return vi.fn(async (req: { schema: string }) => {
    if (req.schema === 'definition') return { data: defCsv };
    if (req.schema === 'statistics') return { data: statCsv };
    throw new Error(`unexpected schema ${req.schema}`);
  });
}

describe('loadSmileStatic', () => {
  it('walks asOf back over closed days until definitions appear (holiday weekend lookback)', async () => {
    // GLBX available_end can land INSIDE a closed day (live probe 2026-07-05: available_end
    // 01:50Z Saturday -> definitions window [Sat, Sat 01:50) is EMPTY and the smile died with
    // "no option expirations"). The static loader must look back day-by-day (<=5) to the last
    // trading day instead.
    const getRange = vi.fn(async (req: { schema: string; start?: string }) => {
      if (req.schema === 'definition') {
        return { data: (req.start ?? '').startsWith('2026-07-02') ? defCsv : 'instrument_id,raw_symbol\n' };
      }
      if (req.schema === 'statistics') return { data: statCsv };
      throw new Error(`unexpected schema ${req.schema}`);
    });
    const { defs, oi } = await loadSmileStatic({ getRange }, 'ES', { asOf: '2026-07-05', end: '2026-07-05T01:50:00Z' });
    expect(defs.length).toBeGreaterThan(0);
    expect(oi.get(201)).toBe(1500);
    const defStarts = getRange.mock.calls.filter((c) => c[0].schema === 'definition').map((c) => c[0].start);
    expect(defStarts).toEqual(['2026-07-05', '2026-07-04', '2026-07-03', '2026-07-02']);   // stop at first hit
    const statStarts = getRange.mock.calls.filter((c) => c[0].schema === 'statistics').map((c) => c[0].start);
    expect(statStarts).toEqual(['2026-06-28']);   // fallback day MINUS the 4-day stats lookback (a
    // holiday can publish defs with NO stats — the window must reach the last day that has them)
  });

  it('caches the lookback result under the REQUESTED day (no re-walk on refresh)', async () => {
    const getRange = vi.fn(async (req: { schema: string; start?: string }) => {
      if (req.schema === 'definition') {
        return { data: (req.start ?? '').startsWith('2026-07-02') ? defCsv : 'instrument_id,raw_symbol\n' };
      }
      return { data: statCsv };
    });
    await loadSmileStatic({ getRange }, 'ES', { asOf: '2026-07-05' });
    const calls = getRange.mock.calls.length;
    await loadSmileStatic({ getRange }, 'ES', { asOf: '2026-07-05' });
    expect(getRange.mock.calls.length).toBe(calls);   // second refresh = pure cache hit
  });

  it('gives up honestly after 5 closed days -> throws (asOf + 5 lookbacks, then no definitions)', async () => {
    const getRange = vi.fn(async (req: { schema: string }) =>
      req.schema === 'definition' ? { data: 'instrument_id,raw_symbol\n' } : { data: statCsv });
    await expect(loadSmileStatic({ getRange }, 'ES', { asOf: '2026-07-05' })).rejects.toThrow(/no definitions/);
    expect(getRange.mock.calls.filter((c) => c[0].schema === 'definition').length).toBe(6); // asOf + 5 lookbacks
  });

  beforeEach(async () => { clearSmileStaticCache(); await _fs.rm(SMILE_DEFS, { recursive: true, force: true }); });

  it('loadDefsCached COALESCES two concurrent same-day callers into ONE definitions pull', async () => {
    const getRange = source();
    // a /smile poll and a /term cold pull arriving together for the same root
    const [a, b] = await Promise.all([
      loadDefsCached({ getRange }, 'ES', { asOf: '2026-06-30' }),
      loadDefsCached({ getRange }, 'ES', { asOf: '2026-06-30' }),
    ]);
    expect(getRange.mock.calls.filter((c) => c[0].schema === 'definition').length).toBe(1); // not 2
    expect(a).toEqual(b); // same data (prune returns a fresh array each call; the 1-pull count above proves coalescing)
  });

  it('loadDefsCached does NOT cache a failed pull (next call retries)', async () => {
    const getRange = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ data: defCsv });
    await expect(loadDefsCached({ getRange }, 'ES', { asOf: '2026-06-30' })).rejects.toThrow('boom');
    const defs = await loadDefsCached({ getRange }, 'ES', { asOf: '2026-06-30' });
    expect(defs.length).toBeGreaterThan(0);
  });

  it('pulls definitions + OI on the first call and returns them', async () => {
    const getRange = source();
    const { defs, oi } = await loadSmileStatic({ getRange }, 'ES', { asOf: '2026-06-30' });
    expect(getRange).toHaveBeenCalledTimes(2); // one definition + one statistics
    expect(defs.map((d) => d.instrument_id).sort((a, b) => a - b)).toEqual([100, 201]);
    expect(oi.get(201)).toBe(1500);
  });

  it('reuses the cached static pulls for the same root/day (no re-pull)', async () => {
    const getRange = source();
    await loadSmileStatic({ getRange }, 'ES', { asOf: '2026-06-30' });
    const second = await loadSmileStatic({ getRange }, 'ES', { asOf: '2026-06-30' });
    expect(getRange).toHaveBeenCalledTimes(2); // still 2 — the second call hit the cache
    expect(second.oi.get(201)).toBe(1500);
  });

  it('a new day re-pulls OI/settle but NOT the definitions (defs are the long-lived catalog)', async () => {
    const getRange = source();
    await loadSmileStatic({ getRange }, 'ES', { asOf: '2026-06-30' }); // defs(1) + stats(1)
    await loadSmileStatic({ getRange }, 'ES', { asOf: '2026-07-01' }); // stats(1) — defs served from the catalog
    expect(getRange).toHaveBeenCalledTimes(3); // was 4 before the catalog: the daily defs re-pull is gone
    const defCalls = getRange.mock.calls.filter((c) => c[0].schema === 'definition').length;
    expect(defCalls).toBe(1); // ONE definitions pull across both days
  });

  it('keys by root, so different roots do not collide', async () => {
    const getRange = source();
    await loadSmileStatic({ getRange }, 'ES', { asOf: '2026-06-30' });
    await loadSmileStatic({ getRange }, 'NQ', { asOf: '2026-06-30' });
    expect(getRange).toHaveBeenCalledTimes(4);
  });

  it('resolves the futures root so CL and LO share one cache entry', async () => {
    const getRange = source();
    await loadSmileStatic({ getRange }, 'CL', { asOf: '2026-06-30' }); // resolves to LO
    await loadSmileStatic({ getRange }, 'LO', { asOf: '2026-06-30' }); // same entry -> cache hit
    expect(getRange).toHaveBeenCalledTimes(2);
  });
});
