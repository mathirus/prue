/**
 * v9f: Exit ML Classifier — predicts when to sell based on price/reserve time series.
 *
 * Computes 15 features from the price history of a shadow position and uses
 * a Decision Tree (TypeScript, zero deps) to predict SELL vs HOLD.
 *
 * SAFETY RULES (enforced here):
 * 1. ML NEVER sells in loss (only recommends sell if multiplier >= 1.05)
 * 2. ML NEVER overrides emergency sell (rug detection = always priority)
 * 3. ML NEVER overrides TP levels (TP1/TP2/TP3 execute without consulting ML)
 * 4. ML only ACCELERATES exits: "you have profit, but it's going down -> sell now"
 * 5. In shadow mode: only logs prediction, never acts
 * 6. Confidence threshold: >= 0.75 to recommend sell
 *
 * See memory/exit-ml.md for full documentation.
 */

import { logger } from '../utils/logger.js';

// ── Types ──────────────────────────────────────────────────────────

export interface ExitFeatures {
  price_velocity_10s: number;
  price_velocity_30s: number;
  price_velocity_60s: number;
  multiplier: number;
  drop_from_peak: number;
  reserve_velocity_30s: number;
  reserve_vs_entry: number;
  reserve_acceleration: number;
  sell_burst_30s: number;
  sell_acceleration: number;
  elapsed_minutes: number;
  time_above_entry_pct: number;
  volatility_30s: number;
  security_score: number;
  dp_liquidity_usd: number;
}

export interface ExitPrediction {
  prediction: 'SELL' | 'HOLD';
  confidence: number;
  reason: string;
}

/** A single price log entry from the shadow position tracking. */
export interface PriceLogEntry {
  price: number;
  multiplier: number;
  solReserve: number | null;
  elapsedMs: number;
  sellCount: number;
  cumulativeSellCount: number;
}

// ── Constants ──────────────────────────────────────────────────────

const MIN_POLLS_FOR_PREDICTION = 8;  // Need 8 polls (~40s) for lookback features
const MIN_MULTIPLIER_FOR_SELL = 1.05; // Safety: never recommend sell in loss
const MIN_CONFIDENCE_FOR_SELL = 0.75; // Only recommend sell at high confidence

// ── Feature Computation ────────────────────────────────────────────

function velocity(current: number, past: number): number {
  if (!past || past === 0) return 0;
  return (current - past) / past;
}

function stddev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

/**
 * Compute all 15 exit features from the price history.
 * Returns null if not enough data points (need MIN_POLLS_FOR_PREDICTION).
 */
export function computeExitFeatures(
  logs: PriceLogEntry[],
  entryPrice: number,
  securityScore: number,
  liquidityUsd: number,
): ExitFeatures | null {
  if (logs.length < MIN_POLLS_FOR_PREDICTION) return null;
  const idx = logs.length - 1;

  const current = logs[idx];
  const price = current.price;
  const reserve = current.solReserve;

  if (!price || price === 0 || !entryPrice || entryPrice === 0) return null;

  // Momentum
  const p2 = idx >= 2 ? logs[idx - 2].price : 0;
  const p6 = idx >= 6 ? logs[idx - 6].price : 0;
  const p12 = idx >= 12 ? logs[idx - 12].price : 0;

  const price_velocity_10s = p2 ? velocity(price, p2) : 0;
  const price_velocity_30s = p6 ? velocity(price, p6) : 0;
  const price_velocity_60s = p12 ? velocity(price, p12) : 0;
  const multiplier = price / entryPrice;

  let peakPrice = entryPrice;
  for (let i = 0; i <= idx; i++) {
    if (logs[i].price > peakPrice) peakPrice = logs[i].price;
  }
  const drop_from_peak = peakPrice > 0 ? (peakPrice - price) / peakPrice : 0;

  // Reserve
  const r6 = idx >= 6 ? logs[idx - 6].solReserve : null;
  const reserve_velocity_30s = (reserve && r6) ? velocity(reserve, r6) : 0;

  const entryReserve = logs[0].solReserve;
  const reserve_vs_entry = (reserve && entryReserve && entryReserve > 0) ? reserve / entryReserve : 1;

  let reserve_acceleration = 0;
  if (reserve && idx >= 4) {
    const r3now = idx >= 3 ? logs[idx - 3].solReserve : null;
    const r3prev = idx >= 4 ? logs[idx - 4].solReserve : null;
    const rPrev = logs[idx - 1].solReserve;
    const velNow = r3now ? velocity(reserve, r3now) : 0;
    const velPrev = (rPrev && r3prev) ? velocity(rPrev, r3prev) : 0;
    reserve_acceleration = velNow - velPrev;
  }

  // Sell Pressure
  let sell_burst_30s = 0;
  for (let i = Math.max(0, idx - 5); i <= idx; i++) {
    sell_burst_30s += logs[i].sellCount || 0;
  }

  let sell_acceleration = 0;
  if (idx >= 6) {
    let recent = 0, older = 0;
    for (let i = idx - 2; i <= idx; i++) recent += logs[i].sellCount || 0;
    for (let i = idx - 5; i <= idx - 3; i++) older += logs[i].sellCount || 0;
    sell_acceleration = recent - older;
  }

  // Time
  const elapsed_minutes = current.elapsedMs / 60000;
  let pollsAbove = 0;
  for (let i = 0; i <= idx; i++) {
    if (logs[i].price > entryPrice) pollsAbove++;
  }
  const time_above_entry_pct = (idx + 1) > 0 ? pollsAbove / (idx + 1) : 0;

  // Volatility
  const recentPrices: number[] = [];
  for (let i = Math.max(0, idx - 5); i <= idx; i++) {
    if (logs[i].price > 0) recentPrices.push(logs[i].price);
  }
  const meanPrice = recentPrices.length > 0
    ? recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length
    : 1;
  const volatility_30s = meanPrice > 0 ? stddev(recentPrices) / meanPrice : 0;

  return {
    price_velocity_10s,
    price_velocity_30s,
    price_velocity_60s,
    multiplier,
    drop_from_peak,
    reserve_velocity_30s,
    reserve_vs_entry,
    reserve_acceleration,
    sell_burst_30s,
    sell_acceleration,
    elapsed_minutes,
    time_above_entry_pct,
    volatility_30s,
    security_score: securityScore ?? 0,
    dp_liquidity_usd: liquidityUsd ?? 0,
  };
}

