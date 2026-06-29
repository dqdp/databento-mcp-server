---
name: market-data
description: Market data source routing for Databento and Alpha Vantage MCP workflows
version: 1.1.0
triggers:
  - "databento"
  - "cme market data"
  - "standard cme"
  - "futures quote"
  - "futures historical bars"
  - "cme options"
  - "symbol resolution"
  - "alpha vantage"
  - "stock quote"
  - "stock price"
  - "live data"
  - "realtime quote"
  - "intraday bars"
  - "equity options"
  - "forex"
  - "crypto price"
  - "company fundamentals"
  - "technical indicator"
  - "market data"
---

# Market Data Skill

Route market-data requests across configured sources. In Claude Desktop, this file is portable routing guidance only; actual tool access comes from configured MCP servers.

Claude Desktop Databento support is provided by an MCP server, not by this skill
file alone. Connect Claude Desktop to the Databento MCP server from the app
configuration or through a packaged extension instead of assuming this file can
run tools by itself. As distributed here, it is not a Claude Desktop extension.
Claude Desktop should reach the local server through MCP stdio or a packaged
Desktop Extension, not by running repository-local helper scripts.

## Scope

- Claude Desktop: use configured Databento and Alpha Vantage MCP servers. This
  skill file documents routing and operating rules; it does not provide tools by
  itself.
- Multi-source market data: do not treat this skill as the default for every
  market-data request. Databento remains the source of record for Standard CME
  historical data, order-book data, Databento symbology, Databento metadata, and
  Databento batch workflows. Use other configured MCP servers for their own
  domains.
- Live Databento API: Databento MCP tools call Databento over the network and
  require a valid Databento API key configured in the MCP server or Desktop
  Extension.
- Side effects: Databento batch submit can create Databento batch jobs. Treat
  batch submit as a paid operation unless the user explicitly approves the query
  scope and cost risk.

## Portable Claude Desktop Consumer Contract

This skill may be read or reused by someone outside this repository, including a
Claude Desktop user with their own accounts, keys, and market-data goals.

- Do not assume this repository checkout, build output, local environment files, or local scripts exist for that user.
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
  indicators, news/sentiment, macro, FX, crypto, and non-CME commodities. For
  US equity/ETF quote and time-series requests, default to live data
  (`entitlement=realtime`). FX, crypto, commodities, indices, and macro are
  already live or fixed-cadence and take no `entitlement`. See "Alpha Vantage
  Live Data Defaults (entitlement)".
- Ask one short clarification when an "options" or "market data" request could
  reasonably mean either source.
- For live or potentially large requests, state the selected source, expected
  data shape, date range, adjustment semantics, and cost/volume risk before
  invoking tools. Exception: routine Databento ES/NQ live quote updates,
  routine Alpha Vantage live quotes, and small intraday pulls do not need this
  preamble; default to live data and return it directly when the request is
  unambiguous.

## Expected Claude Desktop MCP Tools

The skill can guide Claude Desktop only if the user's Claude Desktop instance has
the necessary MCP servers connected.

Databento MCP tools expected for this skill:

- Quote/session safety: `get_live_futures_quote` (true Databento Live API
  top-of-book quote update, ES/NQ ONLY), `get_futures_quote` (latest Historical REST quote,
  ES/NQ ONLY), `get_session_info`.
- Timeseries/direct data: `get_historical_bars` (ES/NQ ONLY), `timeseries_get_range`
  (the workhorse for everything else — any dataset/symbol/schema, incl. CL, other
  commodities, and options on futures).
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

## Claude Code Script Commands

These commands are for a Claude Code skill installation that includes the local
scripts. In Claude Desktop, prefer the connected MCP tools from the previous
section instead of shelling out to these paths.

- `get-quote`: `market-data/scripts/get-quote.js`
  - Run: `node ~/.claude/skills/market-data/scripts/get-quote.js ES`
- `get-historical`: `market-data/scripts/get-historical.js`
  - Run: `node ~/.claude/skills/market-data/scripts/get-historical.js ES 1d 100`
- `get-session`: `market-data/scripts/get-session.js`
  - Run: `node ~/.claude/skills/market-data/scripts/get-session.js`
- `resolve-symbols`: `market-data/scripts/resolve-symbols.js`
  - Run: `node ~/.claude/skills/market-data/scripts/resolve-symbols.js GLBX.MDP3 ES.FUT parent instrument_id 2026-06-16`
