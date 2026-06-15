/**
 * Unit tests for TimeseriesClient
 * Tests all 13 schemas, parameter validation, CSV parsing, and error handling
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TimeseriesClient } from '../../../src/api/timeseries-client.js';
import { DataBentoHTTP } from '../../../src/http/databento-http.js';
import { Schema, SType, Encoding } from '../../../src/types/timeseries.js';
import {
  mockOHLCV1HResponse,
  mockOHLCV1SResponse,
  mockOHLCV1MResponse,
  mockOHLCV1DResponse,
  mockOHLCVEODResponse,
  mockMBP1Response,
  mockMBP10Response,
  mockTradesResponse,
  mockMBOResponse,
  mockStatisticsResponse,
  mockDefinitionResponse,
  mockImbalanceResponse,
  mockStatusResponse,
  mockEmptyCSVResponse,
  mockMultiSymbolOHLCVResponse,
  mockErrorResponses,
} from '../../fixtures/databento-responses.js';

describe('TimeseriesClient', () => {
  let client: TimeseriesClient;
  let mockHttp: DataBentoHTTP;

  beforeEach(() => {
    // Create mock HTTP client
    mockHttp = {
      get: vi.fn(),
      post: vi.fn(),
      postForm: vi.fn(),
      getBaseUrl: vi.fn(() => 'https://hist.databento.com'),
    } as any;

    client = new TimeseriesClient(mockHttp);
  });

  describe('getRange - Basic Functionality', () => {
    it('should fetch data with minimal required parameters', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1HResponse);

      const result = await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.OHLCV_1H,
        start: '2024-01-01',
      });

      expect(mockHttp.get).toHaveBeenCalledWith('/v0/timeseries.get_range', {
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: 'ohlcv-1h',
        start: '2024-01-01',
        stype_in: 'raw_symbol',
        stype_out: 'instrument_id',
        encoding: 'csv',
      });

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('schema', 'ohlcv-1h');
      expect(result).toHaveProperty('recordCount', 3);
      expect(result).toHaveProperty('symbols', ['ES.c.0']);
      expect(result.dateRange).toEqual({
        start: '2024-01-01',
        end: 'forward_filled',
      });
    });

    it('should fetch data with all parameters', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1HResponse);

      const result = await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: ['ES.c.0', 'NQ.c.0'],
        schema: Schema.OHLCV_1H,
        start: '2024-01-01',
        end: '2024-01-31',
        stype_in: SType.CONTINUOUS,
        stype_out: SType.INSTRUMENT_ID,
        limit: 1000,
        encoding: Encoding.CSV,
      });

      expect(mockHttp.get).toHaveBeenCalledWith('/v0/timeseries.get_range', {
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0,NQ.c.0',
        schema: 'ohlcv-1h',
        start: '2024-01-01',
        end: '2024-01-31',
        stype_in: 'continuous',
        stype_out: 'instrument_id',
        limit: 1000,
        encoding: 'csv',
      });

      expect(result.symbols).toEqual(['ES.c.0', 'NQ.c.0']);
    });

    it('should handle symbols as array', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1HResponse);

      const result = await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: ['ES.c.0', 'NQ.c.0'],
        schema: Schema.OHLCV_1H,
        start: '2024-01-01',
      });

      expect(mockHttp.get).toHaveBeenCalledWith(
        '/v0/timeseries.get_range',
        expect.objectContaining({
          symbols: 'ES.c.0,NQ.c.0',
        })
      );
    });

    it('should handle symbols as string', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1HResponse);

      const result = await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.OHLCV_1H,
        start: '2024-01-01',
      });

      expect(mockHttp.get).toHaveBeenCalledWith(
        '/v0/timeseries.get_range',
        expect.objectContaining({
          symbols: 'ES.c.0',
        })
      );
    });
  });

  describe('getRange - All 13 Schemas', () => {
    it('should fetch mbp-1 (Market by Price L1) data', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockMBP1Response);

      const result = await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.MBP_1,
        start: '2024-01-01',
      });

      expect(result.schema).toBe('mbp-1');
      expect(result.recordCount).toBe(3);
      expect(result.data).toContain('bid_px_00');
      expect(result.data).toContain('ask_px_00');
    });

    it('should fetch mbp-10 (Market by Price L2) data', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockMBP10Response);

      const result = await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.MBP_10,
        start: '2024-01-01',
      });

      expect(result.schema).toBe('mbp-10');
      expect(result.recordCount).toBe(2);
      expect(result.data).toContain('bid_px_01');
      expect(result.data).toContain('ask_px_01');
    });

    it('should fetch mbo (Market by Order) data', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockMBOResponse);

      const result = await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.MBO,
        start: '2024-01-01',
      });

      expect(result.schema).toBe('mbo');
      expect(result.recordCount).toBe(3);
      expect(result.data).toContain('order_id');
    });

    it('should fetch trades data', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockTradesResponse);

      const result = await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.TRADES,
        start: '2024-01-01',
      });

      expect(result.schema).toBe('trades');
      expect(result.recordCount).toBe(3);
      expect(result.data).toContain('price');
      expect(result.data).toContain('size');
    });

    it('should fetch ohlcv-1s (1-second bars) data', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1SResponse);

      const result = await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.OHLCV_1S,
        start: '2024-01-01',
      });

      expect(result.schema).toBe('ohlcv-1s');
      expect(result.recordCount).toBe(3);
    });

    it('should fetch ohlcv-1m (1-minute bars) data', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1MResponse);

      const result = await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.OHLCV_1M,
        start: '2024-01-01',
      });

      expect(result.schema).toBe('ohlcv-1m');
      expect(result.recordCount).toBe(2);
    });

    it('should fetch ohlcv-1h (1-hour bars) data', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1HResponse);

      const result = await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.OHLCV_1H,
        start: '2024-01-01',
      });

      expect(result.schema).toBe('ohlcv-1h');
      expect(result.recordCount).toBe(3);
      expect(result.data).toContain('open');
      expect(result.data).toContain('high');
      expect(result.data).toContain('low');
      expect(result.data).toContain('close');
      expect(result.data).toContain('volume');
    });

    it('should fetch ohlcv-1d (daily bars) data', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1DResponse);

      const result = await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.OHLCV_1D,
        start: '2024-01-01',
      });

      expect(result.schema).toBe('ohlcv-1d');
      expect(result.recordCount).toBe(1);
    });

    it('should fetch ohlcv-eod (end of day) data', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCVEODResponse);

      const result = await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.OHLCV_EOD,
        start: '2024-01-01',
      });

      expect(result.schema).toBe('ohlcv-eod');
      expect(result.recordCount).toBe(1);
    });

    it('should fetch statistics data', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockStatisticsResponse);

      const result = await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.STATISTICS,
        start: '2024-01-01',
      });

      expect(result.schema).toBe('statistics');
      expect(result.recordCount).toBe(2);
      expect(result.data).toContain('stat_type');
    });

    it('should fetch definition data', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockDefinitionResponse);

      const result = await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.DEFINITION,
        start: '2024-01-01',
      });

      expect(result.schema).toBe('definition');
      expect(result.recordCount).toBe(1);
      expect(result.data).toContain('raw_symbol');
      expect(result.data).toContain('expiration');
    });

    it('should fetch imbalance data', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockImbalanceResponse);

      const result = await client.getRange({
        dataset: 'XNAS.ITCH',
        symbols: 'AAPL',
        schema: Schema.IMBALANCE,
        start: '2024-01-01',
      });

      expect(result.schema).toBe('imbalance');
      expect(result.recordCount).toBe(1);
      expect(result.data).toContain('imbalance_qty');
      expect(result.data).toContain('paired_qty');
    });

    it('should fetch status data', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockStatusResponse);

      const result = await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.STATUS,
        start: '2024-01-01',
      });

      expect(result.schema).toBe('status');
      expect(result.recordCount).toBe(2);
      expect(result.data).toContain('action');
      expect(result.data).toContain('is_trading');
    });
  });

  describe('Date Formatting', () => {
    it('should accept YYYY-MM-DD format dates', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1HResponse);

      const result = await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.OHLCV_1H,
        start: '2024-01-01',
        end: '2024-01-31',
      });

      expect(mockHttp.get).toHaveBeenCalledWith(
        '/v0/timeseries.get_range',
        expect.objectContaining({
          start: '2024-01-01',
          end: '2024-01-31',
        })
      );
    });

    it('should preserve ISO 8601 timestamps with time components', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1HResponse);

      const result = await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.OHLCV_1H,
        start: '2024-01-15T12:00:00Z',
        end: '2024-01-15T23:59:59Z',
      });

      // Verify ISO timestamps are preserved for intraday queries
      const call = vi.mocked(mockHttp.get).mock.calls[0] as [string, Record<string, any>];
      expect(call[1].start).toBe('2024-01-15T12:00:00Z');
      expect(call[1].end).toBe('2024-01-15T23:59:59Z');
    });

    it('should preserve ISO 8601 timestamps from Date objects', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1HResponse);

      const startDate = new Date('2024-01-01T12:00:00Z');
      const endDate = new Date('2024-01-31T12:00:00Z');

      const result = await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.OHLCV_1H,
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      });

      // Verify ISO timestamps from Date.toISOString() are preserved
      const call = vi.mocked(mockHttp.get).mock.calls[0] as [string, Record<string, any>];
      expect(call[1].start).toBe('2024-01-01T12:00:00.000Z');
      expect(call[1].end).toBe('2024-01-31T12:00:00.000Z');
    });

    it('should omit end date when not provided', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1HResponse);

      const result = await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.OHLCV_1H,
        start: '2024-01-01',
      });

      expect(mockHttp.get).toHaveBeenCalledWith(
        '/v0/timeseries.get_range',
        expect.objectContaining({
          start: '2024-01-01',
          encoding: 'csv',
        })
      );
      expect(vi.mocked(mockHttp.get).mock.calls[0][1]).not.toHaveProperty('end');
      expect(result.dateRange.end).toBe('forward_filled');
    });
  });

  describe('Symbol Validation', () => {
    it('should handle single symbol', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1HResponse);

      const result = await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.OHLCV_1H,
        start: '2024-01-01',
      });

      expect(result.symbols).toEqual(['ES.c.0']);
    });

    it('should handle multiple symbols', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockMultiSymbolOHLCVResponse);

      const result = await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: ['ES.c.0', 'NQ.c.0'],
        schema: Schema.OHLCV_1H,
        start: '2024-01-01',
      });

      expect(result.symbols).toEqual(['ES.c.0', 'NQ.c.0']);
      expect(result.recordCount).toBe(4);
    });

    it('should reject empty symbol array', async () => {
      await expect(
        client.getRange({
          dataset: 'GLBX.MDP3',
          symbols: [],
          schema: Schema.OHLCV_1H,
          start: '2024-01-01',
        })
      ).rejects.toThrow('symbols is required and cannot be empty');
    });

    it('should reject more than 2000 symbols', async () => {
      const tooManySymbols = Array.from({ length: 2001 }, (_, i) => `SYMBOL${i}`);

      await expect(
        client.getRange({
          dataset: 'GLBX.MDP3',
          symbols: tooManySymbols,
          schema: Schema.OHLCV_1H,
          start: '2024-01-01',
        })
      ).rejects.toThrow('Maximum 2000 symbols allowed per request');
    });

    it('should accept exactly 2000 symbols', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1HResponse);

      const maxSymbols = Array.from({ length: 2000 }, (_, i) => `SYMBOL${i}`);

      const result = await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: maxSymbols,
        schema: Schema.OHLCV_1H,
        start: '2024-01-01',
      });

      expect(result.symbols).toHaveLength(2000);
    });

    it('should validate comma-separated string symbols count', async () => {
      const tooManySymbols = Array.from({ length: 2001 }, (_, i) => `SYMBOL${i}`).join(',');

      await expect(
        client.getRange({
          dataset: 'GLBX.MDP3',
          symbols: tooManySymbols,
          schema: Schema.OHLCV_1H,
          start: '2024-01-01',
        })
      ).rejects.toThrow('Maximum 2000 symbols allowed per request');
    });
  });

  describe('Parameter Validation', () => {
    it('should require dataset parameter', async () => {
      await expect(
        client.getRange({
          dataset: '',
          symbols: 'ES.c.0',
          schema: Schema.OHLCV_1H,
          start: '2024-01-01',
        })
      ).rejects.toThrow('dataset is required');
    });

    it('should require symbols parameter', async () => {
      await expect(
        client.getRange({
          dataset: 'GLBX.MDP3',
          symbols: '',
          schema: Schema.OHLCV_1H,
          start: '2024-01-01',
        })
      ).rejects.toThrow('symbols is required');
    });

    it('should require schema parameter', async () => {
      await expect(
        client.getRange({
          dataset: 'GLBX.MDP3',
          symbols: 'ES.c.0',
          schema: '' as any,
          start: '2024-01-01',
        })
      ).rejects.toThrow('schema is required');
    });

    it('should require start date parameter', async () => {
      await expect(
        client.getRange({
          dataset: 'GLBX.MDP3',
          symbols: 'ES.c.0',
          schema: Schema.OHLCV_1H,
          start: '',
        })
      ).rejects.toThrow('start date is required');
    });

    it('should reject invalid date format', async () => {
      await expect(
        client.getRange({
          dataset: 'GLBX.MDP3',
          symbols: 'ES.c.0',
          schema: Schema.OHLCV_1H,
          start: 'invalid-date',
        })
      ).rejects.toThrow('Invalid date');
    });

    it('should reject negative limit', async () => {
      await expect(
        client.getRange({
          dataset: 'GLBX.MDP3',
          symbols: 'ES.c.0',
          schema: Schema.OHLCV_1H,
          start: '2024-01-01',
          limit: -1,
        })
      ).rejects.toThrow('limit must be greater than 0');
    });

    it('should reject zero limit', async () => {
      await expect(
        client.getRange({
          dataset: 'GLBX.MDP3',
          symbols: 'ES.c.0',
          schema: Schema.OHLCV_1H,
          start: '2024-01-01',
          limit: 0,
        })
      ).rejects.toThrow('limit must be greater than 0');
    });

    it('should accept positive limit', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1HResponse);

      const result = await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.OHLCV_1H,
        start: '2024-01-01',
        limit: 100,
      });

      expect(mockHttp.get).toHaveBeenCalledWith(
        '/v0/timeseries.get_range',
        expect.objectContaining({ limit: 100 })
      );
    });
  });

  describe('CSV Response Parsing', () => {
    it('should count records correctly', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1HResponse);

      const result = await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.OHLCV_1H,
        start: '2024-01-01',
      });

      expect(result.recordCount).toBe(3); // 4 lines - 1 header = 3 records
    });

    it('should handle empty CSV response (header only)', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockEmptyCSVResponse);

      const result = await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.OHLCV_1H,
        start: '2099-01-01',
      });

      // Empty CSV with just headers is valid, returns 0 records
      expect(result.recordCount).toBe(0);
      expect(result.data).toContain('ts_event');
    });

    it('should handle completely empty response', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce('');

      await expect(
        client.getRange({
          dataset: 'GLBX.MDP3',
          symbols: 'INVALID',
          schema: Schema.OHLCV_1H,
          start: '2024-01-01',
        })
      ).rejects.toThrow('No data available');
    });

    it('should parse CSV response to objects', () => {
      const csvData = `col1,col2,col3
value1,value2,value3
value4,value5,value6`;

      const result = client.parseCSVResponse(csvData);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ col1: 'value1', col2: 'value2', col3: 'value3' });
      expect(result[1]).toEqual({ col1: 'value4', col2: 'value5', col3: 'value6' });
    });

    it('should handle CSV with whitespace', () => {
      const csvData = `col1 ,col2, col3
value1, value2 ,value3 `;

      const result = client.parseCSVResponse(csvData);

      expect(result).toHaveLength(1);
      expect(result[0].col1).toBe('value1');
      expect(result[0].col2).toBe('value2');
      expect(result[0].col3).toBe('value3');
    });
  });

  describe('SType (Symbology) Options', () => {
    it('should use raw_symbol as default stype_in', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1HResponse);

      await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ESH4',
        schema: Schema.OHLCV_1H,
        start: '2024-01-01',
      });

      expect(mockHttp.get).toHaveBeenCalledWith(
        '/v0/timeseries.get_range',
        expect.objectContaining({ stype_in: 'raw_symbol' })
      );
    });

    it('should use instrument_id as default stype_out', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1HResponse);

      await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.OHLCV_1H,
        start: '2024-01-01',
      });

      expect(mockHttp.get).toHaveBeenCalledWith(
        '/v0/timeseries.get_range',
        expect.objectContaining({ stype_out: 'instrument_id' })
      );
    });

    it('should support continuous symbology', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1HResponse);

      await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.OHLCV_1H,
        start: '2024-01-01',
        stype_in: SType.CONTINUOUS,
      });

      expect(mockHttp.get).toHaveBeenCalledWith(
        '/v0/timeseries.get_range',
        expect.objectContaining({ stype_in: 'continuous' })
      );
    });

    it('should support parent symbology', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1HResponse);

      await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES',
        schema: Schema.OHLCV_1H,
        start: '2024-01-01',
        stype_in: SType.PARENT,
      });

      expect(mockHttp.get).toHaveBeenCalledWith(
        '/v0/timeseries.get_range',
        expect.objectContaining({ stype_in: 'parent' })
      );
    });
  });

  describe('Encoding Options', () => {
    it('should request CSV encoding by default', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1HResponse);

      await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.OHLCV_1H,
        start: '2024-01-01',
      });

      expect(mockHttp.get).toHaveBeenCalledWith(
        '/v0/timeseries.get_range',
        expect.objectContaining({ encoding: 'csv' })
      );
    });

    it('should reject JSON encoding because getRange parses CSV responses', async () => {
      await expect(
        client.getRange({
          dataset: 'GLBX.MDP3',
          symbols: 'ES.c.0',
          schema: Schema.OHLCV_1H,
          start: '2024-01-01',
          encoding: Encoding.JSON,
        })
      ).rejects.toThrow('TimeseriesClient.getRange only supports csv encoding');
    });

    it('should reject DBN encoding because getRange parses CSV responses', async () => {
      await expect(
        client.getRange({
          dataset: 'GLBX.MDP3',
          symbols: 'ES.c.0',
          schema: Schema.OHLCV_1H,
          start: '2024-01-01',
          encoding: Encoding.DBN,
        })
      ).rejects.toThrow('TimeseriesClient.getRange only supports csv encoding');
    });
  });

  describe('Static Helper Methods', () => {
    it('should return all available schemas', () => {
      const schemas = TimeseriesClient.getAvailableSchemas();

      expect(schemas).toContain(Schema.MBP_1);
      expect(schemas).toContain(Schema.MBP_10);
      expect(schemas).toContain(Schema.MBO);
      expect(schemas).toContain(Schema.TRADES);
      expect(schemas).toContain(Schema.OHLCV_1S);
      expect(schemas).toContain(Schema.OHLCV_1M);
      expect(schemas).toContain(Schema.OHLCV_1H);
      expect(schemas).toContain(Schema.OHLCV_1D);
      expect(schemas).toContain(Schema.OHLCV_EOD);
      expect(schemas).toContain(Schema.STATISTICS);
      expect(schemas).toContain(Schema.DEFINITION);
      expect(schemas).toContain(Schema.IMBALANCE);
      expect(schemas).toContain(Schema.STATUS);
      expect(schemas).toHaveLength(13);
    });

    it('should return all available symbol types', () => {
      const stypes = TimeseriesClient.getAvailableSymbolTypes();

      expect(stypes).toContain(SType.RAW_SYMBOL);
      expect(stypes).toContain(SType.INSTRUMENT_ID);
      expect(stypes).toContain(SType.CONTINUOUS);
      expect(stypes).toContain(SType.PARENT);
      expect(stypes).toHaveLength(4);
    });

    it('should return the supported getRange encodings', () => {
      const encodings = TimeseriesClient.getAvailableEncodings();

      expect(encodings).toEqual([Encoding.CSV]);
    });
  });

  describe('Error Handling', () => {
    it('should propagate HTTP errors', async () => {
      vi.mocked(mockHttp.get).mockRejectedValueOnce(
        new Error(mockErrorResponses.unauthorized)
      );

      await expect(
        client.getRange({
          dataset: 'GLBX.MDP3',
          symbols: 'ES.c.0',
          schema: Schema.OHLCV_1H,
          start: '2024-01-01',
        })
      ).rejects.toThrow('Unauthorized');
    });

    it('should handle 403 Forbidden errors', async () => {
      vi.mocked(mockHttp.get).mockRejectedValueOnce(
        new Error(mockErrorResponses.forbidden)
      );

      await expect(
        client.getRange({
          dataset: 'PREMIUM',
          symbols: 'ES.c.0',
          schema: Schema.OHLCV_1H,
          start: '2024-01-01',
        })
      ).rejects.toThrow('Forbidden');
    });

    it('should handle 429 Rate Limited errors', async () => {
      vi.mocked(mockHttp.get).mockRejectedValueOnce(
        new Error(mockErrorResponses.rateLimited)
      );

      await expect(
        client.getRange({
          dataset: 'GLBX.MDP3',
          symbols: 'ES.c.0',
          schema: Schema.OHLCV_1H,
          start: '2024-01-01',
        })
      ).rejects.toThrow('Rate limit exceeded');
    });

    it('should handle network errors', async () => {
      vi.mocked(mockHttp.get).mockRejectedValueOnce(
        new Error('Network request failed')
      );

      await expect(
        client.getRange({
          dataset: 'GLBX.MDP3',
          symbols: 'ES.c.0',
          schema: Schema.OHLCV_1H,
          start: '2024-01-01',
        })
      ).rejects.toThrow('Network request failed');
    });

    it('should provide helpful error for no data', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce('');

      await expect(
        client.getRange({
          dataset: 'GLBX.MDP3',
          symbols: 'INVALID',
          schema: Schema.OHLCV_1H,
          start: '2024-01-01',
        })
      ).rejects.toThrow(/No data available.*INVALID.*2024-01-01/);
    });
  });

  describe('Date Formatting Edge Cases', () => {
    it('should reject invalid ISO timestamp format', async () => {
      await expect(
        client.getRange({
          dataset: 'GLBX.MDP3',
          symbols: 'ES.c.0',
          schema: Schema.OHLCV_1H,
          start: '2024-13-45T99:99:99Z',  // Invalid date
        })
      ).rejects.toThrow(/Invalid ISO timestamp|Invalid date/);
    });

    it('should reject completely invalid date string', async () => {
      await expect(
        client.getRange({
          dataset: 'GLBX.MDP3',
          symbols: 'ES.c.0',
          schema: Schema.OHLCV_1H,
          start: 'not-a-date-at-all',
        })
      ).rejects.toThrow(/Invalid date/);
    });

    it('should accept Feb 30 as valid (JS Date auto-converts to Mar 1)', async () => {
      // JavaScript Date constructor accepts Feb 30 and converts it to Mar 1
      // This is standard JS behavior, not a bug
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1HResponse);

      await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.OHLCV_1H,
        start: '2024-02-30T12:00:00Z',  // Auto-converts to Mar 1
      });

      const call = vi.mocked(mockHttp.get).mock.calls[0] as [string, Record<string, any>];
      expect(call[1].start).toBe('2024-02-30T12:00:00Z');  // Preserved as-is
    });

    it('should reject invalid end date when start is valid', async () => {
      await expect(
        client.getRange({
          dataset: 'GLBX.MDP3',
          symbols: 'ES.c.0',
          schema: Schema.OHLCV_1H,
          start: '2024-01-01',
          end: 'invalid-end-date',
        })
      ).rejects.toThrow(/Invalid date/);
    });

    it('should handle numeric date strings', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1HResponse);

      await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.OHLCV_1H,
        start: '2024-01-15',  // Already in YYYY-MM-DD format
        end: '2024-01-16',
      });

      const call = vi.mocked(mockHttp.get).mock.calls[0] as [string, Record<string, any>];
      expect(call[1].start).toBe('2024-01-15');
      expect(call[1].end).toBe('2024-01-16');
    });

    it('should preserve milliseconds in ISO timestamps', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1HResponse);

      await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.OHLCV_1H,
        start: '2024-01-15T12:00:00.123Z',
        end: '2024-01-15T18:00:00.456Z',
      });

      const call = vi.mocked(mockHttp.get).mock.calls[0] as [string, Record<string, any>];
      expect(call[1].start).toBe('2024-01-15T12:00:00.123Z');
      expect(call[1].end).toBe('2024-01-15T18:00:00.456Z');
    });

    it('should handle timezone offsets in ISO timestamps', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1HResponse);

      await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.OHLCV_1H,
        start: '2024-01-15T12:00:00+05:00',
        end: '2024-01-15T18:00:00-08:00',
      });

      const call = vi.mocked(mockHttp.get).mock.calls[0] as [string, Record<string, any>];
      expect(call[1].start).toBe('2024-01-15T12:00:00+05:00');
      expect(call[1].end).toBe('2024-01-15T18:00:00-08:00');
    });

    it('should handle year-only boundary dates', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1HResponse);

      await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.OHLCV_1H,
        start: '2024-01-01',
        end: '2024-12-31',
      });

      const call = vi.mocked(mockHttp.get).mock.calls[0] as [string, Record<string, any>];
      expect(call[1].start).toBe('2024-01-01');
      expect(call[1].end).toBe('2024-12-31');
    });
  });

  describe('Schema Edge Cases', () => {
    it('should handle all 13 schemas without errors', async () => {
      const schemas = [
        Schema.MBP_1, Schema.MBP_10, Schema.MBO, Schema.TRADES,
        Schema.OHLCV_1S, Schema.OHLCV_1M, Schema.OHLCV_1H, Schema.OHLCV_1D, Schema.OHLCV_EOD,
        Schema.STATISTICS, Schema.DEFINITION, Schema.IMBALANCE, Schema.STATUS,
      ];

      for (const schema of schemas) {
        vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1HResponse);

        const result = await client.getRange({
          dataset: 'GLBX.MDP3',
          symbols: 'ES.c.0',
          schema,
          start: '2024-01-01',
        });

        expect(result.schema).toBe(schema);
      }
    });
  });

  describe('Symbols Edge Cases', () => {
    it('should handle single character symbol', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1HResponse);

      await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'A',
        schema: Schema.OHLCV_1H,
        start: '2024-01-01',
      });

      const call = vi.mocked(mockHttp.get).mock.calls[0] as [string, Record<string, any>];
      expect(call[1].symbols).toBe('A');
    });

    it('should handle symbols with special characters', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1HResponse);

      await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.OHLCV_1H,
        start: '2024-01-01',
      });

      const call = vi.mocked(mockHttp.get).mock.calls[0] as [string, Record<string, any>];
      expect(call[1].symbols).toBe('ES.c.0');
    });

    it('should handle comma-separated symbol string', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockMultiSymbolOHLCVResponse);

      await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0,NQ.c.0',
        schema: Schema.OHLCV_1H,
        start: '2024-01-01',
      });

      const call = vi.mocked(mockHttp.get).mock.calls[0] as [string, Record<string, any>];
      expect(call[1].symbols).toBe('ES.c.0,NQ.c.0');
    });

    it('should validate symbol count in comma-separated string', async () => {
      const tooManySymbols = Array.from({ length: 2001 }, (_, i) => `SYM${i}`).join(',');

      await expect(
        client.getRange({
          dataset: 'GLBX.MDP3',
          symbols: tooManySymbols,
          schema: Schema.OHLCV_1H,
          start: '2024-01-01',
        })
      ).rejects.toThrow('Maximum 2000 symbols allowed per request');
    });
  });

  describe('Limit Edge Cases', () => {
    it('should reject limit of 0', async () => {
      await expect(
        client.getRange({
          dataset: 'GLBX.MDP3',
          symbols: 'ES.c.0',
          schema: Schema.OHLCV_1H,
          start: '2024-01-01',
          limit: 0,
        })
      ).rejects.toThrow('limit must be greater than 0');
    });

    it('should reject negative limit', async () => {
      await expect(
        client.getRange({
          dataset: 'GLBX.MDP3',
          symbols: 'ES.c.0',
          schema: Schema.OHLCV_1H,
          start: '2024-01-01',
          limit: -10,
        })
      ).rejects.toThrow('limit must be greater than 0');
    });

    it('should accept limit of 1', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1HResponse);

      await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.OHLCV_1H,
        start: '2024-01-01',
        limit: 1,
      });

      const call = vi.mocked(mockHttp.get).mock.calls[0] as [string, Record<string, any>];
      expect(call[1].limit).toBe(1);
    });

    it('should accept very large limit', async () => {
      vi.mocked(mockHttp.get).mockResolvedValueOnce(mockOHLCV1HResponse);

      await client.getRange({
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        schema: Schema.OHLCV_1H,
        start: '2024-01-01',
        limit: 1000000,
      });

      const call = vi.mocked(mockHttp.get).mock.calls[0] as [string, Record<string, any>];
      expect(call[1].limit).toBe(1000000);
    });
  });

  describe('Required Field Validation', () => {
    it('should reject missing dataset', async () => {
      await expect(
        client.getRange({
          dataset: '',
          symbols: 'ES.c.0',
          schema: Schema.OHLCV_1H,
          start: '2024-01-01',
        })
      ).rejects.toThrow('dataset is required');
    });

    it('should reject missing schema', async () => {
      await expect(
        client.getRange({
          dataset: 'GLBX.MDP3',
          symbols: 'ES.c.0',
          schema: '' as any,
          start: '2024-01-01',
        })
      ).rejects.toThrow('schema is required');
    });

    it('should reject missing start date', async () => {
      await expect(
        client.getRange({
          dataset: 'GLBX.MDP3',
          symbols: 'ES.c.0',
          schema: Schema.OHLCV_1H,
          start: '',
        })
      ).rejects.toThrow('start date is required');
    });

    it('should reject missing symbols', async () => {
      await expect(
        client.getRange({
          dataset: 'GLBX.MDP3',
          symbols: '' as any,
          schema: Schema.OHLCV_1H,
          start: '2024-01-01',
        })
      ).rejects.toThrow('symbols is required');
    });
  });
});
