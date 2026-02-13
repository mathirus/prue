import { describe, it, expect } from 'vitest';
import { evaluateStopLoss } from '../../src/position/stop-loss.js';
import { calculateMoonBag, shouldKeepMoonBag } from '../../src/position/moon-bag.js';
import { PublicKey } from '@solana/web3.js';
import type { Position } from '../../src/types.js';

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

describe('evaluateStopLoss', () => {
  it('should trigger hard stop', () => {
    const pos = makePosition({ pnlPct: -35 });
    const action = evaluateStopLoss(pos, -30, 15, 30);
    expect(action.shouldSell).toBe(true);
    expect(action.reason).toBe('hard_stop');
  });

  it('should not trigger at acceptable loss', () => {
    const pos = makePosition({ pnlPct: -10 });
    const action = evaluateStopLoss(pos, -30, 15, 30);
    expect(action.shouldSell).toBe(false);
  });

  it('should trigger trailing stop', () => {
    const pos = makePosition({
      entryPrice: 0.001,
      currentPrice: 0.0017, // Dropped from peak
      peakPrice: 0.003, // Was 3x
      pnlPct: 70,
    });
    // Drop from peak: (0.003 - 0.0017) / 0.003 = 43% > 15%
    const action = evaluateStopLoss(pos, -30, 15, 30);
    expect(action.shouldSell).toBe(true);
    expect(action.reason).toBe('trailing_stop');
  });

  it('should trigger timeout', () => {
    const pos = makePosition({
      openedAt: Date.now() - 31 * 60_000, // 31 minutes ago
    });
    const action = evaluateStopLoss(pos, -30, 15, 30);
    expect(action.shouldSell).toBe(true);
    expect(action.reason).toBe('timeout');
  });

  it('should not trigger trailing stop if never in profit', () => {
    const pos = makePosition({
      entryPrice: 0.001,
      currentPrice: 0.0008,
      peakPrice: 0.001, // Never above entry
      pnlPct: -20,
    });
    const action = evaluateStopLoss(pos, -30, 15, 30);
    expect(action.shouldSell).toBe(false); // Hard stop at -30, not -20
  });
});

describe('Moon Bag', () => {
  it('should calculate correct moon bag amounts', () => {
    const pos = makePosition({ tokenAmount: 1000000 });
    const { keepAmount, sellAmount } = calculateMoonBag(pos, 25);
    expect(keepAmount).toBe(250000);
    expect(sellAmount).toBe(750000);
  });

  it('should sell everything if moonBagPct is 0', () => {
    const pos = makePosition({ tokenAmount: 1000000 });
    const { keepAmount, sellAmount } = calculateMoonBag(pos, 0);
    expect(keepAmount).toBe(0);
    expect(sellAmount).toBe(1000000);
  });

  it('should keep moon bag only when all TPs hit and in profit', () => {
    expect(shouldKeepMoonBag(makePosition({ tpLevelsHit: [0, 1, 2], pnlPct: 50 }), 3)).toBe(true);
    expect(shouldKeepMoonBag(makePosition({ tpLevelsHit: [0, 1], pnlPct: 50 }), 3)).toBe(false);
    expect(shouldKeepMoonBag(makePosition({ tpLevelsHit: [0, 1, 2], pnlPct: -10 }), 3)).toBe(false);
  });
});
