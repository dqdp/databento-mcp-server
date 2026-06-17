#!/usr/bin/env node
import { MetadataClient } from "../../../src/api/metadata-client.js";
import { DataBentoHTTP } from "../../../src/http/databento-http.js";

const DATABENTO_API_KEY = process.env.DATABENTO_API_KEY;
if (!DATABENTO_API_KEY) {
  console.error("Error: DATABENTO_API_KEY environment variable is required");
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "list-datasets";

  const http = new DataBentoHTTP(DATABENTO_API_KEY!);
  const client = new MetadataClient(http);

  try {
    switch (command) {
      case "list-datasets": {
        const start_date = args[1];
        const end_date = args[2];
        const datasets = await client.listDatasets({ start_date, end_date });
        console.log(JSON.stringify({ datasets, count: datasets.length }, null, 2));
        break;
      }

      case "list-schemas": {
        const dataset = args[1] || "GLBX.MDP3";
        const schemas = await client.listSchemas({ dataset });
        console.log(JSON.stringify({ dataset, schemas, count: schemas.length }, null, 2));
        break;
      }

      case "list-publishers": {
        const dataset = args[1];
        const publishers = await client.listPublishers(dataset);
        console.log(JSON.stringify({ publishers, count: publishers.length }, null, 2));
        break;
      }

      case "list-fields": {
        const schema = args[1] || "trades";
        const encoding = args[2];
        const fields = await client.listFields({ schema, encoding });
        console.log(JSON.stringify({ schema, fields, count: fields.length }, null, 2));
        break;
      }

      case "get-cost": {
        const dataset = args[1] || "GLBX.MDP3";
        const start = args[2] || new Date().toISOString().split("T")[0];
        const cost = await client.getCost({ dataset, start });
        console.log(JSON.stringify(cost, null, 2));
        break;
      }

      case "get-dataset-range": {
        const dataset = args[1] || "GLBX.MDP3";
        const range = await client.getDatasetRange({ dataset });
        console.log(JSON.stringify({ dataset, ...range }, null, 2));
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        console.error("Available commands: list-datasets, list-schemas, list-publishers, list-fields, get-cost, get-dataset-range");
        process.exit(1);
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
