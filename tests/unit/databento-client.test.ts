/**
 * Comprehensive Unit Tests for DataBentoClient
 * Target: 85%+ code coverage
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DataBentoClient } from '../../src/databento-client.js';
import { DataBentoHTTP } from '../../src/http/databento-http.js';

// Mock DataBentoHTTP
vi.mock('../../src/http/databento-http.js', () => {
  return {
    DataBentoHTTP: vi.fn().mockImplementation(function () {
      return {
        get: vi.fn(),
      };
    }),
  };
});

describe('DataBentoClient', () => {
  let client: DataBentoClient;
  let mockHttpGet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new DataBentoClient('db-test-api-key');
    mockHttpGet = (client as any).http.get;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Constructor', () => {
    it('should create instance with API key', () => {
      expect(client).toBeInstanceOf(DataBentoClient);
      expect(DataBentoHTTP).toHaveBeenCalledTimes(1);
      expect(DataBentoHTTP).toHaveBeenCalledWith('db-test-api-key');
    });
  });

  describe('getQuote', () => {
    let sessionSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      sessionSpy = vi.spyOn(client, 'getSessionInfo').mockReturnValue({
        currentSession: 'Unknown',
        sessionStart: new Date(0),
        sessionEnd: new Date(0),
        timestamp: new Date(0),
      });
    });

    afterEach(() => {
      sessionSpy.mockRestore();
    });

    // Mock response with prices in DataBento fixed-point format (value * 1e9)
    const mockQuoteResponse = `ts_recv,ts_event,rtype,publisher_id,instrument_id,action,side,depth,price,size,flags,ts_in_delta,sequence,bid_px_00,ask_px_00,bid_sz_00,ask_sz_00
1234567890123456,1234567890000000,1,1,1234,A,B,0,0,0,0,0,0,4500000000,4502000000,10,15`;

    it('should get quote for ES symbol', async () => {
      mockHttpGet.mockResolvedValue(mockQuoteResponse);

      const quote = await client.getQuote('ES');

      expect(quote.symbol).toBe('ES');
      expect(quote.bid).toBe(4.5);
      expect(quote.ask).toBe(4.502);
      expect(quote.price).toBe((4.5 + 4.502) / 2);
      expect(quote.timestamp).toBeInstanceOf(Date);
      expect(quote.dataAge).toBeGreaterThanOrEqual(0);

      expect(mockHttpGet).toHaveBeenCalledWith('/v0/timeseries.get_range', {
        dataset: 'GLBX.MDP3',
        symbols: 'ES.c.0',
        stype_in: 'continuous',
        stype_out: 'instrument_id',
        start: expect.any(String),
        end: expect.any(String),
        schema: 'mbp-1',
        encoding: 'csv',
        limit: 100,
      });
    });

    it('should get quote for NQ symbol', async () => {
      mockHttpGet.mockResolvedValue(mockQuoteResponse);

      const quote = await client.getQuote('NQ');

      expect(quote.symbol).toBe('NQ');
      expect(mockHttpGet).toHaveBeenCalledWith(
        '/v0/timeseries.get_range',
        expect.objectContaining({
          symbols: 'NQ.c.0',
        })
      );
    });

    it('should send quote end as the current ISO timestamp', async () => {
      vi.useFakeTimers();
      const now = new Date('2024-03-15T18:30:00.000Z');
      vi.setSystemTime(now);
      mockHttpGet.mockResolvedValue(mockQuoteResponse);

      await client.getQuote('ES');

      const callArgs = mockHttpGet.mock.calls[0][1];
      expect(callArgs.end).toBe(now.toISOString());
      expect(callArgs.end).toContain('T');

      vi.useRealTimers();
    });

    it('should use historical API during NY session', async () => {
      sessionSpy.mockReturnValue({
        currentSession: 'NY',
        sessionStart: new Date(),
        sessionEnd: new Date(),
        timestamp: new Date(),
      });
      mockHttpGet.mockResolvedValue(mockQuoteResponse);

      const quote = await client.getQuote('ES');

      expect(mockHttpGet).toHaveBeenCalledTimes(1);
      expect(quote.symbol).toBe('ES');
    });

    it('should cache quote data for 30 seconds', async () => {
      mockHttpGet.mockResolvedValue(mockQuoteResponse);

      // First call
      const quote1 = await client.getQuote('ES');
      expect(mockHttpGet).toHaveBeenCalledTimes(1);

      // Second call within cache TTL
      const quote2 = await client.getQuote('ES');
      expect(mockHttpGet).toHaveBeenCalledTimes(1); // Still just 1 call
      expect(quote2).toEqual(quote1);
    });

    it('should refresh cache after TTL expires', async () => {
      vi.useFakeTimers();
      mockHttpGet.mockResolvedValue(mockQuoteResponse);

      // First call
      await client.getQuote('ES');
      expect(mockHttpGet).toHaveBeenCalledTimes(1);

      // Advance time past cache TTL (30 seconds)
      vi.advanceTimersByTime(31000);

      // Second call should fetch fresh data
      await client.getQuote('ES');
      expect(mockHttpGet).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('should throw error for invalid symbol', async () => {
      await expect(client.getQuote('INVALID' as any)).rejects.toThrow(
        'Invalid symbol: INVALID'
      );
    });

    it('should throw error when no data is available', async () => {
      mockHttpGet.mockResolvedValue('');

      await expect(client.getQuote('ES')).rejects.toThrow(
        'No quote data available for ES'
      );
    });

    it('should throw error when response has no data lines', async () => {
      mockHttpGet.mockResolvedValue(
        'ts_recv,ts_event,rtype,publisher_id,instrument_id\n'
      );

      await expect(client.getQuote('ES')).rejects.toThrow(
        'No recent data available for ES'
      );
    });

    it('should handle multiple data lines and return latest', async () => {
      const multiLineResponse = `ts_recv,ts_event,rtype,publisher_id,instrument_id,action,side,depth,price,size,flags,ts_in_delta,sequence,bid_px_00,ask_px_00,bid_sz_00,ask_sz_00
1234567890123456,1234567890000000,1,1,1234,A,B,0,0,0,0,0,0,4500000000,4502000000,10,15
1234567890123456,1234567891000000,1,1,1234,A,B,0,0,0,0,0,0,4510000000,4512000000,10,15`;

      mockHttpGet.mockResolvedValue(multiLineResponse);

      const quote = await client.getQuote('ES');

      // Should use the latest line
      expect(quote.bid).toBe(4.51);
      expect(quote.ask).toBe(4.512);
    });

    it('should calculate correct timestamp from nanoseconds', async () => {
      const response = `ts_recv,ts_event,rtype,publisher_id,instrument_id,action,side,depth,price,size,flags,ts_in_delta,sequence,bid_px_00,ask_px_00,bid_sz_00,ask_sz_00
1234567890123456,1609459200000000000,1,1,1234,A,B,0,0,0,0,0,0,4500000000,4502000000,10,15`;

      mockHttpGet.mockResolvedValue(response);

      const quote = await client.getQuote('ES');

      // 1609459200000000000 nanoseconds = 1609459200000 milliseconds = Jan 1, 2021 00:00:00 UTC
      expect(quote.timestamp.getTime()).toBe(1609459200000);
    });

    it('should calculate data age correctly', async () => {
      vi.useFakeTimers();
      const now = new Date('2021-01-01T12:00:00Z');
      vi.setSystemTime(now);

      // Set ts_event to 10 seconds ago
      const tenSecondsAgo = now.getTime() - 10000;
      const tsEventNanos = tenSecondsAgo * 1_000_000;

      const response = `ts_recv,ts_event,rtype,publisher_id,instrument_id,action,side,depth,price,size,flags,ts_in_delta,sequence,bid_px_00,ask_px_00,bid_sz_00,ask_sz_00
1234567890123456,${tsEventNanos},1,1,1234,A,B,0,0,0,0,0,0,4500000000,4502000000,10,15`;

      mockHttpGet.mockResolvedValue(response);

      const quote = await client.getQuote('ES');

      expect(quote.dataAge).toBeCloseTo(10000, -2); // Within 100ms

      vi.useRealTimers();
    });
  });

  describe('getHistoricalBars', () => {
    // Mock bars with prices in DataBento fixed-point format (value * 1e9)
    const mockBarsResponse = `ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume
1609459200000000000,1,1,1234,4500000000,4520000000,4490000000,4510000000,1000
1609462800000000000,1,1,1234,4510000000,4530000000,4500000000,4520000000,1500
1609466400000000000,1,1,1234,4520000000,4540000000,4510000000,4530000000,2000
1609470000000000000,1,1,1234,4530000000,4550000000,4520000000,4540000000,2500`;

    it('should get 1h bars for ES', async () => {
      mockHttpGet.mockResolvedValue(mockBarsResponse);

      const bars = await client.getHistoricalBars('ES', '1h', 3);

      expect(bars).toHaveLength(3);
      expect(bars[0].open).toBe(4.51);
      expect(bars[0].high).toBe(4.53);
      expect(bars[0].low).toBe(4.5);
      expect(bars[0].close).toBe(4.52);
      expect(bars[0].volume).toBe(1500);
      expect(bars[0].timestamp).toBeInstanceOf(Date);

      expect(mockHttpGet).toHaveBeenCalledWith(
        '/v0/timeseries.get_range',
        expect.objectContaining({
          schema: 'ohlcv-1h',
          symbols: 'ES.c.0',
          encoding: 'csv',
        })
      );
    });

    it('should get 1d bars for NQ', async () => {
      mockHttpGet.mockResolvedValue(mockBarsResponse);

      const bars = await client.getHistoricalBars('NQ', '1d', 2);

      expect(bars).toHaveLength(2);
      expect(mockHttpGet).toHaveBeenCalledWith(
        '/v0/timeseries.get_range',
        expect.objectContaining({
          schema: 'ohlcv-1d',
          symbols: 'NQ.c.0',
          encoding: 'csv',
        })
      );
    });

    it('should aggregate to H4 bars correctly', async () => {
      // Create 8 hours of data (should aggregate to 2 H4 bars)
      const eightHoursResponse = `ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume
1609459200000000000,1,1,1234,4500000000,4510000000,4490000000,4505000000,1000
1609462800000000000,1,1,1234,4505000000,4515000000,4495000000,4510000000,1100
1609466400000000000,1,1,1234,4510000000,4525000000,4500000000,4515000000,1200
1609470000000000000,1,1,1234,4515000000,4530000000,4505000000,4520000000,1300
1609473600000000000,1,1,1234,4520000000,4540000000,4510000000,4525000000,1400
1609477200000000000,1,1,1234,4525000000,4550000000,4515000000,4530000000,1500
1609480800000000000,1,1,1234,4530000000,4560000000,4520000000,4535000000,1600
1609484400000000000,1,1,1234,4535000000,4570000000,4525000000,4540000000,1700`;

      mockHttpGet.mockResolvedValue(eightHoursResponse);

      const bars = await client.getHistoricalBars('ES', 'H4', 2);

      expect(bars).toHaveLength(2);

      // First H4 bar (hours 0-3)
      expect(bars[0].open).toBe(4.5); // Open of first 1h bar
      expect(bars[0].high).toBe(4.53); // Max high of first 4 bars
      expect(bars[0].low).toBe(4.49); // Min low of first 4 bars
      expect(bars[0].close).toBe(4.52); // Close of 4th bar
      expect(bars[0].volume).toBe(1000 + 1100 + 1200 + 1300); // Sum of volumes

      // Second H4 bar (hours 4-7)
      expect(bars[1].open).toBe(4.52);
      expect(bars[1].high).toBe(4.57);
      expect(bars[1].low).toBe(4.51);
      expect(bars[1].close).toBe(4.54);
      expect(bars[1].volume).toBe(1400 + 1500 + 1600 + 1700);
    });

    it('should handle H4 aggregation with incomplete final chunk', async () => {
      // 5 hours of data (1 complete H4 + 1 partial)
      const fiveHoursResponse = `ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume
1609459200000000000,1,1,1234,4500000000,4510000000,4490000000,4505000000,1000
1609462800000000000,1,1,1234,4505000000,4515000000,4495000000,4510000000,1100
1609466400000000000,1,1,1234,4510000000,4525000000,4500000000,4515000000,1200
1609470000000000000,1,1,1234,4515000000,4530000000,4505000000,4520000000,1300
1609473600000000000,1,1,1234,4520000000,4540000000,4510000000,4525000000,1400`;

      mockHttpGet.mockResolvedValue(fiveHoursResponse);

      const bars = await client.getHistoricalBars('ES', 'H4', 10);

      expect(bars).toHaveLength(2); // 1 complete H4 + 1 partial H4
      expect(bars[1].volume).toBe(1400); // Only 1 hour in the partial chunk
    });

    it('should return the requested number of H4 bars after aggregation', async () => {
      const startNs = 1609459200000000000n;
      const hourNs = 3600000000000n;
      const rows = Array.from({ length: 12 }, (_, index) => {
        const tsEvent = startNs + BigInt(index) * hourNs;
        const open = (4500 + index) * 1_000_000_000;
        return [
          tsEvent.toString(),
          '1',
          '1',
          '1234',
          open,
          open + 1_000_000_000,
          open - 1_000_000_000,
          open + 500_000_000,
          1000 + index,
        ].join(',');
      });
      const response = `ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume\n${rows.join('\n')}`;

      mockHttpGet.mockResolvedValue(response);

      const bars = await client.getHistoricalBars('ES', 'H4', 2);

      expect(bars).toHaveLength(2);
      expect(bars[0].timestamp.getTime()).toBe(1609473600000);
      expect(bars[1].timestamp.getTime()).toBe(1609488000000);
    });

    it('should throw error for invalid symbol', async () => {
      await expect(
        client.getHistoricalBars('INVALID' as any, '1h', 10)
      ).rejects.toThrow('Invalid symbol: INVALID');
    });

    it('should throw error when no data is available', async () => {
      mockHttpGet.mockResolvedValue('');

      await expect(client.getHistoricalBars('ES', '1h', 10)).rejects.toThrow(
        'No bar data available for ES'
      );
    });

    it('should throw error when response has no data lines', async () => {
      mockHttpGet.mockResolvedValue(
        'ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume\n'
      );

      await expect(client.getHistoricalBars('ES', '1h', 10)).rejects.toThrow(
        'No bar data available for ES'
      );
    });

    it('should calculate correct date range for 1h timeframe', async () => {
      mockHttpGet.mockResolvedValue(mockBarsResponse);

      await client.getHistoricalBars('ES', '1h', 48); // 2 days worth

      const callArgs = mockHttpGet.mock.calls[0][1];
      const startDate = new Date(callArgs.start);
      const endDate = new Date(callArgs.end);
      const daysDiff = Math.ceil(
        (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)
      );

      // Should request at least 2 days + 7 day buffer for weekends
      expect(daysDiff).toBeGreaterThanOrEqual(9);
    });

    it('should send historical bars end as the current ISO timestamp', async () => {
      vi.useFakeTimers();
      const now = new Date('2024-03-15T18:30:00.000Z');
      vi.setSystemTime(now);
      mockHttpGet.mockResolvedValue(mockBarsResponse);

      await client.getHistoricalBars('ES', '1h', 3);

      const callArgs = mockHttpGet.mock.calls[0][1];
      expect(callArgs.end).toBe(now.toISOString());
      expect(callArgs.end).toContain('T');

      vi.useRealTimers();
    });

    it('should calculate correct date range for H4 timeframe', async () => {
      mockHttpGet.mockResolvedValue(mockBarsResponse);

      await client.getHistoricalBars('ES', 'H4', 12); // 2 days worth (12 * 4h)

      const callArgs = mockHttpGet.mock.calls[0][1];
      expect(callArgs.schema).toBe('ohlcv-1h'); // Fetches 1h to aggregate
    });

    it('should calculate correct date range for 1d timeframe', async () => {
      mockHttpGet.mockResolvedValue(mockBarsResponse);

      await client.getHistoricalBars('ES', '1d', 10);

      const callArgs = mockHttpGet.mock.calls[0][1];
      const startDate = new Date(callArgs.start);
      const endDate = new Date(callArgs.end);
      const daysDiff = Math.ceil(
        (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)
      );

      // Should request 10 days + 7 day buffer
      expect(daysDiff).toBeGreaterThanOrEqual(17);
    });

    it('should parse prices correctly from fixed-point notation', async () => {
      const response = `ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume
1609459200000000000,1,1,1234,123456789000,234567890000,12345678000,98765432000,5000`;

      mockHttpGet.mockResolvedValue(response);

      const bars = await client.getHistoricalBars('ES', '1h', 1);

      expect(bars[0].open).toBeCloseTo(123.456789, 6);
      expect(bars[0].high).toBeCloseTo(234.56789, 5);
      expect(bars[0].low).toBeCloseTo(12.345678, 6);
      expect(bars[0].close).toBeCloseTo(98.765432, 6);
    });

    it('should return last N bars when more data is available', async () => {
      mockHttpGet.mockResolvedValue(mockBarsResponse);

      const bars = await client.getHistoricalBars('ES', '1h', 2);

      expect(bars).toHaveLength(2);
      // Should return the last 2 bars
      expect(bars[0].volume).toBe(2000);
      expect(bars[1].volume).toBe(2500);
    });
  });

  describe('getSessionInfo', () => {
    it('should return Asian session for UTC hours 0-6', () => {
      const timestamp = new Date('2021-01-01T03:00:00Z');
      const session = client.getSessionInfo(timestamp);

      expect(session.currentSession).toBe('Asian');
      expect(session.sessionStart.getUTCHours()).toBe(0);
      expect(session.sessionEnd.getUTCHours()).toBe(7);
      expect(session.timestamp).toEqual(timestamp);
    });

    it('should return London session for UTC hours 7-13', () => {
      const timestamp = new Date('2021-01-01T10:00:00Z');
      const session = client.getSessionInfo(timestamp);

      expect(session.currentSession).toBe('London');
      expect(session.sessionStart.getUTCHours()).toBe(7);
      expect(session.sessionEnd.getUTCHours()).toBe(14);
    });

    it('should return NY session for UTC hours 14-21', () => {
      const timestamp = new Date('2021-01-01T16:00:00Z');
      const session = client.getSessionInfo(timestamp);

      expect(session.currentSession).toBe('NY');
      expect(session.sessionStart.getUTCHours()).toBe(14);
      expect(session.sessionEnd.getUTCHours()).toBe(22);
    });

    it('should return Unknown session for UTC hours 22-23', () => {
      const timestamp = new Date('2021-01-01T23:00:00Z');
      const session = client.getSessionInfo(timestamp);

      expect(session.currentSession).toBe('Unknown');
    });

    it('should use current time if timestamp not provided', () => {
      const session = client.getSessionInfo();

      expect(session.currentSession).toMatch(/Asian|London|NY|Unknown/);
      expect(session.timestamp).toBeInstanceOf(Date);
    });

    it('should return Asian session at hour 0', () => {
      const timestamp = new Date('2021-01-01T00:00:00Z');
      const session = client.getSessionInfo(timestamp);

      expect(session.currentSession).toBe('Asian');
    });

    it('should return Asian session at hour 6', () => {
      const timestamp = new Date('2021-01-01T06:59:59Z');
      const session = client.getSessionInfo(timestamp);

      expect(session.currentSession).toBe('Asian');
    });

    it('should return London session at hour 7', () => {
      const timestamp = new Date('2021-01-01T07:00:00Z');
      const session = client.getSessionInfo(timestamp);

      expect(session.currentSession).toBe('London');
    });

    it('should return London session at hour 13', () => {
      const timestamp = new Date('2021-01-01T13:59:59Z');
      const session = client.getSessionInfo(timestamp);

      expect(session.currentSession).toBe('London');
    });

    it('should return NY session at hour 14', () => {
      const timestamp = new Date('2021-01-01T14:00:00Z');
      const session = client.getSessionInfo(timestamp);

      expect(session.currentSession).toBe('NY');
    });

    it('should return NY session at hour 21', () => {
      const timestamp = new Date('2021-01-01T21:59:59Z');
      const session = client.getSessionInfo(timestamp);

      expect(session.currentSession).toBe('NY');
    });

    it('should return Unknown session at hour 22', () => {
      const timestamp = new Date('2021-01-01T22:00:00Z');
      const session = client.getSessionInfo(timestamp);

      expect(session.currentSession).toBe('Unknown');
    });

    it('should set session start and end times to midnight for Unknown session', () => {
      const timestamp = new Date('2021-01-01T23:00:00Z');
      const session = client.getSessionInfo(timestamp);

      expect(session.currentSession).toBe('Unknown');
      expect(session.sessionStart).toEqual(timestamp);
      expect(session.sessionEnd).toEqual(timestamp);
    });
  });

  describe('aggregateToH4', () => {
    it('should aggregate empty array', () => {
      const result = (client as any).aggregateToH4([]);
      expect(result).toEqual([]);
    });

    it('should aggregate single bar', () => {
      const bars = [
        {
          timestamp: new Date('2021-01-01T00:00:00Z'),
          open: 4.5,
          high: 4.6,
          low: 4.4,
          close: 4.55,
          volume: 1000,
        },
      ];

      const result = (client as any).aggregateToH4(bars);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(bars[0]);
    });

    it('should aggregate 3 bars (incomplete chunk)', () => {
      const bars = [
        {
          timestamp: new Date('2021-01-01T00:00:00Z'),
          open: 4.5,
          high: 4.6,
          low: 4.4,
          close: 4.55,
          volume: 1000,
        },
        {
          timestamp: new Date('2021-01-01T01:00:00Z'),
          open: 4.55,
          high: 4.65,
          low: 4.45,
          close: 4.6,
          volume: 1100,
        },
        {
          timestamp: new Date('2021-01-01T02:00:00Z'),
          open: 4.6,
          high: 4.7,
          low: 4.5,
          close: 4.65,
          volume: 1200,
        },
      ];

      const result = (client as any).aggregateToH4(bars);

      expect(result).toHaveLength(1);
      expect(result[0].open).toBe(4.5);
      expect(result[0].high).toBe(4.7);
      expect(result[0].low).toBe(4.4);
      expect(result[0].close).toBe(4.65);
      expect(result[0].volume).toBe(3300);
    });

    it('should handle empty bars array', () => {
      const bars: any[] = [];
      const result = (client as any).aggregateToH4(bars);

      expect(result).toHaveLength(0);
      expect(result).toEqual([]);
    });

    it('should handle single bar', () => {
      const bars = [
        {
          timestamp: new Date('2021-01-01T00:00:00Z'),
          open: 4.5,
          high: 4.6,
          low: 4.4,
          close: 4.55,
          volume: 1000,
        },
      ];

      const result = (client as any).aggregateToH4(bars);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(bars[0]);
    });

    it('should handle exactly 4 bars (perfect H4)', () => {
      const bars = [
        {
          timestamp: new Date('2021-01-01T00:00:00Z'),
          open: 4.5,
          high: 4.6,
          low: 4.4,
          close: 4.55,
          volume: 1000,
        },
        {
          timestamp: new Date('2021-01-01T01:00:00Z'),
          open: 4.55,
          high: 4.65,
          low: 4.45,
          close: 4.6,
          volume: 1100,
        },
        {
          timestamp: new Date('2021-01-01T02:00:00Z'),
          open: 4.6,
          high: 4.7,
          low: 4.5,
          close: 4.65,
          volume: 1200,
        },
        {
          timestamp: new Date('2021-01-01T03:00:00Z'),
          open: 4.65,
          high: 4.75,
          low: 4.55,
          close: 4.7,
          volume: 1300,
        },
      ];

      const result = (client as any).aggregateToH4(bars);

      expect(result).toHaveLength(1);
      expect(result[0].open).toBe(4.5);
      expect(result[0].high).toBe(4.75);
      expect(result[0].low).toBe(4.4);
      expect(result[0].close).toBe(4.7);
      expect(result[0].volume).toBe(4600);
    });

    it('should handle 8 bars (2 perfect H4s)', () => {
      const bars = Array.from({ length: 8 }, (_, i) => ({
        timestamp: new Date(`2021-01-01T${String(i).padStart(2, '0')}:00:00Z`),
        open: 100 + i,
        high: 100 + i + 0.5,
        low: 100 + i - 0.5,
        close: 100 + i + 0.25,
        volume: 1000 + i * 100,
      }));

      const result = (client as any).aggregateToH4(bars);

      expect(result).toHaveLength(2);
      // First H4 bar (indices 0-3)
      expect(result[0].open).toBe(100);
      expect(result[0].close).toBe(103.25);
      expect(result[0].volume).toBe(4600);  // 1000+1100+1200+1300
      // Second H4 bar (indices 4-7)
      expect(result[1].open).toBe(104);
      expect(result[1].close).toBe(107.25);
      expect(result[1].volume).toBe(6200);  // 1400+1500+1600+1700
    });

    it('should handle 2 bars (incomplete H4)', () => {
      const bars = [
        {
          timestamp: new Date('2021-01-01T00:00:00Z'),
          open: 100,
          high: 101,
          low: 99,
          close: 100.5,
          volume: 1000,
        },
        {
          timestamp: new Date('2021-01-01T01:00:00Z'),
          open: 100.5,
          high: 102,
          low: 100,
          close: 101,
          volume: 1100,
        },
      ];

      const result = (client as any).aggregateToH4(bars);

      expect(result).toHaveLength(1);
      expect(result[0].open).toBe(100);
      expect(result[0].high).toBe(102);
      expect(result[0].low).toBe(99);
      expect(result[0].close).toBe(101);
      expect(result[0].volume).toBe(2100);
    });

    it('should handle 5 bars (1 complete + 1 incomplete H4)', () => {
      const bars = Array.from({ length: 5 }, (_, i) => ({
        timestamp: new Date(`2021-01-01T${String(i).padStart(2, '0')}:00:00Z`),
        open: 100 + i,
        high: 100 + i + 1,
        low: 100 + i - 1,
        close: 100 + i + 0.5,
        volume: 1000,
      }));

      const result = (client as any).aggregateToH4(bars);

      expect(result).toHaveLength(2);
      // First H4 (4 bars)
      expect(result[0].open).toBe(100);
      expect(result[0].close).toBe(103.5);
      expect(result[0].volume).toBe(4000);
      // Second H4 (1 bar)
      expect(result[1].open).toBe(104);
      expect(result[1].close).toBe(104.5);
      expect(result[1].volume).toBe(1000);
    });

    it('should preserve timestamp from first bar in chunk', () => {
      const firstTimestamp = new Date('2021-06-15T08:00:00Z');
      const bars = [
        { timestamp: firstTimestamp, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
        { timestamp: new Date('2021-06-15T09:00:00Z'), open: 1.5, high: 2.5, low: 1, close: 2, volume: 200 },
        { timestamp: new Date('2021-06-15T10:00:00Z'), open: 2, high: 3, low: 1.5, close: 2.5, volume: 300 },
        { timestamp: new Date('2021-06-15T11:00:00Z'), open: 2.5, high: 3.5, low: 2, close: 3, volume: 400 },
      ];

      const result = (client as any).aggregateToH4(bars);

      expect(result[0].timestamp).toEqual(firstTimestamp);
    });

    it('should calculate correct high/low across all bars in chunk', () => {
      const bars = [
        { timestamp: new Date(), open: 100, high: 105, low: 95, close: 102, volume: 1000 },
        { timestamp: new Date(), open: 102, high: 110, low: 100, close: 108, volume: 1100 },  // Highest high
        { timestamp: new Date(), open: 108, high: 109, low: 90, close: 92, volume: 1200 },    // Lowest low
        { timestamp: new Date(), open: 92, high: 98, low: 91, close: 95, volume: 1300 },
      ];

      const result = (client as any).aggregateToH4(bars);

      expect(result[0].high).toBe(110);  // Max of all highs
      expect(result[0].low).toBe(90);    // Min of all lows
    });

    it('should use close of last bar in chunk', () => {
      const bars = [
        { timestamp: new Date(), open: 100, high: 105, low: 95, close: 102, volume: 1000 },
        { timestamp: new Date(), open: 102, high: 108, low: 100, close: 106, volume: 1100 },
        { timestamp: new Date(), open: 106, high: 110, low: 104, close: 108, volume: 1200 },
        { timestamp: new Date(), open: 108, high: 112, low: 106, close: 110, volume: 1300 },  // Last close
      ];

      const result = (client as any).aggregateToH4(bars);

      expect(result[0].close).toBe(110);  // Close from last bar
    });

    it('should sum volumes correctly', () => {
      const bars = [
        { timestamp: new Date(), open: 100, high: 105, low: 95, close: 102, volume: 1000 },
        { timestamp: new Date(), open: 102, high: 108, low: 100, close: 106, volume: 2500 },
        { timestamp: new Date(), open: 106, high: 110, low: 104, close: 108, volume: 3750 },
        { timestamp: new Date(), open: 108, high: 112, low: 106, close: 110, volume: 5000 },
      ];

      const result = (client as any).aggregateToH4(bars);

      expect(result[0].volume).toBe(12250);  // Sum of all volumes
    });

    it('should handle zero volume bars', () => {
      const bars = [
        { timestamp: new Date(), open: 100, high: 105, low: 95, close: 102, volume: 0 },
        { timestamp: new Date(), open: 102, high: 108, low: 100, close: 106, volume: 0 },
        { timestamp: new Date(), open: 106, high: 110, low: 104, close: 108, volume: 0 },
        { timestamp: new Date(), open: 108, high: 112, low: 106, close: 110, volume: 0 },
      ];

      const result = (client as any).aggregateToH4(bars);

      expect(result[0].volume).toBe(0);
    });

    it('should handle negative prices (e.g., spreads)', () => {
      const bars = [
        { timestamp: new Date(), open: -10, high: -5, low: -15, close: -8, volume: 1000 },
        { timestamp: new Date(), open: -8, high: -3, low: -12, close: -6, volume: 1100 },
        { timestamp: new Date(), open: -6, high: -1, low: -10, close: -4, volume: 1200 },
        { timestamp: new Date(), open: -4, high: 1, low: -8, close: -2, volume: 1300 },
      ];

      const result = (client as any).aggregateToH4(bars);

      expect(result[0].open).toBe(-10);
      expect(result[0].high).toBe(1);    // Max (least negative)
      expect(result[0].low).toBe(-15);   // Min (most negative)
      expect(result[0].close).toBe(-2);
    });
  });
});
