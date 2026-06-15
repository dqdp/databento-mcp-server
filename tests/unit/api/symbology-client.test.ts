/**
 * Unit tests for SymbologyClient
 * Tests symbol resolution across supported Historical API symbol types
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SymbologyClient } from "../../../src/api/symbology-client.js";
import { DataBentoHTTP } from "../../../src/http/databento-http.js";
import {
  generateSymbologyRequest,
  generateSymbologyResponse,
  generateJSONResponse,
} from "../../fixtures/mock-data.js";
import { SymbolType } from "../../../src/types/symbology.js";

describe("SymbologyClient", () => {
  let symbologyClient: SymbologyClient;
  let mockHTTP: DataBentoHTTP;

  beforeEach(() => {
    symbologyClient = new SymbologyClient("db-test-api-key-12345");
    // Get the internal HTTP client and mock its methods
    mockHTTP = (symbologyClient as any).http as DataBentoHTTP;
    vi.spyOn(mockHTTP, "postForm").mockResolvedValue("");
  });

  describe("resolve", () => {
    it("should resolve symbols successfully", async () => {
      const request = generateSymbologyRequest({
        symbols: ["ES.c.0", "NQ.c.0"],
        stype_in: SymbolType.Continuous,
        stype_out: SymbolType.InstrumentId,
      });
      const expectedResponse = generateSymbologyResponse(request.symbols);
      const mockResponse = generateJSONResponse(expectedResponse.mappings);

      vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

      const result = await symbologyClient.resolve(request);

      expect(result.result).toBe("success");
      expect(result.mappings).toBeDefined();
      expect(Object.keys(result.mappings)).toHaveLength(2);
    });

    it("should use form-encoded POST method for symbol resolution", async () => {
      const request = generateSymbologyRequest();
      const mockResponse = generateJSONResponse({});

      const postFormSpy = vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

      await symbologyClient.resolve(request);

      expect(postFormSpy).toHaveBeenCalledWith(
        "/v0/symbology.resolve",
        expect.any(Object)
      );
    });

    it("should join symbols with commas in request body", async () => {
      const request = generateSymbologyRequest({
        symbols: ["ES.FUT", "NQ.FUT", "YM.FUT"],
      });
      const mockResponse = generateJSONResponse({});

      const postFormSpy = vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

      await symbologyClient.resolve(request);

      expect(postFormSpy).toHaveBeenCalledWith(
        "/v0/symbology.resolve",
        expect.objectContaining({
          symbols: "ES.FUT,NQ.FUT,YM.FUT",
        })
      );
    });

    it("should include all required parameters in request", async () => {
      const request = generateSymbologyRequest({
        dataset: "GLBX.MDP3",
        symbols: ["ES.c.0"],
        stype_in: SymbolType.Continuous,
        stype_out: SymbolType.InstrumentId,
        start_date: "2024-01-01",
      });
      const mockResponse = generateJSONResponse({});

      const postFormSpy = vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

      await symbologyClient.resolve(request);

      expect(postFormSpy).toHaveBeenCalledWith(
        "/v0/symbology.resolve",
        expect.objectContaining({
          dataset: "GLBX.MDP3",
          symbols: "ES.c.0",
          stype_in: SymbolType.Continuous,
          stype_out: SymbolType.InstrumentId,
          start_date: "2024-01-01",
        })
      );
    });

    it("should include end_date when provided", async () => {
      const request = generateSymbologyRequest({
        end_date: "2024-01-31",
      });
      const mockResponse = generateJSONResponse({});

      const postFormSpy = vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

      await symbologyClient.resolve(request);

      expect(postFormSpy).toHaveBeenCalledWith(
        "/v0/symbology.resolve",
        expect.objectContaining({
          end_date: "2024-01-31",
        })
      );
    });

    it("should not include end_date when not provided", async () => {
      const request = generateSymbologyRequest({
        end_date: undefined,
      });
      const mockResponse = generateJSONResponse({});

      const postFormSpy = vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

      await symbologyClient.resolve(request);

      const callArgs = postFormSpy.mock.calls[0][1];
      expect(callArgs).not.toHaveProperty("end_date");
    });

    // Test supported Historical API symbol types
    describe("Symbol Types", () => {
      it("should resolve RawSymbol type", async () => {
        const request = generateSymbologyRequest({
          symbols: ["ESH5"],
          stype_in: SymbolType.RawSymbol,
          stype_out: SymbolType.InstrumentId,
        });
        const mockResponse = generateJSONResponse({ ESH5: "12345" });

        vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

        const result = await symbologyClient.resolve(request);

        expect(result.result).toBe("success");
        expect(result.mappings["ESH5"]).toBeDefined();
      });

      it("should resolve InstrumentId type", async () => {
        const request = generateSymbologyRequest({
          symbols: ["12345"],
          stype_in: SymbolType.InstrumentId,
          stype_out: SymbolType.RawSymbol,
        });
        const mockResponse = generateJSONResponse({ "12345": "ESH5" });

        vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

        const result = await symbologyClient.resolve(request);

        expect(result.result).toBe("success");
        expect(result.mappings["12345"]).toBeDefined();
      });

      it("should resolve Continuous type", async () => {
        const request = generateSymbologyRequest({
          symbols: ["ES.c.0", "ES.c.1"],
          stype_in: SymbolType.Continuous,
          stype_out: SymbolType.RawSymbol,
        });
        const mockResponse = generateJSONResponse({
          "ES.c.0": "ESH5",
          "ES.c.1": "ESM5",
        });

        vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

        const result = await symbologyClient.resolve(request);

        expect(result.result).toBe("success");
        expect(result.mappings["ES.c.0"]).toBeDefined();
        expect(result.mappings["ES.c.1"]).toBeDefined();
      });

      it("should resolve Parent type", async () => {
        const request = generateSymbologyRequest({
          symbols: ["ES"],
          stype_in: SymbolType.Parent,
          stype_out: SymbolType.RawSymbol,
        });
        const mockResponse = generateJSONResponse({
          ES: ["ESH5", "ESM5", "ESU5"],
        });

        vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

        const result = await symbologyClient.resolve(request);

        expect(result.result).toBe("success");
        expect(result.mappings["ES"]).toBeDefined();
      });

    });

    // Validation tests
    describe("Validation", () => {
      it("should throw error if dataset is missing", async () => {
        const request = { ...generateSymbologyRequest(), dataset: undefined as any };

        await expect(async () => {
          await symbologyClient.resolve(request);
        }).rejects.toThrow("dataset is required");
      });

      it("should throw error if symbols array is empty", async () => {
        const request = generateSymbologyRequest({ symbols: [] });

        await expect(symbologyClient.resolve(request)).rejects.toThrow(
          "symbols array cannot be empty"
        );
      });

      it("should throw error if symbols exceed 2000", async () => {
        const symbols = Array.from({ length: 2001 }, (_, i) => `SYM${i}`);
        const request = generateSymbologyRequest({ symbols });

        await expect(symbologyClient.resolve(request)).rejects.toThrow(
          "Too many symbols: 2001. Maximum is 2000."
        );
      });

      it("should allow exactly 2000 symbols", async () => {
        const symbols = Array.from({ length: 2000 }, (_, i) => `SYM${i}`);
        const request = generateSymbologyRequest({ symbols });
        const mockResponse = generateJSONResponse({});

        vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

        await expect(symbologyClient.resolve(request)).resolves.not.toThrow();
      });

      it("should throw error if stype_in is missing", async () => {
        const request = { ...generateSymbologyRequest(), stype_in: undefined as any };

        await expect(async () => {
          await symbologyClient.resolve(request);
        }).rejects.toThrow("stype_in is required");
      });

      it("should throw error if stype_out is missing", async () => {
        const request = { ...generateSymbologyRequest(), stype_out: undefined as any };

        await expect(async () => {
          await symbologyClient.resolve(request);
        }).rejects.toThrow("stype_out is required");
      });

      it("should throw error if start_date is missing", async () => {
        const request = { ...generateSymbologyRequest(), start_date: undefined as any };

        await expect(async () => {
          await symbologyClient.resolve(request);
        }).rejects.toThrow("start_date is required");
      });

      it("should validate start_date format (YYYY-MM-DD)", async () => {
        const request = generateSymbologyRequest({
          start_date: "2024/01/01",
        });

        await expect(symbologyClient.resolve(request)).rejects.toThrow(
          "Invalid start_date format"
        );
      });

      it("should reject start_date with invalid format", async () => {
        const request = generateSymbologyRequest({
          start_date: "invalid-date",
        });

        await expect(symbologyClient.resolve(request)).rejects.toThrow(
          "Invalid start_date format"
        );
      });

      it("should accept valid YYYY-MM-DD start_date", async () => {
        const request = generateSymbologyRequest({
          start_date: "2024-01-01",
        });
        const mockResponse = generateJSONResponse({});

        vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

        await expect(symbologyClient.resolve(request)).resolves.not.toThrow();
      });

      it("should validate end_date format when provided", async () => {
        const request = generateSymbologyRequest({
          end_date: "2024/01/31",
        });

        await expect(symbologyClient.resolve(request)).rejects.toThrow(
          "Invalid end_date format"
        );
      });

      it("should accept valid YYYY-MM-DD end_date", async () => {
        const request = generateSymbologyRequest({
          end_date: "2024-01-31",
        });
        const mockResponse = generateJSONResponse({});

        vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

        await expect(symbologyClient.resolve(request)).resolves.not.toThrow();
      });
    });

    // Response parsing tests
    describe("Response Parsing", () => {
      it("should parse Databento result envelope with interval metadata", async () => {
        const request = generateSymbologyRequest({
          symbols: ["ES.c.0"],
          stype_in: SymbolType.Continuous,
          stype_out: SymbolType.RawSymbol,
        });
        const mockResponse = generateJSONResponse({
          result: {
            "ES.c.0": [
              { d0: "2024-01-01", d1: "2024-03-15", s: "ESH4" },
              { d0: "2024-03-15", d1: "2024-06-21", s: "ESM4" },
            ],
          },
          partial: [],
          not_found: [],
        });

        vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

        const result = await symbologyClient.resolve(request);

        expect(result.result).toBe("success");
        expect(result.mappings["ES.c.0"]).toEqual(["ESH4", "ESM4"]);
        expect(result.symbols).toEqual([
          {
            input_symbol: "ES.c.0",
            output_symbols: ["ESH4", "ESM4"],
            intervals: [
              { d0: "2024-01-01", d1: "2024-03-15", s: "ESH4" },
              { d0: "2024-03-15", d1: "2024-06-21", s: "ESM4" },
            ],
          },
        ]);
      });

      it("should expose partial and not_found symbols from Databento response", async () => {
        const request = generateSymbologyRequest({
          symbols: ["ES.c.0", "NQ.c.0", "BAD"],
          stype_in: SymbolType.Continuous,
          stype_out: SymbolType.RawSymbol,
        });
        const mockResponse = generateJSONResponse({
          result: {
            "ES.c.0": [{ d0: "2024-01-01", d1: "2024-03-15", s: "ESH4" }],
          },
          partial: ["NQ.c.0"],
          not_found: ["BAD"],
        });

        vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

        const result = await symbologyClient.resolve(request);

        expect(result.result).toBe("partial");
        expect(result.mappings["ES.c.0"]).toBe("ESH4");
        expect(result.partial).toEqual(["NQ.c.0"]);
        expect(result.not_found).toEqual(["BAD"]);
        expect(result.partial_errors).toEqual({
          "NQ.c.0": "partial",
          BAD: "not_found",
        });
      });

      it("should parse simple string mappings", async () => {
        const request = generateSymbologyRequest({
          symbols: ["ES.c.0", "NQ.c.0"],
        });
        const mockResponse = generateJSONResponse({
          "ES.c.0": "ESH5",
          "NQ.c.0": "NQH5",
        });

        vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

        const result = await symbologyClient.resolve(request);

        expect(result.result).toBe("success");
        expect(result.mappings["ES.c.0"]).toBe("ESH5");
        expect(result.mappings["NQ.c.0"]).toBe("NQH5");
      });

      it("should parse array of resolutions", async () => {
        const request = generateSymbologyRequest({
          symbols: ["ES"],
        });
        const mockResponse = generateJSONResponse({
          ES: ["ESH5", "ESM5", "ESU5"],
        });

        vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

        const result = await symbologyClient.resolve(request);

        expect(result.result).toBe("success");
        expect(Array.isArray(result.mappings["ES"])).toBe(true);
        expect(result.mappings["ES"]).toEqual(["ESH5", "ESM5", "ESU5"]);
      });

      it("should parse single-element array as string", async () => {
        const request = generateSymbologyRequest({
          symbols: ["ES.c.0"],
        });
        const mockResponse = generateJSONResponse({
          "ES.c.0": ["ESH5"],
        });

        vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

        const result = await symbologyClient.resolve(request);

        expect(result.result).toBe("success");
        expect(result.mappings["ES.c.0"]).toBe("ESH5");
      });

      it("should parse object with 's' field", async () => {
        const request = generateSymbologyRequest({
          symbols: ["ES.c.0"],
        });
        const mockResponse = generateJSONResponse({
          "ES.c.0": { s: "ESH5", d0: "2024-01-01", d1: "2024-01-31" },
        });

        vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

        const result = await symbologyClient.resolve(request);

        expect(result.result).toBe("success");
        expect(result.mappings["ES.c.0"]).toBe("ESH5");
      });

      it("should parse array of objects with 's' field", async () => {
        const request = generateSymbologyRequest({
          symbols: ["ES.c.0"],
        });
        const mockResponse = generateJSONResponse({
          "ES.c.0": [
            { s: "ESH5", d0: "2024-01-01", d1: "2024-01-15" },
            { s: "ESM5", d0: "2024-01-16", d1: "2024-01-31" },
          ],
        });

        vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

        const result = await symbologyClient.resolve(request);

        expect(result.result).toBe("success");
        expect(Array.isArray(result.mappings["ES.c.0"])).toBe(true);
        expect(result.mappings["ES.c.0"]).toEqual(["ESH5", "ESM5"]);
      });

      it("should handle empty response", async () => {
        const request = generateSymbologyRequest({
          symbols: ["INVALID"],
        });
        const mockResponse = generateJSONResponse({});

        vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

        const result = await symbologyClient.resolve(request);

        expect(result.result).toBe("success");
        expect(Object.keys(result.mappings)).toHaveLength(0);
      });

      it("should handle malformed JSON", async () => {
        const request = generateSymbologyRequest();

        vi.spyOn(mockHTTP, "postForm").mockResolvedValue("invalid json {");

        const result = await symbologyClient.resolve(request);

        expect(result.result).toBe("error");
        expect(result.error).toContain("Failed to parse symbology response");
      });

      it("should stringify unknown object format", async () => {
        const request = generateSymbologyRequest({
          symbols: ["TEST"],
        });
        const mockResponse = generateJSONResponse({
          TEST: { custom_field: "value", other_field: 123 },
        });

        vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

        const result = await symbologyClient.resolve(request);

        expect(result.result).toBe("success");
        expect(typeof result.mappings["TEST"]).toBe("string");
      });
    });

    // Error handling tests
    describe("Error Handling", () => {
      it("should wrap HTTP errors with context", async () => {
        const request = generateSymbologyRequest();
        const httpError = new Error("HTTP 401: Unauthorized");

        vi.spyOn(mockHTTP, "postForm").mockRejectedValue(httpError);

        await expect(symbologyClient.resolve(request)).rejects.toThrow(
          "Symbology resolution failed"
        );
      });

      it("should handle network errors", async () => {
        const request = generateSymbologyRequest();
        const networkError = new Error("Network timeout");

        vi.spyOn(mockHTTP, "postForm").mockRejectedValue(networkError);

        await expect(symbologyClient.resolve(request)).rejects.toThrow(
          "Symbology resolution failed: Error: Network timeout"
        );
      });

      it("should handle 429 rate limit errors", async () => {
        const request = generateSymbologyRequest();
        const rateLimitError = new Error("HTTP 429: Too Many Requests");

        vi.spyOn(mockHTTP, "postForm").mockRejectedValue(rateLimitError);

        await expect(symbologyClient.resolve(request)).rejects.toThrow(
          "Symbology resolution failed"
        );
      });
    });

    // Date range handling
    describe("Date Range Handling", () => {
      it("should handle single day date range", async () => {
        const request = generateSymbologyRequest({
          start_date: "2024-01-15",
          end_date: "2024-01-15",
        });
        const mockResponse = generateJSONResponse({});

        vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

        await expect(symbologyClient.resolve(request)).resolves.not.toThrow();
      });

      it("should handle multi-month date range", async () => {
        const request = generateSymbologyRequest({
          start_date: "2024-01-01",
          end_date: "2024-12-31",
        });
        const mockResponse = generateJSONResponse({});

        vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

        await expect(symbologyClient.resolve(request)).resolves.not.toThrow();
      });

      it("should handle historical date ranges", async () => {
        const request = generateSymbologyRequest({
          start_date: "2020-01-01",
          end_date: "2020-12-31",
        });
        const mockResponse = generateJSONResponse({});

        vi.spyOn(mockHTTP, "postForm").mockResolvedValue(mockResponse);

        await expect(symbologyClient.resolve(request)).resolves.not.toThrow();
      });
    });
  });
});
