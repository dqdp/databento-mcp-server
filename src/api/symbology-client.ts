/**
 * Symbology API Client
 * Handles symbol resolution and mapping operations
 *
 * @see https://databento.com/docs/api-reference-historical/symbology/resolve
 */

import { DataBentoHTTP, parseJSON } from "../http/databento-http.js";
import {
  SymbolMapping,
  SymbolResolution,
  SymbologyResolveRequest,
  SymbologyResolveResponse,
  SymbolType,
} from "../types/symbology.js";

/**
 * Client for Databento Historical Symbology API
 */
export class SymbologyClient {
  private readonly http: DataBentoHTTP;

  constructor(apiKey: string) {
    this.http = new DataBentoHTTP(apiKey);
  }

  /**
   * Resolve symbols to instrument IDs or other symbol types
   *
   * @param request - Symbology resolution parameters
   * @returns Map of input symbols to output symbols
   *
   * @example
   * ```ts
   * const client = new SymbologyClient(apiKey);
   * const result = await client.resolve({
   *   dataset: "GLBX.MDP3",
   *   symbols: ["ES.c.0", "NQ.c.0"],
   *   stype_in: SymbolType.Continuous,
   *   stype_out: SymbolType.InstrumentId,
   *   start_date: "2024-01-01",
   *   end_date: "2024-01-31",
   * });
   * ```
   */
  async resolve(
    request: SymbologyResolveRequest
  ): Promise<SymbologyResolveResponse> {
    this.validateRequest(request);

    // Databento recommends using POST for symbology.resolve
    // to avoid URL length limits with many symbols
    const endpoint = "/v0/symbology.resolve";

    // Build request body
    const requestBody: Record<string, any> = {
      dataset: request.dataset,
      symbols: Array.isArray(request.symbols)
        ? request.symbols.join(",")
        : request.symbols,
      stype_in: request.stype_in,
      stype_out: request.stype_out,
      start_date: request.start_date,
    };

    // Add optional end_date if provided
    if (request.end_date) {
      requestBody.end_date = request.end_date;
    }

    try {
      const response = await this.http.postForm(endpoint, requestBody);
      return this.parseResponse(response);
    } catch (error) {
      throw new Error(`Symbology resolution failed: ${error}`);
    }
  }

  /**
   * Validate symbology resolution request
   */
  private validateRequest(request: SymbologyResolveRequest): void {
    if (!request.dataset) {
      throw new Error("dataset is required");
    }

    if (!request.symbols || request.symbols.length === 0) {
      throw new Error("symbols array cannot be empty");
    }

    if (request.symbols.length > 2000) {
      throw new Error(
        `Too many symbols: ${request.symbols.length}. Maximum is 2000.`
      );
    }

    if (!request.stype_in) {
      throw new Error("stype_in is required");
    }

    if (!request.stype_out) {
      throw new Error("stype_out is required");
    }

    if (!request.start_date) {
      throw new Error("start_date is required");
    }

    // Validate date format (YYYY-MM-DD)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(request.start_date)) {
      throw new Error(
        `Invalid start_date format: ${request.start_date}. Expected YYYY-MM-DD`
      );
    }

    if (request.end_date && !dateRegex.test(request.end_date)) {
      throw new Error(
        `Invalid end_date format: ${request.end_date}. Expected YYYY-MM-DD`
      );
    }
  }

  /**
   * Parse symbology API response
   */
  private parseResponse(responseText: string): SymbologyResolveResponse {
    try {
      const data = parseJSON<any>(responseText);

      // Databento returns an envelope with a `result` map. Older tests and
      // some callers may still pass the map directly, so support both shapes.
      const resultMap =
        data &&
        typeof data === "object" &&
        data.result &&
        typeof data.result === "object" &&
        !Array.isArray(data.result)
          ? data.result
          : data;

      const partial = this.toStringArray(data?.partial);
      const notFound = this.toStringArray(data?.not_found);
      const mappings: Record<string, string | string[]> = {};
      const symbols: SymbolMapping[] = [];

      if (resultMap && typeof resultMap === "object") {
        Object.entries(resultMap).forEach(([inputSymbol, resolutions]) => {
          const parsed = this.parseResolutions(resolutions);

          if (parsed.outputSymbols.length > 0) {
            mappings[inputSymbol] =
              parsed.outputSymbols.length === 1
                ? parsed.outputSymbols[0]
                : parsed.outputSymbols;

            symbols.push({
              input_symbol: inputSymbol,
              output_symbols: parsed.outputSymbols,
              ...(parsed.intervals.length > 0
                ? { intervals: parsed.intervals }
                : {}),
            });
          }
        });
      }

      const partialErrors: Record<string, string> = {};
      partial.forEach((symbol) => {
        partialErrors[symbol] = "partial";
      });
      notFound.forEach((symbol) => {
        partialErrors[symbol] = "not_found";
      });

      const hasPartialResults = partial.length > 0 || notFound.length > 0;

      return {
        result: hasPartialResults ? "partial" : "success",
        mappings,
        ...(symbols.length > 0 ? { symbols } : {}),
        ...(partial.length > 0 ? { partial } : {}),
        ...(notFound.length > 0 ? { not_found: notFound } : {}),
        ...(Object.keys(partialErrors).length > 0
          ? { partial_errors: partialErrors }
          : {}),
      };
    } catch (error) {
      return {
        result: "error",
        mappings: {},
        error: `Failed to parse symbology response: ${error}`,
      };
    }
  }

  private parseResolutions(resolutions: any): {
    outputSymbols: string[];
    intervals: SymbolResolution[];
  } {
    const values = Array.isArray(resolutions) ? resolutions : [resolutions];
    const outputSymbols: string[] = [];
    const intervals: SymbolResolution[] = [];

    values.forEach((resolution) => {
      if (typeof resolution === "string") {
        outputSymbols.push(resolution);
        return;
      }

      if (resolution && typeof resolution === "object") {
        if ("s" in resolution) {
          outputSymbols.push(String(resolution.s));

          if ("d0" in resolution) {
            intervals.push({
              d0: String(resolution.d0),
              ...(resolution.d1 !== undefined
                ? { d1: String(resolution.d1) }
                : {}),
              s: String(resolution.s),
            });
          }
          return;
        }

        outputSymbols.push(JSON.stringify(resolution));
        return;
      }

      if (resolution !== undefined && resolution !== null) {
        outputSymbols.push(String(resolution));
      }
    });

    return { outputSymbols, intervals };
  }

  private toStringArray(value: any): string[] {
    if (!value) {
      return [];
    }

    return Array.isArray(value) ? value.map(String) : [String(value)];
  }
}
