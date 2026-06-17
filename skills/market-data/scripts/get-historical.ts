#!/usr/bin/env node
import { DataBentoClient } from "../../../src/databento-client.js";

const DATABENTO_API_KEY = process.env.DATABENTO_API_KEY;
if (!DATABENTO_API_KEY) {
  console.error("Error: DATABENTO_API_KEY environment variable is required");
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments: symbol timeframe count
  const symbol = (args[0]?.toUpperCase() || "ES") as "ES" | "NQ";
  const timeframe = (args[1] || "1d") as "1h" | "H4" | "1d";
  const countArgument = args[2] ?? "20";
  const count = Number(countArgument);

  if (!["ES", "NQ"].includes(symbol)) {
    console.error(`Error: Symbol must be ES or NQ, got: ${symbol}`);
    process.exit(1);
  }

  if (!["1h", "H4", "1d"].includes(timeframe)) {
    console.error(`Error: Timeframe must be 1h, H4, or 1d, got: ${timeframe}`);
    process.exit(1);
  }

  const maxCount = timeframe === "1d" ? 10000 : 100;
  if (!Number.isInteger(count) || count < 1 || count > maxCount) {
    console.error(`Error: Count must be between 1 and ${maxCount} for ${timeframe}, got: ${countArgument}`);
    process.exit(1);
  }

  try {
    const client = new DataBentoClient(DATABENTO_API_KEY!);
    const bars = await client.getHistoricalBars(symbol, timeframe, count);

    const result = {
      symbol,
      timeframe,
      count: bars.length,
      bars: bars.map((bar) => ({
        timestamp: bar.timestamp.toISOString(),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      })),
    };

    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
