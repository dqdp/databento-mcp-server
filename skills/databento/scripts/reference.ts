#!/usr/bin/env node
import { ReferenceClient } from "../../../src/api/reference-client.js";
import * as dotenv from "dotenv";

dotenv.config();

const DATABENTO_API_KEY = process.env.DATABENTO_API_KEY;
if (!DATABENTO_API_KEY) {
  console.error("Error: DATABENTO_API_KEY environment variable is required");
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "search";

  const client = new ReferenceClient(DATABENTO_API_KEY!);

  try {
    switch (command) {
      case "search": {
        // Parse: search dataset symbols start_date [end_date] [limit]
        const dataset = args[1] || "XNAS.ITCH";
        const symbols = args[2] || "AAPL";
        const start_date = args[3] || new Date().toISOString().split("T")[0];
        const end_date = args[4];
        const limit = args[5] ? parseInt(args[5], 10) : undefined;

        const response = await client.searchSecurities({
          dataset,
          symbols,
          start_date,
          end_date,
          limit,
        });

        console.log(JSON.stringify({
          dataset,
          symbols,
          record_count: response.securities.length,
          securities: response.securities,
        }, null, 2));
        break;
      }

      case "corporate-actions": {
        // Parse: corporate-actions dataset symbols start_date [end_date]
        const dataset = args[1] || "XNAS.ITCH";
        const symbols = args[2] || "AAPL";
        const start_date = args[3] || new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
        const end_date = args[4];

        const response = await client.getCorporateActions({
          dataset,
          symbols,
          start_date,
          end_date,
        });

        console.log(JSON.stringify({
          dataset,
          symbols,
          record_count: response.actions.length,
          corporate_actions: response.actions,
        }, null, 2));
        break;
      }

      case "adjustments": {
        // Parse: adjustments dataset symbols start_date [end_date]
        const dataset = args[1] || "XNAS.ITCH";
        const symbols = args[2] || "AAPL";
        const start_date = args[3] || new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
        const end_date = args[4];

        const response = await client.getAdjustmentFactors({
          dataset,
          symbols,
          start_date,
          end_date,
        });

        console.log(JSON.stringify({
          dataset,
          symbols,
          record_count: response.adjustments.length,
          adjustments: response.adjustments,
        }, null, 2));
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        console.error("Available commands: search, corporate-actions, adjustments");
        process.exit(1);
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
