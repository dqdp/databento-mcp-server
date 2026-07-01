/**
 * pull-chain — orchestrates the Databento pulls into a chain. This step covers the STATIC
 * half: loadDefinitions (ROOT.OPT parent -> normalized definitions, cached once/day) and the
 * pure expiration selectors. The DYNAMIC quote pull is a later step.
 */
import { describe, it, expect, vi } from 'vitest';
import type { DefinitionRec } from '../../../src/analytics/chain.js';
import { loadDefinitions, listExpirations, chooseExpiration } from '../../../src/analytics/pull-chain.js';

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
});
