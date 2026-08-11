/**
 * smile-web — the LEVEL-2 live smile server. Hits the real routes over HTTP with mock Databento
 * clients (canned CSV), asserting the JSON snapshot route and the live page (poll + interval).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createSmileServer, MAX_LIVE_SESSIONS } from '../../src/server/smile-web.js';
import { black76 } from '../../src/analytics/black76.js';
import { clearSmileStaticCache } from '../../src/analytics/smile-cache.js';

const ns = (d: string) => (BigInt(Date.parse(`${d}T00:00:00Z`)) * 1_000_000n).toString();
const TODAY = '2026-06-30';
const EXP = '2026-09-18';
const FUT = 100;
const F = 7467;
const SIG = 0.2;
const T = (Date.parse(`${EXP}T00:00:00Z`) - Date.parse(`${TODAY}T00:00:00Z`)) / 86_400_000 / 365;

let defCsv = `instrument_id,raw_symbol,instrument_class,expiration,underlying_id,strike_price\n`;
let bboCsv = `instrument_id,ts_event,bid_px_00,ask_px_00\n${FUT},1,7466000000000,7468000000000\n`;
let statCsv = `instrument_id,ts_ref,price,quantity,stat_type\n`;
let id = 201;
for (const K of [7400, 7500]) {
  for (const isCall of [true, false]) {
    const cls = isCall ? 'C' : 'P';
    defCsv += `${id},ES ${cls}${K},${cls},${ns(EXP)},${FUT},${K * 1e9}\n`;
    const p = Math.round(black76(F, K, T, SIG, { isCall }).price * 1e9);
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

describe('smile-web server', () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    clearSmileStaticCache();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-30T14:00:00Z'));
    server = createSmileServer(clients);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    vi.useRealTimers();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('GET /smile/:root.json returns a fresh snapshot chain', async () => {
    const res = await fetch(`${base}/smile/ES.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const chain = await res.json();
    expect(chain.symbol).toBe('ES');
    expect(chain.expiration).toBe(EXP);
    expect(chain.strikes).toEqual([7400, 7500]);
    expect(chain.callIV.some((v: number | null) => typeof v === 'number')).toBe(true);
  });

  it('GET /smile/:root returns the live page (poll loop + interval selector at the requested interval)', async () => {
    const res = await fetch(`${base}/smile/ES?interval=30`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('/smile/ES.json'); // polls the JSON route
    expect(html).toMatch(/<select[^>]*id="iv"/);
    expect(html).toMatch(/value="30"[^>]*selected/); // interval from the query
    expect(html).toMatch(/LIVE/);
  });

  it('a failing snapshot surfaces as 503 JSON, not a crash', async () => {
    const failing = {
      timeseriesClient: {
        // valid defs/stats but an EMPTY bbo window -> no forward (market-closed path)
        getRange: async (req: { schema: string }) => ({
          data:
            req.schema === 'definition'
              ? defCsv
              : req.schema === 'statistics'
                ? statCsv
                : `instrument_id,ts_event,bid_px_00,ask_px_00\n`,
        }),
      },
      metadataClient: { getDatasetRange: async () => ({ end: '2026-06-30T14:00:00Z' }) },
    } as any;
    const s = createSmileServer(failing);
    await new Promise<void>((r) => s.listen(0, r));
    try {
      const res = await fetch(`http://localhost:${(s.address() as AddressInfo).port}/smile/ES.json`);
      expect(res.status).toBe(503);
      expect((await res.json()).error).toMatch(/no options|no forward|market|no bbo/i);
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  it('clamps a crafted oversized window (no runaway pull)', async () => {
    const res = await fetch(`${base}/smile/ES.json?window=999999`);
    expect(res.status).toBe(200); // window clamped to <=200, request still succeeds
    expect((await res.json()).strikes).toEqual([7400, 7500]);
  });

  it('unknown path -> 404', async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });

  it('live mode serves the Live buffer (seeded from Historical, then updated by a piped tick)', async () => {
    const preludeBytes = () => { const b = Buffer.alloc(8); b.write('DBN', 0, 'ascii'); b[3] = 2; b.writeUInt32LE(0, 4); return b; };
    const l1rec = (iid: number, mid: number) => {
      const b = Buffer.alloc(80); b[0] = 20; b[1] = 1; b.writeUInt32LE(iid, 4);
      b.writeBigInt64LE(BigInt(Math.round((mid - 0.5) * 1e9)), 48);
      b.writeBigInt64LE(BigInt(Math.round((mid + 0.5) * 1e9)), 56);
      return b;
    };
    let feedOnData: (chunk: Buffer) => void = () => {};
    const fakeConsumer = { start: () => {}, stop: () => {} };
    const live = createSmileServer(clients, { live: { makeConsumer: (cb) => { feedOnData = cb; return fakeConsumer; }, coalesceMs: 20 } });
    await new Promise<void>((r) => live.listen(0, r));
    const b = `http://localhost:${(live.address() as AddressInfo).port}`;
    try {
      const c1 = await (await fetch(`${b}/smile/ES.json`)).json();
      expect(c1.symbol).toBe('ES');
      expect(c1.spot).toBe(F); // seeded from the Historical snapshot at once

      // pipe a live tick straight into the session's feed: 7500 call reprices to 0.30 IV
      feedOnData(Buffer.concat([preludeBytes(), l1rec(203, black76(F, 7500, T, 0.3, { isCall: true }).price)]));
      await new Promise((r) => setTimeout(r, 60)); // let the coalescer flush (real timer)

      const c2 = await (await fetch(`${b}/smile/ES.json`)).json();
      expect(c2.callIV[c2.strikes.indexOf(7500)]).toBeCloseTo(0.3, 2);
    } finally {
      await new Promise<void>((r) => live.close(() => r()));
    }
  });

  it('snapshot mode: an all-shell book DEGRADES to a quote-less chain, not a failed call', async () => {
    // The gate has nothing to say about OI, PCR, max pain or the expirations list — those come
    // from definitions + settlement statistics. Failing the whole call over unusable QUOTES
    // threw them away too, for a market state that lasts hours.
    let shellBbo = `instrument_id,ts_event,bid_px_00,ask_px_00\n${FUT},1,7466000000000,7468000000000\n`;
    for (const oid of [201, 202, 203, 204]) shellBbo += `${oid},1,100000,6000000000000\n`;
    const shellClients = {
      timeseriesClient: {
        getRange: async (req: { schema: string }) => ({
          data: req.schema === 'definition' ? defCsv : req.schema === 'statistics' ? statCsv : shellBbo,
        }),
      },
      metadataClient: { getDatasetRange: async () => ({ end: '2026-06-30T14:00:00Z' }) },
    } as any;
    const s = createSmileServer(shellClients);
    await new Promise<void>((r) => s.listen(0, r));
    try {
      const res = await fetch(`http://localhost:${(s.address() as AddressInfo).port}/smile/ES.json`);
      expect(res.status).toBe(200);
      const c = await res.json();
      expect(c.strikes).toEqual([]);          // no strike carries a usable price
      expect(c.atmIV).toBeNull();
      expect(c.nGated).toBe(4);               // ...and the page can say WHY it is empty
      expect(c.expirations).toContain(EXP);   // the quote-independent half survives
      expect(c.spotEstimated).toBe(false);    // the FUTURE's own book was two-sided
      expect(c.callOItotal).toBeGreaterThan(0);
      expect(c.maxPain).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  it('live mode: the 503 says WHICH not-ready this is, in a field a poller can branch on', async () => {
    // "seeding, back in a second" and "every book is a shell until the pit opens" are the same
    // status and the same shape today, so the documented consumer maps both to "warming up" and
    // retries for hours. The reason must be machine-readable, not English prose.
    let shellBbo = `instrument_id,ts_event,bid_px_00,ask_px_00\n${FUT},1,7466000000000,7468000000000\n`;
    for (const oid of [201, 202, 203, 204]) shellBbo += `${oid},1,100000,6000000000000\n`;
    const shellClients = {
      timeseriesClient: {
        getRange: async (req: { schema: string }) => ({
          data: req.schema === 'definition' ? defCsv : req.schema === 'statistics' ? statCsv : shellBbo,
        }),
      },
      metadataClient: { getDatasetRange: async () => ({ end: '2026-06-30T14:00:00Z' }) },
    } as any;
    const live = createSmileServer(shellClients, {
      live: { makeConsumer: () => ({ start() {}, stop() {} }), coalesceMs: 20 },
    });
    await new Promise<void>((r) => live.listen(0, r));
    try {
      const res = await fetch(`http://localhost:${(live.address() as AddressInfo).port}/smile/ES.json`);
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe('all-gated');       // NOT the generic warm-up
      expect(body.error).toMatch(/shell|one-sided/);
    } finally {
      await new Promise<void>((r) => live.close(() => r()));
    }
  });

  it('live mode: a session that never builds does not hold its metered socket forever', async () => {
    // The buildError path deliberately does not evict — that is what stops a re-seed storm.
    // But "not per poll" is not "never": a session that has NEVER produced a chain is holding
    // an authenticated Live socket for nothing, and the idle sweeper cannot reclaim it because
    // every poll re-stamps demand.
    let shellBbo = `instrument_id,ts_event,bid_px_00,ask_px_00\n${FUT},1,7466000000000,7468000000000\n`;
    for (const oid of [201, 202, 203, 204]) shellBbo += `${oid},1,100000,6000000000000\n`;
    const shellClients = {
      timeseriesClient: {
        getRange: async (req: { schema: string }) => ({
          data: req.schema === 'definition' ? defCsv : req.schema === 'statistics' ? statCsv : shellBbo,
        }),
      },
      metadataClient: { getDatasetRange: async () => ({ end: '2026-06-30T14:00:00Z' }) },
    } as any;
    let started = 0;
    let stopped = 0;
    const live = createSmileServer(shellClients, {
      live: {
        makeConsumer: () => ({ start() { started++; }, stop() { stopped++; } }),
        coalesceMs: 20,
      },
    });
    await new Promise<void>((r) => live.listen(0, r));
    const b = `http://localhost:${(live.address() as AddressInfo).port}`;
    try {
      await fetch(`${b}/smile/ES.json`);
      await fetch(`${b}/smile/ES.json`);
      expect(started).toBe(1);   // polling alone never re-seeds — that part stays
      expect(stopped).toBe(0);

      vi.setSystemTime(new Date('2026-06-30T14:31:00Z')); // past the unbuilt deadline
      await fetch(`${b}/smile/ES.json`);
      expect(stopped).toBe(1);   // the socket is released rather than held all morning
    } finally {
      await new Promise<void>((r) => live.close(() => r()));
    }
  });

  it('live mode: a chain that stops rebuilding is served MARKED stale, not as fresh', async () => {
    // Once a chain exists, an all-gated flush no longer produces a 503 — current() still
    // returns it. Serving it is right; serving it silently is not: the page's badge clocks
    // the client's own fetch, so an hours-old smile would read as "updated 1s ago".
    const preludeBytes = () => { const b = Buffer.alloc(8); b.write('DBN', 0, 'ascii'); b[3] = 2; b.writeUInt32LE(0, 4); return b; };
    const book = (iid: number, bid: number, ask: number) => {
      const b = Buffer.alloc(80); b[0] = 20; b[1] = 1; b.writeUInt32LE(iid, 4);
      b.writeBigInt64LE(BigInt(Math.round(bid * 1e9)), 48);
      b.writeBigInt64LE(BigInt(Math.round(ask * 1e9)), 56);
      return b;
    };
    let feedOnData: (chunk: Buffer) => void = () => {};
    const live = createSmileServer(clients, {
      live: { makeConsumer: (cb) => { feedOnData = cb; return { start() {}, stop() {} }; }, coalesceMs: 20 },
    });
    await new Promise<void>((r) => live.listen(0, r));
    const b = `http://localhost:${(live.address() as AddressInfo).port}`;
    try {
      const fresh = await (await fetch(`${b}/smile/ES.json`)).json();
      expect(fresh.spot).toBe(F);
      expect(fresh.stale).toBeUndefined();   // a live chain carries no staleness marker

      // every option book degenerates into a cabinet-bid shell
      feedOnData(preludeBytes());
      for (const oid of [201, 202, 203, 204]) feedOnData(book(oid, 0.0001, 6000));
      await new Promise((r) => setTimeout(r, 60));

      const res = await fetch(`${b}/smile/ES.json`);
      expect(res.status).toBe(200);          // the last good chain is better than nothing
      const held = await res.json();
      expect(held.spot).toBe(F);
      expect(held.stale).toBe(true);
      expect(held.staleReason).toMatch(/usable option book/);
    } finally {
      await new Promise<void>((r) => live.close(() => r()));
    }
  });

  it('live mode: an all-shell book serves the HONEST 503 reason and keeps the one session', async () => {
    // The HO 6am class: options bid $0.0001 x ask ~80% of F. The gate rejects every strike, so
    // there is no chain — but the 503 must carry buildChain's reason, not the generic "warming
    // up" (which mis-reads a routine hours-long market state as a transient), and the session
    // must stay cached (re-seeding per poll would burn a metered Historical pull + Live socket).
    let shellBbo = `instrument_id,ts_event,bid_px_00,ask_px_00\n${FUT},1,7466000000000,7468000000000\n`;
    for (const oid of [201, 202, 203, 204]) shellBbo += `${oid},1,100000,6000000000000\n`; // 0.0001 x 6000
    const shellClients = {
      timeseriesClient: {
        getRange: async (req: { schema: string }) => ({
          data: req.schema === 'definition' ? defCsv : req.schema === 'statistics' ? statCsv : shellBbo,
        }),
      },
      metadataClient: { getDatasetRange: async () => ({ end: '2026-06-30T14:00:00Z' }) },
    } as any;
    let consumers = 0;
    const live = createSmileServer(shellClients, {
      live: { makeConsumer: () => { consumers++; return { start() {}, stop() {} }; }, coalesceMs: 20 },
    });
    await new Promise<void>((r) => live.listen(0, r));
    const b = `http://localhost:${(live.address() as AddressInfo).port}`;
    try {
      const r1 = await fetch(`${b}/smile/ES.json`);
      expect(r1.status).toBe(503);
      expect((await r1.json()).error).toMatch(/usable option book/); // the honest reason rides
      const r2 = await fetch(`${b}/smile/ES.json`);
      expect(r2.status).toBe(503);
      expect((await r2.json()).error).toMatch(/usable option book/);
      expect(consumers).toBe(1); // still ONE session — the all-gated state is not treated as poison
    } finally {
      await new Promise<void>((r) => live.close(() => r()));
    }
  });

  it('live mode dedups concurrent first-polls for one key into a single session (no orphaned socket)', async () => {
    // P1: two overlapping cold polls must not each open (and orphan) an authenticated Live socket.
    let consumers = 0;
    const live = createSmileServer(clients, {
      live: { makeConsumer: () => { consumers++; return { start() {}, stop() {} }; }, coalesceMs: 20 },
    });
    await new Promise<void>((r) => live.listen(0, r));
    const b = `http://localhost:${(live.address() as AddressInfo).port}`;
    try {
      const [c1, c2] = await Promise.all([
        fetch(`${b}/smile/ES.json`).then((r) => r.json()),
        fetch(`${b}/smile/ES.json`).then((r) => r.json()),
      ]);
      expect(c1.symbol).toBe('ES');
      expect(c2.symbol).toBe('ES');
      expect(consumers).toBe(1); // in-flight construction deduped
    } finally {
      await new Promise<void>((r) => live.close(() => r()));
    }
  });

  it('live mode collapses equivalent expiry selectors (nearest / NEAREST / absent) onto one session', async () => {
    // P2: the session key must normalize the expiry selector, else the same expiration opens
    // several live sockets.
    let consumers = 0;
    const live = createSmileServer(clients, {
      live: { makeConsumer: () => { consumers++; return { start() {}, stop() {} }; }, coalesceMs: 20 },
    });
    await new Promise<void>((r) => live.listen(0, r));
    const b = `http://localhost:${(live.address() as AddressInfo).port}`;
    try {
      await (await fetch(`${b}/smile/ES.json`)).json(); // absent -> nearest
      await (await fetch(`${b}/smile/ES.json?expiry=nearest`)).json();
      await (await fetch(`${b}/smile/ES.json?expiry=NEAREST`)).json();
      expect(consumers).toBe(1); // one session for all three
    } finally {
      await new Promise<void>((r) => live.close(() => r()));
    }
  });

  it('a gateway ERROR record evicts the poisoned session so a later poll re-seeds', async () => {
    // P1: an rtype-21 ERROR latches the session error; the key must be evicted + torn down so the
    // next poll re-seeds, not wedged into a permanent 503 with the socket still held.
    const prelude = () => { const p = Buffer.alloc(8); p.write('DBN', 0, 'ascii'); p[3] = 2; p.writeUInt32LE(0, 4); return p; };
    const errRec = (msg: string) => {
      const body = Buffer.from(msg, 'ascii');
      const total = Math.ceil((16 + body.length + 1) / 4) * 4;
      const rb = Buffer.alloc(total); rb[0] = total / 4; rb[1] = 21; body.copy(rb, 16); return rb;
    };
    let feedOnData: (chunk: Buffer) => void = () => {};
    let consumers = 0;
    const live = createSmileServer(clients, {
      live: { makeConsumer: (cb) => { feedOnData = cb; consumers++; return { start() {}, stop() {} }; }, coalesceMs: 20 },
    });
    await new Promise<void>((r) => live.listen(0, r));
    const b = `http://localhost:${(live.address() as AddressInfo).port}`;
    try {
      expect((await (await fetch(`${b}/smile/ES.json`)).json()).symbol).toBe('ES');
      expect(consumers).toBe(1);
      feedOnData(Buffer.concat([prelude(), errRec('subscription rejected')])); // gateway rejects
      const bad = await fetch(`${b}/smile/ES.json`);
      expect(bad.status).toBe(503);
      expect((await (await fetch(`${b}/smile/ES.json`)).json()).symbol).toBe('ES'); // re-seeded
      expect(consumers).toBe(2); // a fresh session, not the poisoned one
    } finally {
      await new Promise<void>((r) => live.close(() => r()));
    }
  });

  it('bounds the live-session map and stops sessions evicted by the cap', async () => {
    // P2: one persistent socket per key, never evicted, is a resource leak. Cap the map (LRU).
    const stops: number[] = [];
    let created = 0;
    const live = createSmileServer(clients, {
      live: { makeConsumer: () => { const seq = created++; return { start() {}, stop() { stops.push(seq); } }; }, coalesceMs: 20 },
    });
    await new Promise<void>((r) => live.listen(0, r));
    const b = `http://localhost:${(live.address() as AddressInfo).port}`;
    try {
      const n = MAX_LIVE_SESSIONS + 8;
      for (let w = 1; w <= n; w++) await (await fetch(`${b}/smile/ES.json?window=${w}`)).json(); // distinct keys
      expect(created).toBe(n);
      expect(stops).toHaveLength(n - MAX_LIVE_SESSIONS); // oldest evicted + stopped
    } finally {
      await new Promise<void>((r) => live.close(() => r()));
    }
  });

  it('idle sweeper stops the metered socket when nobody polls, and re-seeds on the next poll', async () => {
    // The money-safety path: when the dashboard closes and polling stops, the metered Live socket must be
    // torn down (not left streaming), then re-seeded on the next poll. Fake setInterval (the sweeper) but
    // leave setTimeout real so undici's fetch + the coalescer still work.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-06-30T14:00:00Z'));
    let started = 0;
    const stops: number[] = [];
    const live = createSmileServer(clients, {
      live: {
        makeConsumer: () => { const seq = started++; return { start() {}, stop() { stops.push(seq); } }; },
        coalesceMs: 20,
        idleMs: 15_000, // clamped to the 15s floor; sweep period = min(15s, IDLE_MS) = 15s
      },
    });
    await new Promise<void>((r) => live.listen(0, r));
    const b = `http://localhost:${(live.address() as AddressInfo).port}`;
    try {
      await (await fetch(`${b}/smile/ES.json`)).json(); // opens session #0 + its socket
      expect(started).toBe(1);
      expect(stops).toEqual([]);
      await vi.advanceTimersByTimeAsync(31_000); // > IDLE_MS + one sweep, with nobody polling
      expect(stops).toEqual([0]); // the idle metered socket was stopped
      await (await fetch(`${b}/smile/ES.json`)).json(); // next poll re-seeds a fresh socket
      expect(started).toBe(2);
    } finally {
      await new Promise<void>((r) => live.close(() => r()));
    }
  });
});
