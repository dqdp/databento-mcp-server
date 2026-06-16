#!/usr/bin/env node
import { assertDirectTimeseriesLimit, getDirectMaxRecords } from "../../../src/api/direct-response-policy.js";
import { TimeseriesClient } from "../../../src/api/timeseries-client.js";
import { DataBentoHTTP } from "../../../src/http/databento-http.js";

const DATABENTO_API_KEY = process.env.DATABENTO_API_KEY;
if (!DATABENTO_API_KEY) {
  console.error("Error: DATABENTO_API_KEY environment variable is required");
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments: dataset symbols schema start [end] [limit]
  const dataset = args[0] || "GLBX.MDP3";
  const symbols = args[1] || "ES.FUT";
  const schema = args[2] || "ohlcv-1d";
  const start = args[3] || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const end = args[4];

  try {
    const maxRecords = getDirectMaxRecords();
    const limit = args[5] ? parseInt(args[5], 10) : maxRecords;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("limit must be a positive integer");
    }
    assertDirectTimeseriesLimit(limit);

    const http = new DataBentoHTTP(DATABENTO_API_KEY!);
    const client = new TimeseriesClient(http);

    const response = await client.getRange({
      dataset,
      symbols,
      schema,
      start,
      end,
      limit,
    });

    const result = {
      dataset,
      schema: response.schema,
      symbols: response.symbols,
      dateRange: response.dateRange,
      recordCount: response.recordCount,
      data: response.data,
    };

    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
