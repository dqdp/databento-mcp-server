/**
 * DataBento Reference API Client
 * Provides access to security master, corporate actions, and adjustment data
 */

import {
  SecurityRecord,
  SecuritySearchParams,
  SecuritySearchResponse,
  CorporateAction,
  CorporateActionsParams,
  CorporateActionsResponse,
  AdjustmentFactor,
  AdjustmentFactorsParams,
  AdjustmentFactorsResponse,
} from "../types/reference.js";
import { DataBentoHTTP, decompressZstd, parseJSONL } from "../http/databento-http.js";

type ReferenceRow = Record<string, unknown>;

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  return String(value);
}

function field(row: ReferenceRow, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = optionalString(row[key]);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstSymbol(symbols: string): string {
  return symbols.split(",")[0] ?? "";
}

function splitRatio(row: ReferenceRow): string | undefined {
  const splitRatioValue = field(row, "split_ratio");
  if (splitRatioValue) {
    return splitRatioValue;
  }

  const ratioOld = field(row, "ratio_old");
  const ratioNew = field(row, "ratio_new");
  if (ratioOld && ratioNew) {
    return `${ratioOld}:${ratioNew}`;
  }

  return undefined;
}

function splitFactor(row: ReferenceRow): number | undefined {
  const splitFactorValue = field(row, "split_factor");
  if (splitFactorValue) {
    return optionalNumber(splitFactorValue);
  }

  const oldRatio = optionalNumber(row.ratio_old);
  const newRatio = optionalNumber(row.ratio_new);
  if (oldRatio !== undefined && newRatio !== undefined && oldRatio !== 0) {
    return newRatio / oldRatio;
  }

  return undefined;
}

function isRecord(value: unknown): value is ReferenceRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flattenReferenceRow(row: ReferenceRow): ReferenceRow {
  const flattened: ReferenceRow = { ...row };

  for (const key of ["date_info", "rate_info", "event_info"]) {
    const nested = row[key];
    if (isRecord(nested)) {
      Object.assign(flattened, nested);
    }
  }

  return flattened;
}

function parseReferenceRows(response: Buffer): ReferenceRow[] {
  const jsonl = decompressZstd(response).toString("utf8");
  return parseJSONL<ReferenceRow>(jsonl).map(flattenReferenceRow);
}

/**
 * Reference API Client for DataBento
 */
export class ReferenceClient {
  private readonly http: DataBentoHTTP;

  constructor(apiKey: string) {
    this.http = new DataBentoHTTP(apiKey);
  }

  /**
   * Search security master database
   *
   * @param params Search parameters
   * @returns Security records matching the search criteria
   */
  async searchSecurities(params: SecuritySearchParams): Promise<SecuritySearchResponse> {
    const symbols = Array.isArray(params.symbols)
      ? params.symbols.join(",")
      : params.symbols;

    const endpoint = params.start_date
      ? "/v0/security_master.get_range"
      : "/v0/security_master.get_last";
    const requestParams = {
      symbols,
      stype_in: params.stype_in || "raw_symbol",
      start: params.start_date,
      end: params.start_date ? params.end_date : undefined,
      compression: "zstd",
    };

    try {
      const response = await this.http.postFormBinary(endpoint, requestParams);
      const parsed = parseReferenceRows(response);
      const limited = params.limit !== undefined ? parsed.slice(0, params.limit) : parsed;

      const securities: SecurityRecord[] = limited.map((row) => ({
        instrument_id: optionalNumber(row.instrument_id ?? row.id),
        security_id: field(row, "security_id"),
        listing_id: field(row, "listing_id"),
        issuer_id: field(row, "issuer_id"),
        symbol: field(row, "symbol", "raw_symbol", "nasdaq_symbol") || firstSymbol(symbols),
        dataset: params.dataset ?? "reference",
        stype: field(row, "stype", "security_type") || "unknown",
        first_available: field(row, "first_available", "ts_start", "ts_effective", "listing_date") || "",
        last_available: field(row, "last_available", "ts_end", "delisting_date") || "",
        exchange: field(row, "exchange", "primary_exchange", "operating_mic", "venue") || "",
        asset_class: field(row, "asset_class", "security_type"),
        description: field(row, "description", "security_description", "issuer_name"),
        isin: field(row, "isin"),
        currency: field(row, "currency", "trading_currency"),
        contract_size: optionalNumber(row.contract_size),
        tick_size: optionalNumber(row.tick_size),
        expiration: field(row, "expiration", "maturity_date"),
      }));

      return {
        securities,
        count: securities.length,
      };
    } catch (error) {
      throw new Error(`Failed to search securities: ${error}`);
    }
  }

  /**
   * Get corporate actions (dividends, splits, etc.)
   *
   * @param params Corporate actions query parameters
   * @returns Corporate action records
   */
  async getCorporateActions(
    params: CorporateActionsParams
  ): Promise<CorporateActionsResponse> {
    if (!params.start_date) {
      throw new Error("start_date is required");
    }

    const symbols = Array.isArray(params.symbols)
      ? params.symbols.join(",")
      : params.symbols;

    const requestParams: Record<string, any> = {
      symbols,
      stype_in: params.stype_in || "raw_symbol",
      start: params.start_date,
      end: params.end_date,
      compression: "zstd",
    };
    if (params.action_types && params.action_types.length > 0) {
      requestParams.events = params.action_types.join(",");
    }

    try {
      const response = await this.http.postFormBinary(
        "/v0/corporate_actions.get_range",
        requestParams
      );
      const parsed = parseReferenceRows(response);

      const actions: CorporateAction[] = parsed.map((row) => ({
        instrument_id: optionalNumber(row.instrument_id),
        security_id: field(row, "security_id"),
        event_id: field(row, "event_id"),
        symbol: field(row, "symbol", "raw_symbol", "nasdaq_symbol") || firstSymbol(symbols),
        dataset: params.dataset ?? "reference",
        action_type: field(row, "action_type", "event", "type") || "",
        effective_date: field(row, "effective_date", "event_date", "ex_date", "ts_event") || "",
        announcement_date: field(row, "announcement_date", "event_created_date"),
        ex_date: field(row, "ex_date"),
        record_date: field(row, "record_date"),
        payment_date: field(row, "payment_date"),
        amount: optionalNumber(row.amount) ?? optionalNumber(row.dividend ?? row.dividend_amount),
        currency: field(row, "currency", "dividend_currency", "rate_currency"),
        split_ratio: splitRatio(row),
        split_factor: splitFactor(row),
        details: field(row, "details", "detail"),
      }));

      // Filter by action types if specified
      let filteredActions = actions;
      if (params.action_types && params.action_types.length > 0) {
        filteredActions = actions.filter((action) =>
          params.action_types!.includes(action.action_type)
        );
      }

      return {
        actions: filteredActions,
        count: filteredActions.length,
      };
    } catch (error) {
      throw new Error(`Failed to get corporate actions: ${error}`);
    }
  }

  /**
   * Get price adjustment factors
   *
   * @param params Adjustment factors query parameters
   * @returns Adjustment factor records
   */
  async getAdjustmentFactors(
    params: AdjustmentFactorsParams
  ): Promise<AdjustmentFactorsResponse> {
    if (!params.start_date) {
      throw new Error("start_date is required");
    }

    const symbols = Array.isArray(params.symbols)
      ? params.symbols.join(",")
      : params.symbols;

    const requestParams = {
      symbols,
      stype_in: params.stype_in || "raw_symbol",
      start: params.start_date,
      end: params.end_date,
      compression: "zstd",
    };

    try {
      const response = await this.http.postFormBinary(
        "/v0/adjustment_factors.get_range",
        requestParams
      );
      const parsed = parseReferenceRows(response);

      const adjustments: AdjustmentFactor[] = parsed.map((row) => ({
        instrument_id: optionalNumber(row.instrument_id),
        security_id: field(row, "security_id"),
        event_id: field(row, "event_id"),
        symbol: field(row, "symbol", "raw_symbol", "nasdaq_symbol") || firstSymbol(symbols),
        dataset: params.dataset ?? "reference",
        effective_date: field(row, "effective_date", "ex_date", "ts_event") || "",
        price_factor: optionalNumber(row.price_factor ?? row.price_adj_factor ?? row.factor) ?? 1.0,
        volume_factor: optionalNumber(row.volume_factor ?? row.volume_adj_factor),
        reason: field(row, "reason"),
        action_type: field(row, "action_type", "event"),
      }));

      return {
        adjustments,
        count: adjustments.length,
      };
    } catch (error) {
      throw new Error(`Failed to get adjustment factors: ${error}`);
    }
  }
}
