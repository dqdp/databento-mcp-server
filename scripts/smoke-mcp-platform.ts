/** Offline smoke of the compiled private entrypoint; never calls a Databento API. */
import assert from "node:assert/strict";
import {createHash,createHmac} from "node:crypto";
import {spawn} from "node:child_process";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import net from "node:net";

async function freePort():Promise<number>{
  const server=net.createServer();
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const port=(server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  return port;
}
function authorization(key:Buffer,body:string,permission:string){
  const now=Math.floor(Date.now()/1000);
  const head=Buffer.from(JSON.stringify({alg:"HS256",typ:"JWT"})).toString("base64url");
  const claims=Buffer.from(JSON.stringify({iss:"mcp-gateway",aud:"databento-connector",sub:"offline-smoke",
    workspace:"f".repeat(32),iat:now,exp:now+60,permission,
    request_sha256:createHash("sha256").update(body).digest("hex")})).toString("base64url");
  return "Bearer "+head+"."+claims+"."+createHmac("sha256",key).update(head+"."+claims).digest("base64url");
}
async function main(){
  const entry=path.resolve("dist/mcp/mcp/platform.js");
  await readFile(entry);
  const directory=await mkdtemp(path.join(tmpdir(),"databento-platform-smoke-"));
  const key=Buffer.alloc(32,19),filename=path.join(directory,"platform.key"),port=await freePort();
  await writeFile(filename,key,{mode:0o600});
  const child=spawn(process.execPath,[entry],{env:{HOST:"127.0.0.1",PORT:String(port),
    DATABENTO_PLATFORM_SIGNING_KEY_FILE:filename,HOME:directory},stdio:["ignore","ignore","ignore"]});
  const base="http://127.0.0.1:"+port;
  try{
    let ready=false;
    for(let attempt=0;attempt<100;attempt++){
      if(child.exitCode!==null)throw new Error("Platform process stopped");
      try{if((await fetch(base+"/healthz")).ok){ready=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.ok(ready,"private platform health");
    assert.equal((await fetch(base+"/v1/tools",{method:"POST",body:"{}"})).status,401);
    const list=await fetch(base+"/v1/tools",{method:"POST",body:"{}",headers:{
      "content-type":"application/json",authorization:authorization(key,"{}","tools:list")}});
    assert.equal(list.status,200);
    const tools=await list.json() as {tools:{name:string}[]};
    assert.ok(tools.tools.some(tool=>tool.name==="get_session_info"));
    assert.ok(!tools.tools.some(tool=>tool.name==="batch_submit_job"));
    const body=JSON.stringify({name:"get_session_info",arguments:{timestamp:"2026-10-23T12:00:00Z"}});
    const result=await fetch(base+"/v1/call",{method:"POST",body,headers:{
      "content-type":"application/json",authorization:authorization(key,body,"get_session_info")}});
    assert.equal(result.status,200);
    const reply=await result.json() as {result:{content:{text:string}[];isError?:boolean};originals:unknown[]};
    assert.notEqual(reply.result.isError,true);
    assert.equal(JSON.parse(reply.result.content[0].text).utcHour,12);
    assert.deepEqual(reply.originals,[]);
    process.stdout.write("Private platform compiled entrypoint offline smoke: PASS\n");
  }finally{
    child.kill("SIGTERM");
    await new Promise<void>(resolve=>{if(child.exitCode!==null)resolve();else child.once("close",()=>resolve());});
    await rm(directory,{recursive:true,force:true});
  }
}
main().catch(()=>{process.stderr.write("Private platform offline smoke failed\n");process.exitCode=1;});
