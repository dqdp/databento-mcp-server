import { describe, expect, it } from "vitest";
import {
  assertExplicitHistoricalRangeWithinLimit,
  getHistoricalRangeLimitDays,
} from "../../../src/api/historical-range-guard.js";

describe("historical range guard", () => {
  it.each([
    ["trades", 1],
    ["tbbo", 1],
    ["mbp-1", 1],
    ["mbp-10", 1],
    ["mbo", 1],
    ["ohlcv-1s", 1],
    ["ohlcv-1m", 31],
    ["ohlcv-1h", 366],
  ])("limits explicit %s ranges to %i day(s)", (schema, maxDays) => {
    expect(getHistoricalRangeLimitDays(schema)).toBe(maxDays);

    expect(() =>
      assertExplicitHistoricalRangeWithinLimit({
        schema,
        start: "2024-01-01",
        end: new Date(Date.UTC(2024, 0, 1 + maxDays)).toISOString().split("T")[0],
      })
    ).not.toThrow();

    expect(() =>
      assertExplicitHistoricalRangeWithinLimit({
        schema,
        start: "2024-01-01",
        end: new Date(Date.UTC(2024, 0, 2 + maxDays)).toISOString().split("T")[0],
      })
    ).toThrow(`${schema} queries are limited to ${maxDays} day${maxDays === 1 ? "" : "s"}`);
  });

  it.each(["ohlcv-1d", "ohlcv-eod", "statistics", "definition", "imbalance", "status"])(
    "does not cap %s explicit ranges",
    (schema) => {
      expect(getHistoricalRangeLimitDays(schema)).toBeUndefined();
      expect(() =>
        assertExplicitHistoricalRangeWithinLimit({
          schema,
          start: "2020-01-01",
          end: "2024-01-01",
        })
      ).not.toThrow();
    }
  );
});
