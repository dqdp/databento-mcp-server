# Remote / Cloud Support Plan

## Status

Remote/cloud support is not implemented yet.

The repository currently supports local Claude Desktop through stdio. The local
track is stable and should remain the default path. Remote/cloud support is a
separate follow-up track and must not weaken the local stdio entrypoint.

## Goal

Add a production-oriented Streamable HTTP MCP endpoint for remote clients while
preserving the existing stdio server for Claude Desktop.

The remote endpoint must protect access to the paid Databento API. Do not expose
remote MCP without authentication, HTTPS, and host/origin validation.

## Non-Goals

- Do not replace the stdio Claude Desktop path.
- Do not build multi-user accounts, per-user Databento keys, OAuth, or billing
  attribution in the first remote/cloud slice.
- Do not add live Databento API calls to the default CI gate.
- Do not run batch jobs in smoke tests.
- Do not add broad API coverage beyond proving the remote MCP transport works.
- Do not implement npm publish or release automation as part of this track.

## MVP Decisions

The first remote/cloud implementation is intentionally single-user and
single-instance.

- Tenant model: single-user / single-tenant self-hosted server.
- Databento credentials: one server-owned `DATABENTO_API_KEY` from env.
- Auth: one bearer token from `MCP_REMOTE_AUTH_TOKEN`.
- Batch tools: disabled on remote by default with `MCP_REMOTE_ENABLE_BATCH=false`.
- Sessions: stateful Streamable HTTP with `sessionIdGenerator`.
- Scaling: first slice supports one running instance. Horizontal scaling needs a
  later decision for sticky sessions, stateless transport, or shared session
  storage.
- TLS: terminate HTTPS at the platform or reverse proxy, not inside Node.
- Deployment target: prove local HTTP smoke first; add a concrete cloud platform
  example only after the endpoint and tests are stable.
- Limits: include body size limits and request timeouts in the first PR. Add
  rate limiting as a follow-up hardening slice before production exposure.

## Current SDK Guidance

Use the current MCP TypeScript SDK docs through Context7 before implementation.
The current target is `@modelcontextprotocol/sdk` v1.29.0.

Relevant SDK shape from Context7:

- Use `StreamableHTTPServerTransport` for remote MCP.
- Use `sessionIdGenerator` for stateful sessions, or `undefined` only for an
  intentional stateless endpoint.
- Use SDK/Express host header validation for DNS rebinding protection.
- `createMcpExpressApp({ host })` enables protection for localhost-style hosts,
  but binding to `0.0.0.0` needs explicit host validation.

## Proposed Architecture

Keep one shared MCP server factory:

```ts
createDatabentoMcpServer(clients)
```

Add a separate HTTP entrypoint, for example:

```text
mcp/http.ts
```

The HTTP entrypoint should:

- Load `DATABENTO_API_KEY` from the environment.
- Load remote server settings from environment variables.
- Create the same `DatabentoMcpClients` as the stdio entrypoint.
- Create a Streamable HTTP transport.
- Mount a single MCP route, such as `/mcp`.
- Keep logging off stdout if it can interfere with protocol handling.

Suggested environment variables:

```text
MCP_HTTP_HOST=127.0.0.1
MCP_HTTP_PORT=3000
MCP_HTTP_PATH=/mcp
MCP_REMOTE_AUTH_TOKEN=<required-for-non-localhost>
MCP_REMOTE_ENABLE_BATCH=false
MCP_ALLOWED_HOSTS=localhost,127.0.0.1
MCP_ALLOWED_ORIGINS=http://localhost:3000
TRUST_PROXY=false
```

## Contracts

HTTP endpoint:

- Mount exactly one MCP endpoint at `MCP_HTTP_PATH`, default `/mcp`.
- Do not add a separate REST API in the remote/cloud MVP.
- Allow only the HTTP methods required by the MCP Streamable HTTP SDK on the MCP
  endpoint. Reject unrelated methods before MCP handling.
- Reject unexpected paths before MCP handling.

Auth responses:

