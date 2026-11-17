import { afterEach, describe, expect, it, vi } from "vitest";
import { DataBentoHTTP } from "../../../src/http/databento-http.js";
import { installPlatformTransportGuard } from "../../../src/api/platform-transport.js";
import {createHash} from "node:crypto";

let guard: ReturnType<typeof installPlatformTransportGuard> | undefined;
afterEach(() => { guard?.restore(); guard = undefined; vi.restoreAllMocks(); });

describe("platform transport cost and originals boundary", () => {
  it("reports a sanitized timeout through HTTP wrappers without exposing exception text",async()=>{
    const apiKey="db-fixture";
    const upstream=vi.spyOn(globalThis,"fetch").mockImplementation(async url=>{
      if(String(url).includes("get_cost"))return new Response("0");
      throw new DOMException("db-fixture private timeout details","TimeoutError");
    });
    guard=installPlatformTransportGuard(apiKey);
    await expect(new DataBentoHTTP(apiKey).get("/v0/timeseries.get_range",{
      dataset:"GLBX.MDP3",symbols:"ES",schema:"trades",start:"2020-01-01"})).rejects.toThrow();
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(guard.failureSummary()).toEqual({error_code:"timeout",phase:"market_data"});
    expect(JSON.stringify(guard.failureSummary())).not.toContain("private");
  });
  it("skips estimates only for each fully included subscription subrequest and blocks any uncovered positive cost",async()=>{
    const apiKey="db-fixture";
    const subscription={plan:"cme_standard" as const,policy_version:1 as const,
      credential_sha256:createHash("sha256").update(apiKey).digest("hex")};
    const upstream=vi.spyOn(globalThis,"fetch").mockImplementation(async url=>
      new Response(String(url).includes("get_cost")?"0.0000001":"ts_event,price\n1,2\n"));
    guard=installPlatformTransportGuard(apiKey,{reservation_id:"a".repeat(32),allowance_usd:0},subscription);
    const http=new DataBentoHTTP(apiKey);
    const request={dataset:"GLBX.MDP3",symbols:"ES.c.0",schema:"ohlcv-1d",start:"2010-01-01",end:"2010-01-02"};
    await http.get("/v0/timeseries.get_range",request);
    await expect(http.get("/v0/timeseries.get_range",{...request,schema:"trades"})).rejects.toThrow();
    expect(upstream.mock.calls.map(call=>new URL(String(call[0])).pathname)).toEqual([
      "/v0/timeseries.get_range","/v0/metadata.get_cost"]);
    expect(guard.costSummary()).toMatchObject({subscription_covered_requests:1,estimated_spent_usd:0,
      approval_required:true,required_allowance_usd:0.000001});
    expect(guard.originals.map(original=>original.request.endpoint)).toEqual([
      "/v0/timeseries.get_range","/v0/metadata.get_cost"]);
  });
  it("still estimates uncovered zero cost and preserves covered attempts on failure without retry",async()=>{
    const apiKey="db-fixture";
    const subscription={plan:"cme_standard" as const,policy_version:1 as const,
      credential_sha256:createHash("sha256").update(apiKey).digest("hex")};
    const upstream=vi.spyOn(globalThis,"fetch").mockImplementation(async url=>
      new Response(String(url).includes("get_cost")?"0":"failure",{status:String(url).includes("get_cost")?200:500}));
    guard=installPlatformTransportGuard(apiKey,undefined,subscription);
    const http=new DataBentoHTTP(apiKey,{retryDelayMs:0});
    const request={dataset:"GLBX.MDP3",symbols:"ES",schema:"ohlcv-1d",start:"2010-01-01",end:"2010-01-02"};
    await expect(http.get("/v0/timeseries.get_range",request)).rejects.toThrow();
    await expect(http.get("/v0/timeseries.get_range",{...request,dataset:"XNAS.ITCH"})).rejects.toThrow();
    expect(upstream.mock.calls.map(call=>new URL(String(call[0])).pathname)).toEqual([
      "/v0/timeseries.get_range","/v0/metadata.get_cost","/v0/timeseries.get_range"]);
    expect(guard.costSummary()).toMatchObject({subscription_covered_requests:1,estimated_spent_usd:0,approval_required:false});
  });
  it("requires raw numeric zero before each actual historical request and keeps omitted end", async () => {
    const request = { dataset: "GLBX.MDP3", symbols: "ES.c.0", schema: "ohlcv-1d",
      start: "2026-01-01", stype_in: "continuous", stype_out: "instrument_id", limit: 2, encoding: "csv" };
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async url =>
      new Response(String(url).includes("metadata.get_cost") ? "0" : "ts_event,close\n1,5000000000000\n"));
    guard = installPlatformTransportGuard("db-synthetic-key");
    const http = new DataBentoHTTP("db-synthetic-key");
    await http.get("/v0/timeseries.get_range", request);
    const calls = upstream.mock.calls.map(call => new URL(String(call[0])));
    expect(calls.map(call => call.pathname)).toEqual(["/v0/metadata.get_cost", "/v0/timeseries.get_range"]);
    expect(Object.fromEntries(calls[0].searchParams)).toMatchObject({ dataset: request.dataset, symbols: request.symbols,
      schema: request.schema, start: request.start, stype_in: "continuous", limit: "2" });
    expect(calls[0].searchParams.has("end")).toBe(false);
    expect(Object.fromEntries(calls[1].searchParams)).toEqual({...request,limit:"2"});
    expect(guard.originals).toHaveLength(2);
    expect(Buffer.from(guard.originals[0].data_base64, "base64").toString()).toBe("0");
    expect(guard.originals[1].representation).toBe("decoded_http_body");
    expect(guard.originals[1].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(guard.originals[1].request.parameters).toEqual(request);
  });
  it.each(["1", "-1", '"0"', '{"total_cost":0}', "null", "false", "NaN", "[]"])(
    "fails closed on cost response %s", async cost => {
      const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(cost));
      guard = installPlatformTransportGuard("db-fixture");
      await expect(new DataBentoHTTP("db-fixture").get("/v0/timeseries.get_range", {
        dataset: "GLBX.MDP3", symbols: "ES.c.0", schema: "trades", start: "2026-10-22"
      })).rejects.toThrow();
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(new URL(String(upstream.mock.calls[0][0])).pathname).toBe("/v0/metadata.get_cost");
    });
  it("denies unknown endpoints and never captures leaked credentials", async () => {
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("db-credential-fixture"));
    guard = installPlatformTransportGuard("db-credential-fixture");
    const http = new DataBentoHTTP("db-credential-fixture");
    await expect(http.get("https://attacker.test/collect", {})).rejects.toThrow();
    expect(upstream).not.toHaveBeenCalled();
    await expect(http.get("/v0/metadata.list_datasets", {})).rejects.toThrow();
    expect(guard.originals).toHaveLength(0);
  });
  it("cost failure does not reach data; successful metadata and symbology need no cost request", async () => {
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async url =>
      new Response(String(url).includes("symbology.resolve") ? '{"result":{}}' : "invalid cost response"));
    guard = installPlatformTransportGuard("db-fixture");
    const http = new DataBentoHTTP("db-fixture");
    await expect(http.get("/v0/timeseries.get_range", {dataset:"GLBX.MDP3", symbols:"ES.c.0",
      schema:"ohlcv-1d",start:"2026-01-01",end:"2026-01-02"})).rejects.toThrow();
    expect(upstream).toHaveBeenCalledTimes(1);
    await http.postForm("/v0/symbology.resolve", {dataset:"GLBX.MDP3",symbols:"ES.c.0"});
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(guard.originals).toHaveLength(1);
  });
  it("permits a positive estimate within a trusted lease and meters it before data", async () => {
    const calls:string[]=[];
    vi.spyOn(globalThis,"fetch").mockImplementation(async url=>{
      const endpoint=new URL(String(url)).pathname;
      calls.push(endpoint);
      if(endpoint.includes("get_cost"))return new Response("2.5");
      expect(guard!.costSummary().estimated_spent_usd).toBe(2.5);
      return new Response("ts_event,close\n1,2\n");
    });
    guard=installPlatformTransportGuard("db-fixture",{reservation_id:"a".repeat(32),allowance_usd:10});
    await new DataBentoHTTP("db-fixture").get("/v0/timeseries.get_range",{
      dataset:"GLBX.MDP3",symbols:"ES.c.0",schema:"trades",start:"2026-10-22"});
    expect(calls).toEqual(["/v0/metadata.get_cost","/v0/timeseries.get_range"]);
    expect(guard.costSummary()).toEqual({reservation_id:"a".repeat(32),estimated_spent_usd:2.5,
      approval_required:false,basis:"provider_estimate_after_plan_discounts"});
  });
  it("aggregates parallel sub-pulls against the entire invocation allowance",async()=>{
    const data:string[]=[];
    vi.spyOn(globalThis,"fetch").mockImplementation(async url=>{
      const parsed=new URL(String(url));
      if(parsed.pathname.includes("get_cost"))return new Response(parsed.searchParams.get("symbols")==="A"?"6":"5");
      data.push(parsed.searchParams.get("symbols")!);
      return new Response("x\n1\n");
    });
    guard=installPlatformTransportGuard("db-fixture",{reservation_id:"b".repeat(32),allowance_usd:10});
    const http=new DataBentoHTTP("db-fixture");
    const settled=await Promise.allSettled(["A","B"].map(symbols=>http.get("/v0/timeseries.get_range",{
      dataset:"GLBX.MDP3",symbols,schema:"trades",start:"2026-10-22"})));
    expect(settled.filter(item=>item.status==="fulfilled")).toHaveLength(1);
    expect(data).toHaveLength(1);
    expect(guard.costSummary()).toMatchObject({estimated_spent_usd:6,approval_required:true,required_allowance_usd:11});
    await expect(http.get("/v0/timeseries.get_range",{dataset:"GLBX.MDP3",symbols:"C",schema:"trades",start:"2026-10-22"})).rejects.toThrow();
    expect(data).toHaveLength(1);
  });
  it("retains a started estimate when provider data fails and never retries that download",async()=>{
    const upstream=vi.spyOn(globalThis,"fetch").mockImplementation(async url=>
      new Response(String(url).includes("get_cost")?"0.25":"provider error",{status:String(url).includes("get_cost")?200:500}));
    guard=installPlatformTransportGuard("db-fixture",{reservation_id:"c".repeat(32),allowance_usd:10});
    await expect(new DataBentoHTTP("db-fixture",{retryDelayMs:0}).get("/v0/timeseries.get_range",{
      dataset:"GLBX.MDP3",symbols:"ES.c.0",schema:"trades",start:"2026-10-22"})).rejects.toThrow();
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(guard.costSummary()).toMatchObject({estimated_spent_usd:0.25,approval_required:false});
  });
  it("rounds tiny estimates upward without allowing accumulated rounding bypass",async()=>{
    let data=0;
    vi.spyOn(globalThis,"fetch").mockImplementation(async url=>{
      if(String(url).includes("get_cost"))return new Response("0.0000001");
      data++;return new Response("x\n1\n");
    });
    guard=installPlatformTransportGuard("db-fixture",{reservation_id:"d".repeat(32),allowance_usd:0.000001});
    const http=new DataBentoHTTP("db-fixture");
    const request={dataset:"GLBX.MDP3",symbols:"A",schema:"trades",start:"2026-10-22"};
    await http.get("/v0/timeseries.get_range",request);
    await expect(http.get("/v0/timeseries.get_range",request)).rejects.toThrow();
    expect(data).toBe(1);
    expect(guard.costSummary()).toMatchObject({estimated_spent_usd:0.000001,approval_required:true});
  });

  it("rejects an unsupported million-dollar estimate without claiming approval or starting data",async()=>{
    const upstream=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response("1000000.000001"));
    guard=installPlatformTransportGuard("db-fixture",{reservation_id:"e".repeat(32),allowance_usd:10});
    await expect(new DataBentoHTTP("db-fixture").get("/v0/timeseries.get_range",{
      dataset:"GLBX.MDP3",symbols:"ES",schema:"trades",start:"2026-10-22"})).rejects.toThrow();
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(guard.costSummary()).toEqual({reservation_id:"e".repeat(32),estimated_spent_usd:0,
      approval_required:false,basis:"provider_estimate_after_plan_discounts"});
  });

});
