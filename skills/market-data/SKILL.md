---
name: market-data
description: Market data source routing for Databento and Alpha Vantage MCP workflows
version: 1.0.0
triggers:
  - "databento"
  - "cme market data"
  - "standard cme"
  - "futures quote"
  - "futures historical bars"
  - "cme options"
  - "symbol resolution"
---

# Market Data Skill

Route market-data requests across configured sources. In Claude Code, this skill
includes Databento command scripts installed under
`~/.claude/skills/market-data`. In Claude Desktop, this file is portable routing
guidance only unless it is packaged into a Desktop Extension; actual tool access
comes from configured MCP servers.

Claude Desktop Databento support is provided by an MCP server, not by this skill
file alone. Connect Claude Desktop to the Databento MCP server from the app
configuration or through a packaged extension instead of assuming this file can
run tools by itself. As distributed here, it is not a Claude Desktop extension.

## Scope

- Claude Code: use the Databento commands below when the user asks for
  Databento market data, metadata, symbology, reference data, or batch jobs.
- Multi-source market data: do not treat this skill as the default for every
  market-data request. Databento remains the source of record for Standard CME
  historical data, order-book data, Databento symbology, Databento metadata, and
  Databento batch workflows. Use other configured MCP servers for their own
  domains.
- Claude Desktop: use a configured Databento MCP stdio server or Desktop
  Extension. This skill file documents routing and operating rules; it does not
  provide tools by itself.
- Live Databento API: Databento commands call Databento over the network and
  require a valid `DATABENTO_API_KEY`.
- Side effects: the `batch` command can submit Databento batch jobs. Treat
  `batch submit` as a paid operation unless the user explicitly approves the
  query scope and cost risk.

## Portable Claude Desktop Consumer Contract

This skill may be read or reused by someone outside this repository, including a
Claude Desktop user with their own accounts, keys, and market-data goals.

- Do not assume this repository checkout, build output, `.env` file,
  `~/.claude/skills/market-data`, or local scripts exist for that user.
- Claude Desktop users must configure MCP servers separately: Databento as a
  local MCP server or Desktop Extension, and Alpha Vantage as its own MCP server,
  connector, or extension.
- API keys belong in MCP server environment/configuration or Desktop Extension
  sensitive configuration fields. Do not ask users to paste API keys into prompts,
  this skill file, screenshots, or committed files.
- Verify the user's Databento entitlement profile before applying the Standard
  CME guardrails to large requests. The Standard CME rules in this file describe
  the expected default profile for this project, not every possible Databento
  account.
- If a required MCP server or tool is unavailable, stop and ask for setup rather
  than rerouting to the wrong provider just because another tool is available.
- In Claude Desktop, users should verify connected tools through the app's
  Extensions, Connectors, or Developer settings before asking for live data.

## No External Documentation Assumption

The end user may not have access to this repository, project docs, Databento
docs, Alpha Vantage docs, MCP docs, or setup notes. Do not require the user to open external documentation before using this skill.

Use only the operating rules embedded in this file:

- Route by asset class, market, and task before choosing a tool.
- Prefer Databento for covered CME futures, CME futures options, GLBX.MDP3,
  order-book schemas, Databento symbology, metadata, and batch exports.
- Prefer Alpha Vantage MCP for equities, ETFs, equity options, fundamentals,
  indicators, news/sentiment, macro, FX, crypto, and non-CME commodities.
- Ask one short clarification when an "options" or "market data" request could
  reasonably mean either source.
- For live or potentially large requests, state the selected source, expected
  data shape, date range, adjustment semantics, and cost/volume risk before
  invoking tools.

## Expected Claude Desktop MCP Tools

The skill can guide Claude Desktop only if the user's Claude Desktop instance has
the necessary MCP servers connected.

Databento MCP tools expected for this skill:

