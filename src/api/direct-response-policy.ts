export const DEFAULT_DIRECT_MAX_RECORDS = 10_000;

export function getDirectMaxRecords(): number {
  const rawValue = process.env.MCP_DIRECT_MAX_RECORDS;
  if (rawValue === undefined || rawValue.trim() === "") {
    return DEFAULT_DIRECT_MAX_RECORDS;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("MCP_DIRECT_MAX_RECORDS must be a positive integer");
  }

  return parsed;
}

export function assertDirectTimeseriesLimit(limit: number): void {
  if (limit < 1) {
    throw new Error("limit must be greater than 0");
  }

  const maxRecords = getDirectMaxRecords();
  if (limit > maxRecords) {
    throw new Error(`Direct timeseries_get_range limit cannot exceed ${maxRecords}`);
  }
}