- Missing `Authorization` header: HTTP 401 with `{ "error": "unauthorized" }`.
- Malformed `Authorization` header: HTTP 401 with `{ "error": "unauthorized" }`.
- Wrong bearer token: HTTP 401 with `{ "error": "unauthorized" }`.
- Authenticated but forbidden remote action: MCP tool error with `isError: true`
  for tool-level restrictions, or HTTP 403 for pre-MCP request restrictions.
- Error responses must not reveal token values, configured hosts, or secret
  comparison details.

Host validation:

- Compare the request `Host` hostname against `MCP_ALLOWED_HOSTS`.
- Strip any port before comparison, so `example.com:443` compares as
  `example.com`.
- Missing or disallowed `Host`: HTTP 403 with `{ "error": "forbidden" }`.

Origin validation:

- If `Origin` is absent, allow the request. Non-browser MCP clients often omit
  it.
- If `Origin` is present, it must exactly match an entry in
  `MCP_ALLOWED_ORIGINS`.
- Disallowed `Origin`: HTTP 403 with `{ "error": "forbidden" }`.

Batch tool filtering:

- When `MCP_REMOTE_ENABLE_BATCH=false`, omit batch tools from remote
  `tools/list`.
- If a client directly calls a hidden batch tool, return an MCP tool error with
  `isError: true`.
- Local stdio must keep the existing tool list and behavior.

Session lifecycle:

- Use stateful in-memory Streamable HTTP sessions with `randomUUID`
  `sessionIdGenerator`.
- Use a 30 minute idle session TTL.
- Clean expired sessions every 5 minutes.
- Process restarts may drop sessions in the MVP.

Configuration validation:

- Invalid `MCP_HTTP_PORT`: fail startup.
- `MCP_HTTP_PATH` missing a leading `/`: fail startup.
- Empty `MCP_ALLOWED_HOSTS`: fail startup.
- Non-local bind without `MCP_REMOTE_AUTH_TOKEN`: fail startup.
- Invalid boolean values such as `MCP_REMOTE_ENABLE_BATCH=maybe`: fail startup.

NPM scripts:

```json
{
  "dev:http": "tsx mcp/http.ts",
  "start:http": "node dist/mcp/http.js",
  "smoke:mcp:http": "tsx scripts/smoke-mcp-http.ts"
}
```

## Security Requirements

Auth:

- Use `Authorization: Bearer <MCP_REMOTE_AUTH_TOKEN>` for remote requests.
- Require bearer token auth for every request when binding anywhere other than
  localhost.
- Compare tokens with a timing-safe comparison.
- Never log token values.
- Fail closed when `MCP_REMOTE_AUTH_TOKEN` is missing for remote binds.
- Do not add OAuth in the MVP. OAuth belongs to a future multi-user track.

Tool exposure:

- Disable all batch tools on remote by default.
- Do not expose `batch_submit_job` remotely unless `MCP_REMOTE_ENABLE_BATCH=true`
  is explicitly set.
- Keep local stdio tool exposure unchanged.

Host and origin validation:

- Validate `Host` against `MCP_ALLOWED_HOSTS`.
- Validate `Origin` when the header is present.
- Reject unexpected hosts before the MCP transport handles the request.
- Include localhost defaults only for local development.

HTTPS:

- Do not claim production support over plain HTTP.
- Prefer TLS termination at the platform or reverse proxy.
- Do not add built-in HTTPS certificate handling in the MVP.
- Document examples for Cloud Run, Fly.io, Render, or a generic reverse proxy
  only after the endpoint and tests are in place.

Rate and resource controls:

- Keep request body limits tight.
- Add request timeouts in the first remote PR.
- Add rate limiting in a follow-up hardening PR before production exposure.
- Do not allow unauthenticated batch job submission under any deployment mode.

## TDD Implementation Order

1. Add tests for remote config parsing:
   - localhost can run without remote auth token.
   - `0.0.0.0` or public host requires `MCP_REMOTE_AUTH_TOKEN`.
   - allowed hosts and origins are parsed predictably.
   - batch tools are disabled by default on remote.

