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

Access professional market data across all asset classes through the DataBento API. This skill provides real-time quotes, historical data, symbol resolution, batch downloads, metadata discovery, and reference data.

## When to Use This Skill

- **Real-time Market Data**: Get current quotes for ES, NQ, and other futures contracts
- **Historical Analysis**: Retrieve OHLCV bars and tick data for backtesting
- **Symbol Management**: Resolve symbols across different symbology types
- **Batch Operations**: Download large historical datasets efficiently
- **Data Discovery**: Explore available datasets, schemas, and publishers
- **Reference Data**: Access security master, corporate actions, and price adjustments

## Prerequisites

- DataBento API key (set `DATABENTO_API_KEY` environment variable)
- Get your API key at https://databento.com

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
Stream any market data schema (trades, MBP, OHLCV) across date ranges.

**Usage**: "Get trades for SPY on 2024-01-15" or "Fetch MBP-1 data for TSLA"

### 6. Batch Downloads
Submit jobs for large historical dataset downloads.

**Usage**: "Submit batch job for ES daily data" or "List my batch jobs"

### 7. Metadata Discovery
Explore datasets, schemas, fields, and pricing information.

**Usage**: "List available datasets" or "What schemas does GLBX.MDP3 have?" or "Get cost for data query"

### 8. Reference Data
Access security master database, corporate actions, and price adjustments.

**Usage**: "Search securities for AAPL" or "Get dividends for MSFT" or "Fetch adjustment factors"

## Configuration

Set your DataBento API key:
```bash
export DATABENTO_API_KEY="db-your-api-key-here"
```

Or add to your `.env` file:
```
DATABENTO_API_KEY=db-your-api-key-here
DATABENTO_DATASET=GLBX.MDP3
```

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

## Rate Limiting

- Built-in rate limiting (5 requests/second for quotes)
- 30-second cache for frequently accessed data
- Automatic retry with exponential backoff

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
