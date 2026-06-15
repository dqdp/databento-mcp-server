import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseRemoteMcpConfig,
  startRemoteMcpHttpServer,
  type StartedRemoteMcpHttpServer,
} from "../../mcp/http.js";
import { REMOTE_BATCH_TOOL_NAMES } from "../../mcp/index.js";

let startedServer: StartedRemoteMcpHttpServer | undefined;

async function closeStartedServer() {
  if (startedServer) {
    await startedServer.close();
    startedServer = undefined;
  }
}

async function startLocalHttpServer(env: Record<string, string> = {}) {
  startedServer = await startRemoteMcpHttpServer({
    apiKey: "db-test-key",
    config: parseRemoteMcpConfig({
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: "0",
      MCP_ALLOWED_HOSTS: "127.0.0.1",
      ...env,
    }),
  });

  return startedServer;
}

async function connectClient(url: string, token?: string) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token
      ? {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      : undefined,
  });
  const client = new Client({
    name: "databento-mcp-http-test",
    version: "1.0.0",
  });

  await client.connect(transport);

  return { client, transport };
}

function expectTextContent(content: unknown): asserts content is { type: "text"; text: string } {
  expect(content).toEqual(
    expect.objectContaining({
      type: "text",
      text: expect.any(String),
    })
  );
}

async function postInitializeWithoutAuth(url: string) {
  return fetch(url, {
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
          name: "raw-auth-test",
          version: "1.0.0",
        },
      },
    }),
  });
}

describe("MCP Streamable HTTP integration", () => {
  afterEach(async () => {
    await closeStartedServer();
  });

  it("serves MCP tools over Streamable HTTP without exposing batch tools by default", async () => {
    const server = await startLocalHttpServer();
    const { client, transport } = await connectClient(server.url);

    try {
      const tools = await client.listTools();
      const toolNames = tools.tools.map((tool) => tool.name);

      expect(toolNames).toContain("get_session_info");
      for (const batchToolName of REMOTE_BATCH_TOOL_NAMES) {
        expect(toolNames).not.toContain(batchToolName);
      }

      const result = await client.callTool({ name: "get_session_info" });
      expect(result.isError).not.toBe(true);
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

      const hiddenBatchResult = await client.callTool({ name: "batch_list_jobs" });
      expect(hiddenBatchResult.isError).toBe(true);
      expectTextContent(hiddenBatchResult.content[0]);
      expect(JSON.parse(hiddenBatchResult.content[0].text)).toEqual({
        error: "Tool is disabled for this transport: batch_list_jobs",
      });
    } finally {
      await client.close();
      await transport.close();
    }
  }, 15_000);

  it("rejects unauthenticated HTTP requests before MCP handling when auth is configured", async () => {
    const server = await startLocalHttpServer({
      MCP_REMOTE_AUTH_TOKEN: "remote-token",
    });

    const response = await postInitializeWithoutAuth(server.url);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("accepts authenticated Streamable HTTP clients when auth is configured", async () => {
    const server = await startLocalHttpServer({
      MCP_REMOTE_AUTH_TOKEN: "remote-token",
    });
    const { client, transport } = await connectClient(server.url, "remote-token");

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("get_session_info");
    } finally {
      await client.close();
      await transport.close();
    }
  }, 15_000);
});
