# Windows Compatibility Review

Date: 2026-06-17

This note records the Windows compatibility questions for the consumer handoff
artifacts after macOS-only manual testing.

## Scope

Reviewed surfaces:

- Claude Desktop consumer skill import: `market-data-skill.zip`
- Claude Desktop Databento MCP extension: `databento-mcp-desktop-extension.mcpb`
- Alpha Vantage MCP remote connector URL
- Legacy Claude Code skill installer path from this repository

## Current External Facts

Claude Code now supports native Windows as well as WSL. The current official
Claude Code setup docs list Windows 10 1809+ / Windows Server 2019+ as supported
and list Bash, Zsh, PowerShell, or CMD as supported shells:
https://code.claude.com/docs/en/setup

The same docs document Windows PowerShell, Windows CMD, and WinGet install paths.
They also state that native Windows and WSL are separate choices:

- Native Windows: good for Windows-native projects and tools.
- WSL 2: good for Linux toolchains or sandboxed command execution.
- WSL 1: fallback when WSL 2 is unavailable.

Claude Code settings docs state that paths shown as `~/.claude` resolve to
`%USERPROFILE%\.claude` on Windows:
https://code.claude.com/docs/en/settings

The MCPB manifest spec uses Node-style platform identifiers, including `win32`
for Windows, and documents `${__dirname}` as a portable extension-directory
variable:
https://raw.githubusercontent.com/modelcontextprotocol/mcpb/main/MANIFEST.md

## Findings

### 1. Consumer Claude Desktop skill should be OS-neutral

`market-data-skill.zip` contains the portable consumer `SKILL.md` only. It does
not depend on shell scripts, `~/.claude/skills`, local Node commands, or this
repository checkout.

Expected Windows risk: low.

Manual Windows check still needed because Claude Desktop UI and skill import
behavior may differ from macOS.

### 2. Databento MCPB is likely cross-platform, but not proven

The MCPB manifest already declares:

- `platforms`: `["darwin", "linux", "win32"]`
- `server.type`: `node`
- `server.entry_point`: `server/mcp/extension-entrypoint.js`
- `mcp_config.args`: `${__dirname}/server/mcp/extension-entrypoint.js`

Local inspection of the built macOS artifact found:

- no native `.node` addons
- no `.dll`, `.so`, or `.dylib` runtime payloads
- no symlinks in the staged extension tree

That makes the packaged server much more likely to run on Windows, because it is
plain JavaScript plus bundled npm dependencies.

Expected Windows risk: medium until tested in real Claude Desktop for Windows.

Main things to verify on Windows:

- Claude Desktop accepts the `.mcpb` file.
- Claude substitutes `${__dirname}` correctly on Windows paths.
- Built-in or provided Node runtime satisfies Node `>=22.15.0`.
- The sensitive `databento_api_key` field is saved and injected into
  `DATABENTO_API_KEY`.
- `get_session_info` works after enabling the extension.

### 3. Alpha Vantage remote connector should be OS-neutral

The Alpha Vantage setup uses a remote HTTPS URL:

```text
https://mcp.alphavantage.co/mcp?apikey=YOUR_ALPHA_VANTAGE_KEY
```

Because this is a remote connector URL, Windows should not need local Python,
Node, `uvx`, or shell setup for Alpha Vantage.

Expected Windows risk: low.

Manual Windows check still needed because Claude Desktop connector UI may differ
from macOS.

### 4. Legacy Claude Code skill installer is separate from the consumer zip

The current nontechnical handoff does not use a script to install the skill.
Claude Desktop imports `market-data-skill.zip` through the UI and unpacks it as a
skill.

This is separate from the repository's developer-oriented Claude Code installer:

```bash
npm run install:skills
```

which runs:

```bash
bash scripts/install-skills.sh
```

That is fine for macOS, Linux, WSL, or Git Bash, but it is not a native
PowerShell installer. It also targets `~/.claude/skills`, which maps to
`%USERPROFILE%\.claude\skills` on Windows only in Claude Code path semantics.

Expected Windows risk: high if someone tries to use the legacy Claude Code
installer directly from native PowerShell.

This does not block the current nontechnical Claude Desktop handoff.

## Recommended Changes

1. Keep the nontechnical instruction focused on Claude Desktop UI installation,
   not Claude Code shell installation.
2. Add a Windows verification checklist before calling the package Windows-ready.
3. Do not promise native Windows support for `npm run install:skills` unless a
   PowerShell installer is added and tested.
4. If native Claude Code skill installation becomes a goal, add:
   - `scripts/install-skills.ps1`
   - Windows path tests for `%USERPROFILE%\.claude\skills`
   - CI or manual gate on a Windows runner
5. For MCPB, add a Windows CI/static check if possible:
   - extract `.mcpb`
   - verify `manifest.json`
   - run the staged `server/mcp/extension-entrypoint.js` under Windows Node
   - call MCP `initialize`, `tools/list`, and `get_session_info`

## Windows Manual Smoke Checklist

On a clean Windows machine with Claude Desktop:

1. Prepare these four files in one folder:
   - `market-data-skill.zip`
   - `databento-mcp-desktop-extension.mcpb`
   - `databento_api_key.txt`
   - `alphavantage_api_key.txt`
2. Install Databento MCP:
   - `+` -> `Connectors` -> `Manage Connectors` -> `+`
   - choose `databento-mcp-desktop-extension.mcpb`
   - paste the key from `databento_api_key.txt`
   - save
   - enable the extension
3. Add Alpha Vantage MCP:
   - `+` -> `Connectors` -> `Manage Connectors` -> `+`
   - add remote URL
   - use `https://mcp.alphavantage.co/mcp?apikey=...`
   - save
   - enable if needed
4. Install the skill:
   - `+` -> `Skills` -> `Manage Skills` -> `+`
   - drag `market-data-skill.zip` into the import area
   - enable if needed
5. Open a new Claude chat and ask:

```text
Проверь подключенные MCP tools. Используй Market Data skill.
Сначала вызови безопасную проверку Databento get_session_info.
Потом проверь, что доступен Alpha Vantage MCP, но не делай больших выгрузок.
```

Pass criteria:

- Databento MCP connects.
- `get_session_info` works.
- Alpha Vantage MCP is visible.
- Market Data skill is visible and routes CME futures to Databento, equities
  and equity options to Alpha Vantage.

## Verdict

The current consumer path is plausibly Windows-compatible, but not yet proven.
The main unsupported Windows surface is the legacy Claude Code
`scripts/install-skills.sh` flow, not the current Claude Desktop handoff flow.

Do not market the package as Windows-tested until the manual Windows smoke
checklist passes on a real Windows Claude Desktop installation.
