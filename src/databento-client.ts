/**
 * DataBento API Client for MCP Server
 * Handles communication with DataBento historical and real-time APIs
 */

import { DataBentoHTTP } from "./http/databento-http.js";

interface QuoteData {
  symbol: string;
  price: number;
  bid: number;
  ask: number;
  timestamp: Date;
  dataAge: number; // milliseconds since data was generated
  availableEnd: string; // exclusive Historical mbp-1 frontier used for this lookup
}

interface BarData {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  instrumentId?: number;
  sourceBarCount?: number;
  aggregationComplete?: boolean;
}

interface SessionInfo {
  currentSession: "Asian" | "London" | "NY" | "Unknown";
  sessionStart: Date;
  sessionEnd: Date;
  timestamp: Date;
}

// Symbol mapping for continuous contracts
const SYMBOL_MAP: Record<string, string> = {
  ES: "ES.c.0", // E-mini S&P 500 continuous contract
  NQ: "NQ.c.0", // E-mini NASDAQ continuous contract
};

const DATASET = "GLBX.MDP3"; // CME Group Market Data Platform 3
export const MAX_INTRADAY_HISTORICAL_BARS = 100;
export const MAX_DAILY_HISTORICAL_BARS = 10000;

const QUOTE_RECORD_LIMIT = 1000;
const QUOTE_MAX_REQUESTS = 32;
const QUOTE_TIMEOUT_MS = 10_000;
const QUOTE_LOOKBACK_NS = 7n * 86_400_000_000_000n;
const UNDEF_PRICE = 9_223_372_036_854_775_807n;

// Keep nanosecond boundaries exact: rounding a split to milliseconds can skip the
// last updates of a busy market. Databento accepts UNIX nanoseconds over HTTP.
function quoteRangeNanos(value: unknown): bigint {
  const match = typeof value === "string"
    ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value)
    : null;
  const secondsMs = match ? Date.parse(`${match[1]}${match[3]}`) : NaN;
  if (!Number.isFinite(secondsMs) || secondsMs < 0) {
    throw new Error("Invalid mbp-1 historical availability timestamp");
  }
  return BigInt(secondsMs) * 1_000_000n + BigInt((match![2] ?? "").padEnd(9, "0"));
}

function maxHistoricalBarsForTimeframe(timeframe: "1h" | "H4" | "1d"): number {
  return timeframe === "1d" ? MAX_DAILY_HISTORICAL_BARS : MAX_INTRADAY_HISTORICAL_BARS;
}

/**
 * DataBento API Client
 */
export class DataBentoClient {
  private readonly http: DataBentoHTTP;
  private priceCache: Map<string, { data: QuoteData; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 30000; // 30 seconds

  constructor(apiKey: string) {
    this.http = new DataBentoHTTP(apiKey);
  }

  /** Get the latest Historical MBP-1 update within a bounded seven-day lookback. */
  async getQuote(symbol: "ES" | "NQ"): Promise<QuoteData> {
    const cached = this.priceCache.get(symbol);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return { ...cached.data, dataAge: Date.now() - cached.data.timestamp.getTime() };
    }

    const databentoSymbol = SYMBOL_MAP[symbol];
    if (!databentoSymbol) throw new Error(`Invalid symbol: ${symbol}`);

    const now = Date.now();
    const deadline = now + QUOTE_TIMEOUT_MS;
    const searchError = () => new Error(
      `Unable to establish the latest historical quote for ${symbol} within the bounded search; use an explicit timeseries range or get_live_futures_quote`
    );
    const requestOptions = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw searchError();
      return { retry: false, timeout: remaining };
    };
    const metadata = JSON.parse(await this.http.get(
      "/v0/metadata.get_dataset_range", { dataset: DATASET }, requestOptions()
    ));
    // The dataset-wide frontier may be ahead of MBP-1. Missing schema metadata
    // is an error, never a reason to fall back to wall-clock time.
    const availability = metadata?.schema?.["mbp-1"];
    const availableStart = quoteRangeNanos(availability?.start);
    const availableEnd = quoteRangeNanos(availability?.end);
    if (availableStart >= availableEnd) throw new Error("Invalid mbp-1 historical availability range");
    const wallEnd = BigInt(now) * 1_000_000n;
    let end = availableEnd < wallEnd ? availableEnd : wallEnd;
    const lookbackStart = wallEnd - QUOTE_LOOKBACK_NS;
    const lowerBound = availableStart > lookbackStart ? availableStart : lookbackStart;
    let requests = 0;

