import { describe, expect, it } from "vitest";
import {
  DEFAULT_HTTP_BODY_LIMIT_BYTES,
  parseRemoteMcpConfig,
  validateRemoteMcpRequest,
} from "../../mcp/http.js";
import { REMOTE_BATCH_TOOL_NAMES, listDatabentoTools } from "../../mcp/index.js";

describe("remote MCP HTTP config", () => {
  it("allows localhost without a remote auth token and disables batch tools by default", () => {
    const config = parseRemoteMcpConfig({});

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(3000);
    expect(config.path).toBe("/mcp");
    expect(config.authToken).toBeUndefined();
    expect(config.batchEnabled).toBe(false);
    expect(config.allowedHosts).toEqual(["localhost", "127.0.0.1"]);
    expect(config.allowedOrigins).toEqual(["http://localhost:3000", "http://127.0.0.1:3000"]);

    const toolNames = listDatabentoTools({ disabledTools: REMOTE_BATCH_TOOL_NAMES }).map((tool) => tool.name);
    expect(toolNames).not.toContain("batch_submit_job");
    expect(toolNames).not.toContain("batch_list_jobs");
    expect(toolNames).not.toContain("batch_download");
  });

  it("requires a remote auth token for non-local binds and public proxy targets", () => {
    expect(() =>
      parseRemoteMcpConfig({
        MCP_HTTP_HOST: "0.0.0.0",
        MCP_ALLOWED_HOSTS: "databento.example.com",
      })
    ).toThrow(/MCP_REMOTE_AUTH_TOKEN/);

    expect(() =>
      parseRemoteMcpConfig({
        MCP_HTTP_HOST: "127.0.0.1",
        MCP_ALLOWED_HOSTS: "databento.example.com",
      })
    ).toThrow(/MCP_REMOTE_AUTH_TOKEN/);

    expect(() =>
      parseRemoteMcpConfig({
        MCP_HTTP_HOST: "127.0.0.1",
        MCP_ALLOWED_ORIGINS: "https://claude.example.com",
      })
    ).toThrow(/MCP_REMOTE_AUTH_TOKEN/);

    expect(() =>
      parseRemoteMcpConfig({
        MCP_HTTP_HOST: "127.0.0.1",
        TRUST_PROXY: "true",
      })
    ).toThrow(/MCP_REMOTE_AUTH_TOKEN/);

    expect(
      parseRemoteMcpConfig({
        MCP_HTTP_HOST: "0.0.0.0",
        MCP_REMOTE_AUTH_TOKEN: "remote-token",
        MCP_ALLOWED_HOSTS: "databento.example.com",
        TRUST_PROXY: "true",
      })
    ).toEqual(
      expect.objectContaining({
        host: "0.0.0.0",
        authToken: "remote-token",
        allowedHosts: ["databento.example.com"],
        trustProxy: true,
      })
    );
  });

  it("requires proxy TLS enforcement for non-local remote exposure", () => {
    expect(() =>
      parseRemoteMcpConfig({
        MCP_HTTP_HOST: "0.0.0.0",
        MCP_REMOTE_AUTH_TOKEN: "remote-token",
        MCP_ALLOWED_HOSTS: "databento.example.com",
      })
    ).toThrow(/TRUST_PROXY/);
  });

  it("parses explicit hosts, origins, ports, paths, and booleans predictably", () => {
    const config = parseRemoteMcpConfig({
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: "4100",
      MCP_HTTP_PATH: "/databento-mcp",
      MCP_REMOTE_AUTH_TOKEN: "remote-token",
      MCP_REMOTE_ENABLE_BATCH: "true",
      MCP_ALLOWED_HOSTS: "localhost, 127.0.0.1, databento.example.com",
      MCP_ALLOWED_ORIGINS: "https://claude.example.com, http://localhost:4100",
      TRUST_PROXY: "true",
    });

    expect(config).toEqual(
      expect.objectContaining({
        host: "127.0.0.1",
        port: 4100,
        path: "/databento-mcp",
        authToken: "remote-token",
        batchEnabled: true,
        allowedHosts: ["localhost", "127.0.0.1", "databento.example.com"],
        allowedOrigins: ["https://claude.example.com", "http://localhost:4100"],
        trustProxy: true,
      })
    );
  });

  it("fails fast for invalid remote config values", () => {
    expect(() => parseRemoteMcpConfig({ MCP_HTTP_PORT: "abc" })).toThrow(/MCP_HTTP_PORT/);
    expect(() => parseRemoteMcpConfig({ MCP_HTTP_PATH: "mcp" })).toThrow(/MCP_HTTP_PATH/);
    expect(() => parseRemoteMcpConfig({ MCP_ALLOWED_HOSTS: "" })).toThrow(/MCP_ALLOWED_HOSTS/);
    expect(() => parseRemoteMcpConfig({ MCP_REMOTE_ENABLE_BATCH: "maybe" })).toThrow(/MCP_REMOTE_ENABLE_BATCH/);
    expect(() => parseRemoteMcpConfig({ TRUST_PROXY: "sometimes" })).toThrow(/TRUST_PROXY/);
  });
});

