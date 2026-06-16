/**
 * Batch API Tool Handlers
 * To be integrated into src/index.ts
 */

import type { BatchClient } from "./batch-client.js";
import type { BatchJobRequest, ListJobsParams } from "../types/batch.js";
import type { GetCostParams } from "../types/metadata.js";

type BatchCostMetadataClient = {
  getCost(params: GetCostParams): Promise<{ total_cost: number | string }>;
};

function countBatchSymbols(symbols: string[] | string): number {
  if (Array.isArray(symbols)) {
    return symbols.length;
  }

  return symbols
    .split(",")
    .map((symbol) => symbol.trim())
    .filter(Boolean).length;
}

function getBatchDownloadSize(job: { package_size?: number; actual_size?: number; total_size?: number }): number | undefined {
  return job.package_size ?? job.actual_size ?? job.total_size;
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
  metadataClient: BatchCostMetadataClient,
  params: BatchJobRequest
): Promise<void> {
  if (!parseBooleanEnv("MCP_REQUIRE_ZERO_COST_PREFLIGHT_FOR_BATCH", true)) {
    return;
  }

  if (!metadataClient || typeof metadataClient.getCost !== "function") {
    throw new Error("metadataClient with getCost is required for batch cost preflight");
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

/**
 * Tool definitions for batch API
 */
export const batchToolDefinitions = [
  {
    name: "batch_submit_job",
    description: "Submit a batch data download job for large historical datasets. Returns job ID and status. Job processing is asynchronous.",
    inputSchema: {
      type: "object",
      properties: {
        dataset: {
          type: "string",
          description: "Dataset code (e.g., GLBX.MDP3, XNAS.ITCH)",
        },
        symbols: {
          type: "array",
          items: { type: "string" },
          description: "Array of symbols (max 2000)",
          minItems: 1,
          maxItems: 2000,
        },
        schema: {
          type: "string",
          enum: ["trades", "tbbo", "bbo-1s", "bbo-1m", "mbp-1", "mbp-10", "mbo", "ohlcv-1s", "ohlcv-1m", "ohlcv-1h", "ohlcv-1d", "definition", "statistics", "status"],
          description: "Data record schema",
        },
        start: {
          type: "string",
          description: "Start date (YYYY-MM-DD or ISO 8601)",
        },
        end: {
          type: "string",
          description: "Exclusive end date (YYYY-MM-DD or ISO 8601)",
        },
        encoding: {
          type: "string",
          enum: ["dbn", "csv", "json"],
          description: "Output encoding (default: dbn)",
        },
        compression: {
          type: "string",
          enum: ["none", "zstd", "gzip"],
          description: "Compression type (default: zstd)",
        },
        stype_in: {
          type: "string",
          enum: ["instrument_id", "raw_symbol", "continuous", "parent"],
          description: "Input symbology type (default: raw_symbol)",
        },
        stype_out: {
          type: "string",
          enum: ["instrument_id", "raw_symbol", "continuous", "parent"],
          description: "Output symbology type (default: instrument_id)",
        },
        split_duration: {
          type: "string",
          description: "Split files by duration (e.g., day, week, month)",
        },
        split_size: {
          type: "integer",
          minimum: 1,
          description: "Split files by size in bytes",
        },
        split_symbols: {
          type: "boolean",
          description: "Split files by symbol (default: false)",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Limit number of records",
        },
      },
      required: ["dataset", "symbols", "schema", "start", "end"],
    },
  },
  {
    name: "batch_list_jobs",
    description: "List all batch jobs with their current status. Optionally filter by job states or time range.",
    inputSchema: {
      type: "object",
      properties: {
        states: {
          type: "array",
          items: {
            type: "string",
            enum: ["queued", "processing", "done", "expired"],
          },
          description: "Filter by job states",
        },
        since: {
          type: "string",
          description: "Filter jobs since timestamp (ISO 8601)",
        },
      },
    },
  },
  {
    name: "batch_download",
    description: "Get download information for a completed batch job. Returns download URLs and metadata. Does NOT stream file content through MCP.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "Batch job identifier",
        },
      },
      required: ["job_id"],
    },
  },
];

/**
 * Tool handlers for batch API
 * Add these cases to the switch statement in index.ts
 */
export async function handleBatchSubmitJob(
  batchClient: BatchClient,
  metadataClient: BatchCostMetadataClient,
  args: any
) {
  if (args === undefined) {
    throw new Error("metadataClient with getCost is required for batch cost preflight");
  }

  const params = args as BatchJobRequest;
  await assertBatchCostPreflight(metadataClient, params);
  const jobInfo = await batchClient.submitJob(params);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            status: "submitted",
            job_id: jobInfo.id,
            state: jobInfo.state,
            dataset: jobInfo.dataset,
            schema: jobInfo.schema,
            symbols_count: countBatchSymbols(jobInfo.symbols),
            cost_usd: jobInfo.cost_usd,
            date_range: {
              start: jobInfo.start,
              end: jobInfo.end,
            },
            encoding: jobInfo.encoding,
            compression: jobInfo.compression,
            ts_received: jobInfo.ts_received,
            message: "Job submitted successfully. Use batch_list_jobs or batch_download to check status and download files when ready.",
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleBatchListJobs(batchClient: BatchClient, args: any) {
  const params = args as ListJobsParams;
  const jobs = await batchClient.listJobs(params);

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
      date_range: {
        start: job.start,
        end: job.end,
      },
      ts_received: job.ts_received,
      ts_queued: job.ts_queued,
      ts_process_start: job.ts_process_start,
      ts_process_done: job.ts_process_done,
      ts_expiration: job.ts_expiration,
      record_count: job.record_count,
      file_count: job.file_count,
      total_size_bytes: getBatchDownloadSize(job),
    })),
  };

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(summary, null, 2),
      },
    ],
  };
}

export async function handleBatchDownload(batchClient: BatchClient, args: any) {
  const { job_id } = args as { job_id: string };
  const downloadResult = await batchClient.getDownloadInfo(job_id);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(downloadResult, null, 2),
      },
    ],
  };
}
