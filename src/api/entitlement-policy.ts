const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/;
const ISO_DATE_TIME_WITHOUT_ZONE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?$/;

export type StandardCmeEntitlementLevel = "L0" | "L1" | "L2" | "L3";

export interface StandardCmeSchemaEntitlement {
  level: StandardCmeEntitlementLevel;
  rollingWindowMonths?: number;
}

export interface HistoricalEntitlementRequest {
  dataset: string;
  schema: string;
  start: string;
  end?: string;
}

export interface StandardCmeEntitlementOptions {
  now?: Date;
  allowedDatasets?: readonly string[];
}

const DEFAULT_STANDARD_CME_DATASETS = ["GLBX.MDP3"] as const;

const STANDARD_CME_SCHEMA_ENTITLEMENTS = new Map<string, StandardCmeSchemaEntitlement>([
  ["ohlcv-1s", { level: "L0", rollingWindowMonths: undefined }],
  ["ohlcv-1m", { level: "L0", rollingWindowMonths: undefined }],
  ["ohlcv-1h", { level: "L0", rollingWindowMonths: undefined }],
  ["ohlcv-1d", { level: "L0", rollingWindowMonths: undefined }],
  ["definition", { level: "L0", rollingWindowMonths: undefined }],
  ["statistics", { level: "L0", rollingWindowMonths: undefined }],
  ["status", { level: "L0", rollingWindowMonths: undefined }],
  ["mbp-1", { level: "L1", rollingWindowMonths: 12 }],
  ["tbbo", { level: "L1", rollingWindowMonths: 12 }],
  ["bbo-1s", { level: "L1", rollingWindowMonths: 12 }],
  ["bbo-1m", { level: "L1", rollingWindowMonths: 12 }],
  ["trades", { level: "L1", rollingWindowMonths: 12 }],
  ["mbp-10", { level: "L2", rollingWindowMonths: 1 }],
  ["mbo", { level: "L3", rollingWindowMonths: 1 }],
]);

function normalizeDataset(dataset: string): string {
  return dataset.trim().toUpperCase();
}

function normalizeSchema(schema: string): string {
  return schema.trim().toLowerCase();
}

function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function subtractUtcMonths(date: Date, months: number): Date {
  const targetMonthIndex = date.getUTCMonth() - months;
  const monthStart = new Date(Date.UTC(
    date.getUTCFullYear(),
    targetMonthIndex,
    1,
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds()
  ));
  const targetDay = Math.min(
    date.getUTCDate(),
    daysInUtcMonth(monthStart.getUTCFullYear(), monthStart.getUTCMonth())
  );
  monthStart.setUTCDate(targetDay);
  return monthStart;
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

function startOfUtcDay(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function parseDateBoundary(value: string, fieldName: string): { ms: number; dateOnly: boolean } {
  const dateOnlyMatch = matchValidDateOnly(value);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    return {
      ms: Date.UTC(Number(year), Number(month) - 1, Number(day)),
      dateOnly: true,
    };
  }

  if (!ISO_DATE_TIME_PATTERN.test(value) && !ISO_DATE_TIME_WITHOUT_ZONE_PATTERN.test(value)) {
    throw new Error(`${fieldName} must be a valid ISO 8601 timestamp or YYYY-MM-DD date`);
  }

  const match = ISO_DATE_TIME_PATTERN.exec(value) ?? ISO_DATE_TIME_WITHOUT_ZONE_PATTERN.exec(value);
  if (!match) {
    throw new Error(`${fieldName} must be a valid ISO 8601 timestamp or YYYY-MM-DD date`);
  }

  const [, year, month, day] = match;
  if (!isValidCalendarDate(Number(year), Number(month), Number(day))) {
    throw new Error(`${fieldName} must be a valid ISO 8601 timestamp or YYYY-MM-DD date`);
  }

  const parsed = Date.parse(ISO_DATE_TIME_WITHOUT_ZONE_PATTERN.test(value) ? `${value}Z` : value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} must be a valid ISO 8601 timestamp or YYYY-MM-DD date`);
  }

  return { ms: parsed, dateOnly: false };
}

function allowedDatasetsFromOptions(options: StandardCmeEntitlementOptions): string[] {
  const configured = options.allowedDatasets ?? process.env.MCP_DATABENTO_ALLOWED_DATASETS?.split(",");
  return (configured ?? DEFAULT_STANDARD_CME_DATASETS)
    .map((dataset) => normalizeDataset(dataset))
    .filter(Boolean);
}

export function getStandardCmeSchemaEntitlement(
  schema: string
): StandardCmeSchemaEntitlement | undefined {
  const entitlement = STANDARD_CME_SCHEMA_ENTITLEMENTS.get(normalizeSchema(schema));
  return entitlement ? { ...entitlement } : undefined;
}

export function assertStandardCmeHistoricalEntitlement(
  request: HistoricalEntitlementRequest,
  options: StandardCmeEntitlementOptions = {}
): void {
  const dataset = normalizeDataset(request.dataset);
  const allowedDatasets = allowedDatasetsFromOptions(options);
  if (!allowedDatasets.includes(dataset)) {
    throw new Error(`${request.dataset} is not allowed by the Standard CME dataset allowlist`);
  }

  const schema = normalizeSchema(request.schema);
  const entitlement = getStandardCmeSchemaEntitlement(schema);
  if (!entitlement) {
    throw new Error(`${request.schema} is not included in the Standard CME entitlement policy`);
  }

  const start = parseDateBoundary(request.start, "start");
  const end = request.end ? parseDateBoundary(request.end, "end") : undefined;
  if (end && end.ms < start.ms) {
    throw new Error("end must be greater than or equal to start");
  }

  if (entitlement.rollingWindowMonths === undefined) {
    return;
  }

  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error("now must be a valid date");
  }

  const earliest = subtractUtcMonths(now, entitlement.rollingWindowMonths);
  const earliestMs = start.dateOnly ? startOfUtcDay(earliest.getTime()) : earliest.getTime();
  if (start.ms < earliestMs) {
    throw new Error(
      `${schema} is only covered by Standard CME for the rolling last ${entitlement.rollingWindowMonths} ` +
        `month${entitlement.rollingWindowMonths === 1 ? "" : "s"}`
    );
  }
}
