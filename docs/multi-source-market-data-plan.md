# Multi-Source Market Data Skill Plan

## Purpose

This plan defines how the market-data Claude Code skill should coexist with other
market-data MCP servers. The next planned source is Alpha Vantage MCP. The goal
is routing clarity: agents should choose a source based on the task and
entitlement model, not because a prompt contains the generic phrase
"market data".

## Portable Claude Desktop Consumer Assumptions

The market-data skill is intended to be portable and not tied to this repository checkout.
Another Claude Desktop user may reuse the routing contract with their
own Databento account, Alpha Vantage account, MCP setup, and market-data goals.

Implications:

- The skill must not assume this repository checkout, build output, local `.env`
  file, or installed `~/.claude/skills/market-data` scripts are available.
- Claude Desktop users need separately configured MCP servers, connectors, or
  Desktop Extensions for Databento and Alpha Vantage before the routing contract
  can result in actual tool calls.
- Secrets should live in MCP server environment/configuration or Desktop
  Extension sensitive configuration fields, not in prompts, screenshots,
  committed files, or the skill text.
- The Standard CME guardrails are this project's default entitlement profile.
  A different user's Databento account may require an explicit entitlement check
  before large direct or batch requests.
- If the necessary Databento or Alpha Vantage tool is unavailable, the agent
  should ask for setup instead of silently falling back to the wrong provider.

## Current Sources

### Databento MCP / Databento Skill

Use Databento for:

- Standard CME historical data under the current entitlement policy.
- GLBX.MDP3 OHLCV, trades, MBP, MBO, TBBO, BBO, definitions, statistics, and
  status.
- Databento symbology and dataset metadata.
- CME futures options and options-on-futures workflows when covered by the
  configured Databento dataset and entitlement.
- Databento batch workflows with `metadata.get_cost` zero-cost preflight.
- Large covered exports, including `ALL_SYMBOLS`, when the batch guardrails pass.

Do not use Databento as a generic fallback for broad equity, fundamental,
technical-indicator, news, or macroeconomic questions unless the user explicitly
asks for Databento and the request fits the configured entitlement policy.

### Alpha Vantage MCP

Use Alpha Vantage MCP for:

- Broad equity quotes and OHLCV requests such as AAPL, MSFT, NVDA, SPY, and
  other public equities or ETFs.
- Equity options, stock options, ETF options, US option chains, and historical
  options for equity symbols.
- Company overview, fundamentals, earnings, dividends, splits, IPO/listing
  utilities, and other research-style endpoints.
- News/sentiment, technical indicators, economic indicators, FX, crypto, and
  commodity datasets when the request is not explicitly a Databento workflow.

Alpha Vantage documents an official MCP server at
<https://mcp.alphavantage.co/>. It supports:

- Remote Claude/connector URL:
  `https://mcp.alphavantage.co/mcp?apikey=YOUR_API_KEY`
- Local stdio launch:
  `uvx marketdata-mcp-server YOUR_API_KEY`
- Wrapper-tool usage:
  `TOOL_LIST` for discovery, `TOOL_GET` for schema inspection, and `TOOL_CALL`
  for invoking functions such as `TIME_SERIES_DAILY` or `COMPANY_OVERVIEW`.

## Data Shape Differences

The routing contract is not only about market coverage. Databento and Alpha
Vantage expose different data models, so agents must interpret each source on
its own terms.

| Dimension | Databento | Alpha Vantage MCP |
| --- | --- | --- |
| Access model | Databento record schemas selected by dataset, symbols, schema, start, and end. | Alpha Vantage functions discovered with `TOOL_LIST`, inspected with `TOOL_GET`, and invoked with `TOOL_CALL`. |
| Output shape | Schema-specific records, CSV/DBN-style tabular outputs, UTC timestamps, instrument IDs, and exchange-native market-data fields. | Function-specific and endpoint-specific JSON or CSV payloads with fields and nesting that vary by function. |
| Symbols | Databento symbol identity models: `raw_symbol`, `instrument_id`, `continuous`, and CME parent-style symbols. | Public equity/ETF tickers, FX/crypto pairs, commodity/macro function parameters, and option-chain parameters. |
| History and granularity | Tick, order-book, bar, definition, statistics, status, and batch exports under Databento entitlement windows. | Function-dependent compact/full outputs, adjusted vs raw equity time series choices, and endpoint-specific freshness/rate-limit constraints. |
| Options | CME futures options and options on futures. | Equity options, ETF options, US option chains, and historical equity-options style responses. |

Operational rule: use `TOOL_GET` before `TOOL_CALL` for nontrivial Alpha Vantage
requests, and do not silently normalize across providers without calling out
timestamp/timezone handling, adjusted vs raw semantics, symbol identity,
depth/granularity, freshness, and entitlement or rate-limit differences.

## Routing Rules

| User intent | Source |
| --- | --- |
| "Get ES/NQ CME futures history" | Databento |
| "Download all covered CME daily bars" | Databento batch |
| "Resolve ES.c.0 to instrument IDs" | Databento |
| "Get CME futures options for ES" | Databento |
| "What Databento schemas are available?" | Databento |
| "Get AAPL daily prices" | Alpha Vantage MCP |
| "Get AAPL option chain" | Alpha Vantage MCP |
| "Historical options for SPY" | Alpha Vantage MCP |
| "Company overview for NVDA" | Alpha Vantage MCP |
| "RSI for MSFT" | Alpha Vantage MCP |
| "US CPI / treasury yield / macro indicator" | Alpha Vantage MCP unless another source is explicitly requested |
| "Market data for AAPL" | Ask one clarifying question or default to Alpha Vantage MCP |
| "Use Databento for AAPL" | Ask for confirmation and explain that the current Databento policy is Standard CME-focused |
| "Get options data" | Ask whether the user means CME futures options or equity/ETF options |

## Skill Changes

Completed in this planning slice:

- Narrow the Databento skill description away from "all asset classes".
- Remove the broad `market data` auto-trigger from `skills/manifest.json`.
- Rename the installed Claude Code skill to `market-data`.
- Remove the broad `historical bars` auto-trigger in favor of futures/CME-specific
  triggers.
- Add a `Multi-Source Market Data Routing` section to `skills/market-data/SKILL.md`.
- Explicitly split CME futures options from equity/ETF options.
- Document data shape differences between Databento record schemas and Alpha
  Vantage functions.
- Document portable Claude Desktop consumer assumptions for users outside this
  repository.
- Document Alpha Vantage MCP as a separate server, not a script bundled with the
  market-data skill.

Future implementation should be separate from this repository unless we decide
to build a true router MCP server. Do not put Alpha Vantage API keys, wrapper
logic, or connector setup into the Databento MCP runtime by default.

## Verification

For this documentation/skill-routing slice:

```bash
npm run test:once -- tests/unit/skill-contract.test.ts
npm run smoke:skills
```

Before committing alongside code changes, use the normal full gate from
`AGENTS.md`.

## Open Questions

- Should Claude Desktop use Alpha Vantage as a remote connector URL or local
  `uvx marketdata-mcp-server` stdio server?
- Where should the Alpha Vantage API key live: Claude connector secret storage,
  local `.env`, or platform-specific key storage?
- Do we need an executable router MCP server, or is the current market-data skill
  routing contract enough?
- Should ambiguous non-CME equity requests default to Alpha Vantage silently, or
  should the agent ask one clarifying question every time?
