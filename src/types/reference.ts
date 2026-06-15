/**
 * TypeScript type definitions for DataBento Reference API
 * Based on the Databento Python SDK reference API
 */

/**
 * Security master record containing instrument metadata
 */
export interface SecurityRecord {
  /** Instrument ID assigned by DataBento */
  instrument_id?: number;
  /** Security ID assigned by Databento Reference API */
  security_id?: string;
  /** Listing ID assigned by Databento Reference API */
  listing_id?: string;
  /** Issuer ID assigned by Databento Reference API */
  issuer_id?: string;
  /** Trading symbol */
  symbol: string;
  /** Dataset code */
  dataset: string;
  /** Security type (e.g., 'FUTURE', 'OPTION', 'EQUITY') */
  stype: string;
  /** First date the security was active */
  first_available: string;
  /** Last date the security was active */
  last_available: string;
  /** Exchange or venue */
  exchange: string;
  /** Asset class */
  asset_class?: string;
  /** Security description */
  description?: string;
  /** ISIN identifier */
  isin?: string;
  /** Currency code */
  currency?: string;
  /** Contract size/multiplier */
  contract_size?: number;
  /** Tick size */
  tick_size?: number;
  /** Expiration date (for derivatives) */
  expiration?: string;
}

/**
 * Corporate action record (dividends, splits, etc.)
 */
export interface CorporateAction {
  /** Instrument ID */
  instrument_id?: number;
  /** Security ID assigned by Databento Reference API */
  security_id?: string;
  /** Event ID assigned by Databento Reference API */
  event_id?: string;
  /** Trading symbol */
  symbol: string;
  /** Dataset code */
  dataset: string;
  /** Action type: 'DIVIDEND', 'SPLIT', 'MERGER', 'SPINOFF', etc. */
  action_type: string;
  /** Effective date of the action (ISO date string) */
  effective_date: string;
  /** Announcement date (ISO date string) */
  announcement_date?: string;
  /** Ex-dividend date (ISO date string) */
  ex_date?: string;
  /** Record date (ISO date string) */
  record_date?: string;
  /** Payment date (ISO date string) */
  payment_date?: string;
  /** Dividend amount (for dividend actions) */
  amount?: number;
  /** Currency of the amount */
  currency?: string;
  /** Split ratio (for split actions) - e.g., "2:1" */
  split_ratio?: string;
  /** Split factor (numeric representation) */
  split_factor?: number;
  /** Additional action details */
  details?: string;
}

/**
 * Price adjustment factor record
 */
export interface AdjustmentFactor {
  /** Instrument ID */
  instrument_id?: number;
  /** Security ID assigned by Databento Reference API */
  security_id?: string;
  /** Event ID assigned by Databento Reference API */
  event_id?: string;
  /** Trading symbol */
  symbol: string;
  /** Dataset code */
  dataset: string;
  /** Effective date of the adjustment (ISO date string) */
  effective_date: string;
  /** Price adjustment factor (cumulative) */
  price_factor: number;
  /** Volume adjustment factor (cumulative) */
  volume_factor?: number;
  /** Reason for adjustment */
  reason?: string;
  /** Related corporate action type */
  action_type?: string;
}

/**
 * Request parameters for security search
 */
export interface SecuritySearchParams {
  /** Optional compatibility label; Databento Reference API does not require a dataset */
  dataset?: string;
  /** Symbols to search (comma-separated or array) */
  symbols: string | string[];
  /** Optional start date (ISO format YYYY-MM-DD); omitted requests the latest snapshot */
  start_date?: string;
  /** End date (ISO format YYYY-MM-DD), used only with start_date */
  end_date?: string;
  /** Symbol type (default: 'raw_symbol') */
  stype_in?: string;
  /** Local maximum number of results to return */
  limit?: number;
}

/**
 * Request parameters for corporate actions
 */
export interface CorporateActionsParams {
  /** Optional compatibility label; Databento Reference API does not require a dataset */
  dataset?: string;
  /** Symbols to query */
  symbols: string | string[];
  /** Start date (ISO format YYYY-MM-DD) */
  start_date: string;
  /** End date (ISO format YYYY-MM-DD) */
  end_date?: string;
  /** Symbol type */
  stype_in?: string;
  /** Databento corporate action event filters (e.g., ['DIV', 'FSPLT', 'RSPLT']) */
  action_types?: string[];
}

/**
 * Request parameters for adjustment factors
 */
export interface AdjustmentFactorsParams {
  /** Optional compatibility label; Databento Reference API does not require a dataset */
  dataset?: string;
  /** Symbols to query */
  symbols: string | string[];
  /** Start date (ISO format YYYY-MM-DD) */
  start_date: string;
  /** End date (ISO format YYYY-MM-DD) */
  end_date?: string;
  /** Symbol type */
  stype_in?: string;
}

/**
 * Response wrapper for security search
 */
export interface SecuritySearchResponse {
  securities: SecurityRecord[];
  count: number;
}

/**
 * Response wrapper for corporate actions
 */
export interface CorporateActionsResponse {
  actions: CorporateAction[];
  count: number;
}

/**
 * Response wrapper for adjustment factors
 */
export interface AdjustmentFactorsResponse {
  adjustments: AdjustmentFactor[];
  count: number;
}