2. Add middleware unit tests:
   - missing bearer token is rejected.
   - wrong bearer token is rejected.
   - valid bearer token is accepted.
   - disallowed `Host` is rejected.
   - disallowed `Origin` is rejected.
   - request bodies over the configured limit are rejected.

3. Add an HTTP MCP integration test:
   - start the HTTP server on a random local port.
   - connect with `StreamableHTTPClientTransport`.
   - run `initialize`.
   - run `tools/list`.
   - call safe no-argument `get_session_info`.
   - assert auth failures return HTTP errors before MCP handling.
   - assert remote tools do not include batch tools unless explicitly enabled.

4. Implement the HTTP entrypoint:
   - keep stdio entrypoint unchanged.
   - reuse `createDatabentoMcpServer`.
   - use stateful Streamable HTTP sessions with `sessionIdGenerator`.
   - expose a script such as `start:http` only after tests pass.

5. Add CI coverage:
   - run the remote HTTP integration test in the default PR gate.
   - keep the test using a test-shaped `DATABENTO_API_KEY`.
   - keep live Databento smoke opt-in only.

6. Add deployment docs:
   - document required env vars.
   - document HTTPS/TLS termination expectation.
   - document that remote endpoint should not be public without auth.
   - document that the first remote implementation is single-user and
     single-instance.

## Verification And Review Workflow

Use this loop for the remote/cloud implementation slice and any follow-up
hardening slice.

1. Write or update failing tests first.
2. Run the targeted tests and confirm they fail for the intended contract
   reasons.
3. Do a local self-check before implementation:
   - tests encode the documented contracts;
   - tests do not call live Databento endpoints;
   - tests do not submit batch jobs;
   - tests do not depend on a fixed port;
   - auth, host, origin, and batch-disabled failure paths are covered.
4. Do not run a review-agent gate at this checkpoint unless the tests reveal
   that the planned architecture no longer fits the SDK or repository shape.
5. Implement the smallest code change that satisfies those tests.
6. Run the targeted tests for the changed slice.
7. Run the full local gate and the remote smoke/integration command:

   ```bash
   npm run test:once
   npm run build
   npm run smoke:mcp
   npm run smoke:mcp:http
   npm audit --omit=dev
   npm pack --dry-run --ignore-scripts --json --cache /tmp/databento-mcp-npm-cache
   ```

8. After the full gate passes, launch two independent review agents with empty
   context.
9. Give each review agent a concrete file list and concrete review task.
10. Tell both agents explicitly:
   - read-only review only;
   - do not run tests;
   - do not edit code;
   - do not expand scope beyond the implemented slice;
   - report only concrete P0/P1/P2 findings with file and line references.
11. If either reviewer reports relevant P0 or P1 findings, fix them, rerun the
   targeted tests, rerun the full gate, and then rerun both clean-context review
   agents.
12. P2 findings can be fixed in the same slice only if they are tightly related
   and low risk; otherwise document them as follow-up work.
13. Do not commit until tests and the required review loop are clean.

## Acceptance Gate

Before considering remote/cloud support complete, run:

```bash
npm run test:once
npm run build
npm run smoke:mcp
npm audit --omit=dev
npm pack --dry-run --ignore-scripts --json --cache /tmp/databento-mcp-npm-cache
```

And add a remote-specific smoke or integration command, for example:

```bash
npm run smoke:mcp:http
```

The remote smoke must not call live Databento endpoints. It should use only safe
MCP methods such as `tools/list` and `get_session_info`.

## Review Checklist

- Stdio Claude Desktop path still works.
- Remote HTTP path uses Streamable HTTP, not stdio.
- Auth is mandatory for non-localhost binds.
- Remote auth is bearer-token based for the MVP.
- Host validation is mandatory for all HTTP binds.
- Origin validation rejects unexpected browser-originated requests.
- Batch tools are not exposed remotely unless explicitly enabled.
- Remote sessions are documented as single-instance/stateful.
- Docs do not suggest deploying plain HTTP directly to the public internet.
- CI covers the remote transport without live Databento API access.
- No credentials are committed or printed.
