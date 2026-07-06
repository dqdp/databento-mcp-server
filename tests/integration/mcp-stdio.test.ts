import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = path.resolve(__dirname, "../..");
// Resolve tsx's CLI via Node module resolution (walks up to the nearest node_modules) rather than
// assuming it sits under this checkout's own node_modules: in a git worktree the deps resolve from
// the parent working tree, so PROJECT_ROOT/node_modules is empty. tsx's package `exports` don't
// expose ./dist/cli.mjs, so resolve the always-exported package.json and join the bin path.
const TSX_CLI = path.join(path.dirname(createRequire(__filename).resolve("tsx/package.json")), "dist/cli.mjs");
const MCP_ENTRYPOINT = path.join(PROJECT_ROOT, "mcp/index.ts");

type TextContent = {
  type: "text";
  text: string;
};

function expectTextContent(content: unknown): asserts content is TextContent {
  expect(content).toEqual(
    expect.objectContaining({
      type: "text",
      text: expect.any(String),
    })
  );
}

function expectContentArray(content: unknown): asserts content is unknown[] {
  expect(Array.isArray(content)).toBe(true);
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectMcpClient() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX_CLI, MCP_ENTRYPOINT],
    cwd: PROJECT_ROOT,
    env: {
      DATABENTO_API_KEY: "db-test-key",
    },
    stderr: "pipe",
  });

  const client = new Client({
    name: "databento-mcp-integration-test",
    version: "1.0.0",
  });

  await client.connect(transport);

  return { client, transport };
}

describe("MCP stdio integration", () => {
  it("does not write startup diagnostics to stdout", async () => {
    const child = spawn(process.execPath, [TSX_CLI, MCP_ENTRYPOINT], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        DATABENTO_API_KEY: "db-test-key",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));

    await wait(750);
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      wait(1000),
    ]);

    const stdout = Buffer.concat(stdoutChunks).toString("utf8");

    expect(stdout).toBe("");
  }, 10_000);

  it("handles no-argument tool calls without requiring an arguments object", async () => {
    const { client, transport } = await connectMcpClient();

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("get_session_info");

      const result = await client.callTool({ name: "get_session_info" });

      expect(result.isError).not.toBe(true);
      expectContentArray(result.content);
      expect(result.content).toHaveLength(1);
      expectTextContent(result.content[0]);

      const payload = JSON.parse(result.content[0].text);
      expect(payload).toEqual(
        expect.objectContaining({
          currentSession: expect.any(String),
          sessionStart: expect.any(String),
          sessionEnd: expect.any(String),
          timestamp: expect.any(String),
          utcHour: expect.any(Number),
        })
      );
    } finally {
      await client.close();
      await transport.close();
    }
  });
});
