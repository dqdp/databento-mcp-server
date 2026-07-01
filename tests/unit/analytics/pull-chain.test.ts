/**
 * pull-chain — orchestrates the Databento pulls into a chain. This step covers the STATIC
 * half: loadDefinitions (ROOT.OPT parent -> normalized definitions, cached once/day) and the
 * pure expiration selectors. The DYNAMIC quote pull is a later step.
 */
import { describe, it, expect, vi } from 'vitest';
import type { DefinitionRec } from '../../../src/analytics/chain.js';
import { black76 } from '../../../src/analytics/black76.js';
import { normalizeDefinitions } from '../../../src/analytics/databento-normalize.js';
import {
  loadDefinitions,
  listExpirations,
  chooseExpiration,
  chooseMostLiquid,
  loadOpenInterest,
  pullQuotesSnapshot,
  buildSmile,
} from '../../../src/analytics/pull-chain.js';

const EXP1 = '2026-07-17';
const EXP2 = '2026-09-18';
const ns = (d: string) => (BigInt(Date.parse(`${d}T00:00:00Z`)) * 1_000_000n).toString();

const defCsv =
  `instrument_id,raw_symbol,instrument_class,expiration,underlying_id,strike_price\n` +
  `100,ESN6,F,${ns(EXP1)},0,\n` +
  `201,ESN6 C6300,C,${ns(EXP1)},100,6300000000000\n` +
  `202,ESN6 P6300,P,${ns(EXP1)},100,6300000000000\n` +
  `300,ESU6,F,${ns(EXP2)},0,\n` +
  `301,ESU6 C6300,C,${ns(EXP2)},300,6300000000000\n` +
  `900,UD:1V: SPREAD,T,${ns(EXP1)},100,\n`;

describe('loadDefinitions', () => {
  it('pulls ROOT.OPT parent definitions and normalizes them', async () => {
    const getRange = vi.fn().mockResolvedValue({ data: defCsv });
    const defs = await loadDefinitions({ getRange }, 'ES', { asOf: '2026-06-30' });

    expect(getRange).toHaveBeenCalledTimes(1);
    expect(getRange.mock.calls[0][0]).toMatchObject({
      dataset: 'GLBX.MDP3',
      symbols: 'ES.OPT',
      stype_in: 'parent',
      schema: 'definition',
    });
    // spreads (T) dropped; C/P/F kept
    expect(defs.map((d) => d.instrument_id).sort((a, b) => a - b)).toEqual([100, 201, 202, 300, 301]);
  });
});

describe('expiration selectors', () => {
  const def = (id: number, cls: 'C' | 'P' | 'F', exp: string): DefinitionRec => ({
    type: 'definition',
    instrument_id: id,
    instrument_class: cls,
    strike: cls === 'F' ? null : 6300,
    expiration: exp,
    underlying: '0',
  });
  const defs = [def(201, 'C', EXP1), def(202, 'P', EXP1), def(301, 'C', EXP2), def(100, 'F', EXP1)];

  it('lists distinct OPTION expirations sorted (futures excluded)', () => {
    expect(listExpirations(defs)).toEqual([EXP1, EXP2]);
  });

  it('chooses the nearest expiration with DTE >= 1 by default', () => {
    expect(chooseExpiration(defs, { today: '2026-06-30' })).toBe(EXP1);
  });

  it('honors an explicit --expiry', () => {
    expect(chooseExpiration(defs, { expiry: EXP2, today: '2026-06-30' })).toBe(EXP2);
  });

  it('skips a 0-DTE expiration for the default', () => {
    const withZeroDte = [...defs, def(400, 'C', '2026-06-30')];
    expect(chooseExpiration(withZeroDte, { today: '2026-06-30' })).toBe(EXP1);
  });

  it('throws on an unknown explicit expiry', () => {
    expect(() => chooseExpiration(defs, { expiry: '2099-01-01', today: '2026-06-30' })).toThrow();
  });

  it('quarterly mode picks the nearest month in {3,6,9,12}, skipping a nearer weekly', () => {
    // EXP1 = 2026-07-17 (July, non-quarterly), EXP2 = 2026-09-18 (Sep, quarterly)
    expect(chooseExpiration(defs, { today: '2026-06-30', mode: 'quarterly' })).toBe(EXP2);
    expect(chooseExpiration(defs, { today: '2026-06-30' })).toBe(EXP1); // default 'nearest' = the July weekly
  });
});

