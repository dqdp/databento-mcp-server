const DAY_MS = 24 * 60 * 60 * 1000;

const EXPLICIT_RANGE_LIMIT_DAYS_BY_SCHEMA = new Map<string, number>([
  ["trades", 1],
  ["tbbo", 1],
  ["mbp-1", 1],
  ["mbp-10", 1],
  ["mbo", 1],
  ["ohlcv-1s", 1],
  ["ohlcv-1m", 31],
  ["ohlcv-1h", 366],
]);

function parseDateBoundary(value: string): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return Date.UTC(year, month - 1, day);
  }

  return Date.parse(value);
}

export function getHistoricalRangeLimitDays(schema: string): number | undefined {
  return EXPLICIT_RANGE_LIMIT_DAYS_BY_SCHEMA.get(schema.toLowerCase());
}

export function assertExplicitHistoricalRangeWithinLimit(params: {
  schema: string;
  start: string;
  end?: string;
}): void {
  const maxDays = getHistoricalRangeLimitDays(params.schema);
  if (maxDays === undefined || params.end === undefined) {
    return;
  }

  const startMs = parseDateBoundary(params.start);
  const endMs = parseDateBoundary(params.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return;
  }

  if (endMs < startMs) {
    throw new Error("end must be greater than or equal to start");
  }

  const requestedDays = Math.ceil((endMs - startMs) / DAY_MS);
  if (endMs - startMs > maxDays * DAY_MS) {
    throw new Error(
      `${params.schema} queries are limited to ${maxDays} day${maxDays === 1 ? "" : "s"}; ` +
        `requested explicit range is ${requestedDays} days`
    );
  }
}
