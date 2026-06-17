#!/usr/bin/env node
import { BatchClient } from "../../../src/api/batch-client.js";
import { MetadataClient } from "../../../src/api/metadata-client.js";
import { DataBentoHTTP } from "../../../src/http/databento-http.js";
import type { BatchJobRequest, ListJobsParams } from "../../../src/types/batch.js";

const DATABENTO_API_KEY = process.env.DATABENTO_API_KEY;
if (!DATABENTO_API_KEY) {
  console.error("Error: DATABENTO_API_KEY environment variable is required");
  process.exit(1);
}

function countBatchSymbols(symbols: string[] | string): number {
  if (Array.isArray(symbols)) {
    return symbols.length;
  }

  return symbols
    .split(",")
    .map((symbol) => symbol.trim())
    .filter(Boolean).length;
}

function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === "") {
    return defaultValue;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`${name} must be a boolean value`);
}

function parseNumberEnv(name: string, defaultValue: number): number {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === "") {
    return defaultValue;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }

  return parsed;
}

async function assertBatchCostPreflight(
  metadataClient: MetadataClient,
  params: BatchJobRequest
): Promise<void> {
  if (!parseBooleanEnv("MCP_REQUIRE_ZERO_COST_PREFLIGHT_FOR_BATCH", true)) {
    return;
  }

  const cost = await metadataClient.getCost({
    dataset: params.dataset,
    symbols: params.symbols,
    schema: params.schema,
    start: params.start,
    end: params.end,
    stype_in: params.stype_in,
    stype_out: params.stype_out,
  });
  const totalCost = Number(cost.total_cost);
  const epsilon = parseNumberEnv("MCP_ZERO_COST_EPSILON_USD", 0);

  if (!Number.isFinite(totalCost)) {
    throw new Error("Databento cost preflight did not return a finite total_cost");
  }

  if (totalCost > epsilon) {
    throw new Error(
      "Databento estimated this covered Standard CME request as billable. " +
        "Refusing to submit batch job automatically; verify the account plan or entitlement policy."
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "list";

  const http = new DataBentoHTTP(DATABENTO_API_KEY!);
  const client = new BatchClient(http);
  const metadataClient = new MetadataClient(http);

  try {
    switch (command) {
      case "submit": {
        // Parse: submit dataset symbols schema start end
        const dataset = args[1] || "GLBX.MDP3";
        const symbolsStr = args[2] || "ES.FUT";
        const symbols = symbolsStr.split(",").map(s => s.trim());
        const schema = args[3] || "ohlcv-1d";
        const start = args[4] || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
        const end = args[5];
        if (!end) {
          throw new Error("end is required for batch submit");
        }

        const params: BatchJobRequest = {
          dataset,
          symbols,
          schema: schema as any,
          start,
          end,
        };

        await assertBatchCostPreflight(metadataClient, params);
        const jobInfo = await client.submitJob(params);
        console.log(JSON.stringify({
          status: "submitted",
          job_id: jobInfo.id,
          state: jobInfo.state,
          dataset: jobInfo.dataset,
          schema: jobInfo.schema,
          symbols_count: countBatchSymbols(jobInfo.symbols),
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
            symbols_count: countBatchSymbols(job.symbols),
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