- Quote/session safety: `get_futures_quote`, `get_session_info`.
- Timeseries/direct data: `get_historical_bars`, `timeseries_get_range`.
- Symbology: `symbology_resolve`.
- Metadata and entitlement checks: `metadata_list_datasets`,
  `metadata_list_schemas`, `metadata_list_publishers`, `metadata_list_fields`,
  `metadata_get_cost`, `metadata_get_dataset_range`.
- Batch workflows: `batch_submit_job`, `batch_list_jobs`, `batch_download`.
  Batch submit must keep zero-cost preflight enabled by default.
- Reference workflows: `reference_search_securities`,
  `reference_get_corporate_actions`, `reference_get_adjustments`.

Alpha Vantage MCP tools expected for this skill:

- `TOOL_LIST` to discover available Alpha Vantage functions.
- `TOOL_GET` to inspect one function's required parameters and response shape.
- `TOOL_CALL` to invoke the selected function after source and shape are clear.

If one of these MCP servers or required tools is missing, do not improvise with
the wrong provider. Ask the user to install or enable the missing package first.

## Consumer Installation Packages

For a nontechnical Claude Desktop user, distribute this setup as two independent
packages:

- Market Data Skill package: a self-contained `market-data` skill folder whose
  `SKILL.md` includes this routing contract and has no external documentation
  links.
- Databento MCP Desktop Extension package: a local MCP server package, preferably
  MCPB/Desktop Extension format, that installs the Databento MCP server and asks
  for `DATABENTO_API_KEY` through sensitive configuration.

Alpha Vantage MCP should remain a separately configured source unless this
project later builds its own router package. The Databento MCP package must not
bundle or request Alpha Vantage credentials.

## Prerequisites

- Node.js `>=22.15.0`.
- `DATABENTO_API_KEY` in the command environment.
- Built skill scripts installed in `~/.claude/skills/market-data/scripts`.

```bash
export DATABENTO_API_KEY="db-your-api-key-here"
```

## Command Contract

| Script | Path | Command | Live API / side effects |
| --- | --- | --- | --- |
| `get-quote` | `market-data/scripts/get-quote.js` | `node ~/.claude/skills/market-data/scripts/get-quote.js ES` | Live Databento API read. Supports `ES` or `NQ`; default `ES`. |
| `get-historical` | `market-data/scripts/get-historical.js` | `node ~/.claude/skills/market-data/scripts/get-historical.js ES 1d 20` | Live Databento API read. Args: symbol `ES`/`NQ`, timeframe `1h`/`H4`/`1d`; count `1..100` for `1h`/`H4`, `1..10000` for `1d`. |
| `get-session` | `market-data/scripts/get-session.js` | `node ~/.claude/skills/market-data/scripts/get-session.js` | Local session calculation after env/key-format check; optional timestamp argument. |
| `resolve-symbols` | `market-data/scripts/resolve-symbols.js` | `node ~/.claude/skills/market-data/scripts/resolve-symbols.js GLBX.MDP3 ES.FUT raw_symbol instrument_id 2026-06-16` | Live Databento API read. Args: dataset, comma-separated symbols, input type, output type, start date, optional end date. |
| `timeseries` | `market-data/scripts/timeseries.js` | `node ~/.claude/skills/market-data/scripts/timeseries.js GLBX.MDP3 ES.FUT ohlcv-1d 2026-06-01 2026-06-16 100` | Live Databento API read. Args: dataset, symbols, schema, start, optional end, optional limit. Direct output is capped by `MCP_DIRECT_MAX_RECORDS` (default 10000). |
| `metadata` | `market-data/scripts/metadata.js` | `node ~/.claude/skills/market-data/scripts/metadata.js list-datasets` | Live Databento API read. Commands: `list-datasets`, `list-schemas`, `list-publishers`, `list-fields`, `get-cost`, `get-dataset-range`. |
| `batch` | `market-data/scripts/batch.js` | `node ~/.claude/skills/market-data/scripts/batch.js list` | Live Databento API. `list` and `download` read account/job metadata; `submit` runs zero-cost preflight before creating a batch job. |
| `reference` | `market-data/scripts/reference.js` | `node ~/.claude/skills/market-data/scripts/reference.js search GLBX.MDP3 ES.FUT 2026-06-16` | Live Databento API read. Commands: `search`, `corporate-actions`, `adjustments`. |

