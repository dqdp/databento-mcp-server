import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as zodToJsonSchemaModule from "zod-to-json-schema";
import { getDirectMaxRecords } from "../src/api/direct-response-policy.js";
import { assertStandardCmeHistoricalEntitlement } from "../src/api/entitlement-policy.js";
import {
  MAX_DAILY_HISTORICAL_BARS,
  MAX_INTRADAY_HISTORICAL_BARS,
} from "../src/databento-client.js";

const FUTURES_SYMBOLS = ["ES", "NQ"] as const;
const FUTURES_TIMEFRAMES = ["1h", "H4", "1d"] as const;
const LIVE_QUOTE_MIN_TIMEOUT_MS = 1;
const LIVE_QUOTE_MAX_TIMEOUT_MS = 30000;
const SYMBOLOGY_TYPES = ["raw_symbol", "instrument_id", "continuous", "parent"] as const;
const TIMESERIES_SCHEMAS = [
  "mbp-1",
  "mbp-10",
  "mbo",
  "trades",
  "tbbo",
  "bbo-1s",
  "bbo-1m",
  "ohlcv-1s",
  "ohlcv-1m",
  "ohlcv-1h",
  "ohlcv-1d",
  "statistics",
  "definition",
  "status",
] as const;
const BATCH_SCHEMAS = [
  "trades",
  "tbbo",
  "bbo-1s",
  "bbo-1m",
  "mbp-1",
  "mbp-10",
  "mbo",
  "ohlcv-1s",
  "ohlcv-1m",
  "ohlcv-1h",
  "ohlcv-1d",
  "definition",
  "statistics",
  "status",
] as const;
const BATCH_ENCODINGS = ["dbn", "csv", "json"] as const;
const BATCH_COMPRESSIONS = ["none", "zstd", "gzip"] as const;
const BATCH_JOB_STATES = ["queued", "processing", "done", "expired"] as const;
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/;

type ToolArgumentSchema = z.ZodTypeAny;
type ZodToMcpJsonSchema = (
  schema: z.ZodTypeAny,
  options: { $refStrategy: "none" }
) => Record<string, unknown>;

const convertZodToJsonSchema = zodToJsonSchemaModule.zodToJsonSchema as unknown as ZodToMcpJsonSchema;

export interface DatabentoToolDefinition {
  name: string;
  description: string;
  schema: ToolArgumentSchema;
}

export type ToolArgumentParseResult =
  | {
      status: "valid";
      arguments: Record<string, unknown>;
    }
  | {
      status: "invalid";
      error: string;
    }
  | {
      status: "unknown";
    };

function toolArgs<T extends z.ZodRawShape>(shape: T): z.ZodObject<T> {
  return z.object(shape).strict();
}

function toolArgsWithDateRange<T extends z.ZodRawShape>(
  shape: T,
  startKey: string,
  endKey: string
): ToolArgumentSchema {
  return toolArgs(shape).superRefine((args, context) => {
    validateDateRange(args as Record<string, unknown>, context, startKey, endKey);
  });
}

function toolArgsWithStandardCmeEntitlement<T extends z.ZodRawShape>(
  shape: T,
  datasetKey: string,
  startKey: string,
  endKey: string,
  schemaKey: string
): ToolArgumentSchema {
  return toolArgsWithDateRange(shape, startKey, endKey).superRefine((args, context) => {
    const parsedArgs = args as Record<string, unknown>;
    const dataset = parsedArgs[datasetKey];
    const schema = parsedArgs[schemaKey];
    const start = parsedArgs[startKey];
    const end = parsedArgs[endKey];

    if (typeof dataset !== "string" || typeof schema !== "string" || typeof start !== "string") {
      return;
    }

    try {
      assertStandardCmeHistoricalEntitlement({
        dataset,
        schema,
        start,
        end: typeof end === "string" ? end : undefined,
      });
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [endKey],
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function containsAllSymbolsToken(symbols: string): boolean {
  return symbols
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .includes("ALL_SYMBOLS");
}

function directTimeseriesArgs<T extends z.ZodRawShape>(shape: T): ToolArgumentSchema {
  return toolArgsWithStandardCmeEntitlement(
    shape,
    "dataset",
    "start",
    "end",
    "schema"
  ).superRefine((args, context) => {
    const parsedArgs = args as Record<string, unknown>;
    const limit = parsedArgs.limit;
    const symbols = parsedArgs.symbols;

    if (typeof symbols === "string" && containsAllSymbolsToken(symbols)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["symbols"],
        message: "ALL_SYMBOLS is only allowed for batch_submit_job, not direct timeseries_get_range",
      });
    }

    if (typeof limit === "number") {
      const maxRecords = getDirectMaxRecords();
      if (limit > maxRecords) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["limit"],
          message: `Direct timeseries_get_range limit cannot exceed ${maxRecords}`,
        });
      }
    }
  });
}

