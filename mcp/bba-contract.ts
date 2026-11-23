import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const streamId = z.string().regex(/^[0-9a-f]{32}$/);
const singleSymbol = /^(?!\s)(?![\s\S]*\s$)[^,|\x00-\x1f\x7f]+(?![\s\S])/;
const allSymbols = /^[aA][lL][lL]_[sS][yY][mM][bB][oO][lL][sS]$/;
// The ID is sent as a string. Match the decimal range 1..4294967295 in client JSON Schema as well.
const instrumentId = new RegExp("^(?:" + [
  "[1-9][0-9]{0,8}", "[1-3][0-9]{9}", "4[01][0-9]{8}", "42[0-8][0-9]{7}",
  "429[0-3][0-9]{6}", "4294[0-8][0-9]{5}", "42949[0-5][0-9]{4}", "429496[0-6][0-9]{3}",
  "4294967[01][0-9]{2}", "42949672[0-8][0-9]", "429496729[0-5]",
].join("|") + ")$");
const symbol = z.string().min(1).max(256).regex(singleSymbol).refine(value => !allSymbols.test(value));
const actions = [
  z.strictObject({action: z.literal("start"), symbol, stype_in: z.enum(["raw_symbol", "continuous", "instrument_id"])}),
  z.strictObject({action: z.literal("read"), stream_id: streamId, after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    limit: z.number().int().min(1).max(100).optional(), wait_ms: z.number().int().min(0).max(5000).optional()}),
  z.strictObject({action: z.literal("stop"), stream_id: streamId}),
] as const;
export const bbaActions = z.discriminatedUnion("action", actions).refine(value =>
  value.action !== "start" || value.stype_in !== "instrument_id" ||
  instrumentId.test(value.symbol));
export type BbaAction = z.infer<typeof bbaActions>;
// Allow a client to honor the Gateway's 60-second Retry-After and resume the same subscription.
export const BBA_IDLE_MS = 120000;

export const bbaTool: Tool = {
  name: "stream_bba",
  description: "Stream changes to best bid/ask prices and sizes on one persistent GLBX.MDP3 MBP-1 subscription. " +
    "Start with a single contract, read with after=0 then next_cursor, and stop the handle. " +
    "Empty reads mean no new BBA. A positive missed_events reports buffer overrun. Provider close/error is terminal.",
  inputSchema: {type: "object", required: ["action"], additionalProperties: false, properties: {
    action: {type: "string", enum: ["start", "read", "stop"]},
    symbol: {type: "string", minLength: 1, maxLength: 256, pattern: singleSymbol.source, not: {pattern: allSymbols.source},
      description: "Required for start. One outright or option symbol."},
    stype_in: {type: "string", enum: ["raw_symbol", "continuous", "instrument_id"], description: "Required for start. For example ES.v.0 uses continuous."},
    stream_id: {type: "string", pattern: "^[0-9a-f]{32}$", description: "Required for read and stop. From start."},
    after: {type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Required for read. Last delivered cursor, initially 0."},
    limit: {type: "integer", minimum: 1, maximum: 100, description: "Read only. Maximum events per page, default 32."},
    wait_ms: {type: "integer", minimum: 0, maximum: 5000, description: "Read only. Maximum wait for an update, default 1000 ms."},
  }, if: {properties: {action: {const: "start"}}},
    then: {required: ["symbol", "stype_in"], properties: {stream_id: false, after: false, limit: false, wait_ms: false},
      if: {properties: {stype_in: {const: "instrument_id"}}}, then: {properties: {symbol: {pattern: instrumentId.source}}}},
    else: {required: ["stream_id"], properties: {symbol: false, stype_in: false},
      if: {properties: {action: {const: "read"}}}, then: {required: ["after"]},
      else: {properties: {after: false, wait_ms: false, limit: false}}},
  },
};
