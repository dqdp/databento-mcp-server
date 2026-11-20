import { createHash, createHmac } from "node:crypto";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startPlatformHttpServer, verifyPlatformToken, type StartedPlatformServer } from "../../mcp/platform.js";

const key = Buffer.alloc(32, 7);
function token(body: Buffer, permission: string, extra: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now()/1000);
  const header = Buffer.from(JSON.stringify({alg:"HS256",typ:"JWT"})).toString("base64url");
  const claims = Buffer.from(JSON.stringify({iss:"mcp-gateway",aud:"databento-connector",sub:"user-a",
    workspace:"a".repeat(32),iat:now,exp:now+60,permission,
    request_sha256:createHash("sha256").update(body).digest("hex"), ...extra})).toString("base64url");
  const signature=createHmac("sha256",key).update(header+"."+claims).digest("base64url");
  return header+"."+claims+"."+signature;
}
let started: StartedPlatformServer | undefined;
const stateDirectories:string[]=[];
async function stateDirectory(){const directory=await mkdtemp(path.join(tmpdir(),"db-cost-test-"));stateDirectories.push(directory);return directory;}
function summary(reservation_id:string,estimated_spent_usd=0){return {reservation_id,estimated_spent_usd,approval_required:false,basis:"provider_estimate_after_plan_discounts" as const};}
async function call(url:string,input:unknown){const body=Buffer.from(JSON.stringify(input));return fetch(url+"/v1/call",{method:"POST",body,headers:{authorization:"Bearer "+token(body,(input as {name:string}).name),"content-type":"application/json"}});}
afterEach(async()=>{ await started?.close(); started=undefined; await Promise.all(stateDirectories.splice(0).map(directory=>rm(directory,{recursive:true,force:true}))); });

