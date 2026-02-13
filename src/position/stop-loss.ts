import type { Position } from '../types.js';
import { logger } from '../utils/logger.js';

export interface StopLossAction {
  shouldSell: boolean;
  reason: 'hard_stop' | 'trailing_stop' | 'timeout' | 'rug_pull' | 'none';
  currentPnlPct: number;
}

/**
 * Evaluates stop-loss conditions for a position.
 */
export function evaluateStopLoss(
  position: Position,
  hardStopPct: number,
  trailingStopPct: number,
  timeoutMinutes: number,
): StopLossAction {
  const noAction: StopLossAction = {
    shouldSell: false,
    reason: 'none',
    currentPnlPct: position.pnlPct,
  };

  if (position.entryPrice <= 0) return noAction;

  // Hard stop loss
  if (position.pnlPct <= hardStopPct) {
    logger.info(`[sl] HARD STOP triggered: ${position.pnlPct.toFixed(1)}% <= ${hardStopPct}%`);
    return {
      shouldSell: true,
      reason: 'hard_stop',
      currentPnlPct: position.pnlPct,
    };
  }

  // v11i: Moonbag breakeven floor — protect TP1 gains by selling if price drops below entry
  // Data: 80/20 split means moonbag is 20% of position. If it goes below entry, we're losing
  // the TP1 gains. Sell to lock in profit from the 80% sold at TP1.
  if (position.status === 'partial_close' && position.tpLevelsHit.length >= 1) {
    const currentMultiple = position.entryPrice > 0 ? position.currentPrice / position.entryPrice : 0;
    if (currentMultiple > 0 && currentMultiple < 1.0) {
      logger.info(`[sl] MOONBAG BREAKEVEN triggered: ${currentMultiple.toFixed(2)}x < 1.0x (protecting TP gains)`);
      return {
        shouldSell: true,
        reason: 'trailing_stop',
        currentPnlPct: position.pnlPct,
      };
    }
  }

  // Trailing stop loss
  // v11i: Moonbag (partial_close after TP1) gets 15% trailing with low activation (1.04x)
  // Other positions: 12% activation, config-based trailing
  const isMoonbag = position.status === 'partial_close' && position.tpLevelsHit.length >= 1;
  const minTrailingActivation = isMoonbag ? 1.04 : 1.12;
  let effectiveTrailingPct: number;
  if (isMoonbag) {
    // v11i: Moonbag — 15% trailing for upside capture
    // Data: winners reach 1.3-2x after TP1, 15% gives room to ride while protecting gains
    effectiveTrailingPct = 15;
  } else if (position.tpLevelsHit.length >= 1) {
    effectiveTrailingPct = Math.min(trailingStopPct, 8); // Post-TP1 non-moonbag: tight 8%
  } else {
    effectiveTrailingPct = trailingStopPct; // Regular: config value 10%
  }
  if (effectiveTrailingPct > 0 && position.peakPrice >= position.entryPrice * minTrailingActivation) {
    const dropFromPeak = ((position.peakPrice - position.currentPrice) / position.peakPrice) * 100;

    if (dropFromPeak >= effectiveTrailingPct) {
      const tightened = position.tpLevelsHit.length >= 1 ? ' (post-TP tightened)' : '';
      logger.info(
        `[sl] TRAILING STOP triggered: ${dropFromPeak.toFixed(1)}% drop from peak (threshold: ${effectiveTrailingPct}%${tightened})`,
      );
      return {
        shouldSell: true,
        reason: 'trailing_stop',
        currentPnlPct: position.pnlPct,
      };
    }
  }

  // Early exit for no-momentum tokens (pre-TP only)
  // DATA: Rugs avg peak 1.15x in 4.9min; Winners avg peak 2.24x in 9.3min
  // If 3 min passed, no TP hit, and price < entry → likely rug/loss, cut early
  // 16 no-TP trades lost -0.015792 SOL total - early exit saves waiting for timeout/hard stop
  if (position.tpLevelsHit.length === 0) {
    const elapsed = (Date.now() - position.openedAt) / 60_000;
    const currentMultiple = position.entryPrice > 0 ? position.currentPrice / position.entryPrice : 0;
    if (elapsed >= 3 && currentMultiple > 0 && currentMultiple < 1.0) {
      logger.info(
        `[sl] EARLY EXIT triggered: ${elapsed.toFixed(1)}min, no TP, price=${currentMultiple.toFixed(2)}x < entry (no momentum)`,
      );
      return {
        shouldSell: true,
        reason: 'trailing_stop',
        currentPnlPct: position.pnlPct,
      };
    }

    // v8u: Slow grind exit — if 5+ min, no TP, and price stuck below 1.1x → cut losses
    // DATA (81 trades): Winners reach 1.2x in median 327s (5.5min). Rugs stay 1.0-1.15x.
    // 2JG79RRV: 1.28x peak in 290s then rug. CF2FG1LW: 1.18x over 739s then fail.
    // BYZnLJyt: 1.25x peak in 223s then rug. Pattern: slow grinders rarely become winners.
    if (elapsed >= 5 && currentMultiple > 0 && currentMultiple < 1.1) {
      logger.info(
        `[sl] SLOW GRIND EXIT: ${elapsed.toFixed(1)}min, no TP, price=${currentMultiple.toFixed(2)}x < 1.1x (stagnant)`,
      );
      return {
        shouldSell: true,
        reason: 'trailing_stop',
        currentPnlPct: position.pnlPct,
      };
    }
  }

  // Timeout - extended by TP hits (confirmed winners get more time)
  // C2: Moon bag 3x, TP2+ = +5min, TP1 = +2min, base = timeoutMinutes
  if (timeoutMinutes > 0) {
    let effectiveTimeout: number;
    if (position.status === 'partial_close' && position.tpLevelsHit.length >= 2) {
      // Moon bag after TP2+: 3x timeout
      effectiveTimeout = timeoutMinutes * 3;
    } else if (position.tpLevelsHit.length >= 2) {
      // TP2+ hit: +5 min bonus
      effectiveTimeout = timeoutMinutes + 5;
    } else if (position.tpLevelsHit.length >= 1) {
      // v8j: TP1-only gets NO timeout bonus (was +2min). Data: 6/6 winners exit by timeout, wasting 2 extra min
      effectiveTimeout = timeoutMinutes;
    } else {
      effectiveTimeout = timeoutMinutes;
    }
    const elapsed = (Date.now() - position.openedAt) / 60_000;
    if (elapsed >= effectiveTimeout) {
      const label = position.tpLevelsHit.length > 0
        ? ` (TP${position.tpLevelsHit.length} bonus: +${effectiveTimeout - timeoutMinutes}min)`
        : position.status === 'partial_close' ? ' (moon bag 3x)' : '';
      logger.info(`[sl] TIMEOUT triggered: ${elapsed.toFixed(0)} min >= ${effectiveTimeout} min${label}`);
      return {
        shouldSell: true,
        reason: 'timeout',
        currentPnlPct: position.pnlPct,
      };
    }
  }

  return noAction;
}
