import type { TakeProfitLevel, Position } from '../types.js';
import { logger } from '../utils/logger.js';

export interface TakeProfitAction {
  shouldSell: boolean;
  sellPct: number;
  level: number;
  multiplier: number;
}

/**
 * Evaluates take-profit levels for a position.
 * Returns the next TP action if price has reached a new level.
 */
export function evaluateTakeProfit(
  position: Position,
  levels: TakeProfitLevel[],
): TakeProfitAction {
  const noAction: TakeProfitAction = {
    shouldSell: false,
    sellPct: 0,
    level: -1,
    multiplier: 0,
  };

  if (position.entryPrice <= 0 || position.currentPrice <= 0) {
    return noAction;
  }

  const currentMultiplier = position.currentPrice / position.entryPrice;

  // Find the highest TP level that has been reached but not yet executed
  for (let i = levels.length - 1; i >= 0; i--) {
    const level = levels[i];

    // Skip already hit levels
    if (position.tpLevelsHit.includes(i)) continue;

    if (currentMultiplier >= level.atMultiplier) {
      logger.info(
        `[tp] Level ${i + 1} reached: ${currentMultiplier.toFixed(2)}x >= ${level.atMultiplier}x -> sell ${level.pct}%`,
      );

      return {
        shouldSell: true,
        sellPct: level.pct,
        level: i,
        multiplier: level.atMultiplier,
      };
    }
  }

  return noAction;
}

/**
 * Calculates the token amount to sell for a given percentage.
 */
export function calculateSellAmount(
  totalTokens: number,
  sellPct: number,
): number {
  return Math.floor(totalTokens * (sellPct / 100));
}
