# Consumer Distribution Plan

## Goal

Ship a market-data setup that a nontechnical user can install in Claude Desktop
without reading this repository or external documentation.

The distribution must be split into two independent artifacts:

- Artifact A: Market Data Skill Package.
- Artifact B: Databento MCP Desktop Extension Package.

Alpha Vantage MCP remains a separately configured source unless this project
later builds a true multi-source router.

Current repo commands:

```bash
npm run build:consumer
npm run smoke:consumer
```

Current output paths:

- `dist/consumer/market-data-skill/`
- `dist/consumer/databento-mcp-desktop-extension/`
- `dist/consumer/databento-mcp-desktop-extension.mcpb`

## Artifact A: Market Data Skill Package

Purpose:

- Give Claude the routing, safety, and data-shape rules for Databento plus Alpha
  Vantage workflows.
- Work as a self-contained instruction artifact.
- Avoid links to external documentation.

Contents:

- `market-data/SKILL.md`
- Do not include the Claude Code `manifest.json` in the default consumer skill
  artifact unless bundled scripts are also included.
- Generate the default consumer `SKILL.md` from the source skill by stripping
  Claude Code prerequisites, local script paths, and shell command tables.

Non-goals:

- Do not include Databento API keys.
- Do not include Alpha Vantage API keys.
- Do not assume this repository checkout exists.
- Do not require bundled scripts for Claude Desktop use.
- Do not advertise local `node ...scripts` commands in the default consumer
  skill artifact.

Installation UX target:

1. User receives a single `market-data-skill` folder or archive.
2. User imports or places the skill in the host-supported skills location.
3. User asks Claude about market data routing.
4. Claude uses the skill only after the needed MCP servers are connected.

Acceptance Gate:

- `SKILL.md` has no external documentation links.
- `SKILL.md` includes routing, data-shape, options-market split, cost/volume
  guardrails, expected MCP tools, and missing-tool behavior.
- Skill smoke confirms the installed skill exists and loads.

## Artifact B: Databento MCP Desktop Extension Package

Purpose:

- Install the Databento MCP server into Claude Desktop with minimal manual setup.
- Collect `DATABENTO_API_KEY` through sensitive configuration.
- Avoid asking the user to edit JSON by hand.

Preferred format:

- MCPB Desktop Extension archive.

Expected MCPB bundle contents:

- `manifest.json`
- Built server entrypoint, for example `server/index.js`
- Production `node_modules`
- Package metadata needed by the server
- Optional icon/assets

Manifest requirements:

- `manifest_version`: `0.3`
- `server.type`: `node`
- `server.entry_point`: bundled Databento stdio MCP entrypoint
- `server.mcp_config.command`: `node`
- `server.mcp_config.args`: `${__dirname}`-relative server entrypoint
- `user_config.databento_api_key`: string, required, sensitive
- `server.mcp_config.env.DATABENTO_API_KEY`: `${user_config.databento_api_key}`
- `privacy_policies`: Databento privacy policy URL, because the extension sends
  requests to the external Databento service.
- Optional non-sensitive user config:
  - `databento_dataset`, default `GLBX.MDP3`
  - `direct_max_records`, default `10000`
  - `require_zero_cost_preflight_for_batch`, default `true`

No API keys in files:

- Never write real keys into `manifest.json`, `SKILL.md`, scripts, fixtures,
  screenshots, git commits, or release archives.
- Keys must be collected by Claude Desktop as sensitive configuration or passed
  through local environment variables.

Installation UX target:

1. User receives one Databento MCP package file.
2. User opens it in Claude Desktop.
3. Claude Desktop shows an install dialog.
4. User enters the Databento API key into a masked/sensitive field.
5. User confirms install.
6. User checks that Databento tools appear in Claude Desktop connectors or
   extension settings.
7. User asks for a safe smoke request such as session info.

Acceptance Gate:

- The MCP server starts from the extracted `.mcpb` archive without the source
  checkout.
- Missing or malformed API key produces a clear setup error.
- `tools/list` exposes the expected Databento tools.
- Safe `get_session_info` works without large Databento data pulls.
- Batch submit remains guarded by zero-cost preflight.
- No live batch jobs or large timeseries calls run during package smoke tests.

## Operational Handoff

Give the user two files or folders:

- `market-data-skill`: teaches Claude how to route and reason.
- `databento-mcp-desktop-extension`: gives Claude Desktop the Databento tools.

Tell the user only the minimum sequence:

1. Install the Databento MCP package.
2. Enter the Databento API key when Claude Desktop asks.
3. Install or enable Alpha Vantage MCP separately if they need equities,
   equity options, fundamentals, indicators, news, macro, FX, crypto, or
   commodities.
4. Add/import the Market Data skill.
5. Ask Claude to check connected tools before the first live data request.

## Implementation Slices

Completed:

1. Make `SKILL.md` self-contained and link-free.
2. Add tests that enforce the self-contained skill contract.
3. Add an MCPB manifest template for the Databento MCP server.
4. Add a packaging script that builds:
   - `dist/consumer/market-data-skill`
   - `dist/consumer/databento-mcp-desktop-extension`
   - `dist/consumer/databento-mcp-desktop-extension.mcpb`
5. Add a package smoke test that extracts the `.mcpb` archive and runs from the
   extracted artifact, not the source checkout.

Next:

6. Add a manual clean-machine checklist for macOS and Windows.
7. Test the MCPB package in real Claude Desktop on macOS.
8. Test Windows installation behavior or document a fallback path.

## Open Decisions

- Whether the first external handoff should be MCPB-only or also include a
  fallback manual `claude_desktop_config.json` snippet.
- Whether to keep bundling production `node_modules` inside the MCPB artifact or
  publish the MCP server package to npm and use a lighter wrapper.
- Whether to package Alpha Vantage setup guidance as a separate skill-only
  artifact or leave it to the official Alpha Vantage MCP package.
- Whether to add native Windows packaging checks in CI before the first external
  handoff.