### Multi-Command Argument Forms

Use these positional forms when calling scripts that dispatch by subcommand:

- `metadata list-datasets [start_date] [end_date]`
- `metadata list-schemas [dataset]`
- `metadata list-publishers [dataset]`
- `metadata list-fields [schema] [encoding]`
- `metadata get-cost dataset start`
- `metadata get-dataset-range [dataset]`
- `batch list [states]`
- `batch submit dataset symbols schema start end`
- `batch download <job_id>`
- `reference search dataset symbols start_date [end_date] [limit]`
- `reference corporate-actions dataset symbols start_date [end_date]`
- `reference adjustments dataset symbols start_date [end_date]`

For `reference` commands, the reference dataset argument is output metadata only;
the underlying Reference API requests are scoped by symbols, symbol type, and
date range rather than a Databento dataset request parameter.

Confirm the dataset, symbols, schema, date range, and cost risk with the user
before running `batch submit`, because it creates a Databento batch job and may
be paid if preflight is disabled or overridden. `batch submit` requires an
explicit `end` and runs Databento `metadata.get_cost` zero-cost preflight by
default.

Historical Standard CME guardrails:

- L0 `ohlcv-1s`, `ohlcv-1m`, `ohlcv-1h`, `ohlcv-1d`, `definition`,
  `statistics`, and `status`: full available history.
- L1 `trades`, `mbp-1`, `tbbo`, `bbo-1s`, and `bbo-1m`: rolling last 12 months.
- L2 `mbp-10` and L3 `mbo`: rolling last 1 month.
- `timeseries` rejects `ALL_SYMBOLS` and caps direct output with
  `MCP_DIRECT_MAX_RECORDS` (default 10000).
- Use `batch submit` for large covered exports, including `ALL_SYMBOLS`.

## Multi-Source Market Data Routing

This environment may have more than one market-data MCP server. Select the
source by task, not by the generic phrase "market data".

| Request type | Preferred source | Reason |
| --- | --- | --- |
| Standard CME futures history, GLBX.MDP3 OHLCV, trades, MBP, MBO, TBBO, BBO, definitions, statistics, status | Databento | Databento remains the source of record for Standard CME historical data and entitlement-controlled bulk exports. |
| CME futures options, options on futures traded on CME, CME option-chain-like workflows, and option symbology tied to CME futures | Databento | These are futures-options workflows, not equity-options workflows. Keep them with Databento when the configured Databento entitlement and dataset cover the request. |
| Databento symbology, dataset metadata, batch job list/download/submit, cost preflight | Databento | These are Databento account and dataset workflows. |
| Broad equity quote/daily/intraday data, company overview, fundamentals, earnings, dividends, splits, news/sentiment, technical indicators, economic indicators, FX, crypto, and commodities not explicitly requested from Databento | Alpha Vantage MCP | Alpha Vantage should handle broad equity and research-style market-data tasks. |
| Equity options, stock options, ETF options, US options chains, and historical options for symbols such as AAPL, SPY, or QQQ | Alpha Vantage MCP | Alpha Vantage MCP handles equity options. Do not route these to Databento just because both sources expose some kind of options data. |
| Ambiguous requests such as "get AAPL market data" | Ask one clarifying question or default to Alpha Vantage MCP unless the user explicitly asks for Databento. | Avoid routing non-CME equity work into the Standard CME Databento policy. |
| Ambiguous "options" requests | Ask whether the user means CME futures options or equity/ETF options. | The word "options" maps to different markets and sources. |

