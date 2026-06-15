# Architectural Hardening Plan

Last updated: 2026-06-16.

This plan captures the architectural review findings for the Databento MCP
server and turns them into a repair order. The goal is hardening, not a product
rewrite: keep the current stdio MCP path, keep the separate Streamable HTTP
remote entrypoint, and make contracts, skill packaging, and remote operation
stricter.

## Scope

In scope:

- MCP tool argument contracts and validation.
- Claude Code skill metadata, documentation, packaging, and installer checks.
- Remote MCP production hardening that does not change the MVP architecture.
- TDD-first implementation and full local verification gates.

Out of scope for this plan:

- Replacing stdio Claude Desktop support with remote HTTP.
- Building OAuth, multi-user tenancy, billing attribution, or per-user Databento
  keys.
- Adding live Databento API calls to default CI.
- Expanding API coverage beyond the current tool surface.

## Decisions Before Implementation

These decisions narrow the first hardening pass and prevent scope creep.

1. Keep the current lower-level MCP `Server` implementation for the first
   validation slice.
   - Do not migrate the whole server to high-level `McpServer.registerTool` yet.
   - Add explicit Zod validation before dispatching tool calls.
   - Reconsider `McpServer.registerTool` later only if the validation layer stays
     too complex.
   - Use a supported Zod-to-JSON-Schema conversion path for MCP
     `Tool.inputSchema`; do not rely on SDK transitive dependencies or internal
     helper paths.
2. Do not add structured tool outputs in the first validation slice.
   - First stabilize input contracts.
   - Treat `structuredContent` and `outputSchema` as a later API-quality
     improvement.
3. Keep native Windows PowerShell skill installation out of the first pass.
   - Document macOS/Linux bash support.
   - Document Windows support through WSL or Git Bash.
   - Add a PowerShell installer later only if native Windows skill installation
     becomes a real requirement.
4. Add `/healthz` only as part of remote production hardening, not the MCP
   validation slice.
   - It must stay separate from the MCP route.
   - It must not expose secrets, full config, Databento API state, or user data.
5. Keep implementation slices ordered:
   - MCP validation contracts.
   - Skill metadata and `SKILL.md`.
   - Skill installer and CI smoke.
   - Remote production hardening.
6. All skill installer tests and smokes must run with an isolated temporary
   `HOME` or temporary target directory.
   - Do not use the real user `~/.claude/skills` in automated verification.
   - Do not allow installer tests to remove or overwrite a user's installed
     Databento skill.

## Review Findings

### 1. MCP tool schemas are not enforced as runtime contracts

Current state:

- `listDatabentoTools()` exposes manual JSON schemas.
- `createCallToolHandler()` reads `request.params.arguments ?? {}` and uses
  TypeScript casts inside the switch.
- The lower-level SDK `Server.setRequestHandler(...)` path is valid, but it does
  not make the manual tool schemas a single executable source of truth.

Risk:

- Schema and handler behavior can drift.
- Invalid client input can reach Databento client code before being rejected.
- Future tool changes may pass `tools/list` tests while breaking runtime calls.

Hardening:

- Introduce a small tool-definition layer per MCP tool:
  - name
  - description
  - Zod input schema
  - handler
- Generate/export MCP `inputSchema` from the same schema used for runtime parse.
- Treat Zod schemas as the single source of truth for known enabled tools.
- Convert Zod schemas to MCP `Tool.inputSchema` through the chosen supported
  converter, keeping the root input schema as `{ type: "object" }`.
- Validate known enabled `tools/call` requests before calling internal clients.
- Preserve disabled-tool and unknown-tool behavior before schema dispatch.
- Return MCP tool errors with `isError: true` for invalid arguments.
- Remove unguarded `args as ...` usage from handlers.
- Keep the layer deliberately simple; avoid building a framework around the
  current switch statement.

TDD first:

- Add MCP integration tests through `Client.callTool`, not only direct handler
  unit tests.
- Add tests for missing required fields.
- Add tests for invalid enum values.
- Add tests for invalid date/count/range/limit shapes.
- Add a test for non-object `arguments`.
- Assert that invalid input does not call the underlying Databento client.
- Keep existing `tools/list` schema assertions.
- Keep HTTP regression coverage for hidden/disabled remote batch tools.

### 2. Skill metadata does not match the runtime

Current state:

- `skills/manifest.json` declares Node `>=18.0.0` and `ES modules`.
- `package.json` requires Node `>=22.15.0`.
- `tsconfig.json` compiles CommonJS.
- Runtime reference APIs depend on Node zstd support.

Risk:

- Users can install the skill on an unsupported Node version.
- The manifest can mislead tooling and future maintainers.
- Skill compatibility claims can drift from package compatibility.

Hardening:

- Update skill metadata to Node `>=22.15.0`.
- Update module type metadata to CommonJS, or remove the field if it is not part
  of a consumed contract.
- Update or verify `metadata.repository`, `metadata.updated`, and version
  consistency if those fields remain in the consumed manifest contract.
- Keep README, `SKILL.md`, `package.json`, and `skills/manifest.json` aligned.
- Add a lightweight compatibility check in tests or CI.

TDD first:

- Add a manifest/package compatibility check.
- Assert the manifest Node requirement matches `package.json` engines.
- Assert the manifest module type matches package/tsconfig behavior.
- Assert manifest version and maintained metadata do not drift from package/docs
  decisions.

### 3. `SKILL.md` is descriptive, but not operational enough

Current state:

