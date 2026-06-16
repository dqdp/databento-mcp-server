# Repository Instructions

## Working Mode

- Work in TDD order: write or update a failing test first, make the smallest fix, then run the targeted test until it passes.
- Do not treat high unit coverage as enough. MCP compatibility must be verified at the MCP entrypoint, not only through internal clients.
- Keep changes scoped to the bug or repair step being handled. Avoid broad refactors unless the current failing test requires them.
- Do not commit credentials. `DATABENTO_API_KEY` must stay in environment variables or local `.env` files.
- Use the Context7 MCP server for current external library, protocol, and framework documentation before changing related code. Resolve the library ID first, then query the relevant docs.

## Current Baseline

As of 2026-06-16, the local Claude Desktop / stdio repair track is complete.

Completed baseline:

- Claude Desktop configuration docs use the current config paths and absolute-path guidance.
- The MCP server handles omitted tool `arguments` with `request.params.arguments ?? {}`.
- The MCP TypeScript SDK is updated and verified.
- Stdio MCP smoke and Vitest integration coverage are active.
- Databento timeseries, symbology, reference, and batch contract fixes are in place.
- `get_historical_bars` keeps intraday `1h`/`H4` counts capped at 100 but allows
  daily `1d` counts up to 10,000 for full-history-style daily pulls.
- Historical `timeseries_get_range` and `batch_submit_job` enforce the Standard
  CME entitlement profile:
  - L0 `ohlcv-1s`/`ohlcv-1m`/`ohlcv-1h`/`ohlcv-1d`/`definition`/`statistics`/`status`
    allow the full available window.
  - L1 `trades`/`mbp-1`/`tbbo`/`bbo-1s`/`bbo-1m` allow the rolling last 12 months.
  - L2 `mbp-10` and L3 `mbo` allow the rolling last 1 month.
  - Direct `timeseries_get_range` rejects `ALL_SYMBOLS`, defaults omitted
    `limit` to `MCP_DIRECT_MAX_RECORDS=10000`, and rejects larger direct limits.
  - `batch_submit_job` requires explicit `end`, allows `ALL_SYMBOLS`, and runs a
    zero-cost Databento `metadata.get_cost` preflight by default.
- GitHub CI covers Node 22 and 24 with `npm ci`, tests, build, stdio smoke, Streamable HTTP smoke, and installed-skill smoke.
- Package contents are allowlisted and verified with `npm pack --dry-run`.
- Claude Code skill packaging uses `SKILL.md`, and installed skill runtime imports are verified.

Current local gate:

```bash
npm run test:once
npm run build
npm run smoke:mcp
npm run smoke:mcp:http
npm run smoke:skills
npm audit --omit=dev
npm pack --dry-run --ignore-scripts --json --cache /tmp/databento-mcp-npm-cache
```

Remote/cloud MVP support is implemented as a separate Streamable HTTP entrypoint.
Use `docs/remote-cloud-support-plan.md` for implementation contracts and
`docs/remote-mcp-runbook.md` for operations, deployment, Claude client
connection, token rotation, and troubleshooting. Keep local stdio as the default
Claude Desktop path.

Remote/cloud MVP decisions:

- Build single-user / single-tenant support first.
- Use bearer token auth from `MCP_REMOTE_AUTH_TOKEN`; do not add OAuth in the
  MVP.
- Require `MCP_REMOTE_AUTH_TOKEN` for any public allowed host, public allowed
  origin, non-local bind, or `TRUST_PROXY=true`.
- Use `TRUST_PROXY=true` for remote/proxy exposure and require
  `X-Forwarded-Proto: https` on trusted-proxy requests.
- Disable batch tools on remote by default with `MCP_REMOTE_ENABLE_BATCH=false`.
- Use stateful Streamable HTTP for a single running instance.
- Terminate HTTPS at the platform or reverse proxy.
- Use body limits, request timeouts, per-token/IP rate limiting, structured JSON
  logs without secrets, and a minimal `GET /healthz` outside the MCP route.

Review workflow for completed implementation slices:

- After writing failing tests, run a local self-check that the tests encode the
  intended contracts and avoid live Databento calls, batch submissions, and
  fixed ports.
- Do not run an intermediate review-agent gate unless the tests show that the
  planned architecture no longer fits the SDK or repository shape.
- After implementation, run targeted tests and then the full local gate.
- After the full gate passes, launch two independent review agents with empty
  context.
- Give each reviewer concrete files and concrete review tasks.
- Instruct reviewers to stay read-only, not run tests, not edit code, and not
  expand scope beyond the written slice.
- If either reviewer reports relevant P0/P1 findings, fix them, rerun tests and
  the full gate, then rerun both clean-context reviewers.
- Treat P2 findings as in-scope only when they are tightly related and low risk;
  otherwise document them as follow-up. Do not rerun the reviewer pair only for
  P2/P3 findings.

## Repair Order

1. Done - Claude Desktop compatibility:
   - Correct Claude Desktop configuration documentation.
   - Handle optional MCP `arguments` with `request.params.arguments ?? {}`.
   - Update and verify the MCP TypeScript SDK.
   - Add a stdio MCP smoke/integration test.
2. Done - Timeseries and CSV foundation:
   - Force `encoding: "csv"` wherever code parses CSV.
   - Do not send `end=start` when `end` is omitted.
3. Done - Symbology:
   - Parse real Databento `result` response shapes.
   - Preserve date intervals and expose partial/not-found results.
