# Remote MCP Operations Runbook

Last verified: 2026-06-16.

This runbook covers operating the Databento MCP server over Streamable HTTP and
connecting Claude clients safely.

## Scope

Use this runbook for the remote/cloud MCP entrypoint:

```text
dist/mcp/mcp/http.js
```

The local Claude Desktop stdio entrypoint remains:

```text
dist/mcp/mcp/index.js
```

Do not expose the HTTP endpoint publicly without TLS termination, bearer auth,
and Host/Origin validation.

## Client Support Matrix

| Client | Recommended path | Notes |
| --- | --- | --- |
| Claude Desktop local machine | Stdio MCP config | Most reliable Desktop path. Uses `claude_desktop_config.json`. |
| Claude app / Desktop with Connectors enabled | Remote connector URL | Use the HTTPS `/mcp` URL and bearer token if the Connectors UI supports adding a custom connector for your account. |
| Claude Code | Remote HTTP MCP | Official CLI path: `claude mcp add --transport http ...`. Useful as an operator validation client. |
| Claude API | MCP connector beta | Requires a public HTTPS URL and API-side MCP connector configuration. |

The Claude Desktop JSON config should not be assumed to support arbitrary remote
Streamable HTTP servers. If the Desktop app does not expose a Connectors/custom
connector UI for your account, use the local stdio config or validate remote MCP
with Claude Code / MCP Inspector instead.

Relevant upstream docs:

- Claude Code MCP remote HTTP syntax: <https://code.claude.com/docs/en/mcp>
- Claude connector directory: <https://claude.com/connectors>
- Claude API MCP connector: <https://platform.claude.com/docs/en/agents-and-tools/mcp-connector>
- MCP Inspector: <https://modelcontextprotocol.io/docs/tools/inspector>

## Architecture

```text
Claude remote MCP client
  -> HTTPS reverse proxy / platform TLS
  -> Node Streamable HTTP MCP server at /mcp
  -> Databento API
```

The Node server expects the reverse proxy to provide:

```text
Host: <public host>
X-Forwarded-Proto: https
Authorization: Bearer <MCP_REMOTE_AUTH_TOKEN>
```

Remote batch tools are hidden and blocked by default:

```text
MCP_REMOTE_ENABLE_BATCH=false
```

## Secrets

Required:

```text
DATABENTO_API_KEY=db-...
MCP_REMOTE_AUTH_TOKEN=<strong random token>
```

Generate a token:

```bash
openssl rand -base64 48
```

Rules:

- Do not commit `.env` files or tokens.
- Rotate `MCP_REMOTE_AUTH_TOKEN` if it is copied into chat, logs, screenshots,
  or ticket systems.
- Keep `DATABENTO_API_KEY` server-side only. Claude clients should never receive
  the Databento API key.

## Local Preflight

From a clean checkout:

```bash
npm ci
npm run build:mcp
npm run smoke:mcp:http
```

Expected output:

```text
MCP Streamable HTTP smoke passed
```

The smoke starts the built HTTP server locally, verifies unauthenticated requests
return `401`, connects with `StreamableHTTPClientTransport`, lists tools, calls
`get_session_info`, and asserts remote batch tools are absent.

## Production-Like Environment

Use an environment file owned by the service account:

```bash
cat >/etc/databento-mcp.env <<'EOF'
DATABENTO_API_KEY=db-your-api-key
MCP_REMOTE_AUTH_TOKEN=replace-with-strong-token
MCP_HTTP_HOST=127.0.0.1
MCP_HTTP_PORT=3000
MCP_HTTP_PATH=/mcp
MCP_ALLOWED_HOSTS=mcp.example.com
MCP_ALLOWED_ORIGINS=https://claude.ai,https://claude.com
MCP_REMOTE_ENABLE_BATCH=false
MCP_RATE_LIMIT_MAX_REQUESTS=120
MCP_RATE_LIMIT_WINDOW_MS=60000
TRUST_PROXY=true
EOF
chmod 600 /etc/databento-mcp.env
```

Use `127.0.0.1` as the Node bind host when a local reverse proxy terminates TLS
on the same machine. Use `0.0.0.0` only when the platform requires it and network
controls prevent direct public access to the Node port.

