#!/usr/bin/env node
import { DataBentoClient } from "../../../src/databento-client.js";
import * as dotenv from "dotenv";

dotenv.config();

const DATABENTO_API_KEY = process.env.DATABENTO_API_KEY;
if (!DATABENTO_API_KEY) {
  console.error("Error: DATABENTO_API_KEY environment variable is required");
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const symbol = (args[0]?.toUpperCase() || "ES") as "ES" | "NQ";

  if (!["ES", "NQ"].includes(symbol)) {
    console.error(`Error: Symbol must be ES or NQ, got: ${symbol}`);
    process.exit(1);
  }

  try {
    const client = new DataBentoClient(DATABENTO_API_KEY!);
    const quote = await client.getQuote(symbol);

    const result = {
      symbol: quote.symbol,
      price: quote.price,
      bid: quote.bid,
      ask: quote.ask,
      spread: +(quote.ask - quote.bid).toFixed(2),
      timestamp: quote.timestamp.toISOString(),
      dataAge: `${Math.round(quote.dataAge / 1000)}s ago`,
      source: "DataBento",
    };

    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