    const search = async (start: bigint, stop: bigint): Promise<QuoteData | undefined> => {
      if (requests >= QUOTE_MAX_REQUESTS) throw searchError();
      const options = requestOptions();
      requests++;
      const response = await this.http.get("/v0/timeseries.get_range", {
        dataset: DATASET,
        symbols: databentoSymbol,
        stype_in: "continuous",
        stype_out: "instrument_id",
        start: start.toString(),
        end: stop.toString(),
        schema: "mbp-1",
        encoding: "csv",
        pretty_px: false,
        pretty_ts: false,
        limit: QUOTE_RECORD_LIMIT,
      }, options);
      if (Date.now() >= deadline) throw searchError();
      const lines = response.trim().split("\n");
      const rows = lines.slice(1).filter(line => line.trim());
      if (rows.length >= QUOTE_RECORD_LIMIT) {
        // A limited response is a chronological PREFIX. Search the newer half
        // first, then the older half only if the newer half is fully empty.
        const mid = start + (stop - start) / 2n;
        if (mid === start) throw searchError();
        return await search(mid, stop) ?? await search(start, mid);
      }
      if (rows.length === 0) return undefined;

      const headers = lines[0].trim().split(",");
      const fields = rows[rows.length - 1].trim().split(",");
      const integerField = (name: string): bigint => {
        const raw = fields[headers.indexOf(name)];
        if (!raw || !/^-?\d+$/.test(raw)) throw new Error(`Invalid historical quote ${name} for ${symbol}`);
        return BigInt(raw);
      };
      const received = integerField("ts_recv");
      const event = integerField("ts_event");
      const bid = integerField("bid_px_00");
      const ask = integerField("ask_px_00");
      // Do not silently substitute an older two-sided book for an invalid last update.
      if (received < start || received >= stop || event <= 0n || event > wallEnd || bid === UNDEF_PRICE || ask === UNDEF_PRICE) {
        throw new Error(`Invalid historical quote for ${symbol}`);
      }
      const bidPx = Number(bid) / 1e9;
      const askPx = Number(ask) / 1e9;
      const timestamp = new Date(Number(event / 1_000_000n));
      return {
        symbol, price: (bidPx + askPx) / 2, bid: bidPx, ask: askPx, timestamp,
        dataAge: Date.now() - timestamp.getTime(), availableEnd: availability.end,
      };
    };

