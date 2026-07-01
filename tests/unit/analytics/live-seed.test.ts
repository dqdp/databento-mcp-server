/**
 * live-seed — turn "root (+ expiry/window)" into the SeedOpts a LiveSmileFeed starts from (the
 * Historical snapshot: defs + OI + an initial quote set, since Live has no snapshot-on-subscribe)
 * PLUS the narrowed instrument_ids to subscribe the Live session to.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { black76 } from '../../../src/analytics/black76.js';
import { clearSmileStaticCache } from '../../../src/analytics/smile-cache.js';
import { seedLiveFromHistorical } from '../../../src/analytics/live-seed.js';

const ns = (d: string) => (BigInt(Date.parse(`${d}T00:00:00Z`)) * 1_000_000n).toString();
const TODAY = '2026-06-30';
const EXP = '2026-09-18';
const FUT = 100;
const F = 7467;
const T = (Date.parse(`${EXP}T00:00:00Z`) - Date.parse(`${TODAY}T00:00:00Z`)) / 86_400_000 / 365;
let defCsv = `instrument_id,raw_symbol,instrument_class,expiration,underlying_id,strike_price\n`;
let bboCsv = `instrument_id,ts_event,bid_px_00,ask_px_00\n${FUT},1,7466000000000,7468000000000\n`;
let statCsv = `instrument_id,ts_ref,price,quantity,stat_type\n`;
let id = 201;
for (const K of [7400, 7500]) {
  for (const isCall of [true, false]) {
    const cls = isCall ? 'C' : 'P';
    defCsv += `${id},ES ${cls}${K},${cls},${ns(EXP)},${FUT},${K * 1e9}\n`;
    const p = Math.round(black76(F, K, T, 0.2, { isCall }).price * 1e9);
    bboCsv += `${id},1,${p - 500000000},${p + 500000000}\n`;
    statCsv += `${id},0,0,1000,9\n`;
    id++;
  }
}
const clients = {
  timeseriesClient: {
    getRange: async (req: { schema: string }) => ({
      data: req.schema === 'definition' ? defCsv : req.schema === 'statistics' ? statCsv : bboCsv,
    }),
  },
  metadataClient: { getDatasetRange: async () => ({ end: '2026-06-30T14:00:00Z' }) },
} as any;

describe('seedLiveFromHistorical', () => {
  beforeEach(() => clearSmileStaticCache());

  it('produces a buildable SeedOpts + the narrowed instrument_ids to subscribe', async () => {
    const { seed, instrumentIds } = await seedLiveFromHistorical(clients, 'ES', {});
    expect(seed.symbol).toBe('ES');
    expect(seed.expiration).toBe(EXP);
    expect(seed.expDefs).toHaveLength(4); // whole expiration's C/P (OI aggregates)
    expect(seed.quotes?.some((q) => q.instrument_id === FUT)).toBe(true); // seeded forward
    // subscription = the expiration's option ids + the future
    expect(instrumentIds).toEqual(expect.arrayContaining([201, 202, 203, 204, FUT]));
    expect(instrumentIds.length).toBeLessThanOrEqual(4 + 1);
  });

  it('resolves the futures root to its options root (CL -> LO) for the subscription', async () => {
    const { seed } = await seedLiveFromHistorical(clients, 'CL', {});
    expect(seed.symbol).toBe('LO');
  });
});
