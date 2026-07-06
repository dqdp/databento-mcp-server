/**
 * defs-catalog — the LONG-LIVED security-definition catalog. Definitions are stable reference data
 * (a listed strike/expiration never changes); Databento re-publishes the full ~37k snapshot at each
 * SOD but only NEW listings (tens of rows) trickle in intraday (live probe 2026-07-06: full day
 * 37,361 rows vs a 1h intraday window 9-43). So we pull the FULL snapshot ONCE, persist it root-keyed
 * (NOT day-keyed) so it survives restarts, and refresh with cheap intraday-delta merges + a periodic
 * full reconcile — never re-downloading the snapshot daily.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadDefsCatalog,
  clearDefsCatalog,
  setDefsCacheDir,
  refreshDefsCatalog,
} from '../../../src/analytics/defs-catalog.js';

const DISK = path.join(os.tmpdir(), `defs-cat-${process.pid}`);
setDefsCacheDir(DISK);
afterAll(async () => { await fs.rm(DISK, { recursive: true, force: true }); });

const ns = (d: string) => (BigInt(Date.parse(`${d}T20:00:00Z`)) * 1_000_000n).toString();
const NS = 1_000_000_000;
// a definition row builder (the real GLBX shape: raw_symbol + underlying SYMBOL column)
const row = (id: number, sym: string, cls: string, strike: number, exp: string, under: string) =>
  `${id},${sym},${cls},${ns(exp)},77,${strike * NS},${under}`;
const HDR = 'instrument_id,raw_symbol,instrument_class,expiration,underlying_id,strike_price,underlying';

// FULL snapshot: 3 OG strikes, one expiry (a future one), + an EXPIRED series that must be pruned.
function fullCsv(today: string): string {
  return [
    HDR,
    row(100, 'OGQ6 C4000', 'C', 4000, '2026-09-24', 'GCV26'),
    row(101, 'OGQ6 C4100', 'C', 4100, '2026-09-24', 'GCV26'),
    row(102, 'OGQ6 P4100', 'P', 4100, '2026-09-24', 'GCV26'),
    row(900, 'OGK6 C3000', 'C', 3000, '2026-04-27', 'GCK26'), // expired before `today` -> pruned
  ].join('\n');
}
// intraday DELTA: one NEW strike listed as spot moved
const deltaCsv = [HDR, row(103, 'OGQ6 C4200', 'C', 4200, '2026-09-24', 'GCV26')].join('\n');

function source(opts: { deltaWindow?: [string, string] } = {}) {
  const calls: Array<{ start?: string; end?: string }> = [];
  const getRange = vi.fn(async (req: { schema: string; start?: string; end?: string }) => {
    calls.push({ start: req.start, end: req.end });
    // a "delta" pull is any window that starts intraday (not at 00:00Z SOD); return only new rows.
    const isDelta = opts.deltaWindow && req.start === opts.deltaWindow[0];
    return { data: isDelta ? deltaCsv : fullCsv('2026-07-06') };
  });
  return { getRange, calls };
}

describe('loadDefsCatalog', () => {
  beforeEach(async () => {
    clearDefsCatalog();
    await fs.rm(DISK, { recursive: true, force: true });
  });

  it('first call pulls the FULL snapshot, prunes expired series, and persists root-keyed (no day)', async () => {
    const { getRange } = source();
    const defs = await loadDefsCatalog({ getRange }, 'GC', { asOf: '2026-07-06', end: '2026-07-06T14:00:00Z' });
    expect(defs.map((d) => d.instrument_id).sort((a, b) => a - b)).toEqual([100, 101, 102]); // 900 pruned
    // persisted under a root key, NOT a day key
    const files = await fs.readdir(DISK);
    expect(files.some((f) => f.includes('OG') && !f.includes('2026-07-06'))).toBe(true);
  });

  it('a SECOND call (memory cleared = restart) reads DISK — ZERO new pulls', async () => {
    const { getRange } = source();
    await loadDefsCatalog({ getRange }, 'GC', { asOf: '2026-07-06', end: '2026-07-06T14:00:00Z' });
    const n = getRange.mock.calls.length;
    clearDefsCatalog(); // simulate a connector RESTART (memory gone, disk file remains)
    const defs = await loadDefsCatalog({ getRange }, 'GC', { asOf: '2026-07-06', end: '2026-07-06T14:00:00Z' });
    expect(getRange.mock.calls.length).toBe(n); // served from disk, not re-pulled
    expect(defs.length).toBe(3);
  });

  it('refresh MERGES the intraday delta (new strike) without re-downloading the full snapshot', async () => {
    const delta: [string, string] = ['2026-07-06T00:00:00Z', '2026-07-06T14:00:00Z'];
    const { getRange, calls } = source({ deltaWindow: delta });
    await loadDefsCatalog({ getRange }, 'GC', { asOf: '2026-07-06', end: '2026-07-06T14:00:00Z' });
    // the refresh queries an INTRADAY window (start clamped past SOD) and merges the tens-of-rows delta
    const merged = await refreshDefsCatalog({ getRange }, 'GC', {
      asOf: '2026-07-06',
      end: '2026-07-06T14:00:00Z',
      deltaStart: delta[0],
    });
    expect(merged.map((d) => d.instrument_id).sort((a, b) => a - b)).toEqual([100, 101, 102, 103]);
    const deltaCall = calls.find((c) => c.start === delta[0]);
    expect(deltaCall).toBeTruthy(); // a scoped delta pull happened, not another full one
  });

  it('a missing/empty snapshot does NOT persist a junk catalog (rejects, next call retries)', async () => {
    const getRange = vi.fn(async () => ({ data: HDR + '\n' })); // header only -> 0 defs
    await expect(
      loadDefsCatalog({ getRange }, 'GC', { asOf: '2026-07-06', end: '2026-07-06T14:00:00Z' }),
    ).rejects.toThrow(/no definitions/);
    const files = await fs.readdir(DISK).catch(() => []);
    expect(files).toEqual([]);
  });
});