- `timeseries`: `market-data/scripts/timeseries.js`
  - Run: `node ~/.claude/skills/market-data/scripts/timeseries.js GLBX.MDP3 ES.c.0 ohlcv-1d 2026-06-01 2026-06-16`
- `metadata`: `market-data/scripts/metadata.js`
  - Run: `node ~/.claude/skills/market-data/scripts/metadata.js list-datasets`
  - Forms: `metadata list-datasets [start_date] [end_date]`,
    `metadata list-schemas [dataset]`, `metadata list-publishers [dataset]`,
    `metadata list-fields [schema] [encoding]`,
    `metadata get-cost dataset start`,
    `metadata get-dataset-range [dataset]`.
- `batch`: `market-data/scripts/batch.js`
  - Run: `node ~/.claude/skills/market-data/scripts/batch.js list`
  - Forms: `batch list [states]`,
    `batch submit dataset symbols schema start end`,
    `batch download <job_id>`.
- `reference`: `market-data/scripts/reference.js`
  - Run: `node ~/.claude/skills/market-data/scripts/reference.js search GLBX.MDP3 ES.FUT 2026-06-16`
  - Forms: `reference search dataset symbols start_date [end_date] [limit]`,
    `reference corporate-actions dataset symbols start_date [end_date]`,
    `reference adjustments dataset symbols start_date [end_date]`.

Script notes:

- The reference dataset argument is output metadata only; Databento Reference API
  calls do not require a dataset parameter.
- Session and simple setup scripts perform an env/key-format check only. They do
  not prove live account entitlement or network access.

## Databento MCP Operating Rules

Use Databento through connected MCP tools, not local shell scripts. If the
Databento MCP server or required tool name is missing in Claude Desktop, stop and
ask the user to install or enable the Databento MCP package.

Confirm the dataset, symbols, schema, date range, and cost risk with the user
before calling `batch_submit_job`, because it creates a Databento batch job and
may be paid if zero-cost preflight is disabled or overridden. Batch submit
requires an explicit `end` and should keep Databento `metadata_get_cost`
zero-cost preflight enabled by default.

Historical Standard CME guardrails:

- L0 `ohlcv-1s`, `ohlcv-1m`, `ohlcv-1h`, `ohlcv-1d`, `definition`,
  `statistics`, and `status`: full available history.
- L1 `trades`, `mbp-1`, `tbbo`, `bbo-1s`, and `bbo-1m`: rolling last
  12 months.
- L2 `mbp-10` and L3 `mbo`: rolling last 1 month.
- Direct `timeseries_get_range` rejects `ALL_SYMBOLS` and caps direct output
  with `MCP_DIRECT_MAX_RECORDS` (default 10000).
- Use `batch_submit_job` for large covered exports, including `ALL_SYMBOLS`.

Databento operating reality (verified against the live MCP, 2026-06-29):

- The convenience tools `get_live_futures_quote`, `get_futures_quote`, and
  `get_historical_bars` are hard-wired to ES/NQ only. For every other instrument
  — CL/WTI and other commodities, and ALL options on futures — use
  `timeseries_get_range`.
- `get_live_futures_quote` is the true Databento Live API path. It opens a
  short-lived Raw API socket subscription for `GLBX.MDP3`, `schema=mbp-1`,
  `stype_in=continuous`, and `ES.v.0` or `NQ.v.0`, returns the first
  top-of-book update, then closes the socket. It is a short-lived live update
  tool, not an MBO snapshot tool and not a persistent push/stream tool.
- `get_futures_quote` is the latest quote path via Databento Historical REST
  (`ES.c.0`/`NQ.c.0`) and uses a local 30-second cache. Treat it as a
  separate historical-data feature, not as a degraded live-data mode, and do not
  describe it as true live streaming.
- The Historical API serves intraday/last-24h data at low latency: top-of-book
  and trade schemas (`mbp-1`, `tbbo`, `trades`, `bbo-*`, `ohlcv-1s/1m`) can reach
  near the current catalog frontier, but this is still historical pull data. Deep
  book (`mbo`, `mbp-10`) can lag by hours, so it is NOT near-real-time — do not
  use it for current quotes.
- Always check `metadata_get_dataset_range` for the current `end` first; an `end`
  after the available frontier returns HTTP 422 (`data_end_after_available_end`).
- Symbology combinations are restricted: `raw_symbol`/`continuous`/`parent` inputs
  must use `stype_out=instrument_id` (raw→raw and continuous→raw_symbol both 422).
  Times need full ISO 8601 with seconds and `Z` (e.g. `2026-06-29T09:00:00Z`);
  bare `HH:MM` is rejected.
