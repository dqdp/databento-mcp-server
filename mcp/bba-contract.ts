import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const streamId = z.string().regex(/^[0-9a-f]{32}$/);
const symbol = z.string().min(1).max(256).regex(/^[^,|\x00-\x1f\x7f]+$/)
  .refine(value => value === value.trim() && value.toUpperCase() !== "ALL_SYMBOLS");
const actions = [
  z.strictObject({action: z.literal("start"), symbol, stype_in: z.enum(["raw_symbol", "continuous", "instrument_id"])}),
  z.strictObject({action: z.literal("read"), stream_id: streamId, after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    limit: z.number().int().min(1).max(100).optional(), wait_ms: z.number().int().min(0).max(5000).optional()}),
  z.strictObject({action: z.literal("stop"), stream_id: streamId}),
] as const;
export const bbaActions = z.discriminatedUnion("action", actions);
export type BbaAction = z.infer<typeof bbaActions>;
export const BBA_IDLE_MS = 45000;
export const BBA_LIFETIME_MS = 300000;

export const bbaTool: Tool = {
  name: "stream_bba",
  description: "Stream changes to best bid/ask prices and sizes on one persistent GLBX.MDP3 MBP-1 subscription. " +
    "Start with a single contract, read with after=0 then next_cursor, and stop the handle. " +
    "Empty reads mean no new BBA. A positive missed_events reports buffer overrun. Provider close/error is terminal.",
  inputSchema: {type: "object", required: ["action"], additionalProperties: false, properties: {
    action: {type: "string", enum: ["start", "read", "stop"]},
    symbol: {type: "string", minLength: 1, maxLength: 256, description: "Required for start. One outright or option symbol."},
    stype_in: {type: "string", enum: ["raw_symbol", "continuous", "instrument_id"], description: "Required for start. For example ES.v.0 uses continuous."},
    stream_id: {type: "string", pattern: "^[0-9a-f]{32}$", description: "Required for read and stop. From start."},
    after: {type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Required for read. Last delivered cursor, initially 0."},
    limit: {type: "integer", minimum: 1, maximum: 100, description: "Read only. Maximum events per page, default 32."},
    wait_ms: {type: "integer", minimum: 0, maximum: 5000, description: "Read only. Maximum wait for an update, default 1000 ms."},
  }},
};