describe("remote MCP HTTP preflight validation", () => {
  const secureConfig = parseRemoteMcpConfig({
    MCP_HTTP_HOST: "0.0.0.0",
    MCP_HTTP_PATH: "/mcp",
    MCP_REMOTE_AUTH_TOKEN: "remote-token",
    MCP_ALLOWED_HOSTS: "databento.example.com",
    MCP_ALLOWED_ORIGINS: "https://claude.example.com",
    TRUST_PROXY: "true",
  });

  function validate(headers: Record<string, string>, method = "POST", url = "/mcp") {
    return validateRemoteMcpRequest(secureConfig, {
      method,
      url,
      headers,
    });
  }

  it("rejects missing, malformed, and wrong bearer auth before MCP handling", () => {
    expect(validate({ host: "databento.example.com" })).toEqual({
      ok: false,
      status: 401,
      body: { error: "unauthorized" },
    });
    expect(validate({ host: "databento.example.com", authorization: "Basic abc" })).toEqual({
      ok: false,
      status: 401,
      body: { error: "unauthorized" },
    });
    expect(validate({ host: "databento.example.com", authorization: "Bearer wrong" })).toEqual({
      ok: false,
      status: 401,
      body: { error: "unauthorized" },
    });
  });

  it("accepts a valid bearer token and allowed host and origin", () => {
    expect(
      validate({
        host: "databento.example.com:443",
        origin: "https://claude.example.com",
        authorization: "Bearer remote-token",
        "x-forwarded-proto": "https",
      })
    ).toEqual({ ok: true });
  });

  it("rejects trusted proxy requests that were not forwarded over HTTPS", () => {
    expect(
      validate({
        host: "databento.example.com",
        authorization: "Bearer remote-token",
      })
    ).toEqual({
      ok: false,
      status: 403,
      body: { error: "forbidden" },
    });

    expect(
      validate({
        host: "databento.example.com",
        authorization: "Bearer remote-token",
        "x-forwarded-proto": "http",
      })
    ).toEqual({
      ok: false,
      status: 403,
      body: { error: "forbidden" },
    });
  });

  it("rejects disallowed host and origin values before MCP handling", () => {
    expect(
      validate({
        host: "evil.example.com",
        authorization: "Bearer remote-token",
        "x-forwarded-proto": "https",
      })
    ).toEqual({
      ok: false,
      status: 403,
      body: { error: "forbidden" },
    });

    expect(
      validate({
        host: "databento.example.com",
        origin: "https://evil.example.com",
        authorization: "Bearer remote-token",
        "x-forwarded-proto": "https",
      })
    ).toEqual({
      ok: false,
      status: 403,
      body: { error: "forbidden" },
    });
  });

  it("allows absent origins for non-browser MCP clients", () => {
    expect(
      validate({
        host: "databento.example.com",
        authorization: "Bearer remote-token",
        "x-forwarded-proto": "https",
      })
    ).toEqual({ ok: true });
  });

  it("rejects unexpected paths, methods, and oversized request bodies", () => {
    expect(
      validate(
        {
          host: "databento.example.com",
          authorization: "Bearer remote-token",
          "x-forwarded-proto": "https",
        },
        "POST",
        "/wrong"
      )
    ).toEqual({
      ok: false,
      status: 404,
      body: { error: "not_found" },
    });

    expect(
      validate(
        {
          host: "databento.example.com",
          authorization: "Bearer remote-token",
          "x-forwarded-proto": "https",
        },
        "PUT",
        "/mcp"
      )
    ).toEqual({
      ok: false,
      status: 405,
      body: { error: "method_not_allowed" },
    });

    expect(
      validate({
        host: "databento.example.com",
        authorization: "Bearer remote-token",
        "x-forwarded-proto": "https",
        "content-length": String(DEFAULT_HTTP_BODY_LIMIT_BYTES + 1),
      })
    ).toEqual({
      ok: false,
      status: 413,
      body: { error: "payload_too_large" },
    });
  });
});
