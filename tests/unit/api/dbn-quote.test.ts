/**
 * dbn-quote — decode a single DBN L1 (mbp-1 / bbo) record body into a chain QuoteRec, reusing
 * the exact field offsets the working Live client already uses (instrument_id@4, ts_event@8,
 * bid_px@48, ask_px@56; prices /1e9; UNDEF = INT64_MAX). Tested on synthetic DBN-shaped bytes
 * so the live consumer can fold ticks into chain.ts without a network.
 */
import { describe, it, expect } from 'vitest';
import { decodeL1Quote } from '../../../src/api/dbn-quote.js';

const UNDEF_PX = 9_223_372_036_854_775_807n; // INT64_MAX
const UNDEF_TS = 18_446_744_073_709_551_615n; // UINT64_MAX

/** Build an 80-byte MBP-1/bbo record body with the given fields at the real offsets. */
function rec(opts: { iid: number; ts?: bigint; bidRaw?: bigint; askRaw?: bigint }): Buffer {
  const b = Buffer.alloc(80);
  b[1] = 1; // rtype MBP-1 (not read by the body decoder; here for realism)
  b.writeUInt32LE(opts.iid, 4);
  b.writeBigUInt64LE(opts.ts ?? 0n, 8);
  b.writeBigInt64LE(opts.bidRaw ?? UNDEF_PX, 48);
  b.writeBigInt64LE(opts.askRaw ?? UNDEF_PX, 56);
  return b;
}

const nsOf = (iso: string) => BigInt(Date.parse(iso)) * 1_000_000n;

describe('decodeL1Quote', () => {
  it('decodes instrument_id, bid/ask (/1e9) and ts_event -> ISO', () => {
    const q = decodeL1Quote(rec({ iid: 42530352, ts: nsOf('2026-07-01T14:00:00Z'), bidRaw: 68_240_000_000n, askRaw: 68_260_000_000n }));
    expect(q).toEqual({ type: 'quote', instrument_id: 42530352, bid: 68.24, ask: 68.26, ts: '2026-07-01T14:00:00.000Z' });
  });

  it('maps an UNDEF (INT64_MAX) side to null but keeps the other (one-sided book)', () => {
    const q = decodeL1Quote(rec({ iid: 1, bidRaw: 68_240_000_000n, askRaw: UNDEF_PX }));
    expect(q).toMatchObject({ instrument_id: 1, bid: 68.24, ask: null });
  });

  it('returns null when BOTH sides are UNDEF (no quote)', () => {
    expect(decodeL1Quote(rec({ iid: 1, bidRaw: UNDEF_PX, askRaw: UNDEF_PX }))).toBeNull();
  });

  it('maps an UNDEF ts_event (UINT64_MAX) to null ts', () => {
    const q = decodeL1Quote(rec({ iid: 1, ts: UNDEF_TS, bidRaw: 10_000_000_000n, askRaw: 10_100_000_000n }));
    expect(q?.ts).toBeNull();
  });

  it('returns null for a record shorter than an L1 body', () => {
    expect(decodeL1Quote(Buffer.alloc(40))).toBeNull();
  });
});
