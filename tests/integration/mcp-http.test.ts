import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseRemoteMcpConfig,
  startRemoteMcpHttpServer,
  type RemoteMcpLogEvent,
  type StartedRemoteMcpHttpServer,
} from "../../mcp/http.js";
import { REMOTE_BATCH_TOOL_NAMES, listDatabentoTools } from "../../mcp/index.js";
import packageJson from "../../package.json";

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

async function startLocalHttpServerWithLogs(
  env: Record<string, string> = {},
  logs: RemoteMcpLogEvent[] = []
) {
  startedServer = await startRemoteMcpHttpServer({
    apiKey: "db-test-key",
    logger: (event) => logs.push(event),
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

function siblingUrl(url: string, pathname: string) {
  const parsed = new URL(url);
  parsed.pathname = pathname;
  parsed.search = "";
  return parsed.toString();
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
      const localBatchToolNames = listDatabentoTools()
        .map((tool) => tool.name)
        .filter((toolName) => toolName.startsWith("batch_"));

      expect(toolNames).toContain("get_session_info");
      expect([...REMOTE_BATCH_TOOL_NAMES].sort()).toEqual([...localBatchToolNames].sort());
      for (const batchToolName of localBatchToolNames) {
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

      for (const batchToolName of localBatchToolNames) {
        const hiddenBatchResult = await client.callTool({ name: batchToolName });
        expect(hiddenBatchResult.isError).toBe(true);
        expectTextContent(hiddenBatchResult.content[0]);
        expect(JSON.parse(hiddenBatchResult.content[0].text)).toEqual({
          error: `Tool is disabled for this transport: ${batchToolName}`,
        });
      }
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

  it("serves a minimal unauthenticated health check outside the MCP route", async () => {
    const logs: RemoteMcpLogEvent[] = [];
    const server = await startLocalHttpServerWithLogs(
      {
        MCP_REMOTE_AUTH_TOKEN: "remote-token",
      },
      logs
    );

    const response = await fetch(siblingUrl(server.url, "/healthz"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body).toEqual({
      status: "ok",
      service: "databento-mcp-http",
      version: packageJson.version,
    });
    expect(JSON.stringify(body)).not.toContain("db-test-key");
    expect(JSON.stringify(body)).not.toContain("remote-token");
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "info",
        event: "remote_server_started",
        path: "/mcp",
        health_path: "/healthz",
      })
    );
  });

  it("rate limits repeated remote requests and logs rejections without secrets", async () => {
    const logs: RemoteMcpLogEvent[] = [];
    const server = await startLocalHttpServerWithLogs(
      {
        MCP_REMOTE_AUTH_TOKEN: "remote-token",
        MCP_RATE_LIMIT_MAX_REQUESTS: "1",
        MCP_RATE_LIMIT_WINDOW_MS: "60000",
      },
      logs
    );

    const unauthorized = await postInitializeWithoutAuth(server.url);
    const limited = await postInitializeWithoutAuth(server.url);

    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: "unauthorized" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "warn",
        event: "auth_rejected",
      })
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "warn",
        event: "rate_limited",
        rate_limit_key_type: "ip",
      })
    );
    expect(JSON.stringify(logs)).not.toContain("remote-token");
    expect(JSON.stringify(logs)).not.toContain("db-test-key");
    expect(JSON.stringify(logs)).not.toContain("authorization");
  });
});
