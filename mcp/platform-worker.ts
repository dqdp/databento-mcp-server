/** One request per process: legacy module caches and provider clients never cross owners. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDatabentoMcpServer, createDefaultDatabentoMcpClients } from "./index.js";
import { listPlatformTools, PLATFORM_DISABLED_TOOLS, type PlatformCall,validateCostControl,emptyCostSummary } from "./platform-contract.js";
import { installPlatformTransportGuard } from "../src/api/platform-transport.js";
import { parseDatabentoToolArguments } from "./tool-contracts.js";
import {withPlatformProviderPricing} from "../src/api/entitlement-policy.js";
import {withPlatformLiveCapture,LIVE_COST_STATUS,type PlatformLiveOriginal} from "../src/api/platform-live.js";
import {CallToolResultSchema,type CallToolResult} from "@modelcontextprotocol/sdk/types.js";
import type {PlatformOriginal} from "../src/api/platform-transport.js";

const GENERIC_RESULT = {content:[{type:"text" as const,text:JSON.stringify({error:"Databento operation failed"})}],isError:true};

export async function invokePlatformTool(input: PlatformCall) {
  if (!listPlatformTools().some(tool => tool.name === input.name)) throw new Error("Operation is not permitted");
  const live=input.name==="get_live_futures_quote";
  if(live&&input.cost_control!==undefined)throw new Error("Historical cost control is not applicable to Live");
  const control=validateCostControl(input.cost_control);
  const rawLive:PlatformLiveOriginal[]=[];
  function report(result:CallToolResult,originals:PlatformOriginal[],costSummary=emptyCostSummary(control)){
    return live?{result,originals,live_cost_status:LIVE_COST_STATUS}:
      {result,originals,cost_summary:costSummary};
  }
  return withPlatformLiveCapture(rawLive,()=>withPlatformProviderPricing(async()=>{
    const parsed = parseDatabentoToolArguments(input.name, input.arguments);
    if (parsed.status !== "valid") return report(GENERIC_RESULT,[]);
    const apiKey = input.api_key ?? (input.name === "get_session_info" ? "db-offline-session-info" : undefined);
    if (typeof apiKey !== "string" || !apiKey.startsWith("db-")) throw new Error("An explicit provider credential is required");
    const guard = installPlatformTransportGuard(apiKey,control);
    const clients = createDefaultDatabentoMcpClients(apiKey);
    const server = createDatabentoMcpServer(clients,{disabledTools:PLATFORM_DISABLED_TOOLS});
    const client = new Client({name:"databento-platform-worker",version:"1.0.0"});
    const [clientTransport,serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = CallToolResultSchema.parse(await client.callTool({name:input.name, arguments:parsed.arguments}));
      if (result.isError) return report(GENERIC_RESULT,[],guard.costSummary());
      const originals=[...guard.originals,...rawLive];
      const encoded = JSON.stringify({result,originals});
      if (encoded.includes(apiKey)) return report(GENERIC_RESULT,[],guard.costSummary());
      return report(result,originals,guard.costSummary());
    } catch {
      return report(GENERIC_RESULT,[],guard.costSummary());
    } finally {
      try{await client.close();}finally{try{await server.close();}finally{guard.restore();}}
    }
  }));
}

async function main() {
  const pieces: Buffer[] = [];
  let size = 0;
  for await (const piece of process.stdin) {
    const value = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
    size += value.length;
    if (size > 2 * 1024 * 1024) throw new Error("Invalid request");
    pieces.push(value);
  }
  const input = JSON.parse(Buffer.concat(pieces).toString("utf8")) as PlatformCall;
  const result = await invokePlatformTool(input);
  process.stdout.write(JSON.stringify(result), () => process.exit(0));
}
if (require.main === module) {
  main().catch(() => { process.stdout.write(JSON.stringify({error:"operation_failed"}),()=>process.exit(1)); });
}
