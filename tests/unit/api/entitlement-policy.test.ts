import { describe, expect, it } from "vitest";
import {
  assertStandardCmeHistoricalEntitlement,
  getStandardCmeSchemaEntitlement,
} from "../../../src/api/entitlement-policy.js";

const NOW = new Date("2026-06-16T12:00:00.000Z");
const ALLOWED_DATASETS = ["GLBX.MDP3"];

function assertAllowed(params: {
  dataset?: string;
  schema: string;
  start: string;
  end?: string;
}) {
  expect(() =>
    assertStandardCmeHistoricalEntitlement(
      {
        dataset: params.dataset ?? "GLBX.MDP3",
        schema: params.schema,
        start: params.start,
        end: params.end,
      },
      {
        now: NOW,
        allowedDatasets: ALLOWED_DATASETS,
      }
    )
  ).not.toThrow();
}

function assertRejected(
  params: {
    dataset?: string;
    schema: string;
    start: string;
    end?: string;
  },
  message: string
) {
  expect(() =>
    assertStandardCmeHistoricalEntitlement(
      {
        dataset: params.dataset ?? "GLBX.MDP3",
        schema: params.schema,
        start: params.start,
        end: params.end,
      },
      {
        now: NOW,
        allowedDatasets: ALLOWED_DATASETS,
      }
    )
  ).toThrow(message);
}

describe("standard CME entitlement policy", () => {
  it("maps covered Standard CME schemas to entitlement levels", () => {
    expect(getStandardCmeSchemaEntitlement("ohlcv-1d")).toEqual({
      level: "L0",
      rollingWindowMonths: undefined,
    });
    expect(getStandardCmeSchemaEntitlement("trades")).toEqual({
      level: "L1",
      rollingWindowMonths: 12,
    });
    expect(getStandardCmeSchemaEntitlement("bbo-1s")).toEqual({
      level: "L1",
      rollingWindowMonths: 12,
    });
    expect(getStandardCmeSchemaEntitlement("bbo-1m")).toEqual({
      level: "L1",
      rollingWindowMonths: 12,
    });
    expect(getStandardCmeSchemaEntitlement("mbp-10")).toEqual({
      level: "L2",
      rollingWindowMonths: 1,
    });
    expect(getStandardCmeSchemaEntitlement("mbo")).toEqual({
      level: "L3",
      rollingWindowMonths: 1,
    });
    expect(getStandardCmeSchemaEntitlement("ohlcv-eod")).toBeUndefined();
  });

  it("allows L0 schemas across long historical ranges", () => {
    for (const schema of ["ohlcv-1s", "ohlcv-1m", "ohlcv-1h", "ohlcv-1d", "definition", "statistics", "status"]) {
      assertAllowed({
        schema,
        start: "2010-01-01",
        end: "2026-06-16",
      });
    }
  });

  it("allows L1 schemas inside the rolling last 12 months", () => {
    for (const schema of ["trades", "tbbo", "bbo-1s", "bbo-1m", "mbp-1"]) {
      assertAllowed({
        schema,
        start: "2025-06-16",
        end: "2026-06-16",
      });
    }
  });

  it("rejects L1 schemas older than the rolling last 12 months", () => {
    for (const schema of ["trades", "tbbo", "bbo-1s", "bbo-1m", "mbp-1"]) {
      assertRejected(
        {
          schema,
          start: "2025-06-15T23:59:59Z",
          end: "2026-06-16",
        },
        `${schema} is only covered by Standard CME for the rolling last 12 months`
      );
    }
  });

  it("allows L2 and L3 schemas inside the rolling last 1 month", () => {
    for (const schema of ["mbp-10", "mbo"]) {
      assertAllowed({
        schema,
        start: "2026-05-16",
        end: "2026-06-16",
      });
    }
  });

  it("rejects L2 and L3 schemas older than the rolling last 1 month", () => {
    for (const schema of ["mbp-10", "mbo"]) {
      assertRejected(
        {
          schema,
          start: "2026-05-15T23:59:59Z",
          end: "2026-06-16",
        },
        `${schema} is only covered by Standard CME for the rolling last 1 month`
      );
    }
  });

  it("rejects schemas not included in the first Standard CME policy", () => {
    assertRejected(
      {
        schema: "ohlcv-eod",
        start: "2026-01-01",
        end: "2026-06-16",
      },
      "ohlcv-eod is not included in the Standard CME entitlement policy"
    );
    assertRejected(
      {
        schema: "imbalance",
        start: "2026-01-01",
        end: "2026-06-16",
      },
      "imbalance is not included in the Standard CME entitlement policy"
    );
  });

  it("rejects datasets outside the configured allowlist", () => {
    assertRejected(
      {
        dataset: "XNAS.ITCH",
        schema: "ohlcv-1d",
        start: "2026-01-01",
        end: "2026-06-16",
      },
      "XNAS.ITCH is not allowed by the Standard CME dataset allowlist"
    );
  });

  it("rejects ranges where end is before start", () => {
    assertRejected(
      {
        schema: "ohlcv-1d",
        start: "2026-06-16",
        end: "2026-06-15",
      },
      "end must be greater than or equal to start"
    );
  });

  it("rejects impossible ISO timestamp calendar dates", () => {
    assertRejected(
      {
        schema: "ohlcv-1d",
        start: "2026-02-30T00:00:00Z",
        end: "2026-06-16",
      },
      "start must be a valid ISO 8601 timestamp or YYYY-MM-DD date"
    );
  });
});