- `SKILL.md` explains what the skill can do.
- It does not fully specify the script command contracts, argument order, safety
  profile, and cost/side-effect profile.

Risk:

- Claude Code or a human operator may infer incorrect script usage.
- Batch operations can be treated as routine even though they may create paid
  jobs or large downloads.
- The skill may be confused with Claude Desktop support.

Hardening:

- Add a command table for every script in `skills/manifest.json`.
- For each script document:
  - command
  - arguments
  - example
  - whether it calls the live Databento API
  - whether it can create a batch job or other paid/side-effecting operation
- State clearly that this is a Claude Code skill.
- State clearly that Claude Desktop should use the MCP stdio server path.

TDD first:

- Add a docs/manifest consistency check:
  - every manifest script appears in `SKILL.md`
  - every documented script exists after build/install
- Extend installed-skill smoke coverage beyond one script.

### 4. Skill installer support is bash-oriented and under-specified

Current state:

- `scripts/install-skills.sh` installs into `~/.claude/skills/databento`.
- CI verifies one installed script fails cleanly without `DATABENTO_API_KEY`.
- Native Windows PowerShell install is not covered.

Risk:

- Windows users may assume native support when the installer needs a
  bash-compatible shell.
- Installed manifest/script path behavior can drift without detection.

Hardening:

- Document supported installer environments explicitly:
  - macOS/Linux bash-compatible shell
  - Windows via WSL/Git Bash
- Do not add native PowerShell install in the first pass.
- Validate installed file layout:
  - `SKILL.md`
  - manifest
  - all scripts
  - copied shared runtime `src`
- Verify installed scripts can resolve their runtime imports.

TDD first:

- Run every installer smoke with an isolated temporary `HOME` or temporary target
  directory.
- Extend the CI installed-skill smoke to inspect the installed tree.
- Run every installed script in a safe no-key mode and assert a clean
  `DATABENTO_API_KEY` error.
- Add a packaging check that validates the npm tarball contains:
  - `scripts/install-skills.sh`
  - `skills/manifest.json`
  - `skills/databento/SKILL.md`
  - compiled skill scripts
  - compiled shared runtime under `dist/skills`
- Add a follow-up PowerShell installer only if native Windows support is a goal.

### 5. Remote MCP is an MVP, not a public production service yet

Current state:

- Remote MCP has a separate Streamable HTTP entrypoint.
- It uses bearer auth, Host/Origin validation, body limits, request timeouts,
  session IDs, per-token/IP rate limiting, safe structured logs, `/healthz`,
  and disables batch tools by default.

Risk:

- A public endpoint with incorrectly tuned rate limiting can still burn API quota
  or server resources.
- Operators have limited visibility into rejected requests, session lifecycle,
  and tool error patterns.

Hardening:

- Keep per-token rate limiting with source-IP fallback at the HTTP entrypoint.
- Keep structured logs without secrets:
  - startup config summary without tokens
  - auth reject
  - host/origin reject
  - session create/close
  - request size reject
  - MCP request failure category
- Keep the minimal `/healthz` endpoint outside the MCP route contract.
- Keep TLS termination at the platform or reverse proxy.
- Keep direct public Node port exposure unsupported.

TDD first:

- Keep unit tests for rate-limit behavior.
- Keep tests that errors/log payloads do not include tokens or Databento keys.
- Keep Streamable HTTP smoke without live Databento calls.

## Recommended Repair Order

1. MCP validation contracts.
2. Skill metadata compatibility.
3. `SKILL.md` operational contract.
4. Skill installer and CI smoke hardening.
5. Remote production hardening: rate limiting, logs, optional health/readiness.
6. Full verification and clean-context review.

## Verification Gate

Run targeted tests for the current slice first, then run the full local gate:

```bash
npm run test:once
npm run build
npm run smoke:mcp
npm run smoke:mcp:http
npm run smoke:skills
npm audit --omit=dev
npm pack --dry-run --ignore-scripts --json --cache /tmp/databento-mcp-npm-cache
```

Default verification must not call the live Databento API and must not submit
batch jobs.

## Review Gate

After test-first changes and implementation:

1. Run targeted tests.
2. Run the full local gate.
3. Launch two independent clean-context reviewers.
4. Give reviewers concrete files and concrete tasks:
   - reviewer 1: MCP contracts, transport, remote security
   - reviewer 2: skill metadata, `SKILL.md`, installer, CI packaging checks
5. Instruct reviewers to stay read-only, not run tests, not edit code, and not
   expand scope beyond the implemented slice.
6. If either reviewer reports relevant P0/P1 findings, fix them, rerun tests and
   the full gate, then rerun both reviewers.
7. Treat P2 findings as in-scope only when they are tightly related and low
   risk; otherwise document them as follow-up.

## Open Questions

Resolved for this plan:

- Native Windows PowerShell skill installation is a follow-up, not part of the
  first hardening pass.
- The first MCP validation slice keeps the current lower-level `Server` and adds
  explicit Zod validation.
- Structured tool outputs are postponed until after input validation is stable.
- Remote `/healthz` is included as `GET /healthz`, outside the MCP route, with
  no Databento calls and no secrets.
- Rate limiting is keyed by valid bearer token and falls back to source IP when
  no valid bearer token is present.
- First structured logs cover startup, auth/host/origin/proxy rejects, request
  size rejects, rate limits, session create/close, and MCP request failures
  without logging secrets, request bodies, or full authorization headers.

Still open:

- None for the current remote hardening slice.
