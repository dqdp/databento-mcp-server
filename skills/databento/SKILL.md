---
name: databento
description: Professional market data access via DataBento API for all asset classes
version: 1.0.0
triggers:
  - "databento"
  - "market data"
  - "futures quote"
  - "historical bars"
  - "symbol resolution"
---

# DataBento Skill

Access professional market data through the Databento API from Claude Code. This
skill is a Claude Code skill with shell scripts installed under
`~/.claude/skills/databento`; it is not a Claude Desktop extension.

Claude Desktop support is provided by the project MCP server, not by this skill.
Connect Claude Desktop to the built MCP stdio server from the app configuration
instead of installing this skill as a desktop extension.

## Scope

- Claude Code: use the commands below when the user asks for Databento market
  data, metadata, symbology, reference data, or batch jobs.
- Claude Desktop: use the MCP stdio server from this repository. This skill file
  documents Claude Code commands only.
- Live Databento API: most commands call Databento over the network and require a
  valid `DATABENTO_API_KEY`.
- Side effects: the `batch` command can submit Databento batch jobs. Treat
  `batch submit` as a paid operation unless the user explicitly approves the
  query scope and cost risk.

## Prerequisites

- Node.js `>=22.15.0`.
- `DATABENTO_API_KEY` in the command environment.
- Built skill scripts installed in `~/.claude/skills/databento/scripts`.

```bash
export DATABENTO_API_KEY="db-your-api-key-here"
```

## Command Contract

| Script | Path | Command | Live API / side effects |
| --- | --- | --- | --- |
| `get-quote` | `databento/scripts/get-quote.js` | `node ~/.claude/skills/databento/scripts/get-quote.js ES` | Live Databento API read. Supports `ES` or `NQ`; default `ES`. |
| `get-historical` | `databento/scripts/get-historical.js` | `node ~/.claude/skills/databento/scripts/get-historical.js ES 1d 20` | Live Databento API read. Args: symbol `ES`/`NQ`, timeframe `1h`/`H4`/`1d`; count `1..100` for `1h`/`H4`, `1..10000` for `1d`. |
| `get-session` | `databento/scripts/get-session.js` | `node ~/.claude/skills/databento/scripts/get-session.js` | Local session calculation after env/key-format check; optional timestamp argument. |
| `resolve-symbols` | `databento/scripts/resolve-symbols.js` | `node ~/.claude/skills/databento/scripts/resolve-symbols.js GLBX.MDP3 ES.FUT raw_symbol instrument_id 2026-06-16` | Live Databento API read. Args: dataset, comma-separated symbols, input type, output type, start date, optional end date. |
| `timeseries` | `databento/scripts/timeseries.js` | `node ~/.claude/skills/databento/scripts/timeseries.js GLBX.MDP3 ES.FUT ohlcv-1d 2026-06-01 2026-06-16 100` | Live Databento API read. Args: dataset, symbols, schema, start, optional end, optional limit. Detailed explicit ranges are capped. |
| `metadata` | `databento/scripts/metadata.js` | `node ~/.claude/skills/databento/scripts/metadata.js list-datasets` | Live Databento API read. Commands: `list-datasets`, `list-schemas`, `list-publishers`, `list-fields`, `get-cost`, `get-dataset-range`. |
| `batch` | `databento/scripts/batch.js` | `node ~/.claude/skills/databento/scripts/batch.js list` | Live Databento API. `list` and `download` read account/job metadata; `submit` creates a batch job and may be paid. |
| `reference` | `databento/scripts/reference.js` | `node ~/.claude/skills/databento/scripts/reference.js search XNAS.ITCH AAPL 2026-06-16` | Live Databento API read. Commands: `search`, `corporate-actions`, `adjustments`. |

### Multi-Command Argument Forms

Use these positional forms when calling scripts that dispatch by subcommand:

- `metadata list-datasets [start_date] [end_date]`
- `metadata list-schemas [dataset]`
- `metadata list-publishers [dataset]`
- `metadata list-fields [schema] [encoding]`
- `metadata get-cost dataset start`
- `metadata get-dataset-range [dataset]`
- `batch list [states]`
- `batch submit dataset symbols schema start [end]`
- `batch download <job_id>`
- `reference search dataset symbols start_date [end_date] [limit]`
- `reference corporate-actions dataset symbols start_date [end_date]`
- `reference adjustments dataset symbols start_date [end_date]`

For `reference` commands, the reference dataset argument is output metadata only;
the underlying Reference API requests are scoped by symbols, symbol type, and
date range rather than a Databento dataset request parameter.

Confirm the dataset, symbols, schema, date range, and cost risk with the user
before running `batch submit`, because it creates a Databento batch job and may
be paid.

Detailed historical range guardrails for explicit `start`/`end` ranges, where
the schema is supported by the selected command:

- `trades`, `tbbo`, `mbp-1`, `mbp-10`, `mbo`, and `ohlcv-1s`: max 1 day.
- `ohlcv-1m`: max 31 days.
- `ohlcv-1h`: max 366 days.
- Daily/eod bars are not capped by this detailed-schema guard.

## When to Use This Skill

- **Real-time Market Data**: Get current quotes for ES, NQ, and other futures contracts
- **Historical Analysis**: Retrieve OHLCV bars and tick data for backtesting
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

**Usage**: "Resolve AAPL to instrument ID" or "Convert ESM4 symbol"

### 5. Historical Timeseries
Stream supported market data schemas (trades, MBP, OHLCV) across date ranges.
Detailed explicit ranges are capped to avoid accidental high-cost requests.

**Usage**: "Get trades for SPY on 2024-01-15" or "Fetch MBP-1 data for TSLA"

### 6. Batch Downloads
Submit jobs for large historical dataset downloads.
Detailed explicit ranges are capped before submitting a paid job.

**Usage**: "Submit batch job for ES daily data" or "List my batch jobs"

### 7. Metadata Discovery
Explore datasets, schemas, fields, and pricing information.

**Usage**: "List available datasets" or "What schemas does GLBX.MDP3 have?" or "Get cost for data query"

### 8. Reference Data
Access security master database, corporate actions, and price adjustments.

**Usage**: "Search securities for AAPL" or "Get dividends for MSFT" or "Fetch adjustment factors"

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
> "What's the cost to download trade data for SPY from Jan-Mar 2024?"

**Reference data**:
> "Get all dividend payments for AAPL in 2024"

## Error Handling

All operations include graceful error handling with clear messages:
- Invalid API key
- Rate limit exceeded
- Invalid symbols or datasets
- Network errors
- Data not available for requested range

## Data Sources

- **CME Group**: ES, NQ, and other CME futures (GLBX.MDP3)
- **Nasdaq**: Equity data (XNAS.ITCH)
- **NYSE**: Equity data (XNYS.TRADES)
- **OPRA**: Options data
- **And more**: See https://databento.com/datasets

## Related Documentation

- [DataBento API Docs](https://docs.databento.com/)
- [Available Schemas](https://docs.databento.com/knowledge-base/new-users/schemas-and-data-formats)
- [Symbol Types](https://docs.databento.com/knowledge-base/symbology)
