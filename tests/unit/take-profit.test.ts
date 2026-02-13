import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { evaluateTakeProfit, calculateSellAmount } from '../../src/position/take-profit.js';
import type { Position, TakeProfitLevel } from '../../src/types.js';

const levels: TakeProfitLevel[] = [
  { pct: 50, atMultiplier: 2.0 },
  { pct: 30, atMultiplier: 5.0 },
  { pct: 20, atMultiplier: 10.0 },
];

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    id: 'test-1',
    tokenMint: PublicKey.default,
    poolAddress: PublicKey.default,
    source: 'pumpswap',
    entryPrice: 0.001,
    currentPrice: 0.001,
    peakPrice: 0.001,
    tokenAmount: 1000000,
    solInvested: 0.1,
    solReturned: 0,
    pnlSol: 0,
    pnlPct: 0,
    status: 'open',
    tpLevelsHit: [],
    openedAt: Date.now(),
    securityScore: 80,
    ...overrides,
  };
}

describe('evaluateTakeProfit', () => {
  it('should not trigger at entry price', () => {
    const pos = makePosition();
    const action = evaluateTakeProfit(pos, levels);
    expect(action.shouldSell).toBe(false);
  });

  it('should trigger level 0 at 2x', () => {
    const pos = makePosition({ currentPrice: 0.002 });
    const action = evaluateTakeProfit(pos, levels);
    expect(action.shouldSell).toBe(true);
    expect(action.level).toBe(0);
    expect(action.sellPct).toBe(50);
  });

  it('should trigger level 1 at 5x if level 0 already hit', () => {
    const pos = makePosition({
      currentPrice: 0.005,
      tpLevelsHit: [0],
    });
    const action = evaluateTakeProfit(pos, levels);
    expect(action.shouldSell).toBe(true);
    expect(action.level).toBe(1);
    expect(action.sellPct).toBe(30);
  });

  it('should trigger level 2 at 10x', () => {
    const pos = makePosition({
      currentPrice: 0.01,
      tpLevelsHit: [0, 1],
    });
    const action = evaluateTakeProfit(pos, levels);
    expect(action.shouldSell).toBe(true);
    expect(action.level).toBe(2);
    expect(action.sellPct).toBe(20);
  });

  it('should not trigger if all levels hit', () => {
    const pos = makePosition({
      currentPrice: 0.02,
      tpLevelsHit: [0, 1, 2],
    });
    const action = evaluateTakeProfit(pos, levels);
    expect(action.shouldSell).toBe(false);
  });

  it('should trigger highest unhit level at extreme price', () => {
    // Price at 15x but only level 0 hit
    const pos = makePosition({
      currentPrice: 0.015,
      tpLevelsHit: [0],
    });
    const action = evaluateTakeProfit(pos, levels);
    expect(action.shouldSell).toBe(true);
    expect(action.level).toBe(2); // Highest unhit level that's reached
  });
});

describe('calculateSellAmount', () => {
  it('should calculate correct sell amount', () => {
    expect(calculateSellAmount(1000000, 50)).toBe(500000);
    expect(calculateSellAmount(1000000, 30)).toBe(300000);
    expect(calculateSellAmount(1000000, 20)).toBe(200000);
  });

  it('should floor the result', () => {
    expect(calculateSellAmount(999999, 33)).toBe(329999);
  });
});