Alpha Vantage MCP is a separate MCP server, not a script in this market-data
skill.
The official Alpha Vantage MCP server exposes functions through wrapper tools:
use `TOOL_LIST` to discover functions, `TOOL_GET` to inspect a function schema,
and `TOOL_CALL` to invoke a function such as `TIME_SERIES_DAILY` or
`COMPANY_OVERVIEW`. Do not call Databento scripts as a fallback for Alpha
Vantage-only tasks.

## Data Shape Differences

Databento and Alpha Vantage do not return interchangeable data shapes. Choose
the source first, then interpret that source's own schema instead of silently
normalizing one provider into the other.

| Dimension | Databento | Alpha Vantage MCP |
| --- | --- | --- |
| Access model | Databento record schemas selected by `dataset`, `symbols`, `schema`, `start`, and `end`. Examples include `trades`, `mbp-1`, `mbp-10`, `mbo`, `tbbo`, `bbo-*`, `ohlcv-*`, `definition`, `statistics`, and `status`. | Alpha Vantage functions discovered with `TOOL_LIST`, inspected with `TOOL_GET`, and invoked with `TOOL_CALL`. Examples include time series, company overview, indicators, news, macro, FX, crypto, commodities, and options functions. |
| Output shape | Schema-specific records, CSV/DBN-style tabular outputs, UTC timestamps, instrument identifiers, and exchange-native market-data fields. | Function-specific and endpoint-specific JSON or CSV payloads whose field names and nesting vary by function. |
| Symbol model | Databento symbol identity models such as `raw_symbol`, `instrument_id`, `continuous`, and CME parent-style symbols. | Public equity/ETF tickers, FX pairs, crypto pairs, commodity/macro function parameters, and Alpha Vantage option-chain parameters. |
| History and granularity | Tick, order-book, bar, definition, statistics, status, and batch exports under Databento entitlement windows. | Function-dependent compact/full outputs, adjusted vs raw equity time series choices, and endpoint-specific freshness/rate-limit constraints. |
| Options data | CME futures options and options on futures when covered by the configured Databento dataset and entitlement. | Equity options, ETF options, US option chains, and historical equity-options style responses. |

Rules for agents:

- Use `TOOL_GET before TOOL_CALL` for nontrivial Alpha Vantage MCP requests so
  the function parameters and response shape are known before invocation.
- Do not describe Alpha Vantage responses as Databento record schemas, and do
  not describe Databento schemas as Alpha Vantage functions.
- When comparing data across sources, call out timestamp/timezone handling,
  adjusted vs raw prices, symbol identity models, depth/granularity, data
  freshness, and entitlement/rate-limit differences.
- Treat Databento batch exports as Databento-specific. Alpha Vantage MCP returns
  function responses, not Databento-style batch job files.

## Routing Examples

- `AAPL options` -> Alpha Vantage MCP, because this means equity options.
- `ES options` -> Databento, because this means CME futures options unless the
  user says otherwise.
- `GLBX.MDP3 mbp-10` -> Databento, because dataset and schema are Databento
  concepts.
- `NVDA fundamentals` -> Alpha Vantage MCP, because fundamentals are an Alpha
  Vantage-style research workflow.
- `SPY 1min bars` -> Alpha Vantage MCP unless the user explicitly asks for
  Databento and accepts that the current Databento policy is Standard CME-focused.
- `compare ES futures and SPY ETF` -> use both sources and label provenance,
  because the instruments live in different source domains.

## When to Use This Skill

- **Standard CME Futures Data**: Get current quotes for ES, NQ, and covered CME futures workflows
- **CME Futures Options Routing**: Keep CME options on futures with Databento when covered
- **Databento Historical Analysis**: Retrieve covered Standard CME OHLCV bars and tick/order-book data for backtesting
- **Symbol Management**: Resolve symbols across different symbology types
- **Batch Operations**: Download large historical datasets efficiently
- **Data Discovery**: Explore available datasets, schemas, and publishers
- **Reference Data**: Access security master, corporate actions, and price adjustments

