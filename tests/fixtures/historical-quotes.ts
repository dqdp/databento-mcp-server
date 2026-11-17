/** Historical HTTP fixtures: official per-schema availability and raw MBP-1 CSV. */
export const QUOTE_NOW = '2026-11-13T15:02:00.000Z';
export const QUOTE_END = '2026-11-13T14:40:00.000000000Z';
export const QUOTE_START = '2010-06-06T00:00:00.000000000Z';

export function quoteNanos(value: string): bigint {
  if (/^\d+$/.test(value)) return BigInt(value);
  const fraction = value.match(/\.(\d+)/)?.[1] ?? '';
  return BigInt(Date.parse(value)) * 1_000_000n + BigInt(fraction.padEnd(9, '0').slice(3) || '0');
}

export interface QuoteRow {
  recv: bigint;
  event?: bigint;
  bid?: string;
  ask?: string;
}

export function quoteCsv(rows: QuoteRow[]): string {
  const header = 'ts_recv,ts_event,rtype,publisher_id,instrument_id,action,side,depth,price,size,flags,ts_in_delta,sequence,bid_px_00,ask_px_00,bid_sz_00,ask_sz_00,bid_ct_00,ask_ct_00,symbol';
  return [header, ...rows.map((r, i) =>
    `${r.recv},${r.event ?? r.recv - 1000n},1,1,1234,A,B,0,7611000000000,1,128,1000,${i + 1},${r.bid ?? '7611000000000'},${r.ask ?? '7611250000000'},10,15,2,3,ESZ6`
  )].join('\n') + '\n';
}

export function quoteAvailability(start = QUOTE_START, end = QUOTE_END) {
  return { start: QUOTE_START, end: QUOTE_NOW, schema: { 'mbp-1': { start, end } } };
}

export function historicalQuoteProvider(rows: QuoteRow[], availability = quoteAvailability()) {
  const ordered = [...rows].sort((a, b) => a.recv < b.recv ? -1 : a.recv > b.recv ? 1 : 0);
  return async (endpoint: string, params: Record<string, any>): Promise<string> => {
    if (endpoint === '/v0/metadata.get_dataset_range') return JSON.stringify(availability);
    if (endpoint !== '/v0/timeseries.get_range') throw new Error(`Unexpected endpoint: ${endpoint}`);
    const start = quoteNanos(params.start);
    const end = quoteNanos(params.end);
    if (end > quoteNanos(availability.schema['mbp-1'].end)) {
      throw new Error('HTTP 422: data_end_after_available_end');
    }
    if (start < quoteNanos(availability.schema['mbp-1'].start)) {
      throw new Error('HTTP 422: data_start_before_available_start');
    }
    return quoteCsv(ordered.filter(r => r.recv >= start && r.recv < end).slice(0, Number(params.limit)));
  };
}
