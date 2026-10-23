#!/usr/bin/env node
/** Private connector RPC. The sole external MCP and OAuth boundary is the platform Gateway. */
import {createHash,createHmac,timingSafeEqual} from "node:crypto";
import {spawn} from "node:child_process";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import http,{type Server as HttpServer,type IncomingMessage,type ServerResponse} from "node:http";
import {tmpdir} from "node:os";
import path from "node:path";
import type {AddressInfo} from "node:net";
import {listPlatformTools,type PlatformCall} from "./platform-contract.js";
import type {PlatformOriginal} from "../src/api/platform-transport.js";
import type {CallToolResult} from "@modelcontextprotocol/sdk/types.js";

export {listPlatformTools} from "./platform-contract.js";
const BODY_LIMIT=2*1024*1024;
const RESPONSE_LIMIT=48*1024*1024;
const DEADLINE=120000;
const MAX_CONCURRENT=4;
export interface PlatformReply {result:CallToolResult;originals:PlatformOriginal[]}
export interface PlatformClaims {sub:string;workspace:string;permission:string}
export interface StartedPlatformServer {server:HttpServer;url:string;close:()=>Promise<void>}

export function verifyPlatformToken(token:string,key:Buffer,body:Buffer,permission:string):PlatformClaims {
  try{
    if(!Buffer.isBuffer(key)||key.length!==32||typeof token!=="string"||token.length>8192) throw new Error();
    const parts=token.split(".");
    if(parts.length!==3||parts.some(part=>!part||!/^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
    const header=JSON.parse(Buffer.from(parts[0],"base64url").toString("utf8"));
    if(header.alg!=="HS256"||Object.keys(header).some(k=>!["alg","typ"].includes(k))||
      (header.typ!==undefined&&header.typ!=="JWT")) throw new Error();
    const expected=createHmac("sha256",key).update(parts[0]+"."+parts[1]).digest();
    const signature=Buffer.from(parts[2],"base64url");
    if(signature.length!==expected.length||!timingSafeEqual(signature,expected)) throw new Error();
    const claims=JSON.parse(Buffer.from(parts[1],"base64url").toString("utf8"));
    const now=Math.floor(Date.now()/1000);
    const digest=createHash("sha256").update(body).digest("hex");
    if(claims.iss!=="mcp-gateway"||claims.aud!=="databento-connector"||
      typeof claims.sub!=="string"||claims.sub.length<1||claims.sub.length>255||
      typeof claims.workspace!=="string"||!/^[a-f0-9]{32}$/.test(claims.workspace)||
      !Number.isSafeInteger(claims.iat)||!Number.isSafeInteger(claims.exp)||
      claims.iat>now||claims.exp<=now||claims.exp<=claims.iat||claims.exp-claims.iat>120||
      claims.permission!==permission||typeof claims.request_sha256!=="string"||
      claims.request_sha256.length!==digest.length||
      !timingSafeEqual(Buffer.from(claims.request_sha256),Buffer.from(digest))) throw new Error();
    return {sub:claims.sub,workspace:claims.workspace,permission:claims.permission};
  }catch{throw new Error("Unauthorized");}
}

export function sanitizedWorkerEnvironment(directory:string):NodeJS.ProcessEnv {
  return {HOME:directory,XDG_CACHE_HOME:path.join(directory,"cache"),TMPDIR:directory,
    NODE_ENV:"production",TZ:"UTC",LANG:"C.UTF-8"};
}

export async function runIsolatedPlatformWorker(input:PlatformCall,signal:AbortSignal):Promise<PlatformReply>{
  const directory=await mkdtemp(path.join(tmpdir(),"databento-platform-"));
  const source=path.extname(__filename)===".ts";
  const script=path.join(__dirname,"platform-worker."+(source?"ts":"js"));
  const args=source?["--import",require.resolve("tsx"),"--max-old-space-size=384",script]:["--max-old-space-size=384",script];
  try{
    return await new Promise<PlatformReply>((resolve,reject)=>{
      const child=spawn(process.execPath,args,{env:sanitizedWorkerEnvironment(directory),cwd:directory,
        stdio:["pipe","pipe","pipe"],shell:false});
      const output:Buffer[]=[];
      let size=0,settled=false;
      const stop=()=>{child.kill("SIGKILL");};
      signal.addEventListener("abort",stop,{once:true});
      if(signal.aborted)stop();
      child.stderr.on("data",()=>{}); // Provider or legacy diagnostics are private and never forwarded.
      child.stdout.on("data",(part:Buffer)=>{
        size+=part.length;
        if(size>RESPONSE_LIMIT)stop();else output.push(part);
      });
      child.stdin.on("error",()=>{});
      child.on("error",()=>{settled=true;reject(new Error("Worker failed"));});
      child.on("close",(code)=>{
        signal.removeEventListener("abort",stop);
        if(settled)return;
        if(signal.aborted||code!==0||size>RESPONSE_LIMIT){reject(new Error("Worker failed"));return;}
        try{
          const reply=JSON.parse(Buffer.concat(output).toString("utf8")) as PlatformReply;
          if(!reply||typeof reply.result!=="object"||!Array.isArray(reply.originals))throw new Error();
          resolve(reply);
        }catch{reject(new Error("Worker failed"));}
      });
      child.stdin.end(JSON.stringify(input));
    });
  }finally{await rm(directory,{recursive:true,force:true});}
}

async function bodyBytes(request:IncomingMessage):Promise<Buffer>{
  const chunks:Buffer[]=[];let length=0;
  for await(const item of request){
    const chunk=Buffer.isBuffer(item)?item:Buffer.from(item);
    length+=chunk.length;if(length>BODY_LIMIT)throw new Error("Too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function send(response:ServerResponse,status:number,payload:unknown){
  if(response.destroyed)return;
  const encoded=Buffer.from(JSON.stringify(payload));
  if(encoded.length>RESPONSE_LIMIT){response.writeHead(502,{"content-type":"application/json","cache-control":"no-store"});response.end('{"error":"operation_failed"}');return;}
  response.writeHead(status,{"content-type":"application/json","cache-control":"no-store","x-content-type-options":"nosniff"});
  response.end(encoded);
}

export async function startPlatformHttpServer(options:{
  signingKey:Buffer;host?:string;port?:number;
  worker?:(input:PlatformCall,signal:AbortSignal)=>Promise<PlatformReply>;
}):Promise<StartedPlatformServer>{
  if(!Buffer.isBuffer(options.signingKey)||options.signingKey.length!==32)throw new Error("A separate 32-byte signing key is required");
  const key=Buffer.from(options.signingKey),worker=options.worker??runIsolatedPlatformWorker;
  const enabled=new Set(listPlatformTools().map(tool=>tool.name));
  let active=0;
  const controllers=new Set<AbortController>();
  const server=http.createServer(async(request,response)=>{
    const route=request.url?.split("?")[0];
    if(route==="/healthz"&&request.method==="GET"){send(response,200,{status:"ok",service:"databento-connector"});return;}
    if(!["/v1/tools","/v1/call"].includes(route??"")){send(response,404,{error:"not_found"});return;}
    if(request.method!=="POST"){send(response,405,{error:"method_not_allowed"});return;}
    const auth=request.headers.authorization;
    if(typeof auth!=="string"||!auth.startsWith("Bearer ")){send(response,401,{error:"unauthorized"});return;}
    const declared=request.headers["content-length"];
    if(declared!==undefined&&(!/^\d+$/.test(declared)||Number(declared)>BODY_LIMIT)){send(response,413,{error:"request_too_large"});return;}
    if(request.headers["content-type"]?.split(";")[0].trim().toLowerCase()!=="application/json"){send(response,415,{error:"unsupported_media_type"});return;}
    let body:Buffer,payload:Record<string,unknown>;
    try{body=await bodyBytes(request);payload=JSON.parse(body.toString("utf8"));}
    catch{send(response,400,{error:"invalid_request"});return;}
    if(!payload||typeof payload!=="object"||Array.isArray(payload)){send(response,400,{error:"invalid_request"});return;}
    const permission=route==="/v1/tools"?"tools:list":payload.name;
    if(typeof permission!=="string"){send(response,400,{error:"invalid_request"});return;}
    try{verifyPlatformToken(auth.slice(7),key,body,permission);}catch{send(response,401,{error:"unauthorized"});return;}
    if(route==="/v1/tools"){
      if(Object.keys(payload).length){send(response,400,{error:"invalid_request"});return;}
      send(response,200,{tools:listPlatformTools()});return;
    }
    if(!enabled.has(permission)){send(response,403,{error:"operation_not_allowed"});return;}
    if(Object.keys(payload).some(k=>!["name","arguments","api_key"].includes(k))||
      !payload.arguments||typeof payload.arguments!=="object"||Array.isArray(payload.arguments)||
      (payload.api_key!==undefined&&(typeof payload.api_key!=="string"||payload.api_key.length>8192||!payload.api_key.startsWith("db-")))||
      (permission!=="get_session_info"&&payload.api_key===undefined)){
      send(response,400,{error:"invalid_request"});return;
    }
    if(active>=MAX_CONCURRENT){send(response,429,{error:"busy"});return;}
    active++;
    const controller=new AbortController();controllers.add(controller);
    const timer=setTimeout(()=>controller.abort(),DEADLINE);
    const abort=()=>{if(!response.writableEnded)controller.abort();};
    response.on("close",abort);
    try{
      const reply=await worker(payload as unknown as PlatformCall,controller.signal);
      if(controller.signal.aborted)send(response,504,{error:"operation_failed"});
      else send(response,200,reply);
    }catch{send(response,502,{error:"operation_failed"});}
    finally{clearTimeout(timer);response.off("close",abort);controllers.delete(controller);active--;}
  });
  server.requestTimeout=DEADLINE;server.headersTimeout=15000;
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(options.port??8002,options.host??"127.0.0.1",()=>{server.off("error",reject);resolve();});});
  const address=server.address() as AddressInfo;
  return {server,url:`http://${options.host??"127.0.0.1"}:${address.port}`,close:async()=>{
    for(const controller of controllers)controller.abort();
    await new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeIdleConnections();});
  }};
}

async function main(){
  const filename=process.env.DATABENTO_PLATFORM_SIGNING_KEY_FILE;
  if(!filename)throw new Error("Signing key file is required");
  const key=await readFile(filename);
  const rawPort=process.env.PORT??"8002";
  if(!/^\d+$/.test(rawPort)||Number(rawPort)>65535)throw new Error("Invalid port");
  const started=await startPlatformHttpServer({signingKey:key,host:process.env.HOST??"127.0.0.1",port:Number(rawPort)});
  for(const signal of ["SIGINT","SIGTERM"] as const)process.once(signal,()=>{void started.close().finally(()=>process.exit(0));});
}
if(require.main===module)main().catch(()=>{process.stderr.write("Databento platform startup failed\n");process.exit(1);});