4. Done - Reference API:
   - Replace non-reference endpoint usage with official Reference API methods.
   - Update tests to use realistic Reference API responses.
5. Done - Batch:
   - Replace fabricated download URLs and filenames with official batch file metadata.
6. Done - MCP integration tests:
   - Re-enable or replace the disabled integration test.
   - Test `tools/list`, `tools/call`, error responses, and no-argument tools.
7. Done - GitHub CI:
   - Add a pull-request CI workflow after `npm run smoke:mcp` exists.
   - Run `npm ci`, targeted/full tests, build, stdio MCP smoke, and HTTP MCP smoke.
   - Use a Node matrix matching local/support targets, initially Node 22 and 24.
   - Keep live Databento API checks out of the default PR gate.
8. Done - Packaging:
   - Add a package allowlist or `.npmignore`.
   - Verify the published tarball contents.
9. Done - Remote/cloud support MVP:
   - Follow `docs/remote-cloud-support-plan.md`.
   - Keep Streamable HTTP separate from local stdio support.
   - Require auth, HTTPS, and origin validation for remote deployment.
   - Keep batch tools disabled on remote by default.

## Verification Commands

Use targeted checks first:

```bash
npm run test:once -- tests/unit/path/to/test.ts
```

Then run the full local gate:

```bash
npm run test:once
npm run build
npm run smoke:mcp
npm run smoke:mcp:http
npm run smoke:skills
```

For packaging and dependency checks:

```bash
npm audit --omit=dev
npm pack --dry-run --ignore-scripts --json --cache /tmp/databento-mcp-npm-cache
```

If normal `npm install` fails because of the user-level npm cache, use a workspace-safe cache:

```bash
npm install --cache /tmp/databento-mcp-npm-cache
```

## Integration And Smoke Tests

Integration tests should run under Vitest and should not call the real Databento API by default.

MCP integration tests should verify the actual MCP layer, not only internal API clients:

- `tools/list` returns the expected tool names and input schemas.
- `tools/call` works for tools with no `arguments`.
- Tool errors are returned as MCP error responses with `isError: true`.
- Tool handlers pass normalized arguments to the underlying clients.
- Fixtures should use realistic Databento response shapes.

Prefer making the MCP server testable by extracting server construction into a factory, for example:

```ts
createDatabentoMcpServer({ clients })
```

The entrypoint should only auto-start in the CLI path. Tests must be able to import the server without starting a long-running stdio process.

Stdio smoke tests should verify that the built server works the same way Claude Desktop will run it:

1. Build the MCP server.
2. Start `node dist/mcp/mcp/index.js` with a test-shaped `DATABENTO_API_KEY`.
3. Connect with an MCP client over stdio.
4. Run `initialize`.
5. Run `tools/list`.
6. Run at least one safe no-argument `tools/call`, such as `get_session_info`.
7. Assert that the process stays alive and returns valid MCP responses.

Streamable HTTP smoke tests should verify the built HTTP entrypoint:

1. Build the MCP server.
2. Start `node dist/mcp/mcp/http.js` on `127.0.0.1` with port `0`, a test-shaped `DATABENTO_API_KEY`, and `MCP_REMOTE_AUTH_TOKEN`.
3. Assert unauthenticated HTTP requests return `401` before MCP handling.
4. Connect with `StreamableHTTPClientTransport`.
5. Run `initialize`, `tools/list`, and safe no-argument `get_session_info`.
6. Assert remote `tools/list` does not expose batch tools by default.

Live Databento smoke tests must be opt-in only:

```bash
DATABENTO_LIVE_SMOKE=1 DATABENTO_API_KEY=db-real-key npm run smoke:live
```

Live smoke tests should use cheap metadata-style calls only. Do not run batch downloads or large timeseries queries in the default test gate.

## GitHub CI Expectations

Add GitHub Actions only after the local MCP smoke command exists, so CI can verify the same subprocess path that Claude Desktop uses.

The default PR workflow should run:

- `npm ci`
- `npm run test:once`
- `npm run build`
- `npm run smoke:mcp`
- `npm run smoke:mcp:http`
- `npm run smoke:skills`

Use Node 22 and 24 in the initial matrix. Keep `DATABENTO_API_KEY` test-shaped for normal CI, for example `db-test-key`.

Do not run live Databento API tests in the default PR gate. Live tests must remain opt-in and secret-backed.

Before adding npm publish or release automation, first fix package contents and dependency audit issues.

## MCP Compatibility Expectations

- Local Claude Desktop support should use stdio transport.
- Remote/cloud support should use Streamable HTTP, not stdio.
- Do not document arbitrary remote HTTP servers as supported in
  `claude_desktop_config.json`; use the Claude Connectors/custom connector UI
  when available, or fall back to local stdio for Claude Desktop.
- Use `docs/remote-mcp-runbook.md` for the current operator-facing remote MCP
  setup steps.
- README examples for Claude Desktop should use the current Claude Desktop config path:
  - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
  - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Prefer absolute paths for `node` and the built server file in Claude Desktop examples.

## Test Quality Rules

- Tests should model real Databento response shapes, not simplified objects that only match current implementation assumptions.
- When fixing API clients, add fixtures that cover the official response shape and at least one edge case.
- If a test asserts currently wrong behavior, update the test first so it fails for the right reason.
- Keep MCP entrypoint tests active. Do not leave protocol coverage only in `.disabled` files.
