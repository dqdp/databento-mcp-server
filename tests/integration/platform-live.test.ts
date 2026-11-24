import {createHash} from "node:crypto";
import net from "node:net";
import {afterEach,describe,expect,it,vi} from "vitest";
import {invokePlatformTool} from "../../mcp/platform-worker.js";
import {computeDatabentoCramResponse} from "../../src/api/live-client.js";

const NOW=Date.parse("2026-11-17T14:00:05.000Z");
const EVENT_NS=BigInt(NOW-65_000)*1_000_000n+123_456n;
const RECEIVE_NS=EVENT_NS+100_000n;
function dbnBytes(consolidated: boolean){
  const metadata=Buffer.alloc(128);metadata.write("DBN");metadata[3]=3;metadata.writeUInt32LE(120,4);
  const mapping=Buffer.alloc(20);mapping[0]=5;mapping[1]=22;
  const quote=Buffer.alloc(80);quote[0]=20;quote[1]=1;quote.writeUInt32LE(12345,4);
  quote.writeBigUInt64LE(EVENT_NS,8);quote.writeBigUInt64LE(RECEIVE_NS,32);
  quote.writeBigInt64LE(4500250000000n,48);quote.writeBigInt64LE(4500500000000n,56);
  quote.writeUInt32LE(10,64);quote.writeUInt32LE(12,68);
  quote.writeUInt32LE(3,72);quote.writeUInt32LE(4,76);
  if (consolidated) {
    const wrongType = Buffer.from(quote);
    wrongType.writeUInt32LE(999, 4);
    quote[1] = 0xb1;
    quote.writeUInt16LE(281, 72);
    quote.writeUInt16LE(289, 76);
    // Reserved bytes after each publisher ID must not be included in its value.
    quote.writeUInt16LE(0xfefd, 74);
    quote.writeUInt16LE(0xfcfb, 78);
    const oneSided = Buffer.from(quote);
    oneSided.writeBigInt64LE(0x7fffffffffffffffn, 56);
    return Buffer.concat([metadata, mapping, wrongType, oneSided, quote]);
  }
  return Buffer.concat([metadata,mapping,quote]);
}
let server:net.Server|undefined;
const sockets=new Set<net.Socket>();
afterEach(async()=>{
  vi.restoreAllMocks();
  for(const socket of sockets)socket.destroy();sockets.clear();
  if(server){await new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));server=undefined;}
});

