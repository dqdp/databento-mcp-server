import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDatabentoMcpServer,
  type DatabentoMcpClients,
} from "../../mcp/index.js";

function textPayload(result: any) {
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe("text");
  return JSON.parse(result.content[0].text);
}

function expectValidationError(result: any) {
  expect(result.isError).toBe(true);
  expect(textPayload(result)).toEqual(
    expect.objectContaining({
      error: expect.stringContaining("Invalid tool arguments"),
    })
  );
}

function createMockClients(): DatabentoMcpClients {
  return {
    databentoClient: {
      getQuote: vi.fn(),
      getHistoricalBars: vi.fn(),
      getSessionInfo: vi.fn(() => ({
        currentSession: "London",
        sessionStart: new Date("2026-06-15T07:00:00.000Z"),
        sessionEnd: new Date("2026-06-15T14:00:00.000Z"),
        timestamp: new Date("2026-06-15T10:30:00.000Z"),
      })),
    },
    metadataClient: {
      listDatasets: vi.fn(),
      listSchemas: vi.fn(),
      listPublishers: vi.fn(),
      listFields: vi.fn(),
      getCost: vi.fn(async () => ({
        dataset: "GLBX.MDP3",
        symbols: ["ES.c.0"],
        schema: "trades",
        start: "2026-06-15",
        end: "2026-06-16",
        mode: "historical-streaming",
        total_cost: 0,
        currency: "USD",
      })),
      getDatasetRange: vi.fn(),
    },
    referenceClient: {
      searchSecurities: vi.fn(async () => ({
        securities: [],
        count: 0,
      })),
      getCorporateActions: vi.fn(),
      getAdjustmentFactors: vi.fn(),
    },
    timeseriesClient: {
      getRange: vi.fn(async () => ({
        schema: "ohlcv-1h",
        symbols: ["ES.c.0"],
        dateRange: {
          start: "2026-06-15",
          end: "open",
        },
        recordCount: 0,
        data: [],
      })),
    },
    symbologyClient: {
      resolve: vi.fn(),
    },
    batchClient: {
      submitJob: vi.fn(),
      listJobs: vi.fn(),
      getDownloadInfo: vi.fn(),
    },
  } as unknown as DatabentoMcpClients;
}

