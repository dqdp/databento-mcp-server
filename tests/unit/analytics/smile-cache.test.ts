/**
 * smile-cache — memoize the STATIC half of a smile pull (definitions + open interest) per
 * (dataset, root, asOf). Definitions and OI are daily-static reference data, so refreshing the
 * same root's smile through the day should reuse them instead of re-pulling the parent twice
 * every call. Keyed by day so a new session day reloads.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadSmileStatic, clearSmileStaticCache } from '../../../src/analytics/smile-cache.js';

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
  beforeEach(() => clearSmileStaticCache());

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

  it('reloads for a different day (definitions/OI are daily-static)', async () => {
    const getRange = source();
    await loadSmileStatic({ getRange }, 'ES', { asOf: '2026-06-30' });
    await loadSmileStatic({ getRange }, 'ES', { asOf: '2026-07-01' });
    expect(getRange).toHaveBeenCalledTimes(4); // 2 + 2, distinct days
  });

  it('keys by root, so different roots do not collide', async () => {
    const getRange = source();
    await loadSmileStatic({ getRange }, 'ES', { asOf: '2026-06-30' });
    await loadSmileStatic({ getRange }, 'CL', { asOf: '2026-06-30' });
    expect(getRange).toHaveBeenCalledTimes(4);
  });
});
