#!/usr/bin/env node
import { randomUUID, timingSafeEqual } from "node:crypto";
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import * as dotenv from "dotenv";
import {
  createDatabentoMcpServer,
  createDefaultDatabentoMcpClients,
  REMOTE_BATCH_TOOL_NAMES,
  type DatabentoMcpClients,
} from "./index.js";

export const DEFAULT_HTTP_BODY_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 1000;
const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1"];
const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];

type EnvLike = Record<string, string | undefined>;
type HeaderBag = Record<string, string | string[] | undefined> | IncomingHttpHeaders;

export interface RemoteMcpConfig {
  host: string;
  port: number;
  path: string;
  authToken?: string;
  batchEnabled: boolean;
  allowedHosts: string[];
  allowedOrigins: string[];
  trustProxy: boolean;
  bodyLimitBytes: number;
  sessionIdleTtlMs: number;
  sessionCleanupIntervalMs: number;
  requestTimeoutMs: number;
}

export interface RemoteMcpRequestLike {
  method?: string;
  url?: string;
  headers: HeaderBag;
}

export type RemoteMcpValidationResult =
  | { ok: true }
  | {
      ok: false;
      status: number;
      body: { error: string };
    };

interface RemoteMcpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

export interface StartRemoteMcpHttpServerOptions {
  apiKey?: string;
  clients?: DatabentoMcpClients;
  config?: RemoteMcpConfig;
  createClients?: (apiKey: string) => DatabentoMcpClients;
}

export interface StartedRemoteMcpHttpServer {
  config: RemoteMcpConfig;
  server: HttpServer;
  url: string;
  close: () => Promise<void>;
}

class HttpRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: { error: string }
  ) {
    super(body.error);
  }
}

function parseBoolean(name: string, value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error(`${name} must be true or false`);
}