## Start The Server

Manual start:

```bash
set -a
. /etc/databento-mcp.env
set +a
npm run start:http
```

Expected stderr:

```json
{"timestamp":"2026-06-16T00:00:00.000Z","level":"info","event":"remote_server_started","host":"127.0.0.1","port":3000,"path":"/mcp","health_path":"/healthz","url":"http://127.0.0.1:3000/mcp","batch_enabled":false,"trust_proxy":true,"body_limit_bytes":1048576,"request_timeout_ms":30000,"rate_limit_max_requests":120,"rate_limit_window_ms":60000}
```

The HTTP server logs startup, auth/host/origin/proxy rejects,
payload-too-large rejects, rate limits, session lifecycle, and MCP request
failures as structured JSON to stderr. It must not print protocol messages to
stdout. Logs must not include `DATABENTO_API_KEY`, `MCP_REMOTE_AUTH_TOKEN`,
full `Authorization` headers, cookies, or request bodies.

Health check:

```bash
curl -fsS http://127.0.0.1:3000/healthz
```

Expected body:

```json
{"status":"ok","service":"databento-mcp-http","version":"1.0.0"}
```

`/healthz` only reports process health. It does not call Databento and does not
inspect MCP sessions.

## systemd Example

```ini
[Unit]
Description=Databento MCP Streamable HTTP Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/databento-mcp-server
EnvironmentFile=/etc/databento-mcp.env
ExecStart=/usr/bin/node /opt/databento-mcp-server/dist/mcp/mcp/http.js
Restart=on-failure
RestartSec=5
User=databento-mcp
Group=databento-mcp
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Enable:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now databento-mcp
sudo systemctl status databento-mcp
```

## Reverse Proxy Example

Example Nginx server block:

```nginx
server {
    listen 443 ssl http2;
    server_name mcp.example.com;

    ssl_certificate /etc/letsencrypt/live/mcp.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp.example.com/privkey.pem;

    location /mcp {
        proxy_pass http://127.0.0.1:3000/mcp;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

Do not forward public traffic to the Node server unless the first
comma-separated `X-Forwarded-Proto` value is exactly `https`; with
`TRUST_PROXY=true`, the server rejects requests without it.

## HTTP Health And Security Checks

Unauthenticated request should fail before MCP handling:

```bash
curl -i https://mcp.example.com/mcp \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0.0"}}}'
```

Expected:

```text
HTTP/2 401
{"error":"unauthorized"}
```

Wrong host should fail:

```bash
curl -i https://127.0.0.1/mcp \
  -H 'Host: wrong.example.com' \
  -H "Authorization: Bearer $MCP_REMOTE_AUTH_TOKEN"
```

Expected:

```text
HTTP 403
{"error":"forbidden"}
```

## MCP Inspector Check

Run from an operator workstation:

```bash
npx @modelcontextprotocol/inspector
```

Use:

```text
Transport: Streamable HTTP
URL: https://mcp.example.com/mcp
Header: Authorization: Bearer <MCP_REMOTE_AUTH_TOKEN>
```

Check:

- `tools/list` contains `get_session_info`.
- `tools/list` does not contain `batch_submit_job`, `batch_list_jobs`, or
  `batch_download`.
- `tools/call` for `get_session_info` returns a JSON session payload.

## Connect Claude Desktop / Claude App

### Preferred Desktop Fallback: Local Stdio

If Claude Desktop does not offer a Connectors/custom connector UI for your
account, use the local stdio server.

Build:

```bash
npm run build:mcp
```

macOS config file:

```text
~/Library/Application Support/Claude/claude_desktop_config.json
```

Windows config file:

```text
%APPDATA%\Claude\claude_desktop_config.json
```

Example:

```json
{
  "mcpServers": {
    "databento": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/yourusername/Dev/databento-mcp-server/dist/mcp/mcp/index.js"],
      "env": {
        "DATABENTO_API_KEY": "db-your-api-key"
      }
    }
  }
}
```

Restart Claude Desktop after changing the file.

### Remote Connector UI

If your Claude app / Claude Desktop account exposes a Connectors or custom MCP
connector UI:

1. Add a custom connector.
2. Name it `databento`.
3. Set URL to:

   ```text
   https://mcp.example.com/mcp
   ```

4. Set auth header:

   ```text
   Authorization: Bearer <MCP_REMOTE_AUTH_TOKEN>
   ```

5. Save and open a new chat.
6. Ask:

   ```text
   What Databento MCP tools are available?
   ```

7. Then ask:

   ```text
   Call get_session_info.
   ```

If the UI only offers curated Directory connectors and does not support a custom
URL, this repository cannot force Claude Desktop to connect to the remote HTTP
server. Use local stdio or Claude Code for remote validation.

## Connect Claude Code

Claude Code supports remote HTTP MCP servers with:

```bash
claude mcp add --transport http databento https://mcp.example.com/mcp \
  --header "Authorization: Bearer $MCP_REMOTE_AUTH_TOKEN"
