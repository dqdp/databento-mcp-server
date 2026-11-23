import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataBentoHTTP } from "../../../src/http/databento-http.js";
import { installPlatformTransportGuard } from "../../../src/api/platform-transport.js";

let guard:ReturnType<typeof installPlatformTransportGuard>|undefined;
afterEach(()=>{guard?.restore();guard=undefined;vi.restoreAllMocks();});

function chunked(total:number,chunkBytes:number,first?:Uint8Array){
  let count=0;
  const cancelled=vi.fn();
  const stream=new ReadableStream<Uint8Array>({
    pull(controller){
      if(count===total){controller.close();return;}
      controller.enqueue(count===0&&first?first:new Uint8Array(chunkBytes).fill(97));
      count++;
    },cancel:cancelled
  },{highWaterMark:0});
  return {stream,cancelled,produced:()=>count};
}
function client(){return new DataBentoHTTP("db-bytes-fixture",{retryDelayMs:0});}

describe("platform exact decoded HTTP body and streaming budgets",()=>{
  it("preserves BOM bytes and hash while returning the same BOM-stripped UTF-8 text",async()=>{
    const original=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from('["GLBX.MDP3"]')]);
    vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(original));
    guard=installPlatformTransportGuard("db-bytes-fixture");
    expect(await client().get("/v0/metadata.list_datasets")).toBe('["GLBX.MDP3"]');
    expect(Buffer.from(guard.originals[0].data_base64,"base64")).toEqual(original);
    expect(guard.originals[0].sha256).toBe(createHash("sha256").update(original).digest("hex"));
  });
  it("rejects invalid UTF-8, cancels remaining chunks and does not retry or save lossy originals",async()=>{
    const source=chunked(12,1024,new Uint8Array([0xc3,0x28]));
    const fetch=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(source.stream));
    guard=installPlatformTransportGuard("db-bytes-fixture");
    await expect(client().get("/v0/metadata.list_datasets")).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(source.cancelled).toHaveBeenCalled();
    expect(source.produced()).toBeLessThan(12);
    expect(guard.originals).toEqual([]);
  });
  it("cancels an oversized chunked response before consuming the full download",async()=>{
    const source=chunked(64,512*1024);
    const fetch=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(source.stream));
    guard=installPlatformTransportGuard("db-bytes-fixture");
    await expect(client().get("/v0/metadata.list_datasets")).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(source.cancelled).toHaveBeenCalled();
    expect(source.produced()).toBeLessThan(64);
    expect(guard.originals).toEqual([]);
  });
  it("shares the byte budget across responses, cancelling only the excess response",async()=>{
    const second=chunked(8,512*1024);
    const fetch=vi.spyOn(globalThis,"fetch")
      .mockResolvedValueOnce(new Response("a".repeat(15*1024*1024)))
      .mockResolvedValueOnce(new Response(second.stream));
    guard=installPlatformTransportGuard("db-bytes-fixture");
    await client().get("/v0/metadata.list_datasets");
    await expect(client().get("/v0/metadata.list_schemas",{dataset:"GLBX.MDP3"})).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(second.cancelled).toHaveBeenCalled();
    expect(second.produced()).toBeLessThan(8);
    expect(guard.originals).toHaveLength(1);
  });
  it("limits provider error bodies and never retries a budget rejection",async()=>{
    const source=chunked(12,32*1024);
    const fetch=vi.spyOn(globalThis,"fetch").mockImplementation(async()=>new Response(source.stream,{status:500}));
    guard=installPlatformTransportGuard("db-bytes-fixture");
    await expect(client().get("/v0/metadata.list_datasets")).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(source.cancelled).toHaveBeenCalled();
    expect(source.produced()).toBeLessThan(12);
    expect(guard.originals).toEqual([]);
  });
  it("correlates parallel responses by invocation instead of a shared last buffer",async()=>{
    const a=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from('["A"]')]);
    const b=Buffer.from('["B"]');
    vi.spyOn(globalThis,"fetch").mockImplementation(async url=>{
      if(String(url).includes("list_datasets")){await new Promise(resolve=>setTimeout(resolve,5));return new Response(a);}
      return new Response(b);
    });
    guard=installPlatformTransportGuard("db-bytes-fixture");
    await Promise.all([client().get("/v0/metadata.list_datasets"),client().get("/v0/metadata.list_schemas",{dataset:"GLBX.MDP3"})]);
    const map=new Map(guard.originals.map(item=>[item.request.endpoint,Buffer.from(item.data_base64,"base64")]));
    expect(map.get("/v0/metadata.list_datasets")).toEqual(a);
    expect(map.get("/v0/metadata.list_schemas")).toEqual(b);
  });
});
