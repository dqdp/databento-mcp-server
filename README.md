# DataBento MCP Server & Skills

Professional market data access via DataBento API, available as both an MCP server and Claude Code skills.

## What's New

**Version 3.0 - Dual Deployment: MCP Server + Claude Code Skills**

This project now supports two deployment modes:
- **MCP Server**: Local stdio for Claude Desktop (17 tools) and a remote Streamable HTTP MVP
- **Claude Code Skills**: Native skills for Claude Code CLI (8 skill scripts)

Both modes share the same core functionality:
- Complete Databento API coverage (Timeseries, Metadata, Batch, Symbology, Reference)
- Full Historical API support with flexible schemas
- Real-time futures quotes (ES, NQ)
- Type-safe TypeScript implementation throughout

Choose the deployment that fits your workflow best!

## Features

- 🎯 **Real-time Futures Quotes** - Current prices for ES and NQ contracts
- 📊 **Historical Timeseries** - Stream any market data schema across date ranges
- 📈 **Batch Downloads** - Submit and manage large historical data jobs
- 🔍 **Symbol Resolution** - Resolve symbols to instrument IDs across datasets
- 📚 **Metadata Discovery** - Explore datasets, schemas, fields, and pricing
- 🏢 **Reference Data** - Access security master, corporate actions, and adjustments
- ⏰ **Session Detection** - Automatic Asian/London/NY session identification
- 🚀 **Rate Limiting** - Built-in request throttling and caching (30s TTL)
- 🔒 **Error Handling** - Graceful failures with clear error messages

## Installation

### Prerequisites

- Node.js v22.15+ or compatible runtime with `node:zlib` zstd support. For
  Claude Desktop on macOS, an absolute Node.js path is recommended because GUI
  apps may not inherit your shell `PATH`.
