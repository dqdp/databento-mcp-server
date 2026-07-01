/**
 * dbn-quote — decode one DBN L1 record body (mbp-1 / bbo-1s / bbo-1m; they share the MBP-1
 * layout) into the chain reducer's QuoteRec. Offsets mirror the working Live client
 * (live-client.ts parseMbp1QuoteRecord): instrument_id@4 (u32), ts_event@8 (u64), bid_px@48
 * (i64), ask_px@56 (i64); prices are fixed-point /1e9; UNDEF price = INT64_MAX, UNDEF ts =
 * UINT64_MAX. Framing + rtype filtering stay with the socket consumer; this is body-only and
 * pure so it's unit-tested on synthetic bytes without a network.
 */
import type { QuoteRec } from '../analytics/chain.js';

const L1_BODY_MIN_LENGTH = 80; // MBP-1 record min length
const UNDEF_PRICE = 9_223_372_036_854_775_807n; // INT64_MAX
const UNDEF_TS = 18_446_744_073_709_551_615n; // UINT64_MAX

function price(raw: bigint): number | null {
  return raw === UNDEF_PRICE || raw <= 0n ? null : Number(raw) / 1e9;
}

/** Decode a framed DBN L1 record body into a QuoteRec, or null (too short / both sides UNDEF). */
export function decodeL1Quote(record: Buffer): QuoteRec | null {
  if (record.length < L1_BODY_MIN_LENGTH) return null;
  const bid = price(record.readBigInt64LE(48));
  const ask = price(record.readBigInt64LE(56));
  if (bid == null && ask == null) return null; // no quote either side
  const tsEvent = record.readBigUInt64LE(8);
  const ts = tsEvent === UNDEF_TS || tsEvent === 0n ? null : new Date(Number(tsEvent / 1_000_000n)).toISOString();
  return { type: 'quote', instrument_id: record.readUInt32LE(4), bid, ask, ts };
}
