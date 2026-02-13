import type { Position } from '../types.js';
import { logger } from '../utils/logger.js';

/**
 * Calculates the moon bag amount to keep after all TPs are hit.
 * A moon bag is a small residual position held for potential moonshots.
 */
export function calculateMoonBag(
  position: Position,
  moonBagPct: number,
): { keepAmount: number; sellAmount: number } {
  if (moonBagPct <= 0) {
    return { keepAmount: 0, sellAmount: position.tokenAmount };
  }

  const keepAmount = Math.floor(position.tokenAmount * (moonBagPct / 100));
  const sellAmount = position.tokenAmount - keepAmount;

  logger.debug(
    `[moon-bag] Keep ${moonBagPct}% = ${keepAmount} tokens, sell ${sellAmount} tokens`,
  );

  return { keepAmount, sellAmount };
}

/**
 * Checks if a position qualifies for moon bag treatment.
 * Only keeps a moon bag if the position has been profitable.
 */
export function shouldKeepMoonBag(
  position: Position,
  allTpLevelsCount: number,
): boolean {
  // Only keep moon bag if all TP levels have been hit
  const allTpsHit = position.tpLevelsHit.length >= allTpLevelsCount;

  // And position is currently in profit
  const inProfit = position.pnlPct > 0;

  return allTpsHit && inProfit;
}
