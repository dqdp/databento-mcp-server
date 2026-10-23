import { afterEach, describe, expect, it, vi } from "vitest";
import { DataBentoHTTP } from "../../src/http/databento-http.js";
import { invokePlatformTool } from "../../mcp/platform-worker.js";

afterEach(()=>vi.restoreAllMocks());
describe("actual native MCP dispatch under the platform cost boundary",()=>{
  it("preserves CSV bytes and nanosecond timestamps after zero-cost proof",async()=>{
    const csv="ts_event,open,high,low,close,volume\n1767225600000000001,1,2,1,2,3\n";
    const upstream=vi.spyOn(DataBentoHTTP.prototype,"get").mockImplementation(async endpoint=>
      endpoint==="/v0/metadata.get_cost"?"0":csv);
    const response=await invokePlatformTool({name:"timeseries_get_range",arguments:{
      dataset:"GLBX.MDP3",symbols:"ES.c.0",schema:"ohlcv-1d",start:"2026-01-01",end:"2026-01-02",
      stype_in:"continuous",limit:2},api_key:"db-owner-a-fixture"});
    expect(response.result.isError).not.toBe(true);
    expect(JSON.parse((response.result.content[0] as {text:string}).text).data).toBe(csv);
    expect(upstream.mock.calls.map(c=>c[0])).toEqual(["/v0/metadata.get_cost","/v0/timeseries.get_range"]);
    expect(response.originals).toHaveLength(2);
    expect(Buffer.from(response.originals[1].data_base64,"base64").toString()).toBe(csv);
  });
  it("high-level historical bars cannot bypass cost policy and keeps omitted end semantics",async()=>{
    const upstream=vi.spyOn(DataBentoHTTP.prototype,"get").mockResolvedValue("2.5");
    const response=await invokePlatformTool({name:"get_historical_bars",arguments:{
      symbol:"ES",timeframe:"1d",count:2},api_key:"db-owner-b-fixture"});
    expect(response.result.isError).toBe(true);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls[0][0]).toBe("/v0/metadata.get_cost");
    expect(upstream.mock.calls[0][1]).not.toHaveProperty("end");
    expect(JSON.stringify(response)).not.toContain("db-owner-b-fixture");
    expect(response.originals).toEqual([]);
  });
  it("hidden Live, Reference and Batch cannot reach underlying clients",async()=>{
    const upstream=vi.spyOn(DataBentoHTTP.prototype,"get");
    for(const name of ["get_live_futures_quote","reference_search_securities","batch_submit_job"]){
      await expect(invokePlatformTool({name,arguments:{},api_key:"db-fixture"})).rejects.toThrow();
    }
    expect(upstream).not.toHaveBeenCalled();
  });
});
