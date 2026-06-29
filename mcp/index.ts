#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import * as dotenv from "dotenv";
import { DataBentoClient } from "../src/databento-client.js";
import { DataBentoHTTP } from "../src/http/databento-http.js";
import { MetadataClient } from "../src/api/metadata-client.js";
import { TimeseriesClient } from "../src/api/timeseries-client.js";
import { ReferenceClient } from "../src/api/reference-client.js";
import { SymbologyClient } from "../src/api/symbology-client.js";
import { BatchClient } from "../src/api/batch-client.js";
import { DatabentoLiveClient } from "../src/api/live-client.js";
import { getDirectMaxRecords } from "../src/api/direct-response-policy.js";
import type { BatchJobRequest, ListJobsParams } from "../src/types/batch.js";
import {
  listDatabentoToolContracts,
  parseDatabentoToolArguments,
} from "./tool-contracts.js";

export const DATABENTO_MCP_SERVER_VERSION = "1.1.0";

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
  metadataClient: DatabentoMcpClients["metadataClient"],
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

export interface DatabentoMcpClients {
  databentoClient: Pick<DataBentoClient, "getQuote" | "getSessionInfo" | "getHistoricalBars">;
  liveClient: Pick<DatabentoLiveClient, "getLiveFuturesQuote">;
  metadataClient: Pick<
    MetadataClient,
    "listDatasets" | "listSchemas" | "listPublishers" | "listFields" | "getCost" | "getDatasetRange"
  >;
  referenceClient: Pick<ReferenceClient, "searchSecurities" | "getCorporateActions" | "getAdjustmentFactors">;
  timeseriesClient: Pick<TimeseriesClient, "getRange">;
  symbologyClient: Pick<SymbologyClient, "resolve">;
  batchClient: Pick<BatchClient, "submitJob" | "listJobs" | "getDownloadInfo">;
}

export const REMOTE_BATCH_TOOL_NAMES = ["batch_submit_job", "batch_list_jobs", "batch_download"] as const;

export interface DatabentoMcpServerOptions {
  disabledTools?: Iterable<string>;
}

function normalizeDisabledTools(disabledTools: Iterable<string> | undefined): Set<string> {
  return new Set(disabledTools ?? []);
}

export function createDefaultDatabentoMcpClients(apiKey: string): DatabentoMcpClients {
  const http = new DataBentoHTTP(apiKey);

  return {
    databentoClient: new DataBentoClient(apiKey),
    liveClient: new DatabentoLiveClient(apiKey),
    metadataClient: new MetadataClient(http),
    referenceClient: new ReferenceClient(apiKey),
    timeseriesClient: new TimeseriesClient(http),
    symbologyClient: new SymbologyClient(apiKey),
    batchClient: new BatchClient(http),
  };
}

// List available tools
export function listDatabentoTools(options: DatabentoMcpServerOptions = {}): Tool[] {
  const disabledTools = normalizeDisabledTools(options.disabledTools);

  return listDatabentoToolContracts().filter((tool) => !disabledTools.has(tool.name));
}

function createToolErrorResult(error: string): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error }, null, 2),
      },
    ],
    isError: true,
  };
}