```

Verify:

```bash
claude mcp list
claude mcp get databento
```

Inside Claude Code, use:

```text
/mcp
```

## Expected Remote Tool Surface

Default remote tools should include safe metadata/session/timeseries/reference
tools, and should exclude batch tools.

Must be absent unless `MCP_REMOTE_ENABLE_BATCH=true`:

```text
batch_submit_job
batch_list_jobs
batch_download
```

Even if a client calls a hidden batch tool directly, the MCP response should be
an `isError: true` tool error.

## Operations

### Restart

```bash
sudo systemctl restart databento-mcp
```

Existing Streamable HTTP sessions are in memory and can be dropped on restart.
Clients should reconnect.

### Rotate Remote Token

1. Generate a new token.
2. Update `/etc/databento-mcp.env`.
3. Restart the service.
4. Update the Claude connector / Claude Code MCP config with the new bearer
   token.
5. Re-run the MCP Inspector check.

### Disable Remote Access

Stop the service:

```bash
sudo systemctl stop databento-mcp
```

Or remove the reverse proxy route for `/mcp`.

### Enable Remote Batch Tools

Default is disabled. Enable only after a separate risk review:

```text
MCP_REMOTE_ENABLE_BATCH=true
```

Then restart and explicitly verify that batch tools appear in `tools/list`.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `401 {"error":"unauthorized"}` | Missing or wrong remote bearer token | Check `Authorization: Bearer ...` and `MCP_REMOTE_AUTH_TOKEN`. |
| `429 {"error":"rate_limited"}` | Too many requests for the bearer token or fallback IP | Back off using `Retry-After`, then tune `MCP_RATE_LIMIT_MAX_REQUESTS` or `MCP_RATE_LIMIT_WINDOW_MS` if needed. |
| `403 {"error":"forbidden"}` | Host, Origin, or `X-Forwarded-Proto` rejected | Check `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS`, and reverse proxy headers. |
| Startup fails with `MCP_REMOTE_AUTH_TOKEN is required` | Public/proxy exposure configured without token | Set `MCP_REMOTE_AUTH_TOKEN` or return to local-only hosts/origins and `TRUST_PROXY=false`. |
| Startup fails with `TRUST_PROXY=true is required` | Public host/origin or non-local bind configured without trusted proxy mode | Put the service behind TLS reverse proxy and set `TRUST_PROXY=true`. |
| Claude Desktop does not show a way to add URL | Desktop account/app lacks custom remote connector UI | Use local stdio config or Claude Code remote HTTP config. |
| `get_session_info` works, Databento tools fail with upstream 401 | Databento API key issue | Check `DATABENTO_API_KEY` and Databento account permissions. |
| Batch tools missing | Expected default | Set `MCP_REMOTE_ENABLE_BATCH=true` only if intentionally enabled. |

## Rollback

1. Remove the remote connector from Claude / Claude Code.
2. Stop `databento-mcp`.
3. Remove or disable the reverse proxy `/mcp` route.
4. Keep or restore the local Claude Desktop stdio config if local access is
   still needed.

## Verification Checklist

- `npm run build:mcp` passes.
- `npm run smoke:mcp:http` passes.
- Public URL is HTTPS.
- Unauthenticated request returns `401`.
- Wrong host returns `403`.
- MCP Inspector can list tools.
- Remote `tools/list` excludes batch tools by default.
- Claude Desktop local stdio or Claude remote connector path is explicitly
  chosen and documented for the operator.
