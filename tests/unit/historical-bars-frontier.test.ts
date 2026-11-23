import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {DataBentoClient} from "../../src/databento-client.js";
import {quoteNanos} from "../fixtures/historical-quotes.js";

vi.mock("../../src/http/databento-http.js",()=>({DataBentoHTTP:vi.fn().mockImplementation(function(){return {get:vi.fn()};})}));
const header="ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume";
const row=(time:string,id=1234,close=5)=>`${quoteNanos(time)},32,1,${id},4000000000,6000000000,3000000000,${close*1e9},100`;
const availability={start:"2010-06-06T00:00:00Z",end:"2026-11-17T14:00:00Z",schema:{
  "ohlcv-1h":{start:"2010-06-06T00:00:00Z",end:"2026-11-16T23:59:59.999999999Z"},
  "ohlcv-1d":{start:"2010-06-06T00:00:00Z",end:"2026-11-17T00:00:00Z"}}};
let client:DataBentoClient,get:ReturnType<typeof vi.fn>;
function serve(rows:string[],metadata:unknown=availability){
  get.mockImplementation(async(endpoint:string,params:Record<string,any>)=>{
    if(endpoint==="/v0/metadata.get_dataset_range")return JSON.stringify(metadata);
    const start=quoteNanos(params.start);
    const end=params.end?quoteNanos(params.end):start+86_400_000_000_000n;
    return [header,...rows.filter(line=>{const ts=BigInt(line.split(",")[0]);return ts>=start&&ts<end;})
      .slice(0,params.limit)].join("\n");
  });
}
const query=()=>get.mock.calls.find(([endpoint])=>endpoint==="/v0/timeseries.get_range")![1];
beforeEach(()=>{vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-11-17T14:20:00Z"));
  client=new DataBentoClient("db-fixture");get=(client as any).http.get;});
afterEach(()=>vi.useRealTimers());

describe("latest historical bars bounded by each schema frontier",()=>{
  it("uses the hourly frontier and a sufficient prefix cap before returning the newest bars",async()=>{
    serve([row("2026-11-09T20:00:00Z"),row("2026-11-16T20:00:00Z"),row("2026-11-16T21:00:00Z"),row("2026-11-16T22:00:00Z"),row("2026-11-16T23:00:00Z")]);
    const bars=await client.getHistoricalBars("ES","1h",3);
    expect(bars.map(b=>b.timestamp.toISOString())).toEqual(["2026-11-16T20:00:00.000Z","2026-11-16T21:00:00.000Z","2026-11-16T22:00:00.000Z"]);
    expect(quoteNanos(query().end)).toBe(quoteNanos("2026-11-16T23:00:00Z"));
    expect(query().limit).toBeGreaterThan(3);
    expect(bars.every(b=>b.instrumentId===1234)).toBe(true);
  });
  it("returns latest daily rows across weekends instead of the earliest limited prefix",async()=>{
    serve([row("2026-11-06T00:00:00Z"),row("2026-11-09T00:00:00Z"),row("2026-11-10T00:00:00Z"),row("2026-11-13T00:00:00Z"),row("2026-11-16T00:00:00Z")]);
    const bars=await client.getHistoricalBars("GCZ6","1d",3);
    expect(bars.map(b=>b.timestamp.toISOString())).toEqual(["2026-11-10T00:00:00.000Z","2026-11-13T00:00:00.000Z","2026-11-16T00:00:00.000Z"]);
    expect(quoteNanos(query().end)).toBe(quoteNanos("2026-11-17T00:00:00Z"));
  });
  it("aligns H4 to UTC buckets, does not join trading gaps, and marks partial source coverage",async()=>{
    serve([row("2026-11-16T09:00:00Z"),row("2026-11-16T10:00:00Z"),row("2026-11-16T11:00:00Z"),
      row("2026-11-16T12:00:00Z"),row("2026-11-16T13:00:00Z"),row("2026-11-16T15:00:00Z"),row("2026-11-16T20:00:00Z")]);
    const bars=await client.getHistoricalBars("CL.v.0","H4",3,"continuous");
    expect(bars.map(b=>b.timestamp.toISOString())).toEqual(["2026-11-16T08:00:00.000Z","2026-11-16T12:00:00.000Z"]);
    expect(bars.map(b=>[b.sourceBarCount,b.aggregationComplete])).toEqual([[3,false],[3,false]]);
    expect(quoteNanos(query().end)).toBe(quoteNanos("2026-11-16T20:00:00Z"));
  });
  it("rejects parent and multiselect requests before any network access",async()=>{
    for(const [symbol,stype] of [["ES.FUT","parent"],["ES,NQ",undefined],["ALL_SYMBOLS",undefined]] as const)
      await expect(client.getHistoricalBars(symbol,"1h",3,stype)).rejects.toThrow(/single|parent/i);
    expect(get).not.toHaveBeenCalled();
  });
  it("preserves sequential continuous rollover but rejects mixed H4 instruments and duplicate timestamps",async()=>{
    serve([row("2026-11-16T00:00:00Z",1234),row("2026-11-16T04:00:00Z",5678)]);
    expect((await client.getHistoricalBars("ES.c.0","H4",3,"continuous")).map(b=>b.instrumentId)).toEqual([1234,5678]);
    serve([row("2026-11-16T00:00:00Z",1234),row("2026-11-16T01:00:00Z",5678)]);
    await expect(client.getHistoricalBars("ES.c.0","H4",3,"continuous")).rejects.toThrow(/instrument/i);
    serve([row("2026-11-16T00:00:00Z",1234),row("2026-11-16T00:00:00Z",5678)]);
    await expect(client.getHistoricalBars("ES.c.0","1h",3,"continuous")).rejects.toThrow(/duplicate|instrument/i);
    serve([row("2026-11-16T00:00:00Z",1234),row("2026-11-16T01:00:00Z",5678)]);
    await expect(client.getHistoricalBars("ESZ6","1h",3)).rejects.toThrow(/instrument/i);
    serve([row("2026-11-16T00:30:00Z",1234)]);
    await expect(client.getHistoricalBars("ESZ6","H4",3)).rejects.toThrow(/hour/i);
  });
  it("fails closed on missing schema metadata and a saturated chronological prefix",async()=>{
    serve([],{end:availability.end});
    await expect(client.getHistoricalBars("ES","1h",3)).rejects.toThrow(/availability/i);
    expect(get.mock.calls.filter(([endpoint])=>endpoint==="/v0/timeseries.get_range")).toHaveLength(0);
    get.mockImplementation(async(endpoint:string,params:Record<string,any>)=>endpoint==="/v0/metadata.get_dataset_range"?
      JSON.stringify(availability):[header,...Array(params.limit).fill(row("2026-11-16T10:00:00Z"))].join("\n"));
    await expect(client.getHistoricalBars("ES","1h",3)).rejects.toThrow(/latest|limit|truncat/i);
  });
});
