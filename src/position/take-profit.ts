import type { TakeProfitLevel, SmartTpConfig, Position } from '../types.js';
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

// ─── v11s: Smart TP1 — confidence-based partial sell ──────────────────

export interface SmartTpSignals {
  reserveChangePct: number | null;   // % change from entry reserve (positive = growing)
  buySellRatio: number;              // sells / max(buys, 1) in last 30s
  timeToTp1Ms: number;              // ms from open to TP1 hit
  cumulativeSellCount: number;      // total sells observed on pool
  positionSolValue: number;         // current value in SOL
  entryReserveLamports: number | undefined; // reserve at entry (undefined = no data)
}

export interface SmartTpResult {
  sellPct: number;      // 60 or 100
  isConfident: boolean; // true if enough signals passed
  signalsPassed: number;
  reason: string;       // human-readable explanation
}

/**
 * v11s: Evaluate whether to do a partial sell (60%) or full sell (100%) at TP1.
 *
 * 4 confidence signals, need min_signals_required to be "confident":
 * 1. Reserve growth >= threshold (strongest signal, data-backed)
 * 2. Buy/sell ratio <= threshold (more buys than sells = demand)
 * 3. Speed to TP1 <= threshold (fast = strong momentum)
 * 4. Cumulative sells <= threshold (low sell pressure)
 *
 * Hard rules (always sell 100%):
 * - Position value < min_position_sol (hold too small for fees)
 * - Reserve data unavailable (can't assess health)
 */
export function evaluateSmartTp(
  signals: SmartTpSignals,
  config: SmartTpConfig,
): SmartTpResult {
  const fullSell = (reason: string, signalsPassed = 0): SmartTpResult => ({
    sellPct: config.defaultSellPct,
    isConfident: false,
    signalsPassed,
    reason,
  });

  // Evaluate all 4 signals ALWAYS (even if position is small or reserve missing)
  // This ensures tp1_snapshots has useful data regardless of position size.
  const passed: string[] = [];
  const failed: string[] = [];

  // Signal 1: Reserve growth
  if (signals.reserveChangePct !== null && signals.reserveChangePct >= config.minReserveGrowthPct) {
    passed.push(`reserve+${signals.reserveChangePct.toFixed(1)}%`);
  } else {
    const resStr = signals.reserveChangePct !== null
      ? `${signals.reserveChangePct >= 0 ? '+' : ''}${signals.reserveChangePct.toFixed(1)}%`
      : '?';
    failed.push(`reserve${resStr}`);
  }

  // Signal 2: Buy/sell ratio (lower = more buys, healthier)
  if (signals.buySellRatio <= config.maxBuySellRatio) {
    passed.push(`ratio=${signals.buySellRatio.toFixed(1)}`);
  } else {
    failed.push(`ratio=${signals.buySellRatio.toFixed(1)}`);
  }

  // Signal 3: Speed to TP1
  if (signals.timeToTp1Ms <= config.maxTimeToTp1Ms) {
    passed.push(`tp1_in=${(signals.timeToTp1Ms / 1000).toFixed(0)}s`);
  } else {
    failed.push(`tp1_in=${(signals.timeToTp1Ms / 1000).toFixed(0)}s`);
  }

  // Signal 4: Cumulative sells
  if (signals.cumulativeSellCount <= config.maxCumulativeSells) {
    passed.push(`sells=${signals.cumulativeSellCount}`);
  } else {
    failed.push(`sells=${signals.cumulativeSellCount}`);
  }

  const isConfident = passed.length >= config.minSignalsRequired;

  // Hard rules: override decision to SELL even if signals say HOLD
  // These only affect execution, not data — signalsPassed is always accurate
  if (signals.positionSolValue < config.minPositionSol) {
    return fullSell(`position_too_small(${passed.length}/4 signals OK)`, passed.length);
  }
  if (signals.entryReserveLamports === undefined || signals.entryReserveLamports === 0) {
    return fullSell(`no_reserve_data(${passed.length}/4 signals OK)`, passed.length);
  }
  const allSignals = [...passed.map(s => `OK:${s}`), ...failed.map(s => `FAIL:${s}`)].join(' | ');

  if (isConfident) {
    return {
      sellPct: config.confidentSellPct,
      isConfident: true,
      signalsPassed: passed.length,
      reason: `confident(${passed.length}/4): ${allSignals}`,
    };
  }

  return {
    sellPct: config.defaultSellPct,
    isConfident: false,
    signalsPassed: passed.length,
    reason: `default(${passed.length}/4): ${allSignals}`,
  };
}
