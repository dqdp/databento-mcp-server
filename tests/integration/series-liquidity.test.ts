/**
 * GET /series/:root.json?liquidity=1 — the most-liquid ranking. The whole-root loadDailyStats pull
 * times out on wide roots (PA/PAO ~14 series × 250+ strikes -> oi=undefined, no ★), so when the
 * day-cached term payload exists we rank on ITS per-series OI (already windowed + cached) instead,
 * and only fall back to the whole-root pull when there is no valid term cache. Pins:
 *   (a) term cached -> ranks from the term OI with NO whole-root pull;
 *   (b) no cache + failing whole-root pull -> still degrades honestly to no-OI;
 *   (c) PARTIAL coverage (a series outside the term window) -> that series is OI-UNKNOWN (no oi
 *       field, not a fabricated 0) and cannot be mis-starred — the wide-root correctness guard;
 *   (d) a stale/corrupt persisted term file does NOT trigger a live term pull on the interactive
 *       path — it falls back to the whole-root pull (getCachedTermData never live-pulls).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { createSmileServer } from '../../src/server/smile-web.js';
import { clearTermDataCache, setTermCacheDir } from '../../src/analytics/term-data.js';
import { clearSmileStaticCache } from '../../src/analytics/smile-cache.js';
import { setDefsCacheDir } from '../../src/analytics/defs-catalog.js';

const DISK = path.join(os.tmpdir(), `series-liq-${process.pid}`);
setTermCacheDir(DISK);
setDefsCacheDir(DISK + '-defs');
afterAll(async () => {
  await fs.rm(DISK, { recursive: true, force: true });
  await fs.rm(DISK + '-defs', { recursive: true, force: true });
});

const ns = (d: string) => (BigInt(Date.parse(`${d}T20:00:00Z`)) * 1_000_000n).toString();
const NS = 1_000_000_000;

// GC (option root OG) series, all with a 4100 forward. OGQ6 is NEAREST but LIGHT; OGV6 is later and
// HEAVIER (so a correct rank must pick OGV6, not the nearest); OGF8 is FAR — beyond the term
// window's maxDays=400 (~2027-08 from asOf 2026-07-05) — and the HEAVIEST, used to prove an
// out-of-window series is never fabricated to oi:0 nor mis-starred. underlying future ids 77/78/79.
type Ser = { stem: string; exp: string; underId: number; under: string; ids: number[]; oiPerId: number };
const OGQ6: Ser = { stem: 'OGQ6', exp: '2026-07-28', underId: 77, under: 'GCQ26', ids: [100, 101, 102, 103, 104, 105], oiPerId: 10 };
const OGV6: Ser = { stem: 'OGV6', exp: '2026-09-24', underId: 78, under: 'GCV26', ids: [200, 201, 202, 203, 204, 205], oiPerId: 100 };
const OGF8: Ser = { stem: 'OGF8', exp: '2028-01-15', underId: 79, under: 'GCF28', ids: [300, 301, 302, 303, 304, 305], oiPerId: 1000 };
const STRIKES = [4000, 4100, 4200];
const UNDER_IDS = new Set([77, 78, 79]);

function defCsvFor(series: Ser[]): string {
  let out = `instrument_id,raw_symbol,instrument_class,expiration,underlying_id,strike_price,underlying\n`;
  for (const s of series) {
    STRIKES.forEach((k, i) => {
      const cId = s.ids[i * 2];
      const pId = s.ids[i * 2 + 1];
      out += `${cId},${s.stem} C${k},C,${ns(s.exp)},${s.underId},${k * NS},${s.under}\n`;
      out += `${pId},${s.stem} P${k},P,${ns(s.exp)},${s.underId},${k * NS},${s.under}\n`;
    });
  }
  return out;
}

// OI per option instrument id (stat_type 9, value in `quantity`); underlyings carry only a forward.
const oiById = new Map<number, number>();
for (const s of [OGQ6, OGV6, OGF8]) for (const id of s.ids) oiById.set(id, s.oiPerId);

// scoped id-set statistics (stype_in=instrument_id): forwards for the underlyings + settle/OI for
// the option ids. This is what the term pull uses — never the whole-root parent.
function statForIds(ids: number[]): string {
  let out = `instrument_id,ts_ref,price,quantity,stat_type\n`;
  for (const id of ids) {
    if (UNDER_IDS.has(id)) out += `${id},0,${4100 * NS},0,3\n`; // the forward settlement
    else {
      out += `${id},0,${50 * NS},0,3\n`; // an option settlement
      out += `${id},0,0,${oiById.get(id) ?? 0},9\n`; // its open interest
    }
  }
  return out;
}

function makeClients(opts: { failParent?: boolean; series?: Ser[] } = {}) {
  const series = opts.series ?? [OGQ6, OGV6];
  const counts = { parentStats: 0, scopedStats: 0 };
  const clients = {
    timeseriesClient: {
      getRange: async (req: { schema: string; symbols: string; stype_in?: string }) => {
        if (req.schema === 'definition') return { data: defCsvFor(series) };
        if (req.schema === 'statistics') {
          if (req.stype_in === 'parent') {
            counts.parentStats++; // the whole-root loadDailyStats pull — the one we want to avoid
            if (opts.failParent) throw new Error('whole-root statistics pull timed out');
            return { data: statForIds([...oiById.keys()]) }; // if allowed, it carries every id's OI
          }
          counts.scopedStats++; // an instrument-id-scoped term pull (forwards / windowed strikes)
          return { data: statForIds(req.symbols.split(',').map(Number)) };
        }
        return { data: '' };
      },
    },
    metadataClient: { getDatasetRange: async () => ({ end: '2026-07-05T14:00:00Z' }) },
  } as any;
  return { clients, counts };
}

describe('GET /series/:root.json?liquidity=1', () => {
  let server: Server;
  let base: string;
  let counts: { parentStats: number; scopedStats: number };

  async function start(opts: { failParent?: boolean; series?: Ser[] } = {}) {
    const made = makeClients(opts);
    counts = made.counts;
    server = createSmileServer(made.clients); // NOT prewarmTerm -> no background pulls
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  }

  beforeEach(async () => {
    clearTermDataCache();
    clearSmileStaticCache(); // also clears the defs catalog (loadSmileStatic -> loadDefsCatalog)
    await fs.rm(DISK, { recursive: true, force: true });
    await fs.rm(DISK + '-defs', { recursive: true, force: true });
  });
  afterEach(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it('(a) with term data cached, ranks on the cached per-series OI — no whole-root stats pull', async () => {
    await start();
    // warm the day-cache the way the skill's --term does; this pulls OI scoped to id-sets only.
    expect((await fetch(`${base}/term/GC.json`)).status).toBe(200);
    expect(counts.parentStats).toBe(0);

    const r = await fetch(`${base}/series/GC.json?liquidity=1`);
    expect(r.status).toBe(200);
    const s = await r.json();
    expect(s.optionsRoot).toBe('OG');
    expect(s.count).toBe(2);
    expect(s.nearest).toBe('OGQ6'); // nearest expiration
    expect(s.mostLiquid).toBe('OGV6'); // heavier LATER series wins -> ranked on OI, not nearness
    // per-series OI is filled from the term payload: each strike C+P summed across the 3 strikes
    const bySt = Object.fromEntries(s.series.map((x: any) => [x.stem, x.oi]));
    expect(bySt.OGQ6).toBe(60); // 3 strikes × (10 call + 10 put)
    expect(bySt.OGV6).toBe(600); // 3 strikes × (100 call + 100 put)
    expect(counts.parentStats).toBe(0); // NEVER hit the whole-root pull
  });

  it('(b) with no term cache and a failing whole-root pull, degrades honestly to no-OI', async () => {
    await start({ failParent: true });
    const r = await fetch(`${base}/series/GC.json?liquidity=1`);
    expect(r.status).toBe(200); // best-effort: still serves the listing
    const s = await r.json();
    expect(counts.parentStats).toBe(1); // it fell back to the whole-root pull (which failed)
    expect(s.mostLiquid).toBeNull(); // no OI available -> no ★ (honest degrade)
    expect(s.series.every((x: any) => x.oi === undefined)).toBe(true); // no OI column at all
    expect(s.nearest).toBe('OGQ6'); // the rest of the listing is unaffected
  });

  it('(c) a series OUTSIDE the term window is OI-unknown (no oi:0 fabrication) and cannot be mis-starred', async () => {
    // The wide-root guard: the listing has 3 future series but the term window (maxDays=400) covers
    // only the 2 near ones. The far OGF8 is the heaviest, yet term never pulled it — it must read as
    // OI-unknown, NOT a fabricated 0, and must not steal (nor fabricate) the ★.
    await start({ series: [OGQ6, OGV6, OGF8] });
    expect((await fetch(`${base}/term/GC.json`)).status).toBe(200); // warms only the 2 in-window series
    expect(counts.parentStats).toBe(0);

    const r = await fetch(`${base}/series/GC.json?liquidity=1`);
    expect(r.status).toBe(200);
    const s = await r.json();
    expect(s.count).toBe(3); // all three listed from the full defs catalog
    const far = s.series.find((x: any) => x.stem === 'OGF8');
    expect(far).toBeTruthy();
    expect('oi' in far).toBe(false); // OI-UNKNOWN — NOT a fabricated 0 (the pre-fix bug)
    const bySt = Object.fromEntries(s.series.map((x: any) => [x.stem, x.oi]));
    expect(bySt.OGQ6).toBe(60); // covered series keep their real OI
    expect(bySt.OGV6).toBe(600);
    expect(s.mostLiquid).toBe('OGV6'); // ranked among COVERED series; the far heavier OGF8 can't win
    expect(counts.parentStats).toBe(0); // still no whole-root pull
  });

  it('(d) a stale/corrupt persisted term file falls back to the whole-root pull, not a live term pull', async () => {
    // isTermCached would call this "cached" on mere file presence, but getCachedTermData validates
    // the read: a stale-schema/corrupt file surviving into a cold process must NOT trigger a metered
    // live term pull on the interactive path — it degrades to the whole-root fallback.
    await start();
    expect((await fetch(`${base}/term/GC.json`)).status).toBe(200); // writes a valid term file
    const files = (await fs.readdir(DISK)).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    // corrupt it to a stale schema + empty series (what a future SCHEMA_VERSION bump leaves behind)
    await fs.writeFile(path.join(DISK, files[0]), JSON.stringify({ schemaVersion: 0, series: [] }));
    clearTermDataCache(); // cold process: in-memory ready gone, only the now-stale disk file remains
    const scopedBefore = counts.scopedStats;
    expect(counts.parentStats).toBe(0);

    const r = await fetch(`${base}/series/GC.json?liquidity=1`);
    expect(r.status).toBe(200);
    const s = await r.json();
    expect(counts.parentStats).toBe(1); // fell back to the whole-root pull...
    expect(counts.scopedStats).toBe(scopedBefore); // ...and did NOT do a live (scoped) term pull
    expect(s.mostLiquid).toBe('OGV6'); // the fallback whole-root OI still ranks correctly
  });
});
