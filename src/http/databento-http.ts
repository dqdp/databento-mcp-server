/**
 * DataBento Base HTTP Client
 * Provides shared HTTP functionality for all Databento API clients
 */

import * as zlib from "node:zlib";
import type { Agent as UndiciAgent } from "undici";

// Databento generates big parent-level responses SERVER-SIDE for minutes (live probe 2026-07-05:
// whole-root statistics ~6 min on GC) — undici's DEFAULT headers/body timeouts (300s) abort such
// requests with "terminated" regardless of our per-request AbortSignal. One shared dispatcher
// raises those engine timeouts; the per-request signal stays the actual deadline.
//
// undici is an OPTIONAL runtime dependency: the standalone skill install runs this SAME compiled
// file with no node_modules alongside it (see scripts/install-skills.sh), so a hard import would
// crash every skill script with "Cannot find module 'undici'". Resolve it lazily and fall back to
// fetch's default dispatcher when it's absent — Node's global fetch IS undici, so only the raised
// engine timeouts are lost, and the skill's interactive pulls stay well under the 300s default.
const LONG_PULL_DISPATCHER: UndiciAgent | undefined = (() => {
  try {
    const { Agent } = require("undici") as typeof import("undici");
    return new Agent({ connectTimeout: 30_000, headersTimeout: 600_000, bodyTimeout: 600_000 });
  } catch {
    return undefined; // undici not installed (standalone skill) -> default 300s engine timeouts
  }
})();


/**
 * Configuration for DataBento API requests
 */
export interface DataBentoConfig {
  baseUrl: string;
  timeout: number;
  retryAttempts: number;
  retryDelayMs: number;
}

export const DATABENTO_CONFIG: DataBentoConfig = {
  baseUrl: "https://hist.databento.com",
  timeout: 15000, // 15 seconds
  retryAttempts: 3,
  retryDelayMs: 1000, // Base delay for exponential backoff
};

interface RequestOptions {
  retry?: boolean;
  /** Per-request abort timeout (ms). Falls back to the client's config timeout. */
  timeout?: number;
}

/**
 * DataBento API HTTP Client
 * Handles authentication, retries, and error handling for all Databento API requests
 */
export class DataBentoHTTP {
  private readonly apiKey: string;
  private readonly config: DataBentoConfig;

  constructor(apiKey: string, overrides?: Partial<DataBentoConfig>) {
    if (!apiKey) {
      throw new Error("DATABENTO_API_KEY is required");
    }
    if (!apiKey.startsWith("db-")) {
      throw new Error('DATABENTO_API_KEY must start with "db-"');
    }
    this.apiKey = apiKey;
    this.config = {
      ...DATABENTO_CONFIG,
      ...(overrides || {}),
    };
  }