describe('chooseMostLiquid (by open interest)', () => {
  const EXP_A = '2026-09-18';
  const EXP_B = '2026-12-18';
  const def = (id: number, exp: string): DefinitionRec => ({
    type: 'definition',
    instrument_id: id,
    instrument_class: 'C',
    strike: 6300,
    expiration: exp,
    underlying: '0',
  });
  const defs = [def(201, EXP_A), def(202, EXP_A), def(301, EXP_B), def(302, EXP_B)];
  const oi = new Map([
    [201, 1000],
    [202, 1000],
    [301, 5000],
    [302, 5000],
  ]);

  it('ranks by summed OI, not by date (later but heavier wins)', () => {
    expect(chooseMostLiquid(defs, oi, { today: '2026-06-30' })).toBe(EXP_B);
  });

  it('excludes a 0-DTE expiration even with huge OI', () => {
    const d2 = [...defs, def(400, '2026-06-30')];
    const oi2 = new Map([...oi, [400, 99999]]);
    expect(chooseMostLiquid(d2, oi2, { today: '2026-06-30' })).toBe(EXP_B);
  });
});

describe('loadOpenInterest', () => {
  it('pulls parent statistics and returns OI by instrument', async () => {
    const statCsv =
      `instrument_id,ts_ref,price,quantity,stat_type\n` +
      `201,0,0,1500,9\n` +
      `202,0,0,800,9\n` +
      `100,0,975000000000,2147483647,7\n`; // stat_type 7 -> ignored
    const getRange = vi.fn().mockResolvedValue({ data: statCsv });
    const oi = await loadOpenInterest({ getRange }, 'ES', { asOf: '2026-06-30' });

    expect(getRange.mock.calls[0][0]).toMatchObject({ symbols: 'ES.OPT', stype_in: 'parent', schema: 'statistics' });
    expect(oi.get(201)).toBe(1500);
    expect(oi.get(202)).toBe(800);
    expect(oi.has(100)).toBe(false);
  });
});

describe('pullQuotesSnapshot + buildSmile', () => {
  const TODAY = '2026-06-30';
  const NOW = '2026-06-30T14:00:00Z';
  const EXP = '2026-09-18';
  const F = 7467;
  const SIG = 0.2;
  const FUT_ID = 100;
  const T = (Date.parse(`${EXP}T00:00:00Z`) - Date.parse(`${TODAY}T00:00:00Z`)) / 86_400_000 / 365; // must match buildSmile's T

  // parent definitions are OPTIONS ONLY (the underlying future ESU6 lives in ES.FUT, not ES.OPT)
  let defCsv = `instrument_id,raw_symbol,instrument_class,expiration,underlying_id,strike_price\n`;
  let bboCsv = `instrument_id,ts_event,bid_px_00,ask_px_00\n${FUT_ID},1,7466000000000,7468000000000\n`;
  let statCsv = `instrument_id,ts_ref,price,quantity,stat_type\n`;
  let id = 201;
  for (const K of [7400, 7500]) {
    for (const isCall of [true, false]) {
      const cls = isCall ? 'C' : 'P';
      defCsv += `${id},ESU6 ${cls}${K},${cls},${ns(EXP)},${FUT_ID},${K * 1e9}\n`;
      const p = Math.round(black76(F, K, T, SIG, { isCall }).price * 1e9);
      bboCsv += `${id},1,${p - 500000000},${p + 500000000}\n`;
      statCsv += `${id},0,0,1000,9\n`;
      id++;
    }
  }
  const source = () =>
    vi.fn(async (req: { schema: string }) => {
      if (req.schema === 'definition') return { data: defCsv };
      if (req.schema === 'statistics') return { data: statCsv };
      if (req.schema === 'bbo-1m') return { data: bboCsv };
      throw new Error(`unexpected schema ${req.schema}`);
    });

  it('pullQuotesSnapshot pulls bbo-1m for the expiration options + the future, and synthesizes the F-def', async () => {
    const getRange = source();
    const defs = normalizeDefinitions(defCsv);
    const snap = await pullQuotesSnapshot({ getRange }, defs, EXP, { now: NOW });

    const req = getRange.mock.calls[0][0] as any;
    expect(req.schema).toBe('bbo-1m');
    expect(req.stype_in).toBe('instrument_id');
    expect(String(req.symbols).split(',').map(Number)).toEqual(expect.arrayContaining([201, 202, 203, 204, FUT_ID]));
    expect(snap.futureDef).toMatchObject({ type: 'definition', instrument_class: 'F', instrument_id: FUT_ID, strike: null });
    expect(snap.quotes.find((q) => q.instrument_id === FUT_ID)).toMatchObject({ bid: 7466, ask: 7468 });
  });

  it('buildSmile composes definitions + OI + quotes into a chain with solved IV', async () => {
    const getRange = source();
    const chain = await buildSmile({ getRange }, 'ES', { today: TODAY, now: NOW });

    expect(chain.symbol).toBe('ES');
    expect(chain.expiration).toBe(EXP);
    expect(chain.spot).toBe(F);
    expect(chain.strikes).toEqual([7400, 7500]);
    for (const v of chain.callIV) if (v != null) expect(v).toBeCloseTo(SIG, 2);
    for (const v of chain.putIV) if (v != null) expect(v).toBeCloseTo(SIG, 2);
    expect(chain.callOItotal).toBeGreaterThanOrEqual(1000);
  });
});
