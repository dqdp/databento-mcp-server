import { existsSync } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { REMOTE_BATCH_TOOL_NAMES } from "../mcp/index.js";

const projectRoot = process.cwd();
const entrypoint = path.join(projectRoot, "dist/mcp/mcp/http.js");
const apiKey = process.env.DATABENTO_API_KEY || "db-test-key";
const authToken = process.env.MCP_REMOTE_AUTH_TOKEN || "ci-http-smoke-token";
const startupTimeoutMs = 10_000;

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

function waitForServerUrl(
  child: ChildProcessWithoutNullStreams,
  stderrChunks: Buffer[],
  stdoutChunks: Buffer[]
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for HTTP smoke server to start after ${startupTimeoutMs}ms`));
    }, startupTimeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
    }

    function currentOutput() {
      return Buffer.concat(stderrChunks).toString("utf8");
    }

    function parseServerUrl(output: string): string | undefined {
      const legacyMatch = output.match(/listening at (http:\/\/\S+)/);
      if (legacyMatch) {
        return legacyMatch[1];
      }

      for (const line of output.split(/\r?\n/)) {
        if (!line.trim()) {
          continue;
        }

        try {
          const parsed = JSON.parse(line) as { event?: string; url?: string };
          if (parsed.event === "remote_server_started" && parsed.url) {
            return parsed.url;
          }
        } catch {
          // Ignore non-JSON stderr from dependencies and keep waiting.
        }
      }

      return undefined;
    }

    function onData() {
      const url = parseServerUrl(currentOutput());
      if (url) {
        cleanup();
        resolve(url);
      }
    }

    function onExit(code: number | null, signal: NodeJS.Signals | null) {
      cleanup();
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      reject(
        new Error(
          `HTTP smoke server exited before startup: code=${code} signal=${signal}${stderr ? `\nstderr: ${stderr}` : ""}${
            stdout ? `\nstdout: ${stdout}` : ""
          }`
        )
      );
    }

    function onError(error: Error) {
      cleanup();
      reject(error);
    }

    child.stderr.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
    onData();
  });
}

async function terminate(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    wait(1000).then(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }),
  ]);
}

async function assertUnauthenticatedRequestsFail(url: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: {
          name: "databento-http-smoke-raw",
          version: "1.0.0",
        },
      },
    }),
  });

  if (response.status !== 401) {
    throw new Error(`Expected unauthenticated HTTP request to fail with 401, got ${response.status}`);
  }

  const payload = await response.json();
  if (payload.error !== "unauthorized") {
    throw new Error(`Expected unauthorized error body, got ${JSON.stringify(payload)}`);
  }
}

async function main() {
  if (!existsSync(entrypoint)) {
    throw new Error(`Missing built MCP HTTP entrypoint at ${entrypoint}. Run npm run build:mcp first.`);
  }

  const child = spawn(process.execPath, [entrypoint], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DATABENTO_API_KEY: apiKey,
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: "0",
      MCP_ALLOWED_HOSTS: "127.0.0.1",
      MCP_ALLOWED_ORIGINS: "http://localhost:3000,http://127.0.0.1:3000",
      MCP_REMOTE_AUTH_TOKEN: authToken,
      MCP_REMOTE_ENABLE_BATCH: "false",
      TRUST_PROXY: "false",
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

  const client = new Client({
    name: "databento-mcp-http-smoke",
    version: "1.0.0",
  });
  let transport: StreamableHTTPClientTransport | undefined;

  try {
    const url = await waitForServerUrl(child, stderrChunks, stdoutChunks);

    await assertUnauthenticatedRequestsFail(url);

    transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      },
    });
    await client.connect(transport);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    if (!toolNames.includes("get_session_info")) {
      throw new Error("Expected get_session_info tool to be registered over HTTP");
    }

    for (const batchToolName of REMOTE_BATCH_TOOL_NAMES) {
      if (toolNames.includes(batchToolName)) {
        throw new Error(`Remote HTTP smoke unexpectedly exposed batch tool ${batchToolName}`);
      }
    }

    const result = await client.callTool({ name: "get_session_info" });
    const content = Array.isArray(result.content) ? result.content : [];
    if (result.isError) {
      const text = content
        .map((item) => (isTextContent(item) ? item.text : JSON.stringify(item)))
        .join("\n");
      throw new Error(`get_session_info returned an MCP error over HTTP: ${text}`);
    }

    const firstContent = content[0];
    if (!isTextContent(firstContent)) {
      throw new Error("get_session_info did not return text content over HTTP");
    }

    const payload = JSON.parse(firstContent.text);
    for (const key of ["currentSession", "sessionStart", "sessionEnd", "timestamp", "utcHour"]) {
      if (!(key in payload)) {
        throw new Error(`get_session_info HTTP response is missing ${key}`);
      }
    }

    console.log("MCP Streamable HTTP smoke passed");
  } catch (error) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
    if (stderr) {
      console.error(stderr);
    }
    if (stdout) {
      console.error(stdout);
    }
    throw error;
  } finally {
    await client.close();
    await transport?.close();
    await terminate(child);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