// ── Decision Tree Prediction ───────────────────────────────────────
// Auto-generated by train-exit-model.py — this is the v1 fallback.
// Low precision (0.167) but high recall (0.856). Use only with confidence filter.

function predictExitDT(f: ExitFeatures): { prediction: 'SELL' | 'HOLD'; confidence: number } {
  if (f.volatility_30s <= 0.021138) {
    if (f.multiplier <= 1.740853) {
      if (f.price_velocity_60s <= -0.025598) {
        if (f.drop_from_peak <= 0.155999) {
          return { prediction: 'HOLD', confidence: 0.2430 };
        } else {
          return { prediction: 'SELL', confidence: 0.6670 };
        }
      } else {
        if (f.dp_liquidity_usd <= 13057.413086) {
          return { prediction: 'HOLD', confidence: 0.1560 };
        } else {
          return { prediction: 'HOLD', confidence: 0.0053 };
        }
      }
    } else {
      if (f.elapsed_minutes <= 5.272133) {
        if (f.dp_liquidity_usd <= 14161.841309) {
          return { prediction: 'SELL', confidence: 0.6935 };
        } else {
          return { prediction: 'HOLD', confidence: 0.0000 };
        }
      } else {
        if (f.volatility_30s <= 0.007648) {
          return { prediction: 'HOLD', confidence: 0.1373 };
        } else {
          return { prediction: 'HOLD', confidence: 0.4558 };
        }
      }
    }
  } else {
    if (f.elapsed_minutes <= 2.778316) {
      if (f.dp_liquidity_usd <= 8344.693848) {
        if (f.volatility_30s <= 0.041076) {
          return { prediction: 'SELL', confidence: 0.5485 };
        } else {
          return { prediction: 'SELL', confidence: 0.7738 };
        }
      } else {
        return { prediction: 'HOLD', confidence: 0.0000 };
      }
    } else {
      if (f.multiplier <= 0.943232) {
        if (f.reserve_vs_entry <= 0.956627) {
          return { prediction: 'HOLD', confidence: 0.0000 };
        } else {
          return { prediction: 'SELL', confidence: 0.9796 };
        }
      } else {
        if (f.multiplier <= 1.779545) {
          return { prediction: 'SELL', confidence: 0.6494 };
        } else {
          return { prediction: 'SELL', confidence: 0.8290 };
        }
      }
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Get exit prediction for a shadow position.
 * Applies safety rules: only recommends SELL if multiplier >= 1.05 and confidence >= 0.75.
 *
 * @param logs - Price history entries (must be sorted by elapsedMs ASC)
 * @param entryPrice - Entry price of the position
 * @param securityScore - Security score at open time
 * @param liquidityUsd - Liquidity USD from detected_pools
 * @returns ExitPrediction with safety-filtered result, or null if not enough data
 */
export function getExitPrediction(
  logs: PriceLogEntry[],
  entryPrice: number,
  securityScore: number,
  liquidityUsd: number,
): ExitPrediction | null {
  const features = computeExitFeatures(logs, entryPrice, securityScore, liquidityUsd);
  if (!features) return null;

  const raw = predictExitDT(features);

  // Safety rule 1: never recommend sell in loss
  if (raw.prediction === 'SELL' && features.multiplier < MIN_MULTIPLIER_FOR_SELL) {
    return {
      prediction: 'HOLD',
      confidence: raw.confidence,
      reason: `blocked_in_loss (mult=${features.multiplier.toFixed(3)})`,
    };
  }

  // Safety rule 6: only recommend sell at high confidence
  if (raw.prediction === 'SELL' && raw.confidence < MIN_CONFIDENCE_FOR_SELL) {
    return {
      prediction: 'HOLD',
      confidence: raw.confidence,
      reason: `low_confidence (${raw.confidence.toFixed(3)} < ${MIN_CONFIDENCE_FOR_SELL})`,
    };
  }

  // Build reason string for logging
  let reason = '';
  if (raw.prediction === 'SELL') {
    const signals: string[] = [];
    if (features.volatility_30s > 0.02) signals.push(`vol=${(features.volatility_30s * 100).toFixed(1)}%`);
    if (features.drop_from_peak > 0.15) signals.push(`drop=${(features.drop_from_peak * 100).toFixed(0)}%`);
    if (features.price_velocity_30s < -0.05) signals.push(`vel30s=${(features.price_velocity_30s * 100).toFixed(1)}%`);
    if (features.sell_burst_30s > 3) signals.push(`sells=${features.sell_burst_30s}`);
    reason = signals.length > 0 ? signals.join(', ') : 'dt_pattern';
  }

  return {
    prediction: raw.prediction,
    confidence: raw.confidence,
    reason,
  };
}