async function connectTestClient(clients = createMockClients()) {
  const server = createDatabentoMcpServer(clients);
  const client = new Client({
    name: "databento-mcp-in-memory-test",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, clients, server };
}

describe("MCP server integration", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-16T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("lists the Databento tools with MCP input schemas", async () => {
    const { client, server } = await connectTestClient();

    try {
      const response = await client.listTools();
      const toolsByName = new Map(response.tools.map((tool) => [tool.name, tool]));

      expect(response.tools).toHaveLength(17);
      expect(toolsByName.get("get_session_info")?.inputSchema).toEqual(
        expect.objectContaining({
          type: "object",
          properties: expect.objectContaining({
            timestamp: expect.objectContaining({ type: "string" }),
          }),
        })
      );
      expect(toolsByName.get("timeseries_get_range")?.inputSchema.required).toEqual([
        "dataset",
        "symbols",
        "schema",
        "start",
      ]);
      expect(
        (toolsByName.get("timeseries_get_range")?.inputSchema.properties as any).schema.enum
      ).toEqual([
        "mbp-1",
        "mbp-10",
        "mbo",
        "trades",
        "tbbo",
        "bbo-1s",
        "bbo-1m",
        "ohlcv-1s",
        "ohlcv-1m",
        "ohlcv-1h",
        "ohlcv-1d",
        "statistics",
        "definition",
        "status",
      ]);
      expect(
        toolsByName.get("reference_search_securities")?.inputSchema.required
      ).toEqual(["symbols"]);
      expect(
        (toolsByName.get("symbology_resolve")?.inputSchema.properties as any).stype_in.enum
      ).toEqual(["raw_symbol", "instrument_id", "continuous", "parent"]);
      expect(
        (toolsByName.get("batch_list_jobs")?.inputSchema.properties as any).states.items.enum
      ).toEqual(["queued", "processing", "done", "expired"]);
      expect(toolsByName.get("batch_submit_job")?.inputSchema.required).toEqual([
        "dataset",
        "symbols",
        "schema",
        "start",
        "end",
      ]);
      expect(
        (toolsByName.get("batch_submit_job")?.inputSchema.properties as any).schema.enum
      ).toEqual([
        "trades",
        "tbbo",
        "bbo-1s",
        "bbo-1m",
        "mbp-1",
        "mbp-10",
        "mbo",
        "ohlcv-1s",
        "ohlcv-1m",
        "ohlcv-1h",
        "ohlcv-1d",
        "definition",
        "statistics",
        "status",
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("calls no-argument tools when the MCP request omits arguments", async () => {
    const { client, clients, server } = await connectTestClient();

    try {
      const result = await client.callTool({ name: "get_session_info" });

      expect(result.isError).not.toBe(true);
      expect(clients.databentoClient.getSessionInfo).toHaveBeenCalledWith(undefined);
      expect(textPayload(result)).toEqual(
        expect.objectContaining({
          currentSession: "London",
          sessionStart: "2026-06-15T07:00:00.000Z",
          sessionEnd: "2026-06-15T14:00:00.000Z",
          timestamp: "2026-06-15T10:30:00.000Z",
          utcHour: 10,
        })
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects invalid tool arguments at the MCP boundary before client calls", async () => {
    const { client, clients, server } = await connectTestClient();

    try {
      expectValidationError(
        await client.callTool({
          name: "get_futures_quote",
          arguments: {},
        })
      );
      expect(clients.databentoClient.getQuote).not.toHaveBeenCalled();

      expectValidationError(
        await client.callTool({
          name: "get_futures_quote",
          arguments: {
            symbol: "CL",
          },
        })
      );
      expect(clients.databentoClient.getQuote).not.toHaveBeenCalled();

      expectValidationError(
        await client.callTool({
          name: "get_historical_bars",
          arguments: {
            symbol: "ES",
            timeframe: "1h",
            count: 101,
          },
        })
      );
      expect(clients.databentoClient.getHistoricalBars).not.toHaveBeenCalled();

      expectValidationError(
        await client.callTool({
          name: "get_session_info",
          arguments: {
            timestamp: "not-a-date",
          },
        })
      );
      expect(clients.databentoClient.getSessionInfo).not.toHaveBeenCalled();

      expectValidationError(
        await client.callTool({
          name: "timeseries_get_range",
          arguments: {
            dataset: "GLBX.MDP3",
            symbols: "ES.c.0",
            schema: "ohlcv-1h",
            start: "2026-06-15",
            limit: 0,
          },
        })
      );
      expect(clients.timeseriesClient.getRange).not.toHaveBeenCalled();

      expectValidationError(
        await client.callTool({
          name: "timeseries_get_range",
          arguments: {
            dataset: "GLBX.MDP3",
            symbols: "ES.c.0",
            schema: "trades",
            start: "2025-06-15",
            end: "2026-06-16",
          },
        })
      );
      expect(clients.timeseriesClient.getRange).not.toHaveBeenCalled();

      expectValidationError(
        await client.callTool({
          name: "timeseries_get_range",
          arguments: {
            dataset: "GLBX.MDP3",
            symbols: "ES.c.0",
            schema: "ohlcv-1h",
            start: "2026-02-30",
          },
        })
      );
      expect(clients.timeseriesClient.getRange).not.toHaveBeenCalled();

      expectValidationError(
        await client.callTool({
          name: "timeseries_get_range",
          arguments: {
            dataset: "GLBX.MDP3",
            symbols: "ES.c.0",
            schema: "ohlcv-1h",
            start: "2026-06-15",
            limit: 10001,
          },
        })
      );
      expect(clients.timeseriesClient.getRange).not.toHaveBeenCalled();

      expectValidationError(
        await client.callTool({
          name: "timeseries_get_range",
          arguments: {
            dataset: "GLBX.MDP3",
            symbols: "ALL_SYMBOLS",
            schema: "ohlcv-1h",
            start: "2026-06-15",
            end: "2026-06-16",
          },
        })
      );
      expect(clients.timeseriesClient.getRange).not.toHaveBeenCalled();

      expectValidationError(
        await client.callTool({
          name: "symbology_resolve",
          arguments: {
            dataset: "GLBX.MDP3",
            symbols: ["ES.c.0"],
            stype_in: "continuous",
            stype_out: "instrument_id",
            start_date: "2026-06-16",
            end_date: "2026-06-15",
          },
        })
      );
      expect(clients.symbologyClient.resolve).not.toHaveBeenCalled();

      expectValidationError(
        await client.callTool({
          name: "metadata_get_cost",
          arguments: {
            dataset: "GLBX.MDP3",
            start: "2026-06-16",
            end: "2026-06-15",
          },
        })
      );
      expect(clients.metadataClient.getCost).not.toHaveBeenCalled();

      expectValidationError(
        await client.callTool({
          name: "reference_get_corporate_actions",
          arguments: {
            symbols: "AAPL",
            start_date: "2026-06-16",
            end_date: "2026-06-15",
          },
        })
      );
      expect(clients.referenceClient.getCorporateActions).not.toHaveBeenCalled();

      expectValidationError(
        await client.callTool({
          name: "batch_submit_job",
          arguments: {
            dataset: "GLBX.MDP3",
            symbols: ["ES.c.0"],
            schema: "trades",
            start: "2026-06-16",
            end: "2026-06-15",
          },
        })
      );
      expect(clients.batchClient.submitJob).not.toHaveBeenCalled();

      expectValidationError(
        await client.callTool({
          name: "batch_submit_job",
          arguments: {
            dataset: "GLBX.MDP3",
            symbols: ["ES.c.0"],
            schema: "trades",
            start: "2026-06-01",
          },
        })
      );
      expect(clients.batchClient.submitJob).not.toHaveBeenCalled();

      expectValidationError(
        await client.callTool({
          name: "batch_submit_job",
          arguments: {
            dataset: "GLBX.MDP3",
            symbols: ["ES.c.0"],
            schema: "mbp-10",
            start: "2026-05-15",
            end: "2026-06-16",
          },
        })
      );
      expect(clients.batchClient.submitJob).not.toHaveBeenCalled();

      await expect(
        client.callTool({
          name: "get_session_info",
          arguments: "not-an-object" as any,
        })
      ).rejects.toThrow(/expected record|Invalid input/);
      expect(clients.databentoClient.getSessionInfo).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("defaults direct timeseries requests to the configured record limit", async () => {
    const { client, clients, server } = await connectTestClient();

    try {
      const result = await client.callTool({
        name: "timeseries_get_range",
        arguments: {
          dataset: "GLBX.MDP3",
          symbols: "ES.c.0",
          schema: "ohlcv-1h",
          start: "2026-06-15",
        },
      });

      expect(result.isError).not.toBe(true);
      expect(clients.timeseriesClient.getRange).toHaveBeenCalledWith({
        dataset: "GLBX.MDP3",
        symbols: "ES.c.0",
        schema: "ohlcv-1h",
        start: "2026-06-15",
        end: undefined,
        stype_in: undefined,
        stype_out: undefined,
        limit: 10000,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("passes normalized tool arguments to injected clients", async () => {
    const { client, clients, server } = await connectTestClient();

    try {
      const result = await client.callTool({
        name: "timeseries_get_range",
        arguments: {
          dataset: "GLBX.MDP3",
          symbols: "ES.c.0",
          schema: "ohlcv-1h",
          start: "2026-06-15",
          limit: 10,
        },
      });

      expect(result.isError).not.toBe(true);
      expect(clients.timeseriesClient.getRange).toHaveBeenCalledWith({
        dataset: "GLBX.MDP3",
        symbols: "ES.c.0",
        schema: "ohlcv-1h",
        start: "2026-06-15",
        end: undefined,
        stype_in: undefined,
        stype_out: undefined,
        limit: 10,
      });
      expect(textPayload(result)).toEqual(
        expect.objectContaining({
          dataset: "GLBX.MDP3",
          schema: "ohlcv-1h",
          recordCount: 0,
        })
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("allows large daily historical bars while keeping intraday counts capped", async () => {
    const { client, clients, server } = await connectTestClient();

    try {
      vi.mocked(clients.databentoClient.getHistoricalBars).mockResolvedValueOnce([]);

      const result = await client.callTool({
        name: "get_historical_bars",
        arguments: {
          symbol: "ES",
          timeframe: "1d",
          count: 5000,
        },
      });

      expect(result.isError).not.toBe(true);
      expect(clients.databentoClient.getHistoricalBars).toHaveBeenCalledWith("ES", "1d", 5000);

      expectValidationError(
        await client.callTool({
          name: "get_historical_bars",
          arguments: {
            symbol: "ES",
            timeframe: "H4",
            count: 101,
          },
        })
      );
      expect(clients.databentoClient.getHistoricalBars).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("allows latest security master searches without start_date", async () => {
    const { client, clients, server } = await connectTestClient();

    try {
      const result = await client.callTool({
        name: "reference_search_securities",
        arguments: {
          symbols: "AAPL",
          limit: 1,
        },
      });

      expect(result.isError).not.toBe(true);
      expect(clients.referenceClient.searchSecurities).toHaveBeenCalledWith({
        dataset: undefined,
        symbols: "AAPL",
        start_date: undefined,
        end_date: undefined,
        limit: 1,
      });
      expect(textPayload(result)).toEqual(
        expect.objectContaining({
          dataset: "reference",
          symbols: "AAPL",
          date_range: {
            start: "latest",
            end: "not_applicable",
          },
          record_count: 0,
          securities: [],
        })
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("counts comma-separated batch job symbols from Databento responses", async () => {
    const { client, clients, server } = await connectTestClient();

    try {
      vi.mocked(clients.batchClient.submitJob).mockResolvedValueOnce({
        id: "batch-job-1",
        state: "received",
        dataset: "GLBX.MDP3",
        schema: "trades",
        symbols: "ZC.FUT,ES.FUT",
        cost_usd: "0.01",
        start: "2026-06-15",
        end: "2026-06-16",
        encoding: "dbn",
        compression: "zstd",
        ts_received: "2026-06-15T10:30:00Z",
      } as any);

      const result = await client.callTool({
        name: "batch_submit_job",
        arguments: {
          dataset: "GLBX.MDP3",
          symbols: ["ZC.FUT", "ES.FUT"],
          schema: "trades",
          start: "2026-06-15",
          end: "2026-06-16",
        },
      });

      expect(result.isError).not.toBe(true);
      expect(clients.metadataClient.getCost).toHaveBeenCalledWith({
        dataset: "GLBX.MDP3",
        symbols: ["ZC.FUT", "ES.FUT"],
        schema: "trades",
        start: "2026-06-15",
        end: "2026-06-16",
        stype_in: undefined,
        stype_out: undefined,
      });
      expect(clients.batchClient.submitJob).toHaveBeenCalledWith({
        dataset: "GLBX.MDP3",
        symbols: ["ZC.FUT", "ES.FUT"],
        schema: "trades",
        start: "2026-06-15",
        end: "2026-06-16",
      });
      expect(textPayload(result)).toEqual(
        expect.objectContaining({
          job_id: "batch-job-1",
          symbols_count: 2,
        })
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("allows ALL_SYMBOLS through batch submit after zero-cost preflight", async () => {
    const { client, clients, server } = await connectTestClient();

    try {
      vi.mocked(clients.batchClient.submitJob).mockResolvedValueOnce({
        id: "batch-all-symbols",
        state: "received",
        dataset: "GLBX.MDP3",
        schema: "ohlcv-1d",
        symbols: "ALL_SYMBOLS",
        cost_usd: "0.00",
        start: "2010-01-01",
        end: "2026-06-16",
        encoding: "dbn",
        compression: "zstd",
        ts_received: "2026-06-15T10:30:00Z",
      } as any);

      const result = await client.callTool({
        name: "batch_submit_job",
        arguments: {
          dataset: "GLBX.MDP3",
          symbols: ["ALL_SYMBOLS"],
          schema: "ohlcv-1d",
          start: "2010-01-01",
          end: "2026-06-16",
        },
      });

      expect(result.isError).not.toBe(true);
      expect(clients.metadataClient.getCost).toHaveBeenCalledWith({
        dataset: "GLBX.MDP3",
        symbols: ["ALL_SYMBOLS"],
        schema: "ohlcv-1d",
        start: "2010-01-01",
        end: "2026-06-16",
        stype_in: undefined,
        stype_out: undefined,
      });
      expect(clients.batchClient.submitJob).toHaveBeenCalledWith({
        dataset: "GLBX.MDP3",
        symbols: ["ALL_SYMBOLS"],
        schema: "ohlcv-1d",
        start: "2010-01-01",
        end: "2026-06-16",
      });
      expect(textPayload(result)).toEqual(
        expect.objectContaining({
          job_id: "batch-all-symbols",
          symbols_count: 1,
        })
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("refuses batch submit when Databento cost preflight reports billable covered data", async () => {
    const { client, clients, server } = await connectTestClient();

    try {
      vi.mocked(clients.metadataClient.getCost).mockResolvedValueOnce({
        dataset: "GLBX.MDP3",
        symbols: ["ES.c.0"],
        schema: "trades",
        start: "2026-06-15",
        end: "2026-06-16",
        mode: "historical-streaming",
        total_cost: 0.25,
        currency: "USD",
      });

      const result = await client.callTool({
        name: "batch_submit_job",
        arguments: {
          dataset: "GLBX.MDP3",
          symbols: ["ES.c.0"],
          schema: "trades",
          start: "2026-06-15",
          end: "2026-06-16",
        },
      });

      expect(result.isError).toBe(true);
      expect(textPayload(result)).toEqual({
        error: expect.stringContaining("Databento estimated this covered Standard CME request as billable"),
      });
      expect(clients.batchClient.submitJob).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("refuses batch submit for any positive preflight cost by default", async () => {
    const { client, clients, server } = await connectTestClient();

    try {
      vi.mocked(clients.metadataClient.getCost).mockResolvedValueOnce({
        dataset: "GLBX.MDP3",
        symbols: ["ES.c.0"],
        schema: "trades",
        start: "2026-06-15",
        end: "2026-06-16",
        mode: "historical-streaming",
        total_cost: 0.005,
        currency: "USD",
      });

      const result = await client.callTool({
        name: "batch_submit_job",
        arguments: {
          dataset: "GLBX.MDP3",
          symbols: ["ES.c.0"],
          schema: "trades",
          start: "2026-06-15",
          end: "2026-06-16",
        },
      });

      expect(result.isError).toBe(true);
      expect(textPayload(result)).toEqual({
        error: expect.stringContaining("Databento estimated this covered Standard CME request as billable"),
      });
      expect(clients.batchClient.submitJob).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("uses Databento package size and comma-separated symbols in batch job lists", async () => {
    const { client, clients, server } = await connectTestClient();

    try {
      vi.mocked(clients.batchClient.listJobs).mockResolvedValueOnce([
        {
          id: "batch-job-1",
          state: "done",
          dataset: "GLBX.MDP3",
          schema: "trades",
          symbols: "ZC.FUT,ES.FUT",
          cost_usd: "0.01",
          start: "2026-06-15",
          end: "2026-06-16",
          encoding: "dbn",
          compression: "zstd",
          ts_received: "2026-06-15T10:30:00Z",
          package_size: 4096,
          actual_size: 8192,
          total_size: 1,
        } as any,
      ]);

      const result = await client.callTool({
        name: "batch_list_jobs",
        arguments: {
          states: ["done"],
        },
      });

      expect(result.isError).not.toBe(true);
      expect(textPayload(result)).toEqual(
        expect.objectContaining({
          total_jobs: 1,
          jobs: [
            expect.objectContaining({
              id: "batch-job-1",
              symbols_count: 2,
              total_size_bytes: 4096,
            }),
          ],
        })
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns batch download transport failures as MCP errors", async () => {
    const { client, clients, server } = await connectTestClient();

    try {
      vi.mocked(clients.batchClient.getDownloadInfo).mockRejectedValueOnce(
        new Error("HTTP 401: Unauthorized")
      );

      const result = await client.callTool({
        name: "batch_download",
        arguments: {
          job_id: "batch-job-1",
        },
      });

      expect(result.isError).toBe(true);
      expect(textPayload(result)).toEqual({
        error: "HTTP 401: Unauthorized",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns MCP tool errors as isError responses", async () => {
    const { client, server } = await connectTestClient();

    try {
      const result = await client.callTool({ name: "not_a_tool" });

      expect(result.isError).toBe(true);
      expect(textPayload(result)).toEqual({
        error: "Unknown tool: not_a_tool",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
