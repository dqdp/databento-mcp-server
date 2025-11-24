#!/usr/bin/env node
import { BatchClient } from "../../../src/api/batch-client.js";
import { DataBentoHTTP } from "../../../src/http/databento-http.js";
import type { BatchJobRequest, ListJobsParams } from "../../../src/types/batch.js";
import * as dotenv from "dotenv";

dotenv.config();

const DATABENTO_API_KEY = process.env.DATABENTO_API_KEY;
if (!DATABENTO_API_KEY) {
  console.error("Error: DATABENTO_API_KEY environment variable is required");
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "list";

  const http = new DataBentoHTTP(DATABENTO_API_KEY!);
  const client = new BatchClient(http);

  try {
    switch (command) {
      case "submit": {
        // Parse: submit dataset symbols schema start [end]
        const dataset = args[1] || "GLBX.MDP3";
        const symbolsStr = args[2] || "ES.FUT";
        const symbols = symbolsStr.split(",").map(s => s.trim());
        const schema = args[3] || "ohlcv-1d";
        const start = args[4] || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
        const end = args[5];

        const params: BatchJobRequest = {
          dataset,
          symbols,
          schema: schema as any,
          start,
          end,
        };

        const jobInfo = await client.submitJob(params);
        console.log(JSON.stringify({
          status: "submitted",
          job_id: jobInfo.id,
          state: jobInfo.state,
          dataset: jobInfo.dataset,
          schema: jobInfo.schema,
          symbols_count: jobInfo.symbols.length,
          cost_usd: jobInfo.cost_usd,
          message: "Use 'batch list' or 'batch download <job_id>' to check status",
        }, null, 2));
        break;
      }

      case "list": {
        const params: ListJobsParams = {};
        if (args[1]) {
          params.states = args[1].split(",") as any;
        }
        const jobs = await client.listJobs(params);
        const summary = {
          total_jobs: jobs.length,
          jobs_by_state: jobs.reduce((acc, job) => {
            acc[job.state] = (acc[job.state] || 0) + 1;
            return acc;
          }, {} as Record<string, number>),
          jobs: jobs.map((job) => ({
            id: job.id,
            state: job.state,
            dataset: job.dataset,
            schema: job.schema,
            symbols_count: job.symbols.length,
            cost_usd: job.cost_usd,
          })),
        };
        console.log(JSON.stringify(summary, null, 2));
        break;
      }

      case "download": {
        const job_id = args[1];
        if (!job_id) {
          console.error("Error: job_id required for download command");
          process.exit(1);
        }
        const downloadResult = await client.getDownloadInfo(job_id);
        console.log(JSON.stringify(downloadResult, null, 2));
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        console.error("Available commands: submit, list, download");
        process.exit(1);
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