- Databento returns raw market data only (quotes, book, trades, definitions,
  statistics). It does NOT compute greeks or implied volatility — derive those
  yourself (unlike Alpha Vantage equity options, which include greeks/IV).
- Options on futures: parent symbology is `{ROOT}.OPT` (e.g. WTI options =
  `LO.OPT`). A full chain is thousands of contracts — pull it via
  `batch_submit_job`, not a synchronous parent request. For a synchronous quote,
  target a specific contract by raw symbol. WTI option raw-symbol format:
  `LO{monthcode}{year} {C|P}{strike×100}` — e.g. `LOQ6 C7000` = $70.00 call on the
  August WTI future. (Verified: that contract returned a live two-sided market.)

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

## Alpha Vantage Live Data Defaults (entitlement)

For Alpha Vantage MCP requests, return live data by default. Do not ask the user
whether they want live data and do not add an explanation about end-of-day versus
realtime unless the user asks or unless live data is unavailable for the request.

The `entitlement` parameter only exists on the US equity/ETF price functions.
For every other asset class the data is already live or fixed-cadence and there
is no `entitlement` parameter to set. Verified scope (checked against the
server's `TOOL_GET` schemas):

- Functions that DO accept `entitlement` (US equities/ETFs): `GLOBAL_QUOTE`,
  `REALTIME_BULK_QUOTES`, `TIME_SERIES_INTRADAY`, `TIME_SERIES_DAILY`,
  `TIME_SERIES_DAILY_ADJUSTED`, `TIME_SERIES_WEEKLY`,
  `TIME_SERIES_WEEKLY_ADJUSTED`, `TIME_SERIES_MONTHLY`,
  `TIME_SERIES_MONTHLY_ADJUSTED`.
- Functions that do NOT accept `entitlement` and are already realtime by nature:
  FX (`FX_INTRADAY`, `FX_DAILY`, `FX_WEEKLY`, `FX_MONTHLY`), crypto
  (`CURRENCY_EXCHANGE_RATE`, `CRYPTO_INTRADAY`, `DIGITAL_CURRENCY_*`), live
  metals (`GOLD_SILVER_SPOT`), and the realtime options family.
- Functions with no `entitlement` because they are fixed-cadence or research
  data: commodities (`WTI`, `BRENT`, `NATURAL_GAS`, metals, agricultural),
  macro/economic indicators, index series (`INDEX_DATA`), fundamentals,
  dividends/splits, earnings, and news/sentiment.

Operating rules:

- For the US equity/ETF price functions listed above, pass
  `entitlement=realtime` by default. This is the default even when the user only
  says "quote", "price", "market data", or "live data" without specifying
  entitlement.
- Without `entitlement=realtime`, these functions return the last completed
  session (end-of-day), which looks stale on weekends and market holidays.
  Defaulting to realtime avoids this.
- For FX, crypto, commodities, indices, macro, and any other function that has no
  `entitlement` parameter, just call the function normally. Do NOT add
  `entitlement`; it is not a valid parameter there and may error. The data is
  already live or at its native refresh cadence.
- Historical OHLCV equity series (`TIME_SERIES_DAILY`, `_WEEKLY`, `_MONTHLY`,
  and their adjusted variants, plus `TIME_SERIES_INTRADAY`) accept `entitlement`.
  Passing `entitlement=realtime` does NOT change any past bars; it only makes the
  most recent data point reflect the live, still-forming current-day bar instead
  of the last completed session. So defaulting to realtime is safe for historical
  pulls. Caveat: if the request is a strict backtest on completed candles, the
  current-day bar is in-progress, not a finalized close. Either omit `entitlement`
  for that case or drop the latest in-progress bar before computing.
- **Equity/ETF options (Alpha Vantage)**: for current option-chain data, default
  to the realtime functions — `REALTIME_OPTIONS` (quotes/greeks/IV),
  `REALTIME_OPTIONS_FMV` (fair-value mark), `REALTIME_PUT_CALL_RATIO`,
  `REALTIME_VOLUME_OPEN_INTEREST_RATIO` — rather than the historical ones. Use
  `HISTORICAL_OPTIONS` / `HISTORICAL_PUT_CALL_RATIO` only when a past date is
  requested. These options functions have NO `entitlement` parameter, so do not
  pass one. Liveness is gated at the account/key level by Alpha Vantage's
  "realtime US options data" entitlement: a key that holds it gets live prices
  from these exact same calls automatically, while a key without it receives
  delayed or end-of-day values. The skill therefore always calls the realtime
  options functions by default so that the moment a more advanced (options-
  entitled) key is configured, live option prices flow through with zero changes
  to the call. With the current key, if the user explicitly needs live options
  and the response is not live, tell them the key's plan does not include the
  realtime US options entitlement (upgradeable on the Alpha Vantage side);
  otherwise no explanation is needed.
- **Options on futures are NOT an Alpha Vantage workflow.** CME futures options
  (e.g. options on ES, CL, NG) route to Databento, not to the Alpha Vantage
  options functions above. Alpha Vantage options coverage is equity/ETF options
  only (AAPL, SPY, QQQ, etc.). See the routing table.
- When unsure whether a function accepts `entitlement`, check with `TOOL_GET`
  before `TOOL_CALL` and pass `entitlement=realtime` only if the schema exposes it.
- `entitlement=delayed` (15-minute delayed) is only a fallback to use if a
  realtime equity call is explicitly rejected by the key.

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

- `AAPL options` -> Alpha Vantage MCP, because this means equity options. Default
  to `REALTIME_OPTIONS` (live with an options-entitled key, delayed/EOD otherwise).
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

## Alpha Vantage Capabilities

The connected Alpha Vantage MCP server exposes a broad function set beyond
equities. Discover with `TOOL_LIST`, inspect with `TOOL_GET`, invoke with
`TOOL_CALL`. Major groups:

- US equities/ETFs: `GLOBAL_QUOTE`, `REALTIME_BULK_QUOTES` (up to 100 symbols),
  `TIME_SERIES_INTRADAY` (1/5/15/30/60min), `TIME_SERIES_DAILY[_ADJUSTED]`,
  `TIME_SERIES_WEEKLY[_ADJUSTED]`, `TIME_SERIES_MONTHLY[_ADJUSTED]`,
  `SYMBOL_SEARCH`, `MARKET_STATUS`, `TOP_GAINERS_LOSERS`, `LISTING_STATUS`.
  These accept `entitlement`; default to `realtime` (see the entitlement section).
- Equity/ETF options (equity options only — NOT options on futures, which go to
  Databento): default to the realtime functions `REALTIME_OPTIONS`,
  `REALTIME_OPTIONS_FMV`, `REALTIME_PUT_CALL_RATIO`,
  `REALTIME_VOLUME_OPEN_INTEREST_RATIO` for current chains (greeks/IV available
  via `require_greeks=true`); use `HISTORICAL_OPTIONS` /
  `HISTORICAL_PUT_CALL_RATIO` for past dates. No `entitlement` parameter exists;
  live prices require the key's realtime US options entitlement and otherwise
  return delayed/EOD from the same calls.
- FX: `FX_INTRADAY`, `FX_DAILY`, `FX_WEEKLY`, `FX_MONTHLY` (realtime, no
  entitlement).
- Crypto: `CURRENCY_EXCHANGE_RATE`, `CRYPTO_INTRADAY`, `DIGITAL_CURRENCY_DAILY`,
  `DIGITAL_CURRENCY_WEEKLY`, `DIGITAL_CURRENCY_MONTHLY`.
- Commodities and metals: `WTI`, `BRENT`, `NATURAL_GAS`, `COPPER`, `ALUMINUM`,
  `WHEAT`, `CORN`, `COTTON`, `SUGAR`, `COFFEE`, `ALL_COMMODITIES`,
  `GOLD_SILVER_SPOT` (live spot), `GOLD_SILVER_HISTORY`.
- Indices: `INDEX_DATA` (200+ indices such as SPX, DJI, NDX, VIX, RUT),
  `INDEX_CATALOG`.
- Fundamentals and corporate data: `COMPANY_OVERVIEW`, `ETF_PROFILE`,
  `INCOME_STATEMENT`, `BALANCE_SHEET`, `CASH_FLOW`, `EARNINGS`,
  `EARNINGS_ESTIMATES`, `EARNINGS_CALL_TRANSCRIPT`, `DIVIDENDS`, `SPLITS`,
  `INSIDER_TRANSACTIONS`, `INSTITUTIONAL_HOLDINGS`, `EARNINGS_CALENDAR`,
  `IPO_CALENDAR`.
- Macro/economic (US): `REAL_GDP`, `REAL_GDP_PER_CAPITA`, `TREASURY_YIELD`,
  `FEDERAL_FUNDS_RATE`, `CPI`, `INFLATION`, `RETAIL_SALES`, `DURABLES`,
  `UNEMPLOYMENT`, `NONFARM_PAYROLL`.
- News and analytics: `NEWS_SENTIMENT`, `ANALYTICS_FIXED_WINDOW`,
  `ANALYTICS_SLIDING_WINDOW`.
- Technical indicators (50+): trend/MA (`SMA`, `EMA`, `WMA`, `DEMA`, `TEMA`,
  `VWAP`, `MACD`, ...), momentum (`RSI`, `STOCH`, `CCI`, `MOM`, `ROC`, ...),
  volatility (`BBANDS`, `ATR`, `NATR`, `TRANGE`), volume (`OBV`, `AD`, `ADOSC`,
  `MFI`), and Hilbert-transform cycle indicators.

`PING`, `ADD_TWO_NUMBERS`, `SEARCH`, and `FETCH` are utility/helper functions,
not market data.

## Commodities Coverage (verified)

Two sources cover commodities differently. Route by what the user needs.

Databento GLBX.MDP3 — futures and options on futures (CME/CBOT/NYMEX/COMEX),
full depth, near-real-time top-of-book. Verified front-month roots resolve on
2026-06-29:

- Energy: `CL` (WTI crude), `BZ` (Brent), `NG` (Henry Hub natural gas), `HO`
  (NY Harbor ULSD / heating oil), `RB` (RBOB gasoline).
- Metals: `GC` (gold), `SI` (silver), `HG` (copper), `PL` (platinum), `PA`
  (palladium).
- Grains/oilseeds (CBOT): `ZC` (corn), `ZS` (soybeans), `ZW` (wheat), plus `ZL`
  (soybean oil), `ZM` (soybean meal).
- Livestock (CME): `LE` (live cattle), `HE` (lean hogs), `GF` (feeder cattle).
- Options on any of these via `{ROOT}.OPT` parent (e.g. `LO.OPT` for WTI options).
- NOT in GLBX.MDP3: ICE softs — coffee (`KC`), sugar (`SB`), cotton (`CT`), cocoa
  (`CC`) trade on ICE Futures US, a separate Databento dataset not in this
  subscription. Do not look for them in GLBX.MDP3.
- Constructible from these futures: forward/term-structure curves (pull a root
  across contract months), and crack spreads (CL vs RB and HO). These were
  previously assumed unavailable; with GLBX.MDP3 futures they are computable.

Alpha Vantage — benchmark/global spot price series (NOT futures, no curve, no
options). Verified functions:

- `WTI`, `BRENT`, `NATURAL_GAS` (daily/weekly/monthly), `COPPER`, `ALUMINUM`,
  `WHEAT`, `CORN`, `COTTON`, `SUGAR`, `COFFEE`, `ALL_COMMODITIES` (monthly/
  quarterly/annual), and `GOLD_SILVER_SPOT` (live spot) / `GOLD_SILVER_HISTORY`.
- None take `entitlement`; they are fixed-cadence series, not live ticks.
- Useful when the user wants a benchmark price level/series (incl. softs like
  coffee/sugar/cotton, which Databento GLBX.MDP3 lacks), not exchange microstructure.

Routing: tradeable futures/options, intraday/near-real-time, term structure, or
crack spreads → Databento. Benchmark spot levels and longer macro series, or any
soft commodity → Alpha Vantage.

## Examples

**Get live futures quote**:
> "Show me the current ES futures quote" -> `get_live_futures_quote`.

**Latest historical quote**:
> "Show me the latest ES quote from historical data" -> `get_futures_quote`.

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

**Alpha Vantage live equity quote**:
> "INOD live data" -> `GLOBAL_QUOTE` with `entitlement=realtime`.

**Alpha Vantage intraday**:
> "AAPL 5-minute bars today" -> `TIME_SERIES_INTRADAY` interval=5min,
> `entitlement=realtime`.

**Alpha Vantage FX/crypto**:
> "EUR/USD now" -> `CURRENCY_EXCHANGE_RATE` or `FX_INTRADAY` (no entitlement).
> "BTC price" -> `CURRENCY_EXCHANGE_RATE` (no entitlement).

**Alpha Vantage fundamentals/macro**:
> "MSFT fundamentals" -> `COMPANY_OVERVIEW`. "US CPI" -> `CPI` (no entitlement).

**Alpha Vantage live equity options**:
> "AAPL options chain now" -> `REALTIME_OPTIONS` (add `require_greeks=true` for
> greeks/IV). Returns live with an options-entitled key, delayed/EOD otherwise.
> No `entitlement` parameter. Options on futures (e.g. "ES options") go to
> Databento instead.

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
