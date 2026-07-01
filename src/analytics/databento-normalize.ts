/**
 * databento-normalize — turn raw Databento GLBX.MDP3 CSV responses into the reducer's
 * NORMALIZED records (see chain.ts). Confirmed against the live API:
 *  - prices and strikes are fixed-point, divide by 1e9.
 *  - `expiration` is a nanosecond timestamp -> convert to a YYYY-MM-DD date.
 *  - `instrument_class` is a single char; keep C/P/F and drop spreads/others (T, S, ...).
 *  - a bbo bid/ask of INT64_MAX (9223372036854775807) means "no quote" -> null.
 *  - open interest is the `statistics` record with `stat_type === 9`, value in `quantity`.
 */
import type { ChainRec, DefinitionRec, InstrumentClass, QuoteRec, StatisticsRec } from './chain.js';

const PRICE_SCALE = 1e9;
const UNDEF_PX = '9223372036854775807'; // INT64_MAX — compare as a string (exceeds JS safe int)
const UNDEF_I32 = '2147483647'; // INT32_MAX — undefined size/quantity sentinel
const STAT_TYPE_OPEN_INTEREST = '9';

/** Header-driven CSV parse. Databento CSV has no embedded commas/quotes in these fields. */
function rows(csv: string): Record<string, string>[] {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const vals = line.split(',');
    const obj: Record<string, string> = {};
    header.forEach((h, i) => {
      obj[h] = vals[i];
    });
    return obj;
  });
}

/** Nanoseconds-since-epoch -> "YYYY-MM-DD" (UTC). */
function nsToDate(ns: string): string {
  if (!ns || !/^\d+$/.test(ns)) return '';
  const ms = Number(BigInt(ns) / 1_000_000n);
  return new Date(ms).toISOString().slice(0, 10);
}

function scaledPrice(raw: string | undefined): number | null {
  if (!raw || raw === UNDEF_PX) return null;
  return Number(raw) / PRICE_SCALE;
}

/** `definition` schema -> definition records (options C/P + the underlying future F). */
export function normalizeDefinitions(csv: string): DefinitionRec[] {
  const out: DefinitionRec[] = [];
  for (const r of rows(csv)) {
    const cls = r['instrument_class'] as InstrumentClass;
    if (cls !== 'C' && cls !== 'P' && cls !== 'F') continue; // drop spreads / other classes
    out.push({
      type: 'definition',
      instrument_id: Number(r['instrument_id']),
      instrument_class: cls,
      strike: cls === 'F' ? null : scaledPrice(r['strike_price']),
      expiration: nsToDate(r['expiration']),
      underlying: r['underlying_id'],
    });
  }
  return out;
}

/** `bbo-1s` / `mbp-1` schema -> quote records (latest bid/ask). */
export function normalizeQuotes(csv: string): QuoteRec[] {
  return rows(csv).map((r) => ({
    type: 'quote',
    instrument_id: Number(r['instrument_id']),
    bid: scaledPrice(r['bid_px_00']),
    ask: scaledPrice(r['ask_px_00']),
    ts: r['ts_event'] ?? null,
  }));
}

/** `statistics` schema -> open-interest records (stat_type 9, value in `quantity`). */
export function normalizeStatistics(csv: string): StatisticsRec[] {
  const out: StatisticsRec[] = [];
  for (const r of rows(csv)) {
    if (r['stat_type'] !== STAT_TYPE_OPEN_INTEREST) continue;
    const q = r['quantity'];
    if (!q || q === UNDEF_I32) continue;
    out.push({ type: 'statistics', instrument_id: Number(r['instrument_id']), stat_type: 'open_interest', value: Number(q) });
  }
  return out;
}

/** Combine the three schema pulls into one record stream for the reducer. */
export function normalizeChain(csv: { definition?: string; bbo?: string; statistics?: string }): ChainRec[] {
  return [
    ...(csv.definition ? normalizeDefinitions(csv.definition) : []),
    ...(csv.bbo ? normalizeQuotes(csv.bbo) : []),
    ...(csv.statistics ? normalizeStatistics(csv.statistics) : []),
  ];
}
