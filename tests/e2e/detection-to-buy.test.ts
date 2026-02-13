import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { evaluateTakeProfit } from '../../src/position/take-profit.js';
import { evaluateStopLoss } from '../../src/position/stop-loss.js';
import type { Position, TakeProfitLevel } from '../../src/types.js';

/**
 * End-to-end test simulating the full detection -> analysis -> buy -> manage -> sell cycle.
 * Uses mock data since we can't connect to mainnet in tests.
 */
describe('Detection to Buy Pipeline', () => {
  const levels: TakeProfitLevel[] = [
    { pct: 50, atMultiplier: 2.0 },
    { pct: 30, atMultiplier: 5.0 },
    { pct: 20, atMultiplier: 10.0 },
  ];

  it('should simulate full position lifecycle with TP', () => {
    // 1. Position opened at 0.001 SOL/token
    const position: Position = {
      id: 'sim-1',
      tokenMint: PublicKey.default,
      poolAddress: PublicKey.default,
      source: 'pumpswap',
      entryPrice: 0.001,
      currentPrice: 0.001,
      peakPrice: 0.001,
      tokenAmount: 1_000_000,
      solInvested: 0.15,
      solReturned: 0,
      pnlSol: 0,
      pnlPct: 0,
      status: 'open',
      tpLevelsHit: [],
      openedAt: Date.now(),
      securityScore: 80,
    };

    // 2. Price goes to 2x -> TP level 0 triggers
    position.currentPrice = 0.002;
    position.peakPrice = 0.002;
    let tp = evaluateTakeProfit(position, levels);
    expect(tp.shouldSell).toBe(true);
    expect(tp.level).toBe(0);
    expect(tp.sellPct).toBe(50);

    // Simulate sell of 50%
    position.tpLevelsHit.push(0);
    position.tokenAmount = 500_000;
    position.solReturned += 0.15; // Got back entry cost

    // 3. Price goes to 5x -> TP level 1 triggers
    position.currentPrice = 0.005;
    position.peakPrice = 0.005;
    tp = evaluateTakeProfit(position, levels);
    expect(tp.shouldSell).toBe(true);
    expect(tp.level).toBe(1);
    expect(tp.sellPct).toBe(30);

    position.tpLevelsHit.push(1);
    position.tokenAmount = 350_000;
    position.solReturned += 0.225;

    // 4. Price goes to 10x -> TP level 2 triggers
    position.currentPrice = 0.01;
    position.peakPrice = 0.01;
    tp = evaluateTakeProfit(position, levels);
    expect(tp.shouldSell).toBe(true);
    expect(tp.level).toBe(2);

    position.tpLevelsHit.push(2);
    position.tokenAmount = 200_000;
    position.solReturned += 0.3;

    // Total returned: 0.15 + 0.225 + 0.3 = 0.675 SOL on 0.15 invested = 4.5x
    expect(position.solReturned).toBeCloseTo(0.675, 2);

    // 5. No more TP levels
    tp = evaluateTakeProfit(position, levels);
    expect(tp.shouldSell).toBe(false);
  });

  it('should simulate position with stop loss', () => {
    const position: Position = {
      id: 'sim-2',
      tokenMint: PublicKey.default,
      poolAddress: PublicKey.default,
      source: 'raydium_amm_v4',
      entryPrice: 0.001,
      currentPrice: 0.0006,
      peakPrice: 0.001,
      tokenAmount: 1_000_000,
      solInvested: 0.15,
      solReturned: 0,
      pnlSol: -0.06,
      pnlPct: -40,
      status: 'open',
      tpLevelsHit: [],
      openedAt: Date.now(),
      securityScore: 65,
    };

    // Price dropped 40% -> hard stop at -30% should trigger
    const sl = evaluateStopLoss(position, -30, 15, 30);
    expect(sl.shouldSell).toBe(true);
    expect(sl.reason).toBe('hard_stop');
  });

  it('should simulate trailing stop after profit', () => {
    const position: Position = {
      id: 'sim-3',
      tokenMint: PublicKey.default,
      poolAddress: PublicKey.default,
      source: 'pumpswap',
      entryPrice: 0.001,
      currentPrice: 0.0025, // Currently 2.5x
      peakPrice: 0.004, // Was 4x at peak
      tokenAmount: 500_000,
      solInvested: 0.15,
      solReturned: 0.15,
      pnlSol: 0.1,
      pnlPct: 67,
      status: 'partial_close',
      tpLevelsHit: [0],
      openedAt: Date.now(),
      securityScore: 75,
    };

    // Dropped 37.5% from peak -> trailing stop at 15% triggers
    const sl = evaluateStopLoss(position, -30, 15, 30);
    expect(sl.shouldSell).toBe(true);
    expect(sl.reason).toBe('trailing_stop');
  });
});