- DataBento API key ([get one here](https://databento.com))
- **For MCP**: Claude Desktop or compatible MCP client
- **For Skills**: Claude Code CLI

### Setup

1. Clone or download this repository:
```bash
cd ~/Dev
git clone <your-repo-url> databento-mcp-server
cd databento-mcp-server
```

2. Install dependencies:
```bash
npm install
```

3. Create `.env` file with your DataBento API key:
```bash
cp .env.example .env
# Edit .env and add your API key
```

Your `.env` should contain:
```
DATABENTO_API_KEY=db-your-api-key-here
DATABENTO_DATASET=GLBX.MDP3
```

4. Choose your deployment mode below

## Configuration

### Option 1: MCP Server (for Claude Desktop)

Build the MCP server:
```bash
npm run build:mcp
```

Run the local MCP stdio smoke test:
```bash
npm run smoke:mcp
```

Add the server to your Claude Desktop configuration:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Use `which node` to find the Node.js path on your machine. On Apple Silicon
macOS with Homebrew, this is often `/opt/homebrew/bin/node`.

```json
{
  "mcpServers": {
    "databento": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/yourusername/Dev/databento-mcp-server/dist/mcp/mcp/index.js"],
      "env": {
        "DATABENTO_API_KEY": "db-your-api-key-here"
      }
    }
  }
}
```

Restart Claude Desktop after editing the configuration file.

Or use `npx` directly if this package is published to npm:
```json
{
  "mcpServers": {
    "databento": {
      "command": "npx",
      "args": ["-y", "databento-mcp-server"],
      "env": {
        "DATABENTO_API_KEY": "db-your-api-key-here"
      }
    }
  }
}
```

### Option 2: Remote MCP Streamable HTTP

The remote HTTP server is intended for self-hosted, single-user deployments.
Keep the local stdio configuration above as the default path for Claude Desktop.

Build and smoke test the HTTP entrypoint:
```bash
npm run build:mcp
npm run smoke:mcp:http
```

Run locally:
```bash
export DATABENTO_API_KEY="db-your-api-key-here"
export MCP_REMOTE_AUTH_TOKEN="change-this-token"
export MCP_HTTP_HOST=127.0.0.1
export MCP_HTTP_PORT=3000
npm run start:http
```

The HTTP endpoint defaults to `http://127.0.0.1:3000/mcp`. Remote clients must
send:
```text
Authorization: Bearer <MCP_REMOTE_AUTH_TOKEN>
```

For non-local deployments, put the Node server behind HTTPS/TLS termination
from your platform or reverse proxy. Configure:
```text
MCP_HTTP_HOST=0.0.0.0
MCP_ALLOWED_HOSTS=your.domain.example
MCP_ALLOWED_ORIGINS=https://your.client.origin.example
MCP_REMOTE_AUTH_TOKEN=<strong-random-token>
TRUST_PROXY=true
```

With `TRUST_PROXY=true`, the server rejects requests unless the trusted reverse
proxy forwards `X-Forwarded-Proto: https`.

Remote batch tools are disabled by default. Set
`MCP_REMOTE_ENABLE_BATCH=true` only when you explicitly want remote clients to
submit and inspect batch jobs.

The first remote implementation is stateful and single-instance. Horizontal
scaling needs sticky sessions, stateless transport, or shared session storage
before multiple instances are safe.

For deployment, reverse proxy, Claude Desktop/Claude app connection, token
rotation, and troubleshooting steps, use the operations runbook:
[`docs/remote-mcp-runbook.md`](docs/remote-mcp-runbook.md).

### Option 3: Claude Code Skills

Install skills:
```bash
npm run install:skills
```

This will:
- Build skill scripts first when `dist/skills` is missing in a source checkout
- Copy the prebuilt skill scripts to `~/.claude/skills/databento/`
- Make scripts executable

When working from a source checkout after changing skill TypeScript, you can also rebuild explicitly:

```bash
npm run build:skills
npm run install:skills
```

Set your API key environment variable:
```bash
export DATABENTO_API_KEY="db-your-api-key-here"
# Or add to your .bashrc/.zshrc for persistence
```

Verify installation:
```bash
node ~/.claude/skills/databento/scripts/get-quote.js ES
```

Run the automated installed-skill smoke without touching your real Claude skills:
```bash
npm run smoke:skills
```

The smoke command creates a temporary `HOME`, runs the installer there, verifies
`SKILL.md`, manifest, all installed scripts, copied shared runtime files, and
the master manifest merge, then checks every installed script fails cleanly
without `DATABENTO_API_KEY`.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABENTO_API_KEY` | ✅ | - | Your DataBento API key (starts with `db-`) |
| `DATABENTO_DATASET` | ❌ | `GLBX.MDP3` | CME dataset for futures data |
| `MCP_HTTP_HOST` | HTTP only | `127.0.0.1` | Bind host for the Streamable HTTP MCP server |
| `MCP_HTTP_PORT` | HTTP only | `3000` | Bind port for the Streamable HTTP MCP server |
| `MCP_HTTP_PATH` | HTTP only | `/mcp` | MCP Streamable HTTP endpoint path |
| `MCP_REMOTE_AUTH_TOKEN` | Remote HTTP | - | Bearer token required for remote/proxy exposure and recommended for all HTTP use |
| `MCP_REMOTE_ENABLE_BATCH` | ❌ | `false` | Enables remote batch tools when set to `true` |
| `MCP_ALLOWED_HOSTS` | HTTP only | `localhost,127.0.0.1` | Comma-separated allowed `Host` hostnames |
| `MCP_ALLOWED_ORIGINS` | HTTP only | `http://localhost:3000,http://127.0.0.1:3000` | Comma-separated allowed browser `Origin` values |
| `MCP_HTTP_BODY_LIMIT_BYTES` | HTTP only | `1048576` | Maximum JSON request body size |
| `TRUST_PROXY` | Remote HTTP | `false` | Require trusted proxy `X-Forwarded-Proto: https` for remote/proxy exposure |

## Available Tools

The MCP server provides 17 tools organized into 6 categories:

| Category | Tools | Description |
|----------|-------|-------------|
| **Original** | 3 tools | ES/NQ futures quotes, session info, historical bars |
| **Timeseries** | 1 tool | Historical market data streaming with flexible schemas |
| **Symbology** | 1 tool | Symbol resolution and conversion |
| **Metadata** | 6 tools | Dataset discovery, schema info, cost estimation |
| **Batch** | 3 tools | Large-scale data download job management |
| **Reference** | 3 tools | Security master, corporate actions, price adjustments |

### Original Tools (Futures & Session)

#### 1. `get_futures_quote`

Get current price quote for ES or NQ futures.

**Input:**
```json
{
  "symbol": "ES"
}
```

**Output:**
```json
{
  "symbol": "ES",
  "price": 5845.25,
  "bid": 5845.00,
  "ask": 5845.50,
  "spread": 0.50,
  "timestamp": "2024-10-02T14:30:00.000Z",
  "dataAge": "15s ago",
  "source": "DataBento"
}
```

#### 2. `get_session_info`

Get current trading session information.

**Input:**
```json
{
  "timestamp": "2024-10-02T14:30:00Z"
}
```
_Note: `timestamp` is optional, defaults to current time_

**Output:**
```json
{
  "currentSession": "NY",
  "sessionStart": "2024-10-02T14:00:00.000Z",
  "sessionEnd": "2024-10-02T22:00:00.000Z",
  "timestamp": "2024-10-02T14:30:00.000Z",
  "utcHour": 14
}
```

**Sessions:**
- **Asian**: 00:00 - 07:00 UTC
- **London**: 07:00 - 14:00 UTC
- **NY**: 14:00 - 22:00 UTC

#### 3. `get_historical_bars`

Get historical OHLCV bars for futures contracts.

**Input:**
```json
{
  "symbol": "NQ",
  "timeframe": "H4",
  "count": 10
}
```

**Output:**
```json
{
  "symbol": "NQ",
  "timeframe": "H4",
  "count": 10,
  "bars": [
    {
      "timestamp": "2024-10-02T00:00:00.000Z",
      "open": 20150.25,
      "high": 20175.50,
      "low": 20145.00,
      "close": 20160.75,
      "volume": 125000
    }
  ]
}
```

**Supported Timeframes:**
- `1h` - Hourly bars
- `H4` - 4-hour bars (aggregated from 1h)
- `1d` - Daily bars

---

### Timeseries Tools

#### 4. `timeseries_get_range`

Stream historical market data with flexible schemas and date ranges. Supports all Databento schemas.

**Input:**
```json
{
  "dataset": "GLBX.MDP3",
  "symbols": "ES.c.0,NQ.c.0",
  "schema": "trades",
  "start": "2024-10-01",
  "end": "2024-10-02",
  "stype_in": "raw_symbol",
  "stype_out": "instrument_id",
  "limit": 1000
}
```

**Supported Schemas:**
- `mbp-1`, `mbp-10` - Market by price (1 or 10 levels)
- `mbo` - Market by order
- `trades` - Trade data
- `ohlcv-1s`, `ohlcv-1m`, `ohlcv-1h`, `ohlcv-1d`, `ohlcv-eod` - OHLCV bars
- `statistics`, `definition`, `imbalance`, `status` - Market metadata

**Output:**
```json
{
  "dataset": "GLBX.MDP3",
  "schema": "trades",
  "symbols": ["ES.c.0"],
  "dateRange": {
    "start": "2024-10-01",
    "end": "2024-10-02"
  },
  "recordCount": 1000,
  "data": "ts_event,ts_recv,ts_in_delta,publisher_id,instrument_id,price,size,action,side,flags,depth,ts_in_delta,sequence\n2024-10-01T09:30:00.123456789Z,2024-10-01T09:30:00.123456999Z,210,1,123456,5845.25,10,T,B,0,0,210,1\n"
}
```

---

### Symbology Tools

#### 5. `symbology_resolve`

Resolve symbols to instrument IDs or other symbol types across a date range.

**Input:**
```json
{
  "dataset": "GLBX.MDP3",
  "symbols": ["ES", "NQ"],
  "stype_in": "continuous",
  "stype_out": "instrument_id",
  "start_date": "2024-10-01",
  "end_date": "2024-10-02"
}
```

**Symbol Types:**
- `raw_symbol` - Native exchange symbol
- `instrument_id` - Databento instrument ID
- `continuous` - Continuous futures (c.0, c.1, etc.)
- `parent` - Parent symbol

**Output:**
```json
{
  "dataset": "GLBX.MDP3",
  "stype_in": "continuous",
  "stype_out": "instrument_id",
  "date_range": {
    "start": "2024-10-01",
    "end": "2024-10-02"
  },
  "symbol_count": 2,
  "result": "partial",
  "mappings": {
    "ES.c.0": "123456"
  },
  "symbols": [
    {
      "input_symbol": "ES.c.0",
      "output_symbols": ["123456"],
      "intervals": [
        {
          "start_date": "2024-10-01",
          "end_date": "2024-10-02",
          "symbol": "123456"
        }
      ]
    }
  ],
  "partial": ["NQ.c.0"],
  "not_found": [],
  "partial_errors": {
    "NQ.c.0": "partial"
  }
}
```

---

### Metadata Tools

#### 6. `metadata_list_datasets`

List all available Databento datasets with optional date range filtering.

**Input:**
```json
{
  "start_date": "2024-01-01",
  "end_date": "2024-12-31"
}
```

**Output:**
```json
{
  "datasets": [
    {
      "dataset": "GLBX.MDP3",
      "description": "CME Globex MDP 3.0",
      "start_date": "2020-01-01",
      "end_date": null
    }
  ],
  "count": 1
}
```

#### 7. `metadata_list_schemas`

List available data schemas for a specific dataset.

**Input:**
```json
{
  "dataset": "GLBX.MDP3"
}
```

**Output:**
```json
{
  "dataset": "GLBX.MDP3",
  "schemas": ["trades", "mbp-1", "mbp-10", "ohlcv-1h", "ohlcv-1d"],
  "count": 5
}
```

#### 8. `metadata_list_publishers`

List publishers with their details, optionally filtered by dataset.

**Input:**
```json
{
  "dataset": "GLBX.MDP3"
}
```

**Output:**
```json
{
  "publishers": [
    {
      "publisher_id": 1,
      "dataset": "GLBX.MDP3",
      "venue": "CME",
      "description": "Chicago Mercantile Exchange"
    }
  ],
  "count": 1,
  "dataset_filter": "GLBX.MDP3"
}
```

#### 9. `metadata_list_fields`

List fields available for a specific schema with their types and descriptions.

**Input:**
```json
{
  "schema": "trades",
  "encoding": "json"
}
```

**Output:**
```json
{
  "schema": "trades",
  "encoding": "json",
  "fields": [
    {
      "name": "ts_event",
      "type": "uint64",
      "description": "Event timestamp in nanoseconds"
    },
    {
      "name": "price",
      "type": "int64",
      "description": "Price in fixed-point notation"
    }
  ],
  "count": 2
}
```

#### 10. `metadata_get_cost`

Calculate the cost in USD for a historical data query before downloading.

**Input:**
```json
{
  "dataset": "GLBX.MDP3",
  "symbols": "ES.c.0",
  "schema": "trades",
  "start": "2024-10-01",
  "end": "2024-10-02",
  "stype_in": "raw_symbol"
}
```

**Output:**
```json
{
  "dataset": "GLBX.MDP3",
  "symbols": ["ES.c.0"],
  "schema": "trades",
  "cost_usd": 15.50,
  "record_count_estimate": 1500000,
  "size_bytes_estimate": 45000000
}
```

#### 11. `metadata_get_dataset_range`

Get the available date range for a dataset.

**Input:**
```json
{
  "dataset": "GLBX.MDP3"
}
```

**Output:**
```json
{
  "dataset": "GLBX.MDP3",
  "start_date": "2020-01-01",
  "end_date": null,
  "description": "Data available from 2020-01-01 to present"
}
```

---

### Batch Tools

#### 12. `batch_submit_job`

Submit a batch data download job for large historical datasets. Returns job ID and status.

**Input:**
```json
{
  "dataset": "GLBX.MDP3",
  "symbols": ["ES.c.0", "NQ.c.0"],
  "schema": "trades",
  "start": "2024-10-01",
  "end": "2024-10-02",
  "encoding": "csv",
  "compression": "zstd",
  "stype_in": "raw_symbol",
  "split_duration": "day"
}
```

**Output:**
```json
{
  "status": "submitted",
  "job_id": "abc123def456",
  "state": "received",
  "dataset": "GLBX.MDP3",
  "schema": "trades",
  "symbols_count": 2,
  "cost_usd": 25.00,
  "date_range": {
    "start": "2024-10-01",
    "end": "2024-10-02"
  },
  "encoding": "csv",
  "compression": "zstd",
  "ts_received": "2024-10-03T10:00:00Z",
  "message": "Job submitted successfully. Use batch_list_jobs or batch_download to check status and download files when ready."
}
```

#### 13. `batch_list_jobs`

List all batch jobs with their current status. Optionally filter by job states or time range.

**Input:**
```json
{
  "states": ["done", "processing"],
  "since": "2024-10-01T00:00:00Z"
}
```

**Output:**
```json
{
  "total_jobs": 5,
  "jobs_by_state": {
    "done": 3,
    "processing": 2
  },
  "jobs": [
    {
      "id": "abc123def456",
      "state": "done",
      "dataset": "GLBX.MDP3",
      "schema": "trades",
      "symbols_count": 2,
      "cost_usd": 25.00,
      "date_range": {
        "start": "2024-10-01",
        "end": "2024-10-02"
      },
      "record_count": 1500000,
      "file_count": 2,
      "total_size_bytes": 45000000,
      "ts_received": "2024-10-03T10:00:00Z",
      "ts_process_done": "2024-10-03T10:15:00Z",
      "ts_expiration": "2024-10-10T10:00:00Z"
    }
  ]
}
```

#### 14. `batch_download`

Get download information for a completed batch job. Returns download URLs and metadata.

**Input:**
```json
{
  "job_id": "abc123def456"
}
```

**Output:**
```json
{
  "job_id": "abc123def456",
  "state": "done",
  "message": "Job completed successfully. 2 file(s) ready for download.",
  "download_info": {
    "id": "abc123def456",
    "state": "done",
    "download_url": "https://api.databento.com/v0/batch/download/user/abc123def456/glbx-mdp3-20241001.trades.csv.zst",
    "download_urls": [
      "https://api.databento.com/v0/batch/download/user/abc123def456/metadata.json",
      "https://api.databento.com/v0/batch/download/user/abc123def456/glbx-mdp3-20241001.trades.csv.zst"
    ],
    "filenames": [
      "metadata.json",
      "glbx-mdp3-20241001.trades.csv.zst"
    ],
    "files": [
      {
        "filename": "metadata.json",
        "size": 1102,
        "hash": "sha256:abc123...",
        "urls": {
          "https": "https://api.databento.com/v0/batch/download/user/abc123def456/metadata.json"
        }
      },
      {
        "filename": "glbx-mdp3-20241001.trades.csv.zst",
        "size": 44000000,
        "hash": "sha256:def456...",
        "urls": {
          "https": "https://api.databento.com/v0/batch/download/user/abc123def456/glbx-mdp3-20241001.trades.csv.zst"
        }
      }
    ],
    "total_size": 45000000,
    "ts_expiration": "2024-10-10T10:00:00Z",
    "record_count": 500000,
    "file_count": 2
  }
}
```

---

### Reference Tools

#### 15. `reference_search_securities`

Search security master database for instrument metadata.

`start_date` is optional. If it is omitted, the tool uses the latest security master snapshot; `limit` is applied locally to the MCP response.

**Input:**
```json
{
  "dataset": "reference",
  "symbols": "ES.c.0,NQ.c.0",
  "start_date": "2024-10-01",
  "end_date": "2024-10-02",
  "limit": 100
}
```

**Output:**
```json
{
  "dataset": "reference",
  "symbols": "ES.c.0,NQ.c.0",
  "date_range": {
    "start": "2024-10-01",
    "end": "2024-10-02"
  },
  "record_count": 2,
  "securities": [
    {
      "instrument_id": "123456",
      "raw_symbol": "ESZ4",
      "description": "E-mini S&P 500 Dec 2024",
      "asset_class": "futures",
      "exchange": "CME",
      "currency": "USD",
      "first_date": "2023-09-18",
      "last_date": "2024-12-20",
      "min_price_increment": 0.25,
      "display_factor": 1.0
    }
  ]
}
```

#### 16. `reference_get_corporate_actions`

Get corporate actions (dividends, splits, etc.) for symbols.

`action_types` maps to Databento corporate action `events` filters, such as `DIV`, `FSPLT`, and `RSPLT`.

**Input:**
```json
{
  "dataset": "reference",
  "symbols": "AAPL,MSFT",
  "start_date": "2024-01-01",
  "end_date": "2024-12-31",
  "action_types": ["DIV", "FSPLT"]
}
```

**Output:**
```json
{
  "dataset": "reference",
  "symbols": "AAPL,MSFT",
  "date_range": {
    "start": "2024-01-01",
    "end": "2024-12-31"
  },
  "record_count": 5,
  "action_types_filter": ["DIV", "FSPLT"],
  "corporate_actions": [
    {
      "security_id": "S-33449",
      "symbol": "AAPL",
      "action_type": "DIV",
      "ex_date": "2024-05-10",
      "record_date": "2024-05-13",
      "payment_date": "2024-05-16",
      "amount": 0.25,
      "currency": "USD"
    }
  ]
}
```

#### 17. `reference_get_adjustments`

Get price adjustment factors for backadjusted prices.

**Input:**
```json
{
  "dataset": "reference",
  "symbols": "AAPL",
  "start_date": "2024-01-01",
  "end_date": "2024-12-31"
}
```

**Output:**
```json
{
  "dataset": "reference",
  "symbols": "AAPL",
  "date_range": {
    "start": "2024-01-01",
    "end": "2024-12-31"
  },
  "record_count": 2,
  "adjustments": [
    {
      "security_id": "S-33449",
      "symbol": "AAPL",
      "effective_date": "2024-05-10",
      "price_factor": 0.998654,
      "volume_factor": 1.0,
      "action_type": "DIV"
    }
  ]
}
```

## Usage Examples

### With Claude Desktop

Once configured, you can ask Claude:

**Original Futures Tools:**

> "What's the current ES price?"

Claude will use the `get_futures_quote` tool to fetch real-time data.

> "Get the last 10 H4 bars for NQ"

Claude will use the `get_historical_bars` tool.

> "What session are we in right now?"

Claude will use the `get_session_info` tool.

**New Databento API Tools:**

> "List all available Databento datasets"

Claude will use `metadata_list_datasets` to show all available datasets.

> "Get trade data for ES on October 1st"

Claude will use `timeseries_get_range` to fetch historical trade data.

> "Resolve the symbol ES.c.0 to instrument ID"

Claude will use `symbology_resolve` to convert symbol types.

> "How much would it cost to download all trades for AAPL in September?"

Claude will use `metadata_get_cost` to calculate the query cost.

> "Submit a batch job for NQ trade data from last week"

Claude will use `batch_submit_job` to create a batch download job.

> "Get security details for ESZ4"

Claude will use `reference_search_securities` to fetch instrument metadata.

> "Get dividend history for AAPL in 2024"

Claude will use `reference_get_corporate_actions` to fetch corporate actions.

### Development Mode

Run the server in development mode with auto-reload:
```bash
npm run dev
```

### Production Mode

Build and run:
```bash
npm run build
npm start
```

## Technical Details

### Data Provider

- **Source**: DataBento CME futures data
- **Symbols**: ES.c.0 (S&P 500), NQ.c.0 (Nasdaq-100)
- **Dataset**: GLBX.MDP3 (CME Globex MDP 3.0)
- **Precision**: Nanosecond timestamps, 1e9 price units

### Caching Strategy

- **Quote Cache**: 30-second TTL (reduces API calls)
- **Weekend Handling**: 7-day lookback for off-hours data
- **Rate Limiting**: Built-in request throttling

### Error Handling

All tools return structured errors:
```json
{
  "error": "No quote data available for ES"
}
```

Common errors:
- Missing API key
- Invalid symbol (only ES/NQ supported)
- No data available (weekends, holidays)
- API rate limit exceeded

## Claude Code Skills Usage

Once installed, the skills can be invoked naturally in Claude Code:

**Get real-time quote:**
```
> Get the current ES futures quote
```

**Historical data:**
```
> Fetch 50 daily bars for NQ
```

**Symbol resolution:**
```
> Resolve ESM4 symbol to instrument ID in GLBX.MDP3
```

**Metadata queries:**
```
> List all available schemas for GLBX.MDP3 dataset
```

**Batch operations:**
```
> List my databento batch jobs
```

The skills are automatically detected based on context and keywords.

## Project Structure

```
databento-mcp-server/
├── src/                      # Shared code (used by both MCP & Skills)
│   ├── databento-client.ts   # Futures client (quotes, bars, sessions)
│   ├── http/
│   │   └── databento-http.ts # Base HTTP client with auth, retry, caching
│   ├── api/                  # API clients
│   │   ├── metadata-client.ts
│   │   ├── timeseries-client.ts
│   │   ├── batch-client.ts
│   │   ├── symbology-client.ts
│   │   └── reference-client.ts
│   └── types/                # TypeScript type definitions
│       ├── metadata.ts
│       ├── timeseries.ts
│       ├── batch.ts
│       ├── symbology.ts
│       └── reference.ts
├── mcp/                      # MCP Server specific code
│   └── index.ts              # MCP server entry point & 17 tool definitions
├── skills/                   # Claude Code Skills
│   ├── databento/
│   │   ├── SKILL.md          # Skill documentation
│   │   ├── scripts/          # 8 executable skill scripts
│   │   │   ├── get-quote.ts
│   │   │   ├── get-historical.ts
│   │   │   ├── get-session.ts
│   │   │   ├── resolve-symbols.ts
│   │   │   ├── timeseries.ts
│   │   │   ├── metadata.ts
│   │   │   ├── batch.ts
│   │   │   └── reference.ts
│   │   └── data/
│   └── manifest.json         # Skills manifest
├── scripts/
│   └── install-skills.sh     # Skill installation script
├── dist/                     # Compiled JavaScript (build output)
│   ├── mcp/                  # MCP server build
│   ├── skills/               # Skills build
│   └── src/                  # Shared code build
├── docs/
│   ├── adrs/                 # Architecture Decision Records
│   └── journals/             # Implementation journals
├── tsconfig.json             # Base TypeScript config
├── tsconfig.mcp.json         # MCP build config
├── tsconfig.skills.json      # Skills build config
├── package.json
├── .env.example
└── README.md
```

## Development

### Building

Build everything:
```bash
npm run build
```

Build MCP server only:
```bash
npm run build:mcp
```

Build skills only:
```bash
npm run build:skills
```

### Adding New Functionality

**For MCP Server:**
1. Add tool definition to `ListToolsRequestSchema` handler in `mcp/index.ts`
2. Implement handler in `CallToolRequestSchema` switch statement
3. Add client method to appropriate API client in `src/api/`
4. Rebuild: `npm run build:mcp`

**For Skills:**
1. Create new script in `skills/databento/scripts/`
2. Import and use shared clients from `src/`
3. Update `skills/manifest.json` with new script
4. Rebuild and install: `npm run build:skills && npm run install:skills`

**For Shared Functionality:**
1. Add logic to appropriate client in `src/api/`
2. Update both MCP and Skills to use it
3. Rebuild both: `npm run build`

### Testing Locally

```bash
# Set API key
export DATABENTO_API_KEY=db-your-key

# Run dev server
npm run dev
```

## Limitations

- **Original Tools**: `get_futures_quote` and `get_historical_bars` only support ES and NQ futures
- **New Tools**: Support all Databento datasets and symbols (GLBX.MDP3, XNAS.ITCH, DBEQ.BASIC, etc.)
- **Data Delay**: Historical API (not tick-by-tick real-time streaming)
- **Weekend Data**: May show stale data on weekends/holidays
- **Rate Limits**: Respects DataBento API limits (60 req/min)
- **Batch Downloads**: Download URLs are returned but file content is not streamed through MCP
- **API Key Permissions**: Access to datasets requires appropriate Databento subscriptions

## Troubleshooting

### "DATABENTO_API_KEY is required"

Ensure your `.env` file contains a valid API key starting with `db-`.

### "No quote data available"

- Check if markets are open (futures trade 23h/day on weekdays)
- Verify your DataBento account has CME futures access
- Check API key permissions

### Remote MCP HTTP 401 errors

For the Streamable HTTP MCP server, `401` means the `Authorization` header is
missing, malformed, or does not match `MCP_REMOTE_AUTH_TOKEN`.

Send:
```text
Authorization: Bearer <MCP_REMOTE_AUTH_TOKEN>
```

### Databento API 401 errors

If a tool call reaches Databento and the upstream API returns `401`, your
`DATABENTO_API_KEY` is invalid, expired, or lacks access. Get a new one from
databento.com or check account permissions.

## License

MIT

## Contributing

Contributions welcome! Please open issues or PRs on GitHub.

## Related Projects

- [GladOSv2](https://github.com/yourusername/GladOSv2) - Trading bot using this MCP server
- [Model Context Protocol](https://modelcontextprotocol.io) - Official MCP documentation

---

Built with ❤️ for the Wolf Agents ecosystem