## Available Capabilities

### 1. Real-Time Futures Quotes
Get current price quotes for ES (E-mini S&P 500) or NQ (E-mini Nasdaq-100) futures.

**Usage**: "Get current ES quote" or "What's the NQ price?"

### 2. Historical Bars
Retrieve OHLCV historical data for futures contracts.

**Usage**: "Get 50 daily bars for ES" or "Show me last 20 hourly NQ candles"

### 3. Session Information
Identify current trading session (Asian/London/NY) based on UTC time.

**Usage**: "What trading session is it?" or "Check current market session"

### 4. Symbol Resolution
Convert symbols between different types (raw_symbol, instrument_id, continuous, etc.).

**Usage**: "Resolve ES.c.0 to instrument ID" or "Convert ESM4 symbol"

### 5. Historical Timeseries
Stream supported market data schemas (trades, MBP, OHLCV) across date ranges.
Direct command output is capped to avoid giant terminal responses.

**Usage**: "Get daily OHLCV data for ES.c.0" or "Fetch MBP-1 data for ES.c.0 from the last week"

### 6. Batch Downloads
Submit jobs for large historical dataset downloads.
Use for large covered exports after confirming scope and cost risk.

**Usage**: "Submit batch job for ES daily data" or "List my batch jobs"

### 7. Metadata Discovery
Explore datasets, schemas, fields, and pricing information.

**Usage**: "List available datasets" or "What schemas does GLBX.MDP3 have?" or "Get cost for data query"

### 8. Reference Data
Access security master database, corporate actions, and price adjustments.

**Usage**: "Search Databento reference data for ES" or "Fetch CME symbol adjustment factors"

## Examples

**Get real-time quote**:
> "Show me the current ES futures quote"

**Historical analysis**:
> "Get the last 100 daily bars for NQ"

**Symbol resolution**:
> "Resolve symbols ['ESM4', 'NQM4'] in GLBX.MDP3 dataset for June 2024"

**Batch download**:
> "Submit a batch job for ES daily OHLCV data from Jan 1 to Dec 31, 2024"

**Metadata query**:
> "What's the cost to download ES daily OHLCV data from Jan 2010 to today?"

**Reference data**:
> "Search Databento reference data for ES symbols in 2024"

## Error Handling

All operations include graceful error handling with clear messages:
- Invalid API key
- Rate limit exceeded
- Invalid symbols or datasets
- Network errors
- Data not available for requested range

## Data Sources

- **Configured Databento default**: Standard CME data from `GLBX.MDP3`.
- **Allowed Databento datasets**: controlled by `MCP_DATABENTO_ALLOWED_DATASETS`
  when explicitly configured by the operator.
- **Broad equities and research data**: route to Alpha Vantage MCP unless the
  user explicitly asks for Databento and the request fits Databento entitlement
  policy.

## Embedded Provider Reference

- Databento Standard CME default dataset: `GLBX.MDP3`.
- Databento L0 full-history schemas: `ohlcv-1s`, `ohlcv-1m`, `ohlcv-1h`,
  `ohlcv-1d`, `definition`, `statistics`, and `status`.
- Databento L1 rolling last-12-month schemas: `trades`, `mbp-1`, `tbbo`,
  `bbo-1s`, and `bbo-1m`.
- Databento L2/L3 rolling last-1-month schemas: `mbp-10` and `mbo`.
- Databento direct timeseries output is capped by `MCP_DIRECT_MAX_RECORDS`
  defaulting to `10000`. Use batch for large covered exports and `ALL_SYMBOLS`.
- Alpha Vantage works through function-style calls. Inspect with `TOOL_GET`
  before `TOOL_CALL` for nontrivial requests.
- Alpha Vantage equity time series can differ by raw versus adjusted output.
  State whether the request needs adjusted or raw prices before comparing with
  Databento outputs.
