/**
 * Symbology API Types
 * Based on Databento Historical Symbology API
 */

/**
 * Symbol type for input/output symbology resolution
 *
 * @see https://databento.com/docs/knowledge-base/symbology
 */
export enum SymbolType {
  /** Native symbology for the venue/publisher */
  RawSymbol = "raw_symbol",
  /** Databento-specific instrument ID */
  InstrumentId = "instrument_id",
  /** Continuous contracts for futures */
  Continuous = "continuous",
  /** Parent symbol for options and futures */
  Parent = "parent",
}

/**
 * Request parameters for symbology resolution
 */
export interface SymbologyResolveRequest {
  /** Dataset code (e.g., GLBX.MDP3, XNAS.ITCH) */
  dataset: string;
  /** Array of symbols to resolve (max 2000) */
  symbols: string[];
  /** Input symbology type */
  stype_in: SymbolType | string;
  /** Output symbology type */
  stype_out: SymbolType | string;
  /** Inclusive start date for symbol resolution (YYYY-MM-DD) */
  start_date: string;
  /** Optional exclusive end date for symbol resolution (YYYY-MM-DD) */
  end_date?: string;
}

/**
 * Symbol mapping result
 */
export interface SymbolMapping {
  /** Input symbol */
  input_symbol: string;
  /** Resolved output symbol(s) */
  output_symbols: string[];
  /** Raw Databento resolution intervals for this symbol */
  intervals?: SymbolResolution[];
  /** Date range for which the mapping is valid */
  date_range?: {
    start: string;
    end?: string;
  };
}

/**
 * Response from symbology resolution
 */
export interface SymbologyResolveResponse {
  /** Result type */
  result: "success" | "partial" | "error";
  /** Map of input symbols to output symbols */
  mappings: Record<string, string | string[]>;
  /** Array of symbol mappings with metadata */
  symbols?: SymbolMapping[];
  /** Symbols that Databento resolved only partially */
  partial?: string[];
  /** Symbols that Databento could not resolve */
  not_found?: string[];
  /** Error message if result is error */
  error?: string;
  /** Partial errors for specific symbols */
  partial_errors?: Record<string, string>;
}

/**
 * Symbol resolution result with dates
 */
export interface SymbolResolution {
  /** Start date (YYYY-MM-DD) */
  d0: string;
  /** End date (YYYY-MM-DD), optional */
  d1?: string;
  /** Resolved symbol */
  s: string;
}
