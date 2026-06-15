# Repository Instructions

## Working Mode

- Work in TDD order: write or update a failing test first, make the smallest fix, then run the targeted test until it passes.
- Do not treat high unit coverage as enough. MCP compatibility must be verified at the MCP entrypoint, not only through internal clients.
- Keep changes scoped to the bug or repair step being handled. Avoid broad refactors unless the current failing test requires them.
- Do not commit credentials. `DATABENTO_API_KEY` must stay in environment variables or local `.env` files.
- Use the Context7 MCP server for current external library, protocol, and framework documentation before changing related code. Resolve the library ID first, then query the relevant docs.

## Repair Order

1. Claude Desktop compatibility:
   - Correct Claude Desktop configuration documentation.
   - Handle optional MCP `arguments` with `request.params.arguments ?? {}`.
   - Update and verify the MCP TypeScript SDK.
   - Add a stdio MCP smoke/integration test.
2. Timeseries and CSV foundation:
   - Force `encoding: "csv"` wherever code parses CSV.
   - Do not send `end=start` when `end` is omitted.
3. Symbology:
   - Parse real Databento `result` response shapes.
   - Preserve date intervals and expose partial/not-found results.
4. Reference API:
   - Replace non-reference endpoint usage with official Reference API methods.
   - Update tests to use realistic Reference API responses.
5. Batch:
   - Replace fabricated download URLs and filenames with official batch file metadata.
6. MCP integration tests:
   - Re-enable or replace the disabled integration test.
   - Test `tools/list`, `tools/call`, error responses, and no-argument tools.
7. GitHub CI:
   - Add a pull-request CI workflow after `npm run smoke:mcp` exists.
   - Run `npm ci`, targeted/full tests, build, and stdio MCP smoke.
   - Use a Node matrix matching local/support targets, initially Node 22 and 24.
   - Keep live Databento API checks out of the default PR gate.
8. Packaging:
   - Add a package allowlist or `.npmignore`.
   - Verify the published tarball contents.
9. Remote/cloud support:
   - Add Streamable HTTP only after local stdio support is stable.
   - Require auth, HTTPS, and origin validation for remote deployment.

## Verification Commands

Use targeted checks first:

```bash
npm run test:once -- tests/unit/path/to/test.ts
```

Then run the full local gate:

```bash
npm run test:once
npm run build
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

Use Node 22 and 24 in the initial matrix. Keep `DATABENTO_API_KEY` test-shaped for normal CI, for example `db-test-key`.

Do not run live Databento API tests in the default PR gate. Live tests must remain opt-in and secret-backed.

Before adding npm publish or release automation, first fix package contents and dependency audit issues.

## MCP Compatibility Expectations

- Local Claude Desktop support should use stdio transport.
- Remote/cloud support should use Streamable HTTP, not stdio.
- README examples for Claude Desktop should use the current Claude Desktop config path:
  - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
  - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Prefer absolute paths for `node` and the built server file in Claude Desktop examples.

## Test Quality Rules

- Tests should model real Databento response shapes, not simplified objects that only match current implementation assumptions.
- When fixing API clients, add fixtures that cover the official response shape and at least one edge case.
- If a test asserts currently wrong behavior, update the test first so it fails for the right reason.
- Keep MCP entrypoint tests active. Do not leave protocol coverage only in `.disabled` files.