// Handle tool calls
function createCallToolHandler(clients: DatabentoMcpClients, options: DatabentoMcpServerOptions = {}) {
  const disabledTools = normalizeDisabledTools(options.disabledTools);

  return async (request: CallToolRequest): Promise<CallToolResult> => {
    const {
      databentoClient,
      liveClient,
      metadataClient,
      referenceClient,
      timeseriesClient,
      symbologyClient,
      batchClient,
    } = clients;
    const { name } = request.params;
    const rawArgs = request.params.arguments ?? {};
    let args: Record<string, unknown> = {};

    if (disabledTools.has(name)) {
      return createToolErrorResult(`Tool is disabled for this transport: ${name}`);
    }

    const parsedArgs = parseDatabentoToolArguments(name, rawArgs);
    if (parsedArgs.status === "invalid") {
      return createToolErrorResult(parsedArgs.error);
    }
    if (parsedArgs.status === "valid") {
      args = parsedArgs.arguments;
    }

    try {
      switch (name) {
      case "get_futures_quote": {
        const { symbol } = args as { symbol: "ES" | "NQ" };
        const quote = await databentoClient.getQuote(symbol);

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

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "get_live_futures_quote": {
        const { symbol, timeout_ms } = args as { symbol: "ES" | "NQ"; timeout_ms?: number };
        const quote = await liveClient.getLiveFuturesQuote(symbol, {
          timeoutMs: timeout_ms,
        });

        const result = {
          symbol: quote.symbol,
          liveSymbol: quote.liveSymbol,
          dataset: quote.dataset,
          schema: quote.schema,
          price: quote.price,
          bid: quote.bid,
          ask: quote.ask,
          spread: +(quote.ask - quote.bid).toFixed(2),
          bidSize: quote.bidSize,
          askSize: quote.askSize,
          bidCount: quote.bidCount,
          askCount: quote.askCount,
          timestamp: quote.timestamp.toISOString(),
          receiveTimestamp: quote.receiveTimestamp.toISOString(),
          dataAge: `${Math.round(quote.dataAge / 1000)}s ago`,
          sessionId: quote.sessionId,
          source: "DataBento Live API",
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "get_session_info": {
        const { timestamp } = args as { timestamp?: string };
        const ts = timestamp ? new Date(timestamp) : undefined;
        const sessionInfo = databentoClient.getSessionInfo(ts);

        const result = {
          currentSession: sessionInfo.currentSession,
          sessionStart: sessionInfo.sessionStart.toISOString(),
          sessionEnd: sessionInfo.sessionEnd.toISOString(),
          timestamp: sessionInfo.timestamp.toISOString(),
          utcHour: sessionInfo.timestamp.getUTCHours(),
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "get_historical_bars": {
        const { symbol, timeframe, count } = args as {
          symbol: "ES" | "NQ";
          timeframe: "1h" | "H4" | "1d";
          count: number;
        };

        const bars = await databentoClient.getHistoricalBars(symbol, timeframe, count);

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

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "symbology_resolve": {
        const { dataset, symbols, stype_in, stype_out, start_date, end_date } = args as {
          dataset: string;
          symbols: string[];
          stype_in: string;
          stype_out: string;
          start_date: string;
          end_date?: string;
        };

        const response = await symbologyClient.resolve({
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
            end: end_date || "forward_filled",
          },
          symbol_count: symbols.length,
          result: response.result,
          mappings: response.mappings,
          symbols: response.symbols,
          partial: response.partial,
          not_found: response.not_found,
          partial_errors: response.partial_errors,
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "timeseries_get_range": {
        const { dataset, symbols, schema, start, end, stype_in, stype_out, limit } = args as {
          dataset: string;
          symbols: string;
          schema: string;
          start: string;
          end?: string;
          stype_in?: string;
          stype_out?: string;
          limit?: number;
        };
        const effectiveLimit = limit ?? getDirectMaxRecords();

        const response = await timeseriesClient.getRange({
          dataset,
          symbols,
          schema,
          start,
          end,
          stype_in,
          stype_out,
          limit: effectiveLimit,
        });

        const result = {
          dataset,
          schema: response.schema,
          symbols: response.symbols,
          dateRange: response.dateRange,
          recordCount: response.recordCount,
          data: response.data,
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "metadata_list_datasets": {
        const { start_date, end_date } = args as {
          start_date?: string;
          end_date?: string;
        };

        const datasets = await metadataClient.listDatasets({ start_date, end_date });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  datasets,
                  count: datasets.length,
                  filters: { start_date, end_date },
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "metadata_list_schemas": {
        const { dataset } = args as { dataset: string };

        const schemas = await metadataClient.listSchemas({ dataset });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  dataset,
                  schemas,
                  count: schemas.length,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "metadata_list_publishers": {
        const { dataset } = args as { dataset?: string };

        const publishers = await metadataClient.listPublishers(dataset);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  publishers,
                  count: publishers.length,
                  dataset_filter: dataset || "none",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "metadata_list_fields": {
        const { schema, encoding } = args as {
          schema: string;
          encoding?: string;
        };

        const fields = await metadataClient.listFields({ schema, encoding });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  schema,
                  encoding: encoding || "default",
                  fields,
                  count: fields.length,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "metadata_get_cost": {
        const {
          dataset,
          symbols,
          schema,
          start,
          end,
          mode,
          stype_in,
          stype_out,
        } = args as {
          dataset: string;
          symbols?: string;
          schema?: string;
          start: string;
          end?: string;
          mode?: string;
          stype_in?: string;
          stype_out?: string;
        };

        const cost = await metadataClient.getCost({
          dataset,
          symbols,
          schema,
          start,
          end,
          mode,
          stype_in,
          stype_out,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(cost, null, 2),
            },
          ],
        };
      }

      case "metadata_get_dataset_range": {
        const { dataset } = args as { dataset: string };

        const range = await metadataClient.getDatasetRange({ dataset });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  dataset,
                  ...range,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "batch_submit_job": {
        const params = args as unknown as BatchJobRequest;
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

      case "batch_list_jobs": {
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

      case "batch_download": {
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

      case "reference_search_securities": {
        const { dataset, symbols, start_date, end_date, limit } = args as {
          dataset?: string;
          symbols: string;
          start_date?: string;
          end_date?: string;
          limit?: number;
        };

        const response = await referenceClient.searchSecurities({
          dataset,
          symbols,
          start_date,
          end_date,
          limit,
        });

        const result = {
          dataset: dataset ?? "reference",
          symbols,
          date_range: {
            start: start_date ?? "latest",
            end: end_date || (start_date ? "all_available_after_start" : "not_applicable"),
          },
          record_count: response.securities.length,
          securities: response.securities,
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "reference_get_corporate_actions": {
        const { dataset, symbols, start_date, end_date, action_types } = args as {
          dataset: string;
          symbols: string;
          start_date: string;
          end_date?: string;
          action_types?: string[];
        };

        const response = await referenceClient.getCorporateActions({
          dataset,
          symbols,
          start_date,
          end_date,
          action_types,
        });

        const result = {
          dataset: dataset ?? "reference",
          symbols,
          date_range: {
            start: start_date,
            end: end_date || "all_available_after_start",
          },
          record_count: response.actions.length,
          action_types_filter: action_types || "all",
          corporate_actions: response.actions,
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "reference_get_adjustments": {
        const { dataset, symbols, start_date, end_date } = args as {
          dataset: string;
          symbols: string;
          start_date: string;
          end_date?: string;
        };

        const response = await referenceClient.getAdjustmentFactors({
          dataset,
          symbols,
          start_date,
          end_date,
        });

        const result = {
          dataset: dataset ?? "reference",
          symbols,
          date_range: {
            start: start_date,
            end: end_date || "all_available_after_start",
          },
          record_count: response.adjustments.length,
          adjustments: response.adjustments,
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return createToolErrorResult(errorMessage);
    }
  };
}

export function createDatabentoMcpServer(
  clients: DatabentoMcpClients,
  options: DatabentoMcpServerOptions = {}
): Server {
  const server = new Server(
    {
      name: "databento-mcp-server",
      version: DATABENTO_MCP_SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: listDatabentoTools(options),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, createCallToolHandler(clients, options));

  return server;
}

export async function startDatabentoMcpServer() {
  dotenv.config({ quiet: true });

  const apiKey = process.env.DATABENTO_API_KEY;
  if (!apiKey) {
    throw new Error("DATABENTO_API_KEY environment variable is required");
  }

  const server = createDatabentoMcpServer(createDefaultDatabentoMcpClients(apiKey));
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("DataBento MCP Server running on stdio");
}

// Start the server
async function main() {
  await startDatabentoMcpServer();
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
}
