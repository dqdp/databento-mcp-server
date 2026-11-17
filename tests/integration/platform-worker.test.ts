import { afterEach, describe, expect, it, vi } from "vitest";
import { invokePlatformTool } from "../../mcp/platform-worker.js";
import {createHash} from "node:crypto";
const barsAvailability=JSON.stringify({schema:{"ohlcv-1d":{start:"2010-06-06T00:00:00Z",end:"2026-01-02T00:00:00Z"}}});

afterEach(()=>vi.restoreAllMocks());
describe("actual native MCP dispatch under the platform cost boundary",()=>{
  it("uses a trusted subscription through native MCP without exposing service fields in tool arguments",async()=>{
    const apiKey="db-subscription-fixture";
    const subscription={plan:"cme_standard" as const,policy_version:1 as const,
      credential_sha256:createHash("sha256").update(apiKey).digest("hex")};
    const csv="ts_event,open,high,low,close,volume\n1262304000000000000,1,2,1,2,3\n";
    const upstream=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(csv));
    const args={dataset:"GLBX.MDP3",symbols:"ES.c.0",schema:"ohlcv-1d",start:"2010-01-01",end:"2010-01-02",
      stype_in:"continuous",limit:2};
    const response=await invokePlatformTool({name:"timeseries_get_range",arguments:args,api_key:apiKey,subscription});
    expect(response.result.isError).not.toBe(true);
    expect(response.cost_summary).toMatchObject({estimated_spent_usd:0,approval_required:false,subscription_covered_requests:1});
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(new URL(String(upstream.mock.calls[0][0])).pathname).toBe("/v0/timeseries.get_range");
    const untrusted=await invokePlatformTool({name:"timeseries_get_range",arguments:{...args,subscription},api_key:apiKey});
    expect(untrusted.result.isError).toBe(true);
    expect(upstream).toHaveBeenCalledTimes(1);
    for(const name of ["get_live_futures_quote","get_session_info","metadata_get_cost"])
      await expect(invokePlatformTool({name,arguments:{},api_key:apiKey,subscription})).rejects.toThrow();
  });
  it("covers native bars using the exact schema frontier range and preserves instrument provenance",async()=>{
    const apiKey="db-subscription-fixture";
    const subscription={plan:"cme_standard" as const,policy_version:1 as const,
      credential_sha256:createHash("sha256").update(apiKey).digest("hex")};
    const upstream=vi.spyOn(globalThis,"fetch").mockImplementation(async url=>new Response(
      String(url).includes("get_dataset_range")?barsAvailability:
      "ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume\n1767225600000000000,32,1,1234,1000000000,2000000000,1000000000,2000000000,3\n"));
    const response=await invokePlatformTool({name:"get_historical_bars",arguments:{symbol:"ES",timeframe:"1d",count:2},
      api_key:apiKey,subscription});
    expect(response.result.isError).not.toBe(true);
    expect(response.cost_summary).toMatchObject({estimated_spent_usd:0,subscription_covered_requests:1});
    expect(upstream).toHaveBeenCalledTimes(2);
    const url=new URL(String(upstream.mock.calls[1][0]));
    expect(url.pathname).toBe("/v0/timeseries.get_range");
    expect(url.searchParams.get("start")).toMatch(/^\d{19}$/);
    expect(url.searchParams.get("end")).toBe("1767312000000000000");
    expect(JSON.parse((response.result.content[0] as {text:string}).text).bars[0].instrument_id).toBe(1234);
  });
  it("preserves CSV bytes and nanosecond timestamps after zero-cost proof",async()=>{
    const csv="ts_event,open,high,low,close,volume\n1767225600000000001,1,2,1,2,3\n";
    const upstream=vi.spyOn(globalThis,"fetch").mockImplementation(async url=>
      new Response(String(url).includes("metadata.get_cost")?"0":csv));
    const response=await invokePlatformTool({name:"timeseries_get_range",arguments:{
      dataset:"GLBX.MDP3",symbols:"ES.c.0",schema:"ohlcv-1d",start:"2026-01-01",end:"2026-01-02",
      stype_in:"continuous",limit:2},api_key:"db-owner-a-fixture"});
    expect(response.result.isError).not.toBe(true);
    expect(JSON.parse((response.result.content[0] as {text:string}).text).data).toBe(csv);
    expect(upstream.mock.calls.map(c=>new URL(String(c[0])).pathname)).toEqual(["/v0/metadata.get_cost","/v0/timeseries.get_range"]);
    expect(response.originals).toHaveLength(2);
    expect(Buffer.from(response.originals[1].data_base64,"base64").toString()).toBe(csv);
  });
  it("high-level historical bars cannot bypass cost policy and estimates the exact frontier interval",async()=>{
    const upstream=vi.spyOn(globalThis,"fetch").mockImplementation(async url=>new Response(String(url).includes("get_dataset_range")?barsAvailability:"2.5"));
    const response=await invokePlatformTool({name:"get_historical_bars",arguments:{
      symbol:"ES",timeframe:"1d",count:2},api_key:"db-owner-b-fixture"});
    expect(response.result.isError).toBe(true);
    expect(upstream).toHaveBeenCalledTimes(2);
    const request=new URL(String(upstream.mock.calls[1][0]));
    expect(request.pathname).toBe("/v0/metadata.get_cost");
    expect(request.searchParams.get("end")).toBe("1767312000000000000");
    expect(JSON.stringify(response)).not.toContain("db-owner-b-fixture");
    expect(response.originals).toEqual([]);
  });
  it("hidden Reference and Batch cannot reach underlying clients",async()=>{
    const upstream=vi.spyOn(globalThis,"fetch");
    for(const name of ["reference_search_securities","batch_submit_job"]){
      await expect(invokePlatformTool({name,arguments:{},api_key:"db-fixture"})).rejects.toThrow();
    }
    expect(upstream).not.toHaveBeenCalled();
  });
  it("uses provider pricing beyond guessed Standard CME coverage without weakening local defaults",async()=>{
    const upstream=vi.spyOn(globalThis,"fetch").mockImplementation(async url=>new Response(
      String(url).includes("get_cost")?"0.5":"ts_event,price\n1,2\n"));
    const response=await invokePlatformTool({name:"timeseries_get_range",arguments:{
      dataset:"XNAS.ITCH",symbols:"AAPL",schema:"trades",start:"2020-01-01",end:"2020-01-02",limit:2},
      api_key:"db-fixture",cost_control:{reservation_id:"e".repeat(32),allowance_usd:10}});
    expect(response.result.isError).not.toBe(true);
    expect(response.cost_summary).toMatchObject({reservation_id:"e".repeat(32),estimated_spent_usd:0.5,approval_required:false});
    const {TimeseriesClient}=await import("../../src/api/timeseries-client.js");
    const {DataBentoHTTP}=await import("../../src/http/databento-http.js");
    const {Schema}=await import("../../src/types/timeseries.js");
    await expect(new TimeseriesClient(new DataBentoHTTP("db-fixture")).getRange({
      dataset:"XNAS.ITCH",symbols:"AAPL",schema:Schema.TRADES,start:"2020-01-01",end:"2020-01-02",limit:2})).rejects.toThrow("Standard CME");
    expect(upstream).toHaveBeenCalledTimes(2);
  });
  it("reports approval_required and preserves cost summary when a high-level MCP handler fails",async()=>{
    const upstream=vi.spyOn(globalThis,"fetch").mockImplementation(async url=>new Response(String(url).includes("get_dataset_range")?barsAvailability:"12"));
    const response=await invokePlatformTool({name:"get_historical_bars",arguments:{symbol:"ES",timeframe:"1d",count:2},
      api_key:"db-fixture",cost_control:{reservation_id:"f".repeat(32),allowance_usd:10}});
    expect(response.result.isError).toBe(true);
    expect(response.cost_summary).toMatchObject({reservation_id:"f".repeat(32),estimated_spent_usd:0,
      approval_required:true,required_allowance_usd:12});
    expect(upstream).toHaveBeenCalledTimes(2);
  });
  it("returns the completed-attempt estimate when the download or native parsing fails",async()=>{
    const upstream=vi.spyOn(globalThis,"fetch").mockImplementation(async url=>new Response(
      String(url).includes("get_dataset_range")?barsAvailability:String(url).includes("get_cost")?"1.5":"db-fixture private upstream body",
      {status:String(url).includes("timeseries")?500:200}));
    const response=await invokePlatformTool({name:"get_historical_bars",arguments:{symbol:"ES",timeframe:"1d",count:2},
      api_key:"db-fixture",cost_control:{reservation_id:"1".repeat(32),allowance_usd:10}});
    expect(response.result.isError).toBe(true);
    expect(response.cost_summary).toMatchObject({reservation_id:"1".repeat(32),estimated_spent_usd:1.5,approval_required:false});
    expect(upstream).toHaveBeenCalledTimes(3);
    expect(JSON.parse((response.result.content[0] as {text:string}).text)).toMatchObject({
      error_code:"upstream_http_error",phase:"market_data",http_status:500});
    expect(JSON.stringify(response)).not.toContain("private upstream body");
  });

  it("keeps syntax, calendar dates and direct record bounds under platform pricing",async()=>{
    const upstream=vi.spyOn(globalThis,"fetch");
    const base={dataset:"XNAS.ITCH",symbols:"AAPL",schema:"trades",start:"2020-01-01",end:"2020-01-02",limit:2};
    for(const changes of [{start:"2020-02-30"},{end:"2019-12-31"},{limit:10001},
      {cost_control:{reservation_id:"0".repeat(32),allowance_usd:999}}]){
      const response=await invokePlatformTool({name:"timeseries_get_range",arguments:{...base,...changes},
        api_key:"db-fixture",cost_control:{reservation_id:"2".repeat(32),allowance_usd:10}});
      expect(response.result.isError).toBe(true);
      expect(response.cost_summary).toMatchObject({estimated_spent_usd:0,approval_required:false});
    }
    expect(upstream).not.toHaveBeenCalled();
  });
  it.each(["NaN","null",'"0"',"-1"])("does not start or meter data on invalid provider estimate %s",async cost=>{
    const upstream=vi.spyOn(globalThis,"fetch").mockImplementation(async url=>new Response(String(url).includes("get_dataset_range")?barsAvailability:cost));
    const response=await invokePlatformTool({name:"get_historical_bars",arguments:{symbol:"ES",timeframe:"1d",count:2},
      api_key:"db-fixture",cost_control:{reservation_id:"3".repeat(32),allowance_usd:10}});
    expect(response.result.isError).toBe(true);
    expect(response.cost_summary).toMatchObject({estimated_spent_usd:0,approval_required:false});
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(JSON.parse((response.result.content[0] as {text:string}).text)).toMatchObject({error_code:"invalid_cost_estimate",phase:"cost_estimate"});
  });

});
