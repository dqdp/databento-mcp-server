import { createHash, createHmac } from "node:crypto";
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
afterEach(async()=>{ await started?.close(); started=undefined; });

describe("private Databento platform authentication",()=>{
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
    expect(names).not.toContain("get_live_futures_quote");
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
});