describe("private Databento platform authentication",()=>{
  it("authenticates subscription bytes, rejects wrong keys/nonhistorical tools, and passes only the bound assertion",async()=>{
    const api_key="db-subscription-fixture";
    const subscription={plan:"cme_standard",policy_version:1,credential_sha256:createHash("sha256").update(api_key).digest("hex")};
    const worker=vi.fn(async()=>({result:{content:[]},originals:[],cost_summary:{
      reservation_id:null,estimated_spent_usd:0,approval_required:false,basis:"provider_estimate_after_plan_discounts" as const,
      subscription_covered_requests:1}}));
    started=await startPlatformHttpServer({signingKey:key,port:0,worker});
    const input={name:"timeseries_get_range",arguments:{},api_key,subscription};
    const response=await call(started.url,input);
    expect(response.status).toBe(200);
    expect(worker.mock.calls[0][0]).toEqual(input);
    expect((await response.json() as {cost_summary:{subscription_covered_requests:number}}).cost_summary.subscription_covered_requests).toBe(1);
    for(const change of [{api_key:"db-rotated"},{subscription:null},{subscription:{...subscription,policy_version:2}},
      {subscription:{...subscription,extra:true}},{name:"get_live_futures_quote"},{name:"metadata_get_cost"},{name:"get_session_info"}])
      expect((await call(started.url,{...input,...change})).status).toBe(400);
    const signed=Buffer.from(JSON.stringify(input));
    const changed=Buffer.from(signed.toString().replace('"policy_version":1','"policy_version":2'));
    expect((await fetch(started.url+"/v1/call",{method:"POST",body:changed,headers:{
      authorization:"Bearer "+token(signed,input.name),"content-type":"application/json"}})).status).toBe(401);
    expect(worker).toHaveBeenCalledTimes(1);
    expect((await call(started.url,{name:input.name,arguments:{},api_key})).status).toBe(502);
  });
  it("admits stream control while four ordinary calls occupy their slots", async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const worker = vi.fn(async () => {
      await hold;
      return {result: {content: []}, originals: []};
    });
    started = await startPlatformHttpServer({signingKey: key, port: 0, worker});
    const url = started.url;
    const ordinary = {name: "get_session_info", arguments: {}};
    const pending = Array.from({length: 4}, () => call(url, ordinary));
    try {
      await vi.waitFor(() => expect(worker).toHaveBeenCalledTimes(4));
      expect((await call(url, ordinary)).status).toBe(429);
      for (const action of ["read", "stop"]) {
        const response = await call(url, {name: "stream_bba", api_key: "db-test",
          credential_revision: "b".repeat(64), arguments: {action, stream_id: "a".repeat(32), ...(action === "read" ? {after: 0} : {})}});
        expect(response.status).toBe(200);
      }
    } finally {
      release();
      await Promise.all(pending);
    }
  });
  it("binds a trusted owner and exact operation to exact bytes",()=>{
    const body=Buffer.from('{"name":"get_session_info","arguments":{}}');
    const claims=verifyPlatformToken(token(body,"get_session_info"),key,body,"get_session_info");
    expect(claims.workspace).toBe("a".repeat(32));
    expect(()=>verifyPlatformToken(token(body,"get_session_info"),key,Buffer.from(body+" "),"get_session_info")).toThrow();
    expect(()=>verifyPlatformToken(token(body,"get_session_info"),key,body,"metadata_list_datasets")).toThrow();
    for(const extra of [{aud:"research-storage"},{iss:"other"},{exp:1},{iat:1,exp:9999999999},{workspace:"../other"},
      {request_sha256:"0".repeat(64)},{permission:["get_session_info"]}])
      expect(()=>verifyPlatformToken(token(body,"get_session_info",extra),key,body,"get_session_info")).toThrow();
  });
  it("tools list requires signed body, preserves native schemas and hides risky tools",async()=>{
    const worker=vi.fn();
    started=await startPlatformHttpServer({signingKey:key,port:0,worker});
    const body=Buffer.from("{}");
    expect((await fetch(started.url+"/v1/tools",{method:"POST",body})).status).toBe(401);
    const response=await fetch(started.url+"/v1/tools",{method:"POST",body,
      headers:{authorization:"Bearer "+token(body,"tools:list"),"content-type":"application/json"}});
    expect(response.status).toBe(200);
    const payload=await response.json() as {tools:{name:string,inputSchema:unknown}[]};
    const names=payload.tools.map(t=>t.name);
    expect(names).toContain("get_session_info");
    expect(names).toContain("timeseries_get_range");
    expect(names).not.toContain("batch_submit_job");
    expect(names).toContain("get_live_futures_quote");
    expect(names.some(name=>name.startsWith("reference_"))).toBe(false);
    expect(worker).not.toHaveBeenCalled();
  });
  it("validates caller scope and body before worker and returns generic failure",async()=>{
    const worker=vi.fn(async()=>{throw new Error("db-private-secret https://private.host/path");});
    started=await startPlatformHttpServer({signingKey:key,port:0,worker});
    const body=Buffer.from(JSON.stringify({name:"get_session_info",arguments:{}}));
    let response=await fetch(started.url+"/v1/call",{method:"POST",body,
      headers:{authorization:"Bearer "+token(body,"metadata_list_datasets"),"content-type":"application/json"}});
    expect(response.status).toBe(401); expect(worker).not.toHaveBeenCalled();
    response=await fetch(started.url+"/v1/call",{method:"POST",body,
      headers:{authorization:"Bearer "+token(body,"get_session_info"),"content-type":"application/json"}});
    expect(response.status).toBe(502);
    expect(await response.text()).not.toMatch(/private|secret/);
  });
  it("runs the actual isolated child MCP entrypoint offline and drops environment credentials",async()=>{
    process.env.DATABENTO_API_KEY="db-do-not-inherit";
    process.env.SMILE_WEB_PORT="29999";
    try{
      started=await startPlatformHttpServer({signingKey:key,port:0});
      const body=Buffer.from(JSON.stringify({name:"get_session_info",arguments:{timestamp:"2026-10-23T12:00:00Z"}}));
      const response=await fetch(started.url+"/v1/call",{method:"POST",body,
        headers:{authorization:"Bearer "+token(body,"get_session_info"),"content-type":"application/json"}});
      expect(response.status).toBe(200);
      const payload=await response.json() as {result:{content:{text:string}[],isError?:boolean},originals:unknown[]};
      expect(payload.result.isError).not.toBe(true);
      expect(JSON.parse(payload.result.content[0].text)).toHaveProperty("currentSession");
      expect(payload.originals).toEqual([]);
      const missing=Buffer.from(JSON.stringify({name:"metadata_list_datasets",arguments:{}}));
      const failure=await fetch(started.url+"/v1/call",{method:"POST",body:missing,
        headers:{authorization:"Bearer "+token(missing,"metadata_list_datasets"),"content-type":"application/json"}});
      expect(failure.status).toBe(400);
    }finally{delete process.env.DATABENTO_API_KEY; delete process.env.SMILE_WEB_PORT;}
  });
  it("claims each lease once before spawning, including concurrency and parent restart",async()=>{
    const stateDir=await stateDirectory();
    const reservation_id="a".repeat(32);
    const worker=vi.fn(async()=>({result:{content:[]},originals:[],cost_summary:summary(reservation_id,1)}));
    started=await startPlatformHttpServer({signingKey:key,port:0,stateDir,worker});
    const input={name:"get_session_info",arguments:{},cost_control:{reservation_id,allowance_usd:10}};
    const responses=await Promise.all([call(started.url,input),call(started.url,input)]);
    expect(responses.map(response=>response.status).sort()).toEqual([200,409]);
    expect(worker).toHaveBeenCalledTimes(1);
    await started.close();started=undefined;
    started=await startPlatformHttpServer({signingKey:key,port:0,stateDir,worker});
    expect((await call(started.url,input)).status).toBe(409);
    expect(worker).toHaveBeenCalledTimes(1);
  });
  it("does not release a lease when its worker failed",async()=>{
    const worker=vi.fn(async()=>{throw new Error("worker stopped");});
    const stateDir=await stateDirectory();
    started=await startPlatformHttpServer({signingKey:key,port:0,stateDir,worker});
    const input={name:"get_session_info",arguments:{},cost_control:{reservation_id:"b".repeat(32),allowance_usd:10}};
    expect((await call(started.url,input)).status).toBe(502);
    expect((await call(started.url,input)).status).toBe(409);
    expect(worker).toHaveBeenCalledTimes(1);
  });
  it("rejects grants without durable replay state before worker invocation",async()=>{
    const worker=vi.fn();
    started=await startPlatformHttpServer({signingKey:key,port:0,worker});
    const input={name:"get_session_info",arguments:{},cost_control:{reservation_id:"c".repeat(32),allowance_usd:0}};
    expect((await call(started.url,input)).status).toBe(503);
    expect(worker).not.toHaveBeenCalled();
  });
  it.each([-1,NaN,Infinity,11])("rejects invalid or over-allowance worker spent estimate %s",async spent=>{
    const stateDir=await stateDirectory();const reservation_id="d".repeat(32);
    const worker=vi.fn(async()=>({result:{content:[],isError:true},originals:[],cost_summary:summary(reservation_id,spent)}));
    started=await startPlatformHttpServer({signingKey:key,port:0,stateDir,worker});
    const response=await call(started.url,{name:"get_session_info",arguments:{},cost_control:{reservation_id,allowance_usd:10}});
    expect(response.status).toBe(502);
    expect(worker).toHaveBeenCalledTimes(1);
  });
  it("preserves a valid cost summary even when native result isError",async()=>{
    const stateDir=await stateDirectory();const reservation_id="e".repeat(32);
    const worker=vi.fn(async()=>({result:{content:[],isError:true},originals:[],cost_summary:summary(reservation_id,2)}));
    started=await startPlatformHttpServer({signingKey:key,port:0,stateDir,worker});
    const response=await call(started.url,{name:"get_session_info",arguments:{},cost_control:{reservation_id,allowance_usd:10}});
    expect(response.status).toBe(200);
    expect((await response.json() as {cost_summary:unknown}).cost_summary).toEqual(summary(reservation_id,2));
  });

  it("passes a trusted zero lease through the actual disposable child MCP",async()=>{
    const stateDir=await stateDirectory();const reservation_id="f".repeat(32);
    started=await startPlatformHttpServer({signingKey:key,port:0,stateDir});
    const response=await call(started.url,{name:"get_session_info",arguments:{timestamp:"2026-10-23T12:00:00Z"},
      cost_control:{reservation_id,allowance_usd:0}});
    expect(response.status).toBe(200);
    const reply=await response.json() as {cost_summary:unknown;result:{isError?:boolean}};
    expect(reply.result.isError).not.toBe(true);
    expect(reply.cost_summary).toEqual(summary(reservation_id));
  });
  it("requires the parent to authenticate exact lease bytes before worker execution",async()=>{
    const stateDir=await stateDirectory();const worker=vi.fn();
    started=await startPlatformHttpServer({signingKey:key,port:0,stateDir,worker});
    const signed=Buffer.from(JSON.stringify({name:"get_session_info",arguments:{},
      cost_control:{reservation_id:"1".repeat(32),allowance_usd:0}}));
    const changed=Buffer.from(signed.toString().replace('"allowance_usd":0','"allowance_usd":10'));
    const response=await fetch(started.url+"/v1/call",{method:"POST",body:changed,
      headers:{authorization:"Bearer "+token(signed,"get_session_info"),"content-type":"application/json"}});
    expect(response.status).toBe(401);expect(worker).not.toHaveBeenCalled();
  });
  it("fails closed before worker on malformed cost-control envelopes",async()=>{
    const stateDir=await stateDirectory();const worker=vi.fn();
    started=await startPlatformHttpServer({signingKey:key,port:0,stateDir,worker});
    for(const cost_control of [null,{reservation_id:"../escape",allowance_usd:10},
      {reservation_id:"2".repeat(32),allowance_usd:-1},{reservation_id:"2".repeat(32),allowance_usd:true},
      {reservation_id:"2".repeat(32),allowance_usd:10,admin:true}]){
      expect((await call(started.url,{name:"get_session_info",arguments:{},cost_control})).status).toBe(400);
    }
    expect(worker).not.toHaveBeenCalled();
  });

  it("does not accept historical leases or missing raw evidence for Live",async()=>{
    const worker=vi.fn(async()=>({result:{content:[]},originals:[],live_cost_status:{
      basis:"live_subscription_entitlement" as const,status:"not_estimated" as const,
      additional_cost_usd:null,historical_get_cost_applicable:false as const}}));
    started=await startPlatformHttpServer({signingKey:key,port:0,worker});
    const input={name:"get_live_futures_quote",arguments:{symbol:"ES"},api_key:"db-synthetic"};
    expect((await call(started.url,{...input,cost_control:{reservation_id:"9".repeat(32),allowance_usd:10}})).status).toBe(400);
    expect(worker).not.toHaveBeenCalled();
    expect((await call(started.url,input)).status).toBe(502);
    expect(worker).toHaveBeenCalledTimes(1);
  });

});