function parsePositiveInteger(name: string, value: string | undefined, defaultValue: number, allowZero = false): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${allowZero ? "0 or greater" : "greater than 0"}`);
  }

  return parsed;
}

function parseCsvList(name: string, value: string | undefined, defaultValue: string[], requireNonEmpty: boolean): string[] {
  if (value === undefined) {
    return defaultValue;
  }

  const parsed = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (requireNonEmpty && parsed.length === 0) {
    throw new Error(`${name} must contain at least one value`);
  }

  return parsed;
}

function isLocalBind(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function isLocalHostname(host: string): boolean {
  if (host.toLowerCase() === "::1") {
    return true;
  }

  const normalizedHost = getHostnameFromHostHeader(host)?.toLowerCase();
  return normalizedHost === "127.0.0.1" || normalizedHost === "localhost" || normalizedHost === "::1";
}

function isLocalOrigin(origin: string): boolean {
  try {
    return isLocalHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export function parseRemoteMcpConfig(env: EnvLike = process.env): RemoteMcpConfig {
  const host = env.MCP_HTTP_HOST || "127.0.0.1";
  const port = parsePositiveInteger("MCP_HTTP_PORT", env.MCP_HTTP_PORT, 3000, true);
  const path = env.MCP_HTTP_PATH || "/mcp";

  if (!path.startsWith("/")) {
    throw new Error("MCP_HTTP_PATH must start with /");
  }

  const authToken = env.MCP_REMOTE_AUTH_TOKEN?.trim() || undefined;
  const batchEnabled = parseBoolean("MCP_REMOTE_ENABLE_BATCH", env.MCP_REMOTE_ENABLE_BATCH, false);
  const allowedHosts = parseCsvList("MCP_ALLOWED_HOSTS", env.MCP_ALLOWED_HOSTS, DEFAULT_ALLOWED_HOSTS, true);
  const allowedOrigins = parseCsvList("MCP_ALLOWED_ORIGINS", env.MCP_ALLOWED_ORIGINS, DEFAULT_ALLOWED_ORIGINS, false);
  const trustProxy = parseBoolean("TRUST_PROXY", env.TRUST_PROXY, false);
  const hasRemoteExposure =
    !isLocalBind(host) ||
    allowedHosts.some((allowedHost) => !isLocalHostname(allowedHost)) ||
    allowedOrigins.some((allowedOrigin) => !isLocalOrigin(allowedOrigin)) ||
    trustProxy;

  if (hasRemoteExposure && !authToken) {
    throw new Error("MCP_REMOTE_AUTH_TOKEN is required for remote MCP HTTP exposure");
  }

  if (hasRemoteExposure && !trustProxy) {
    throw new Error("TRUST_PROXY=true is required for remote MCP HTTP exposure");
  }

  return {
    host,
    port,
    path,
    authToken,
    batchEnabled,
    allowedHosts,
    allowedOrigins,
    trustProxy,
    bodyLimitBytes: parsePositiveInteger(
      "MCP_HTTP_BODY_LIMIT_BYTES",
      env.MCP_HTTP_BODY_LIMIT_BYTES,
      DEFAULT_HTTP_BODY_LIMIT_BYTES
    ),
    sessionIdleTtlMs: parsePositiveInteger(
      "MCP_SESSION_IDLE_TTL_MS",
      env.MCP_SESSION_IDLE_TTL_MS,
      DEFAULT_SESSION_IDLE_TTL_MS
    ),
    sessionCleanupIntervalMs: parsePositiveInteger(
      "MCP_SESSION_CLEANUP_INTERVAL_MS",
      env.MCP_SESSION_CLEANUP_INTERVAL_MS,
      DEFAULT_SESSION_CLEANUP_INTERVAL_MS
    ),
    requestTimeoutMs: parsePositiveInteger(
      "MCP_REQUEST_TIMEOUT_MS",
      env.MCP_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS
    ),
  };
}

function getHeader(headers: HeaderBag, name: string): string | undefined {
  const value = headers[name.toLowerCase()] ?? headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function getHostnameFromHostHeader(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) {
    return undefined;
  }

  if (hostHeader.startsWith("[")) {
    const closingBracketIndex = hostHeader.indexOf("]");
    if (closingBracketIndex === -1) {
      return undefined;
    }

    return hostHeader.slice(1, closingBracketIndex).toLowerCase();
  }

  return hostHeader.split(":")[0].toLowerCase();
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  if (actualBuffer.length !== expectedBuffer.length) {
    const paddedActual = Buffer.alloc(expectedBuffer.length);
    actualBuffer.copy(paddedActual, 0, 0, Math.min(actualBuffer.length, expectedBuffer.length));
    timingSafeEqual(paddedActual, expectedBuffer);
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function bodyLength(headers: HeaderBag): number | undefined {
  const rawContentLength = getHeader(headers, "content-length");
  if (rawContentLength === undefined) {
    return undefined;
  }

  const parsed = Number(rawContentLength);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function validateRemoteMcpRequest(
  config: RemoteMcpConfig,
  request: RemoteMcpRequestLike
): RemoteMcpValidationResult {
  if (request.url !== config.path) {
    return { ok: false, status: 404, body: { error: "not_found" } };
  }

  const method = request.method?.toUpperCase();
  if (method !== "POST" && method !== "GET" && method !== "DELETE") {
    return { ok: false, status: 405, body: { error: "method_not_allowed" } };
  }

  const declaredBodyLength = bodyLength(request.headers);
  if (declaredBodyLength !== undefined && declaredBodyLength > config.bodyLimitBytes) {
    return { ok: false, status: 413, body: { error: "payload_too_large" } };
  }

  const hostname = getHostnameFromHostHeader(getHeader(request.headers, "host"));
  if (!hostname || !config.allowedHosts.map((host) => host.toLowerCase()).includes(hostname)) {
    return { ok: false, status: 403, body: { error: "forbidden" } };
  }

  const origin = getHeader(request.headers, "origin");
  if (origin !== undefined && !config.allowedOrigins.includes(origin)) {
    return { ok: false, status: 403, body: { error: "forbidden" } };
  }

  if (config.authToken) {
    const authorization = getHeader(request.headers, "authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;

    if (!token || !tokenMatches(token, config.authToken)) {
      return { ok: false, status: 401, body: { error: "unauthorized" } };
    }
  }

  if (config.trustProxy) {
    const forwardedProto = getHeader(request.headers, "x-forwarded-proto")?.split(",")[0].trim().toLowerCase();
    if (forwardedProto !== "https") {
      return { ok: false, status: 403, body: { error: "forbidden" } };
    }
  }

  return { ok: true };
}

async function readJsonBody(req: IncomingMessage, limitBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalLength = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalLength += buffer.length;

    if (totalLength > limitBytes) {
      throw new HttpRequestError(413, { error: "payload_too_large" });
    }

    chunks.push(buffer);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  if (!body) {
    return undefined;
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new HttpRequestError(400, { error: "bad_request" });
  }
}

function isInitializeBody(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.some((message) => isInitializeRequest(message));
  }

  return isInitializeRequest(body);
}

function writeJson(res: ServerResponse, status: number, body: { error: string }): void {
  if (res.headersSent) {
    return;
  }

  res.writeHead(status, {
    "content-type": "application/json",
  });
  res.end(JSON.stringify(body));
}

function sessionIdFromRequest(req: IncomingMessage): string | undefined {
  return getHeader(req.headers, "mcp-session-id");
}

async function closeSession(session: RemoteMcpSession): Promise<void> {
  await Promise.allSettled([session.transport.close(), session.server.close()]);
}

export function cleanupExpiredRemoteMcpSessions(
  sessions: Map<string, RemoteMcpSession>,
  now: number,
  idleTtlMs: number
): number {
  let removed = 0;

  for (const [sessionId, session] of sessions) {
    if (now - session.lastSeen <= idleTtlMs) {
      continue;
    }

    sessions.delete(sessionId);
    removed += 1;
    void closeSession(session);
  }

  return removed;
}

export async function startRemoteMcpHttpServer(
  options: StartRemoteMcpHttpServerOptions = {}
): Promise<StartedRemoteMcpHttpServer> {
  const config = options.config ?? parseRemoteMcpConfig();
  const apiKey = options.apiKey ?? process.env.DATABENTO_API_KEY;
  const clients =
    options.clients ??
    (apiKey ? (options.createClients ?? createDefaultDatabentoMcpClients)(apiKey) : undefined);

  if (!clients) {
    throw new Error("DATABENTO_API_KEY is required to start the remote MCP HTTP server");
  }

  const resolvedClients = clients;
  const disabledTools = config.batchEnabled ? [] : REMOTE_BATCH_TOOL_NAMES;
  const sessions = new Map<string, RemoteMcpSession>();

  function createMcpSession(): RemoteMcpSession {
    let session: RemoteMcpSession;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        session.lastSeen = Date.now();
        sessions.set(sessionId, session);
      },
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId);
      },
    });
    const server = createDatabentoMcpServer(resolvedClients, { disabledTools });

    session = {
      server,
      transport,
      lastSeen: Date.now(),
    };

    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId) {
        sessions.delete(sessionId);
      }
    };

    return session;
  }

  async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const validation = validateRemoteMcpRequest(config, {
      method: req.method,
      url: req.url?.split("?")[0],
      headers: req.headers,
    });

    if (!validation.ok) {
      writeJson(res, validation.status, validation.body);
      return;
    }

    try {
      const sessionId = sessionIdFromRequest(req);
      const existingSession = sessionId ? sessions.get(sessionId) : undefined;

      if (existingSession) {
        existingSession.lastSeen = Date.now();
        const body = req.method === "POST" ? await readJsonBody(req, config.bodyLimitBytes) : undefined;
        await existingSession.transport.handleRequest(req, res, body);
        return;
      }

      if (sessionId) {
        writeJson(res, 404, { error: "not_found" });
        return;
      }

      if (req.method !== "POST") {
        writeJson(res, 400, { error: "bad_request" });
        return;
      }

      const body = await readJsonBody(req, config.bodyLimitBytes);
      if (!isInitializeBody(body)) {
        writeJson(res, 400, { error: "bad_request" });
        return;
      }

      const session = createMcpSession();
      await session.server.connect(session.transport);
      await session.transport.handleRequest(req, res, body);
    } catch (error) {
      const httpError = error instanceof HttpRequestError ? error : undefined;
      writeJson(res, httpError?.status ?? 500, httpError?.body ?? { error: "internal_server_error" });
    }
  }

  const server = http.createServer((req, res) => {
    void handleMcpRequest(req, res);
  });

  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = config.requestTimeoutMs + 5000;

  const cleanupTimer = setInterval(() => {
    cleanupExpiredRemoteMcpSessions(sessions, Date.now(), config.sessionIdleTtlMs);
  }, config.sessionCleanupIntervalMs);
  cleanupTimer.unref();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const url = `http://${config.host}:${address.port}${config.path}`;

  return {
    config,
    server,
    url,
    close: async () => {
      clearInterval(cleanupTimer);
      await Promise.allSettled([...sessions.values()].map((session) => closeSession(session)));
      sessions.clear();

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}

async function main() {
  dotenv.config();

  const startedServer = await startRemoteMcpHttpServer();

  console.error(`Databento MCP Streamable HTTP server listening at ${startedServer.url}`);

  async function shutdown() {
    await startedServer.close();
    process.exit(0);
  }

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Failed to start Databento MCP HTTP server:", error);
    process.exit(1);
  });
}
