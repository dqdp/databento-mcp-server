/** One request per process: legacy module caches and provider clients never cross owners. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDatabentoMcpServer, createDefaultDatabentoMcpClients } from "./index.js";
import { listPlatformTools, PLATFORM_DISABLED_TOOLS, type PlatformCall } from "./platform-contract.js";
import { installPlatformTransportGuard } from "../src/api/platform-transport.js";
import { parseDatabentoToolArguments } from "./tool-contracts.js";

const GENERIC_RESULT = {content:[{type:"text" as const,text:JSON.stringify({error:"Databento operation failed"})}],isError:true};

export async function invokePlatformTool(input: PlatformCall) {
  if (!listPlatformTools().some(tool => tool.name === input.name)) throw new Error("Operation is not permitted");
  const parsed = parseDatabentoToolArguments(input.name, input.arguments);
  if (parsed.status !== "valid") return {result:GENERIC_RESULT, originals:[]};
  const apiKey = input.api_key ?? (input.name === "get_session_info" ? "db-offline-session-info" : undefined);
  if (typeof apiKey !== "string" || !apiKey.startsWith("db-")) throw new Error("An explicit provider credential is required");
  const guard = installPlatformTransportGuard(apiKey);
  const clients = createDefaultDatabentoMcpClients(apiKey);
  const server = createDatabentoMcpServer(clients,{disabledTools:PLATFORM_DISABLED_TOOLS});
  const client = new Client({name:"databento-platform-worker",version:"1.0.0"});
  const [clientTransport,serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({name:input.name, arguments:parsed.arguments});
    if (result.isError) return {result:GENERIC_RESULT, originals:[]};
    const encoded = JSON.stringify(result);
    if (encoded.includes(apiKey)) return {result:GENERIC_RESULT, originals:[]};
    return {result, originals:guard.originals};
  } finally {
    await client.close();
    await server.close();
    guard.restore();
  }
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
