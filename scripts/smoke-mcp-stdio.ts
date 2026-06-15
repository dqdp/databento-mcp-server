import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = process.cwd();
const entrypoint = path.join(projectRoot, "dist/mcp/mcp/index.js");
const apiKey = process.env.DATABENTO_API_KEY || "db-test-key";

type TextContent = {
  type: "text";
  text: string;
};

function isTextContent(content: unknown): content is TextContent {
  return (
    typeof content === "object" &&
    content !== null &&
    "type" in content &&
    (content as { type: unknown }).type === "text" &&
    "text" in content &&
    typeof (content as { text: unknown }).text === "string"
  );
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertNoStartupStdout() {
  const child = spawn(process.execPath, [entrypoint], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DATABENTO_API_KEY: apiKey,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  await wait(500);
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    wait(1000),
  ]);

  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  if (stdout.length > 0) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    throw new Error(
      `MCP stdio server wrote startup output to stdout: ${JSON.stringify(stdout)}${stderr ? `\nstderr: ${stderr}` : ""}`
    );
  }
}

async function main() {
  if (!existsSync(entrypoint)) {
    throw new Error(
      `Missing built MCP entrypoint at ${entrypoint}. Run npm run build:mcp first.`
    );
  }

  await assertNoStartupStdout();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint],
    cwd: projectRoot,
    env: {
      DATABENTO_API_KEY: apiKey,
    },
    stderr: "pipe",
  });

  const stderrChunks: Buffer[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  const client = new Client({
    name: "databento-mcp-stdio-smoke",
    version: "1.0.0",
  });

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    if (!toolNames.includes("get_session_info")) {
      throw new Error("Expected get_session_info tool to be registered");
    }

    const result = await client.callTool({ name: "get_session_info" });
    const content = Array.isArray(result.content) ? result.content : [];
    if (result.isError) {
      const text = content
        .map((item) => (isTextContent(item) ? item.text : JSON.stringify(item)))
        .join("\n");
      throw new Error(`get_session_info returned an MCP error: ${text}`);
    }

    const firstContent = content[0];
    if (!isTextContent(firstContent)) {
      throw new Error("get_session_info did not return text content");
    }

    const payload = JSON.parse(firstContent.text);
    for (const key of ["currentSession", "sessionStart", "sessionEnd", "timestamp", "utcHour"]) {
      if (!(key in payload)) {
        throw new Error(`get_session_info response is missing ${key}`);
      }
    }

    console.log("MCP stdio smoke passed");
  } catch (error) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    if (stderr) {
      console.error(stderr);
    }
    throw error;
  } finally {
    await client.close();
    await transport.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