describe("platform bounded Live TCP through actual native MCP",()=>{
  it("reports a quiet feed as a market-data timeout without exposing provider messages",async()=>{
    server=net.createServer(socket=>{
      sockets.add(socket); socket.on("error",()=>{}); socket.on("close",()=>sockets.delete(socket));
    });
    await new Promise<void>(resolve=>server!.listen(0,"127.0.0.1",resolve));
    const port=(server.address() as net.AddressInfo).port;
    const connect=net.createConnection.bind(net);
    vi.spyOn(net,"createConnection").mockImplementation((()=>connect({host:"127.0.0.1",port})) as typeof net.createConnection);
    const reply=await invokePlatformTool({name:"get_live_futures_quote",arguments:{symbol:"ES",timeout_ms:25},api_key:"db-fixture"});
    expect(JSON.parse((reply.result.content[0] as {text:string}).text)).toEqual({
      error:"Databento operation failed",error_code:"timeout",phase:"market_data"});
  });
  it.each([
    {dataset: "GLBX.MDP3", host: "glbx-mdp3", symbol: "ES", liveSymbol: "ES.v.0", stype: "continuous", schema: "mbp-1"},
    {dataset: "OPRA.PILLAR", host: "opra-pillar", symbol: "SPX   261218P05425000", liveSymbol: "SPX   261218P05425000", stype: "raw_symbol", schema: "cmbp-1"},
  ])("selects $schema for $dataset, preserves its DBN and avoids historical calls", async ({dataset, host, symbol, liveSymbol, stype, schema}) => {
    const providerBytes=dbnBytes(schema === "cmbp-1"),commands:string[]=[];
    server=net.createServer(socket=>{
      sockets.add(socket);socket.on("close",()=>sockets.delete(socket));
      socket.on("error",()=>{});socket.write("lsg_version=1.0.0\ncram=synthetic-challenge\n");
      let buffer="",streamed=false;
      socket.on("data",chunk=>{
        buffer+=chunk.toString("utf8");
        while(buffer.includes("\n")){
          const end=buffer.indexOf("\n"),line=buffer.slice(0,end);buffer=buffer.slice(end+1);commands.push(line);
          if(line.startsWith("auth="))socket.write("success=1|session_id=synthetic-session\n");
          if(line==="start_session=0"&&!streamed){streamed=true;socket.write(providerBytes.subarray(0,5));socket.write(providerBytes.subarray(5));}
        }
      });
    });
    await new Promise<void>(resolve=>server!.listen(0,"127.0.0.1",resolve));
    const address=server.address() as net.AddressInfo;
    const connect=net.createConnection.bind(net),hosts:unknown[]=[];
    vi.spyOn(net,"createConnection").mockImplementation(((options:net.NetConnectOpts)=>{
      hosts.push(options);return connect({host:"127.0.0.1",port:address.port});
    }) as typeof net.createConnection);
    vi.spyOn(Date,"now").mockReturnValue(NOW);
    const historical=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("Unexpected HTTP call"));
    const args = dataset === "GLBX.MDP3" ? {symbol, timeout_ms: 2000} : {symbol, dataset, timeout_ms: 2000};
    const reply=await invokePlatformTool({name:"get_live_futures_quote",arguments:args,api_key:"db-synthetic-live-owner"});
    expect(reply.result.isError).not.toBe(true);
    const result=JSON.parse((reply.result.content[0] as {text:string}).text);
    expect(hosts).toEqual([{host:host+".lsg.databento.com",port:13000}]);
    expect(commands).toContain("auth="+computeDatabentoCramResponse("synthetic-challenge","db-synthetic-live-owner")+
      "|dataset="+dataset+"|encoding=dbn|ts_out=0|compression=none|client=databento-mcp-server");
    expect(commands).toContain("schema="+schema+"|stype_in="+stype+"|symbols="+liveSymbol+"|id=0|is_last=1");
    expect(result).toMatchObject({symbol,liveSymbol,dataset,schema,instrumentId:12345,bid:4500.25,ask:4500.5,bidSize:10,askSize:12,
      timestampNs:EVENT_NS.toString(),receiveTimestampNs:RECEIVE_NS.toString(),receivedAt:new Date(NOW).toISOString(),
      freshness:{status:"not_asserted",latest_confirmed:false,event_age_ms:65000,event_timestamp_in_future:false,crossed_market:false}});
    if (schema === "cmbp-1") {
      expect(result).toMatchObject({bidCount: null, askCount: null, bidPublisherId: 281, askPublisherId: 289});
    } else {
      expect(result).toMatchObject({bidCount: 3, askCount: 4});
    }
    expect(reply).not.toHaveProperty("cost_summary");
    expect(reply).toHaveProperty("live_cost_status",{basis:"live_subscription_entitlement",status:"not_estimated",
      additional_cost_usd:null,historical_get_cost_applicable:false});
    expect(historical).not.toHaveBeenCalled();
    expect(reply.originals).toHaveLength(1);
    expect(reply.originals[0]).toMatchObject({representation:"raw_live_dbn",media_type:"application/octet-stream",
      sha256:createHash("sha256").update(providerBytes).digest("hex"),request:{endpoint:"live.subscribe",parameters:{
        dataset,schema,symbols:liveSymbol,stype_in:stype}}});
    expect(Buffer.from(reply.originals[0].data_base64,"base64")).toEqual(providerBytes);
    expect(Buffer.from(reply.originals[0].data_base64,"base64").includes(Buffer.from("auth="))).toBe(false);
    expect(JSON.stringify(reply)).not.toContain("db-synthetic-live-owner");
  });
});