    let window = 60_000_000_000n;
    while (end > lowerBound) {
      const start = end - window > lowerBound ? end - window : lowerBound;
      const quote = await search(start, end);
      if (quote) {
        this.priceCache.set(symbol, { data: quote, timestamp: Date.now() });
        return quote;
      }
      end = start;
      window *= 2n;
    }
    throw new Error(`No quote data available for ${symbol} within the last seven days`);
  }

  /**
   * Get historical bars for a symbol
   */
  async getHistoricalBars(
    symbol: string,
    timeframe: "1h" | "H4" | "1d",
    count: number,
    stypeIn?: "raw_symbol" | "instrument_id" | "continuous" | "parent"
  ): Promise<BarData[]> {
    if (!symbol || !symbol.trim()) {
      throw new Error(`Invalid symbol: ${symbol}`);
    }
    if(stypeIn==="parent"||symbol.toUpperCase()==="ALL_SYMBOLS"||/[|,\r\n\x00-\x1f\x7f]/.test(symbol))
      throw new Error("Historical bars require a single instrument or continuous symbol; parent symbols are not supported");

    const maxCount = maxHistoricalBarsForTimeframe(timeframe);
    if (!Number.isInteger(count) || count < 1 || count > maxCount) {
      throw new Error(`${timeframe} historical bars are limited to ${maxCount} bars`);
    }

    // ES/NQ are aliases for the continuous front contract; any other symbol is a
    // raw_symbol unless the caller specifies stype_in explicitly (mirrors the
    // live-quote tool so historical and live accept the same symbology).
    const aliasSymbol = stypeIn ? undefined : SYMBOL_MAP[symbol.toUpperCase()];
    const resolvedSymbol = aliasSymbol ?? symbol;
    const resolvedStypeIn = stypeIn ?? (aliasSymbol ? "continuous" : "raw_symbol");

    const schema = timeframe === "1d" ? "ohlcv-1d" : "ohlcv-1h";
    const hourNs=3_600_000_000_000n,dayNs=24n*hourNs;
    const schemaInterval=timeframe==="1d"?dayNs:hourNs;
    const resultInterval=timeframe==="H4"?4n*hourNs:schemaInterval;
    const metadata=JSON.parse(await this.http.get("/v0/metadata.get_dataset_range",{dataset:DATASET}));
    const availability=metadata?.schema?.[schema];
    let availableStart:bigint,availableEnd:bigint;
    try{availableStart=quoteRangeNanos(availability?.start);availableEnd=quoteRangeNanos(availability?.end);}
    catch{throw new Error(`Invalid ${schema} historical availability timestamp`);}
    if(availableStart>=availableEnd)throw new Error(`Invalid ${schema} historical availability range`);
    const wallEnd=BigInt(Date.now())*1_000_000n;
    // Only elapsed hourly/daily/UTC H4 buckets. The dataset-wide frontier is not
    // sufficient, and date-only start with omitted end means one day, not "now".
    let end=availableEnd<wallEnd?availableEnd:wallEnd;
    end=end/resultInterval*resultInterval;
    const lookbackDays=timeframe==="1d"?Math.ceil(count*7/5)+14:
      Math.ceil(count*(timeframe==="H4"?4:1)/24*7/5)+7;
    let start=end/dayNs*dayNs-BigInt(lookbackDays)*dayNs;
    if(start<availableStart)start=availableStart;
    start=(start+resultInterval-1n)/resultInterval*resultInterval;
    if(start>=end)throw new Error(`No complete bar data available for ${symbol}`);
    // A provider limit returns an oldest-first prefix. Retrieve every possible slot
    // in this bounded single-series interval before selecting its tail; the extra
    // record detects truncation/duplicates instead of silently returning stale bars.
    const limit=Number((end-start)/schemaInterval)+1;
    if(!Number.isSafeInteger(limit)||limit<1||limit>20000)
      throw new Error("Unable to establish latest historical bars within the bounded range");
    const params = {
      dataset: DATASET,
      symbols: resolvedSymbol,
      stype_in: resolvedStypeIn,
      stype_out: "instrument_id",
      start: start.toString(),
      end: end.toString(),
      schema: schema,
      encoding: "csv",
      pretty_px:false,
      pretty_ts:false,
      limit,
    };

    const response = await this.http.get("/v0/timeseries.get_range", params);

    if (!response || response.length === 0) {
      throw new Error(`No bar data available for ${symbol}`);
    }

    // Parse CSV response
    const lines = response.split("\n");
    const dataLines = lines.slice(1).filter((line) => line.trim());

    if (dataLines.length === 0) {
      throw new Error(`No bar data available for ${symbol}`);
    }
    if(dataLines.length>=limit)throw new Error("Unable to establish latest historical bars from a truncated response");
    const headers=lines[0].trim().split(",");
    const columns=["ts_event","instrument_id","open","high","low","close","volume"];
    if(columns.some(name=>headers.filter(field=>field===name).length!==1))throw new Error("Invalid historical bar columns");
    const instruments=new Set<number>();
    const timestamps=new Set<string>();

    const bars: BarData[] = dataLines.map((line) => {
      const fields = line.split(",");

      const integer=(name:string):bigint=>{
        const value=fields[headers.indexOf(name)]?.trim();
        if(!value||! /^-?\d{1,20}$/.test(value))throw new Error(`Invalid historical bar ${name}`);
        return BigInt(value);
      };
      const tsEvent=integer("ts_event");
      if(tsEvent<start||tsEvent>=end)throw new Error("Historical bar timestamp outside requested range");
      if(timeframe==="H4"&&tsEvent%hourNs!==0n)throw new Error("H4 aggregation requires hourly aligned source bars");
      if(timestamps.has(tsEvent.toString()))throw new Error("Duplicate historical bar timestamp or mixed instruments");
      timestamps.add(tsEvent.toString());
      const instrumentId=Number(integer("instrument_id"));
      if(!Number.isSafeInteger(instrumentId)||instrumentId<0||instrumentId>0xffffffff)throw new Error("Invalid historical bar instrument");
      instruments.add(instrumentId);
      if(resolvedStypeIn!=="continuous"&&instruments.size>1)throw new Error("Historical bars contain mixed instruments");
      const price=(name:string)=>{const value=integer(name);if(value===UNDEF_PRICE)throw new Error("Undefined historical bar price");return Number(value)/1e9;};
      const open=price("open"),high=price("high"),low=price("low"),close=price("close");
      const volume=Number(integer("volume"));
      if(!Number.isSafeInteger(volume)||volume<0)throw new Error("Invalid historical bar volume");

      return {
        timestamp: new Date(Number(tsEvent/1_000_000n)),
        open,
        high,
        low,
        close,
        volume,
        instrumentId,
      };
    });
    bars.sort((a,b)=>a.timestamp.getTime()-b.timestamp.getTime());

    // Handle H4 aggregation if needed
    if (timeframe === "H4") {
      return this.aggregateToH4(bars).slice(-count);
    }

    // Return last N bars
    return bars.slice(-count);
  }

  /**
   * Aggregate 1h bars to H4 bars
   */
  private aggregateToH4(bars: BarData[]): BarData[] {
    const h4Bars: BarData[] = [];
    const buckets=new Map<number,BarData[]>();
    for(const bar of [...bars].sort((a,b)=>a.timestamp.getTime()-b.timestamp.getTime())){
      const start=Math.floor(bar.timestamp.getTime()/14_400_000)*14_400_000;
      const bucket=buckets.get(start)??[];
      bucket.push(bar);buckets.set(start,bucket);
    }
    for(const [timestamp,chunk] of buckets){
      if(new Set(chunk.map(bar=>bar.instrumentId)).size>1)throw new Error("Cannot aggregate different instruments into one H4 bar");
      h4Bars.push({
        timestamp: new Date(timestamp),
        open: chunk[0].open,
        high: Math.max(...chunk.map((b) => b.high)),
        low: Math.min(...chunk.map((b) => b.low)),
        close: chunk[chunk.length - 1].close,
        volume: chunk.reduce((sum, b) => sum + b.volume, 0),
        ...(chunk[0].instrumentId===undefined?{}:{instrumentId:chunk[0].instrumentId}),
        sourceBarCount:chunk.length,
        aggregationComplete:chunk.length===4,
      });
    }

    return h4Bars;
  }

  /**
   * Get current trading session info
   */
  getSessionInfo(timestamp?: Date): SessionInfo {
    const now = timestamp || new Date();
    const utcHour = now.getUTCHours();

    let currentSession: "Asian" | "London" | "NY" | "Unknown";
    let sessionStart: Date;
    let sessionEnd: Date;

    if (utcHour >= 0 && utcHour < 7) {
      // Asian session: 00:00 - 07:00 UTC
      currentSession = "Asian";
      sessionStart = new Date(now);
      sessionStart.setUTCHours(0, 0, 0, 0);
      sessionEnd = new Date(now);
      sessionEnd.setUTCHours(7, 0, 0, 0);
    } else if (utcHour >= 7 && utcHour < 14) {
      // London session: 07:00 - 14:00 UTC
      currentSession = "London";
      sessionStart = new Date(now);
      sessionStart.setUTCHours(7, 0, 0, 0);
      sessionEnd = new Date(now);
      sessionEnd.setUTCHours(14, 0, 0, 0);
    } else if (utcHour >= 14 && utcHour < 22) {
      // NY session: 14:00 - 22:00 UTC
      currentSession = "NY";
      sessionStart = new Date(now);
      sessionStart.setUTCHours(14, 0, 0, 0);
      sessionEnd = new Date(now);
      sessionEnd.setUTCHours(22, 0, 0, 0);
    } else {
      currentSession = "Unknown";
      sessionStart = now;
      sessionEnd = now;
    }

    return {
      currentSession,
      sessionStart,
      sessionEnd,
      timestamp: now,
    };
  }

}