function historicalBarsArgs(): ToolArgumentSchema {
  return toolArgs({
    symbol: z
      .string()
      .trim()
      .min(1)
      .refine((value) => value.toUpperCase() !== "ALL_SYMBOLS" && !value.includes(","), {
        message: "Use a single Databento symbol; ALL_SYMBOLS and comma-separated symbols are not supported",
      })
      .describe(
        "Single Databento symbol. ES and NQ are aliases for the continuous front contract; use raw, instrument_id, continuous, or parent symbols for other futures and options on futures."
      ),
    timeframe: z.enum(FUTURES_TIMEFRAMES).describe("Bar timeframe"),
    count: z
      .number()
      .int()
      .min(1)
      .describe(
        `Number of bars to retrieve. Max ${MAX_INTRADAY_HISTORICAL_BARS} for 1h/H4, max ${MAX_DAILY_HISTORICAL_BARS} for 1d.`
      ),
    stype_in: z
      .enum(SYMBOLOGY_TYPES)
      .describe("Input symbology type. Defaults to continuous for ES/NQ aliases and raw_symbol for all other symbols.")
      .optional(),
  }).superRefine((args, context) => {
    const maxCount = args.timeframe === "1d" ? MAX_DAILY_HISTORICAL_BARS : MAX_INTRADAY_HISTORICAL_BARS;
    if (args.count > maxCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["count"],
        message: `${args.timeframe} historical bars are limited to ${maxCount} bars`,
      });
    }
  });
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function matchValidDateOnly(value: string): RegExpExecArray | null {
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) {
    return null;
  }

  const [, year, month, day] = match;
  return isValidCalendarDate(Number(year), Number(month), Number(day)) ? match : null;
}

function isValidDateOnlyValue(value: string): boolean {
  return matchValidDateOnly(value) !== null;
}

function isValidDateLikeValue(value: string): boolean {
  if (isValidDateOnlyValue(value)) {
    return true;
  }

  const match = ISO_DATE_TIME_PATTERN.exec(value);
  if (!match) {
    return false;
  }

  const [, year, month, day] = match;
  return (
    isValidCalendarDate(Number(year), Number(month), Number(day)) &&
    !Number.isNaN(Date.parse(value))
  );
}

function comparableDateValue(value: string): number {
  const dateOnlyMatch = matchValidDateOnly(value);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    return Date.UTC(Number(year), Number(month) - 1, Number(day));
  }

  return Date.parse(value);
}

function validateDateRange(
  args: Record<string, unknown>,
  context: z.RefinementCtx,
  startKey: string,
  endKey: string
): void {
  const start = args[startKey];
  const end = args[endKey];
  if (typeof start !== "string" || typeof end !== "string") {
    return;
  }

  if (comparableDateValue(end) < comparableDateValue(start)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [endKey],
      message: `Expected ${endKey} to be greater than or equal to ${startKey}`,
    });
  }
}

function dateLike(description: string) {
  return z
    .string()
    .describe(description)
    .refine(isValidDateLikeValue, {
      message: "Expected a valid ISO 8601 timestamp or YYYY-MM-DD date",
    });
}

function dateOnly(description: string) {
  return z
    .string()
    .describe(description)
    .refine(isValidDateOnlyValue, {
      message: "Expected a valid date in YYYY-MM-DD format",
    });
}

const nonEmptyString = (description: string) => z.string().min(1).describe(description);