  /**
   * Make a GET request to the DataBento API
   *
   * @param endpoint - API endpoint path (e.g., "/v0/timeseries.get_range")
   * @param params - Query parameters
   * @returns Response text (CSV or JSON depending on endpoint)
   */
  async get(
    endpoint: string,
    params?: Record<string, any>,
    requestOptions?: RequestOptions
  ): Promise<string> {
    const url = new URL(endpoint, this.config.baseUrl);

    // Add query parameters
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          url.searchParams.append(key, String(value));
        }
      });
    }

    return this.makeRequest(url.toString(), { method: "GET" }, requestOptions);
  }

  /**
   * Make a POST request to the DataBento API with JSON body
   *
   * @param endpoint - API endpoint path
   * @param data - Request body data
   * @returns Response text (CSV or JSON depending on endpoint)
   */
  async post(endpoint: string, data?: any): Promise<string> {
    const url = new URL(endpoint, this.config.baseUrl);

    const body = data ? JSON.stringify(data) : undefined;
    const headers: Record<string, string> = {
      Authorization: this.getAuthHeader(),
      "User-Agent": "DataBento-MCP-Server/1.0",
    };

    if (body) {
      headers["Content-Type"] = "application/json";
    }

    return this.makeRequest(url.toString(), {
      method: "POST",
      headers,
      body,
    });
  }

  /**
   * Make a POST request to the DataBento API with form-encoded body
   * Used for batch job submissions
   *
   * @param endpoint - API endpoint path
   * @param data - Form data as key-value pairs
   * @returns Response text (JSON response)
   */
  async postForm(
    endpoint: string,
    data: Record<string, any>,
    requestOptions?: RequestOptions
  ): Promise<string> {
    const url = new URL(endpoint, this.config.baseUrl);
    const body = buildFormBody(data);

    return this.makeRequest(
      url.toString(),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      },
      requestOptions
    );
  }

  /**
   * Make a POST request to the DataBento API with form-encoded body and
   * return the raw response bytes. Reference API endpoints stream zstd JSONL.
   */
  async postFormBinary(endpoint: string, data: Record<string, any>): Promise<Buffer> {
    const url = new URL(endpoint, this.config.baseUrl);
    const body = buildFormBody(data);

    return this.makeBinaryRequest(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
  }

  /**
   * Make HTTP request with retry logic and error handling
   */
  private async makeRequest(
    url: string,
    options: RequestInit,
    requestOptions?: RequestOptions
  ): Promise<string> {
    const response = await this.fetchWithRetry(url, options, requestOptions);
    return response.text();
  }

  /**
   * Make HTTP request with retry logic and return the raw response body.
   */
  private async makeBinaryRequest(
    url: string,
    options: RequestInit
  ): Promise<Buffer> {
    const response = await this.fetchWithRetry(url, options);
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    requestOptions?: RequestOptions
  ): Promise<Response> {
    const retryAttempts =
      requestOptions?.retry === false ? 1 : this.config.retryAttempts;

    for (let attempt = 1; attempt <= retryAttempts; attempt++) {
      try {
        const response = await fetch(url, {
          ...options,
          headers: {
            ...options.headers,
            Authorization: this.getAuthHeader(),
            "User-Agent": "DataBento-MCP-Server/1.0",
          },
          signal: AbortSignal.timeout(requestOptions?.timeout ?? this.config.timeout),
          // undici extension (Node's fetch IS undici): lift the 300s engine defaults for long pulls,
          // but only when undici resolved — the standalone skill runs without it (default dispatcher).
          ...(LONG_PULL_DISPATCHER ? { dispatcher: LONG_PULL_DISPATCHER } : {}),
        } as RequestInit & { dispatcher?: UndiciAgent });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `HTTP ${response.status}: ${response.statusText} - ${errorText}`
          );
        }

        return response;
      } catch (error) {
        // If this is the last attempt, throw the error
        if (attempt === retryAttempts) {
          throw new Error(
            `DataBento API request failed after ${retryAttempts} attempts: ${error}`
          );
        }

        // Wait before retry with exponential backoff
        const delay = this.config.retryDelayMs * attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw new Error("Unexpected error in DataBento request");
  }

  /**
   * Get Basic Auth header value
   */
  private getAuthHeader(): string {
    return `Basic ${Buffer.from(`${this.apiKey}:`).toString("base64")}`;
  }

  /**
   * Get the base URL for the DataBento API
   * Useful for constructing download URLs
   */
  getBaseUrl(): string {
    return this.config.baseUrl;
  }
}

function buildFormBody(data: Record<string, any>): string {
  const formData = new URLSearchParams();

  Object.entries(data).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      if (Array.isArray(value)) {
        formData.append(key, value.join(","));
      } else {
        formData.append(key, String(value));
      }
    }
  });

  return formData.toString();
}

/**
 * Parse CSV response to array of objects
 *
 * @param csvText - Raw CSV text with header row
 * @returns Array of objects with keys from header row
 */
export function parseCSV(csvText: string): Record<string, string>[] {
  const lines = csvText.trim().split("\n");

  if (lines.length === 0) {
    return [];
  }

  const headers = lines[0].split(",");
  const dataLines = lines.slice(1).filter((line) => line.trim());

  return dataLines.map((line) => {
    const values = line.split(",");
    const obj: Record<string, string> = {};

    headers.forEach((header, index) => {
      obj[header.trim()] = values[index]?.trim() || "";
    });

    return obj;
  });
}

/**
 * Build query parameter string from object
 *
 * @param params - Parameters object
 * @returns URL-encoded query string (without leading "?")
 */
export function buildQueryParams(params: Record<string, any>): string {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      searchParams.append(key, String(value));
    }
  });

  return searchParams.toString();
}

/**
 * Parse JSON response
 *
 * @param jsonText - Raw JSON text
 * @returns Parsed JSON object
 */
export function parseJSON<T = any>(jsonText: string): T {
  try {
    return JSON.parse(jsonText) as T;
  } catch (error) {
    throw new Error(`Failed to parse JSON response: ${error}`);
  }
}

/**
 * Parse newline-delimited JSON response.
 */
export function parseJSONL<T = Record<string, unknown>>(jsonlText: string): T[] {
  const lines = jsonlText
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((line) => parseJSON<T>(line));
}

/**
 * Decompress zstd bytes returned by Databento Reference API endpoints.
 */
export function decompressZstd(data: Buffer): Buffer {
  const zstdDecompressSync = (
    zlib as typeof zlib & {
      zstdDecompressSync?: (buffer: Buffer) => Buffer;
    }
  ).zstdDecompressSync;

  if (!zstdDecompressSync) {
    throw new Error(
      "This Node.js runtime does not support zstd decompression. Use a Node.js version with node:zlib zstd support."
    );
  }

  return zstdDecompressSync(data);
}
