import { describe, expect, it } from "vitest";
import {
  createRemoteMcpRateLimiter,
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
    expect(config.rateLimitMaxRequests).toBe(120);
    expect(config.rateLimitWindowMs).toBe(60_000);

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
      MCP_RATE_LIMIT_MAX_REQUESTS: "2",
      MCP_RATE_LIMIT_WINDOW_MS: "1000",
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
        rateLimitMaxRequests: 2,
        rateLimitWindowMs: 1000,
        trustProxy: true,
      })
    );
  });

  it("fails fast for invalid remote config values", () => {
    expect(() => parseRemoteMcpConfig({ MCP_HTTP_PORT: "abc" })).toThrow(/MCP_HTTP_PORT/);
    expect(() => parseRemoteMcpConfig({ MCP_HTTP_PATH: "mcp" })).toThrow(/MCP_HTTP_PATH/);
    expect(() => parseRemoteMcpConfig({ MCP_HTTP_PATH: "/healthz" })).toThrow(/MCP_HTTP_PATH/);
    expect(() => parseRemoteMcpConfig({ MCP_ALLOWED_HOSTS: "" })).toThrow(/MCP_ALLOWED_HOSTS/);
    expect(() => parseRemoteMcpConfig({ MCP_RATE_LIMIT_MAX_REQUESTS: "abc" })).toThrow(/MCP_RATE_LIMIT_MAX_REQUESTS/);
    expect(() => parseRemoteMcpConfig({ MCP_RATE_LIMIT_WINDOW_MS: "0" })).toThrow(/MCP_RATE_LIMIT_WINDOW_MS/);
    expect(() => parseRemoteMcpConfig({ MCP_REMOTE_ENABLE_BATCH: "maybe" })).toThrow(/MCP_REMOTE_ENABLE_BATCH/);
    expect(() => parseRemoteMcpConfig({ TRUST_PROXY: "sometimes" })).toThrow(/TRUST_PROXY/);
  });

  it("rate limits by bearer token without exposing the token in results", () => {
    let now = 0;
    const config = parseRemoteMcpConfig({
      MCP_REMOTE_AUTH_TOKEN: "remote-secret-token",
      MCP_RATE_LIMIT_MAX_REQUESTS: "2",
      MCP_RATE_LIMIT_WINDOW_MS: "1000",
    });
    const limiter = createRemoteMcpRateLimiter(config, () => now);
    const request = {
      headers: {
        authorization: "Bearer remote-secret-token",
      },
      remoteAddress: "203.0.113.10",
    };

    expect(limiter.check(request)).toEqual({ ok: true });
    expect(limiter.check(request)).toEqual({ ok: true });
    const rejected = limiter.check(request);

    expect(rejected).toEqual({
      ok: false,
      status: 429,
      body: { error: "rate_limited" },
      retryAfterSeconds: 1,
      keyType: "token",
    });
    expect(JSON.stringify(rejected)).not.toContain("remote-secret-token");

    now = 1001;
    expect(limiter.check(request)).toEqual({ ok: true });
  });

  it("rate limits invalid bearer tokens by fallback IP", () => {
    const config = parseRemoteMcpConfig({
      MCP_REMOTE_AUTH_TOKEN: "valid-remote-token",
      MCP_RATE_LIMIT_MAX_REQUESTS: "1",
      MCP_RATE_LIMIT_WINDOW_MS: "1000",
    });
    const limiter = createRemoteMcpRateLimiter(config, () => 0);

    expect(
      limiter.check({
        headers: { authorization: "Bearer invalid-token-1" },
        remoteAddress: "203.0.113.10",
      })
    ).toEqual({ ok: true });
    const rejected = limiter.check({
      headers: { authorization: "Bearer invalid-token-2" },
      remoteAddress: "203.0.113.10",
    });

    expect(rejected).toEqual({
      ok: false,
      status: 429,
      body: { error: "rate_limited" },
      retryAfterSeconds: 1,
      keyType: "ip",
    });
    expect(JSON.stringify(rejected)).not.toContain("invalid-token");
  });

  it("falls back to remote address when no bearer token is present", () => {
    const config = parseRemoteMcpConfig({
      MCP_RATE_LIMIT_MAX_REQUESTS: "1",
      MCP_RATE_LIMIT_WINDOW_MS: "1000",
    });
    const limiter = createRemoteMcpRateLimiter(config, () => 0);

    expect(limiter.check({ headers: {}, remoteAddress: "203.0.113.10" })).toEqual({ ok: true });
    expect(limiter.check({ headers: {}, remoteAddress: "203.0.113.10" })).toEqual({
      ok: false,
      status: 429,
      body: { error: "rate_limited" },
      retryAfterSeconds: 1,
      keyType: "ip",
    });
    expect(limiter.check({ headers: {}, remoteAddress: "203.0.113.11" })).toEqual({ ok: true });
  });

  it("ignores forwarded IP headers unless proxy trust is enabled", () => {
    const config = parseRemoteMcpConfig({
      MCP_RATE_LIMIT_MAX_REQUESTS: "1",
      MCP_RATE_LIMIT_WINDOW_MS: "1000",
    });
    const limiter = createRemoteMcpRateLimiter(config, () => 0);

    expect(
      limiter.check({
        headers: { "x-forwarded-for": "203.0.113.1" },
        remoteAddress: "198.51.100.10",
      })
    ).toEqual({ ok: true });
    expect(
      limiter.check({
        headers: { "x-forwarded-for": "203.0.113.2" },
        remoteAddress: "198.51.100.10",
      })
    ).toEqual({
      ok: false,
      status: 429,
      body: { error: "rate_limited" },
      retryAfterSeconds: 1,
      keyType: "ip",
    });
  });

  it("uses the closest forwarded IP when proxy trust is enabled", () => {
    const config = parseRemoteMcpConfig({
      MCP_REMOTE_AUTH_TOKEN: "valid-remote-token",
      MCP_RATE_LIMIT_MAX_REQUESTS: "1",
      MCP_RATE_LIMIT_WINDOW_MS: "1000",
      TRUST_PROXY: "true",
    });
    const limiter = createRemoteMcpRateLimiter(config, () => 0);

    expect(
      limiter.check({
        headers: {
          authorization: "Bearer invalid-token-1",
          "x-forwarded-for": "198.51.100.1, 203.0.113.10",
        },
        remoteAddress: "127.0.0.1",
      })
    ).toEqual({ ok: true });
    expect(
      limiter.check({
        headers: {
          authorization: "Bearer invalid-token-2",
          "x-forwarded-for": "198.51.100.2, 203.0.113.10",
        },
        remoteAddress: "127.0.0.1",
      })
    ).toEqual({
      ok: false,
      status: 429,
      body: { error: "rate_limited" },
      retryAfterSeconds: 1,
      keyType: "ip",
    });
    expect(
      limiter.check({
        headers: {
          authorization: "Bearer invalid-token-3",
          "x-forwarded-for": "198.51.100.2, 203.0.113.11",
        },
        remoteAddress: "127.0.0.1",
      })
    ).toEqual({ ok: true });
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