export const DATABENTO_TOOL_DEFINITIONS: DatabentoToolDefinition[] = [
  {
    name: "get_futures_quote",
    description: "Get the latest ES or NQ futures quote from Databento Historical REST data. This is not a true live socket subscription.",
    schema: toolArgs({
      symbol: z
        .enum(FUTURES_SYMBOLS)
        .describe("Futures symbol (ES = E-mini S&P 500, NQ = E-mini Nasdaq-100)"),
    }),
  },
  {
    name: "get_live_futures_quote",
    description: "Get a true live top-of-book quote update for a futures or futures-options symbol through the Databento Live API socket feed.",
    schema: toolArgs({
      symbol: z
        .string()
        .trim()
        .min(1)
        .refine((value) => value.toUpperCase() !== "ALL_SYMBOLS" && !value.includes(","), {
          message: "Use a single Databento symbol; ALL_SYMBOLS and comma-separated symbols are not supported",
        })
        .describe(
          "Single Databento symbol. ES and NQ are aliases for ES.v.0/NQ.v.0 continuous front contracts. Use raw, instrument_id, continuous, or parent symbols for other futures and options on futures."
        ),
      dataset: z
        .string()
        .trim()
        .min(1)
        .describe("Databento dataset code. Defaults to GLBX.MDP3 for CME Globex futures and options on futures.")
        .optional(),
      stype_in: z
        .enum(SYMBOLOGY_TYPES)
        .describe("Input symbology type. Defaults to continuous for ES/NQ aliases and raw_symbol for all other symbols.")
        .optional(),
      timeout_ms: z
        .number()
        .int()
        .min(LIVE_QUOTE_MIN_TIMEOUT_MS)
        .max(LIVE_QUOTE_MAX_TIMEOUT_MS)
        .describe("Maximum time to wait for the first live quote, in milliseconds. Defaults to 10000.")
        .optional(),
    }),
  },
  {
    name: "get_session_info",
    description: "Get current trading session information (Asian/London/NY)",
    schema: toolArgs({
      timestamp: dateLike("Optional ISO timestamp (defaults to now)").optional(),
    }),
  },
  {
    name: "get_historical_bars",
    description: "Get historical OHLCV bars for futures contracts",
    schema: historicalBarsArgs(),
  },
  {
    name: "symbology_resolve",
    description: "Resolve symbols to instrument IDs or other symbol types across a date range",
    schema: toolArgsWithDateRange({
      dataset: nonEmptyString("Dataset code (e.g., GLBX.MDP3, XNAS.ITCH)"),
      symbols: z.array(nonEmptyString("Symbol")).min(1).max(2000).describe("Array of symbols to resolve (max 2000)"),
      stype_in: z.enum(SYMBOLOGY_TYPES).describe("Input symbol type"),
      stype_out: z.enum(SYMBOLOGY_TYPES).describe("Output symbol type"),
      start_date: dateOnly("Inclusive start date (YYYY-MM-DD)"),
      end_date: dateOnly("Optional exclusive end date (YYYY-MM-DD)").optional(),
    }, "start_date", "end_date"),
  },
  {
    name: "timeseries_get_range",
    description: "Get historical market data with flexible schemas and date ranges. Direct responses are record-limited; use batch_submit_job for ALL_SYMBOLS or larger covered exports.",
    schema: directTimeseriesArgs({
      dataset: nonEmptyString("Dataset code (e.g., 'GLBX.MDP3' for CME, 'XNAS.ITCH' for Nasdaq)"),
      symbols: nonEmptyString("Comma-separated list of instrument symbols (up to 2000)"),
      schema: z.enum(TIMESERIES_SCHEMAS).describe("Data schema type"),
      start: dateLike("Start date (ISO 8601 or YYYY-MM-DD format)"),
      end: dateLike("Optional exclusive end date (ISO 8601 or YYYY-MM-DD)").optional(),
      stype_in: z.enum(SYMBOLOGY_TYPES).describe("Input symbology type, defaults to 'raw_symbol'").optional(),
      stype_out: z.enum(SYMBOLOGY_TYPES).describe("Output symbology type, defaults to 'instrument_id'").optional(),
      limit: z.number().int().min(1).describe("Maximum records to return; defaults to MCP_DIRECT_MAX_RECORDS (10000) and cannot exceed it").optional(),
    }),
  },
  {
    name: "get_futures_options_smile",
    description:
      "Build a volatility-smile snapshot for options on a CME future (GLBX.MDP3), e.g. root 'ES'. Pulls the chain definitions + latest BBO + open interest, computes IV/greeks (Black-76 — Databento carries no greeks), and returns a text summary plus a compact chain JSON. `expiry` is a date 'YYYY-MM-DD' or a mode: 'nearest' (default, DTE>=1), 'quarterly' (nearest Mar/Jun/Sep/Dec), or 'most-liquid' (highest open interest). Render the returned JSON as an interactive volatility-smile dashboard artifact.",
    schema: toolArgs({
      root: nonEmptyString("Futures root, e.g. 'ES' (E-mini S&P 500). CME / GLBX.MDP3 only."),
      expiry: z
        .string()
        .describe("Target expiration: a date 'YYYY-MM-DD', or a mode 'nearest' | 'quarterly' | 'most-liquid'.")
        .optional(),
      window: z.number().int().min(1).describe("Strikes on each side of ATM (default 20).").optional(),
    }),
  },
  {
    name: "metadata_list_datasets",
    description: "List all available Databento datasets with optional date range filtering",
    schema: toolArgsWithDateRange({
      start_date: dateOnly("Optional inclusive start date (YYYY-MM-DD)").optional(),
      end_date: dateOnly("Optional exclusive end date (YYYY-MM-DD)").optional(),
    }, "start_date", "end_date"),
  },
  {
    name: "metadata_list_schemas",
    description: "List available data schemas for a specific dataset",
    schema: toolArgs({
      dataset: nonEmptyString("Dataset code (e.g., GLBX.MDP3, XNAS.ITCH)"),
    }),
  },
  {
    name: "metadata_list_publishers",
    description: "List publishers with their details, optionally filtered by dataset",
    schema: toolArgs({
      dataset: nonEmptyString("Optional dataset code to filter publishers").optional(),
    }),
  },
  {
    name: "metadata_list_fields",
    description: "List fields available for a specific schema with their types and descriptions",
    schema: toolArgs({
      schema: nonEmptyString("Schema name (e.g., trades, mbp-1, ohlcv-1d)"),
      encoding: nonEmptyString("Optional encoding type (e.g., json, csv, dbn)").optional(),
    }),
  },
  {
    name: "metadata_get_cost",
    description: "Calculate the cost in USD for a historical data query before downloading",
    schema: toolArgsWithDateRange({
      dataset: nonEmptyString("Dataset code (e.g., GLBX.MDP3)"),
      symbols: nonEmptyString("Comma-separated list of symbols or single symbol").optional(),
      schema: nonEmptyString("Schema name (default: trades)").optional(),
      start: dateLike("Inclusive start date/time (YYYY-MM-DD or ISO 8601)"),
      end: dateLike("Optional exclusive end date/time (YYYY-MM-DD or ISO 8601)").optional(),
      mode: nonEmptyString("Query mode (default: historical-streaming)").optional(),
      stype_in: z.enum(SYMBOLOGY_TYPES).describe("Input symbology type (e.g., raw_symbol, continuous)").optional(),
      stype_out: z.enum(SYMBOLOGY_TYPES).describe("Output symbology type (e.g., instrument_id, raw_symbol)").optional(),
    }, "start", "end"),
  },
  {
    name: "metadata_get_dataset_range",
    description: "Get the available date range for a dataset",
    schema: toolArgs({
      dataset: nonEmptyString("Dataset code (e.g., GLBX.MDP3)"),
    }),
  },
  {
    name: "batch_submit_job",
    description: "Submit a Databento batch data download job for covered Standard CME historical data. Batch supports ALL_SYMBOLS and large entitlement-covered exports after zero-cost preflight.",
    schema: toolArgsWithStandardCmeEntitlement({
      dataset: nonEmptyString("Dataset code (e.g., GLBX.MDP3, XNAS.ITCH)"),
      symbols: z.array(nonEmptyString("Symbol")).min(1).max(2000).describe("Array of symbols (max 2000)"),
      schema: z.enum(BATCH_SCHEMAS).describe("Data record schema"),
      start: dateLike("Start date (YYYY-MM-DD or ISO 8601)"),
      end: dateLike("Exclusive end date (YYYY-MM-DD or ISO 8601)"),
      encoding: z.enum(BATCH_ENCODINGS).describe("Output encoding (default: dbn)").optional(),
      compression: z.enum(BATCH_COMPRESSIONS).describe("Compression type (default: zstd)").optional(),
      stype_in: z.enum(SYMBOLOGY_TYPES).describe("Input symbology type (default: raw_symbol)").optional(),
      stype_out: z.enum(SYMBOLOGY_TYPES).describe("Output symbology type (default: instrument_id)").optional(),
      split_duration: nonEmptyString("Split files by duration (e.g., day, week, month)").optional(),
      split_size: z.number().int().positive().describe("Split files by size in bytes").optional(),
      split_symbols: z.boolean().describe("Split files by symbol (default: false)").optional(),
      limit: z.number().int().positive().describe("Limit number of records").optional(),
    }, "dataset", "start", "end", "schema"),
  },
  {
    name: "batch_list_jobs",
    description: "List all batch jobs with their current status. Optionally filter by job states or time range.",
    schema: toolArgs({
      states: z.array(z.enum(BATCH_JOB_STATES)).min(1).describe("Filter by job states").optional(),
      since: dateLike("Filter jobs since timestamp (ISO 8601)").optional(),
    }),
  },
  {
    name: "batch_download",
    description: "Get download information for a completed batch job. Returns download URLs and metadata. Does NOT stream file content through MCP.",
    schema: toolArgs({
      job_id: nonEmptyString("Batch job identifier"),
    }),
  },
  {
    name: "reference_search_securities",
    description: "Search security master database for instrument metadata",
    schema: toolArgsWithDateRange({
      dataset: nonEmptyString("Optional compatibility label for the response; Databento Reference API does not require a dataset").optional(),
      symbols: nonEmptyString("Comma-separated list of symbols"),
      start_date: dateOnly("Optional start date (YYYY-MM-DD). If omitted, returns the latest security master snapshot.").optional(),
      end_date: dateOnly("Optional exclusive end date (YYYY-MM-DD). Used with start_date for a historical range.").optional(),
      limit: z.number().int().positive().describe("Local maximum number of records to include in the MCP response").optional(),
    }, "start_date", "end_date"),
  },
  {
    name: "reference_get_corporate_actions",
    description: "Get corporate actions (dividends, splits, etc.) for symbols",
    schema: toolArgsWithDateRange({
      dataset: nonEmptyString("Optional compatibility label for output. Databento Reference API does not require a dataset.").optional(),
      symbols: nonEmptyString("Comma-separated list of symbols"),
      start_date: dateOnly("Start date (YYYY-MM-DD)"),
      end_date: dateOnly("Optional exclusive end date (YYYY-MM-DD). If omitted, returns all available data after start_date.").optional(),
      action_types: z.array(nonEmptyString("Corporate action event filter")).min(1).describe("Databento corporate action event filters (e.g., ['DIV', 'FSPLT', 'RSPLT'])").optional(),
    }, "start_date", "end_date"),
  },
  {
    name: "reference_get_adjustments",
    description: "Get price adjustment factors for backadjusted prices",
    schema: toolArgsWithDateRange({
      dataset: nonEmptyString("Optional compatibility label for output. Databento Reference API does not require a dataset.").optional(),
      symbols: nonEmptyString("Comma-separated list of symbols"),
      start_date: dateOnly("Start date (YYYY-MM-DD)"),
      end_date: dateOnly("Optional exclusive end date (YYYY-MM-DD). If omitted, returns all available data after start_date.").optional(),
    }, "start_date", "end_date"),
  },
];

