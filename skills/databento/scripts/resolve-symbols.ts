#!/usr/bin/env node
import { SymbologyClient } from "../../../src/api/symbology-client.js";
import * as dotenv from "dotenv";

dotenv.config();

const DATABENTO_API_KEY = process.env.DATABENTO_API_KEY;
if (!DATABENTO_API_KEY) {
  console.error("Error: DATABENTO_API_KEY environment variable is required");
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments: dataset symbols stype_in stype_out start_date [end_date]
  const dataset = args[0] || "GLBX.MDP3";
  const symbolsStr = args[1] || "ES.FUT";
  const symbols = symbolsStr.split(",").map(s => s.trim());
  const stype_in = args[2] || "raw_symbol";
  const stype_out = args[3] || "instrument_id";
  const start_date = args[4] || new Date().toISOString().split("T")[0];
  const end_date = args[5];

  try {
    const client = new SymbologyClient(DATABENTO_API_KEY!);
    const response = await client.resolve({
      dataset,
      symbols,
      stype_in,
      stype_out,
      start_date,
      end_date,
    });

    const result = {
      dataset,
      stype_in,
      stype_out,
      date_range: {
        start: start_date,
        end: end_date || "open",
      },
      symbol_count: symbols.length,
      result: response.result,
      mappings: response.mappings,
    };

    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