const DATABENTO_TOOL_SCHEMAS = new Map(
  DATABENTO_TOOL_DEFINITIONS.map((definition) => [definition.name, definition.schema])
);

function toMcpInputSchema(schema: ToolArgumentSchema): Tool["inputSchema"] {
  const converted = convertZodToJsonSchema(schema as z.ZodTypeAny, {
    $refStrategy: "none",
  });

  if (typeof converted !== "object" || converted === null || converted.type !== "object") {
    throw new Error("MCP tool input schema must be a JSON object schema");
  }

  const { $schema: _schema, ...inputSchema } = converted;
  return inputSchema as Tool["inputSchema"];
}

function formatZodPath(path: (string | number)[]): string {
  return path.length > 0 ? path.join(".") : "arguments";
}

function formatToolArgumentError(toolName: string, error: z.ZodError): string {
  const issues = error.issues
    .map((issue) => `${formatZodPath(issue.path)}: ${issue.message}`)
    .join("; ");

  return `Invalid tool arguments for ${toolName}: ${issues}`;
}

export function listDatabentoToolContracts(): Tool[] {
  return DATABENTO_TOOL_DEFINITIONS.map((definition) => ({
    name: definition.name,
    description: definition.description,
    inputSchema: toMcpInputSchema(definition.schema),
  }));
}

export function parseDatabentoToolArguments(
  toolName: string,
  args: unknown
): ToolArgumentParseResult {
  const schema = DATABENTO_TOOL_SCHEMAS.get(toolName);
  if (!schema) {
    return { status: "unknown" };
  }

  let result: ReturnType<ToolArgumentSchema["safeParse"]>;
  try {
    result = schema.safeParse(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "invalid",
      error: `Invalid tool arguments for ${toolName}: ${message}`,
    };
  }

  if (!result.success) {
    return {
      status: "invalid",
      error: formatToolArgumentError(toolName, result.error),
    };
  }

  return {
    status: "valid",
    arguments: result.data,
  };
}
