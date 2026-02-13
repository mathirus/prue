import { logger } from '../utils/logger.js';
import type { SecurityResult } from '../types.js';
import type { CreatorDeepProfile } from './creator-deep-checker.js';

// v6: Retrained tree with better hyperparameters (depth5, leaf25, weight 1.2)
//   CV: F1=0.800, Precision=0.816, Recall=0.785
//   Temporal (70/30): F1=0.680, Precision=0.700, Recall=0.660
//   vs v4 temporal:   F1=0.580, Precision=0.490, Recall=0.720 ← 49% precision!
// v5: Added hiddenWhaleCount, txVelocity, washPenalty features to extractFeatures
// Trained on 1,638 samples with VALIDATED labels from shadow_positions
export const CLASSIFIER_VERSION = 6;

export interface ClassifierFeatures {
  liquidityUsd: number;
  topHolderPct: number;
  holderCount: number;
  rugcheckScore: number;
  lpBurned: boolean;
  walletAgeSeconds: number;
  txCount: number;
  reputationScore: number;
  honeypotVerified?: boolean;
  mintAuthorityRevoked?: boolean;
  freezeAuthorityRevoked?: boolean;
  isPumpSwap?: boolean;
  entrySolReserve?: number;
  hasCreatorFunding?: boolean;
  graduationTimeS?: number;
  bundlePenalty?: number;
  insidersCount?: number;
  securityScore?: number;
  // v4: observation window features (available after obs phase)
  observationDropPct?: number;
  observationStable?: boolean;
  // v5: new discriminative features
  hiddenWhaleCount?: number;
  txVelocity?: number;
  washPenalty?: number;
}

export interface ClassifierResult {
  prediction: 'safe' | 'rug';
  confidence: number;
  node: string;
}

/**
 * Extract features from SecurityResult + CreatorDeepProfile for the classifier.
 */
export function extractFeatures(
  security: SecurityResult,
  creatorProfile: CreatorDeepProfile | null,
  poolSource?: string,
  observationResult?: { stable: boolean; dropPct: number } | null,
): ClassifierFeatures {
  return {
    liquidityUsd: security.checks.liquidityUsd ?? 0,
    topHolderPct: security.checks.topHolderPct ?? 0,
    holderCount: security.checks.holderCount ?? 0,
    rugcheckScore: security.checks.rugcheckScore ?? 0,
    lpBurned: security.checks.lpBurned ?? false,
    walletAgeSeconds: creatorProfile?.walletAgeSeconds ?? -1,
    txCount: creatorProfile?.txCount ?? -1,
    reputationScore: creatorProfile?.reputationScore ?? 0,
    honeypotVerified: security.checks.honeypotVerified ?? false,
    mintAuthorityRevoked: security.checks.mintAuthorityRevoked ?? false,
    freezeAuthorityRevoked: security.checks.freezeAuthorityRevoked ?? false,
    isPumpSwap: poolSource === 'pumpswap',
    entrySolReserve: security.checks.liquiditySol ?? 0,
    hasCreatorFunding: creatorProfile?.fundingSource != null,
    graduationTimeS: security.checks.graduationTimeSeconds ?? 0,
    bundlePenalty: security.checks.bundlePenalty ?? 0,
    insidersCount: security.checks.insidersCount ?? 0,
    securityScore: security.score ?? 0,
    observationDropPct: observationResult?.dropPct,
    observationStable: observationResult?.stable,
    // v5: new discriminative features
    hiddenWhaleCount: security.checks.hiddenWhaleCount ?? 0,
    txVelocity: security.checks.txVelocity ?? 0,
    washPenalty: security.checks.washPenalty ?? 0,
  };
}

/**
 * v6 DecisionTree — retrained on 1,638 shadow-validated samples (624 rugs, 1,014 safe)
 *
 * Improvements over v4:
 *   - Temporal F1: 0.680 vs 0.580 (+17%)
 *   - Temporal Precision: 0.700 vs 0.490 (+43%) ← v4 blocked more safe than rug!
 *   - Uses 7 features (was 3): +holder_count, +top_holder_pct, +liquidity_usd, +liq_per_holder_v2
 *   - New rug signals in low-reserve zone (liq_per_holder > 3615 = few holders, high liq)
 *   - Rug zone uses holder_count > 5 as escape (legit pools have more holders)
 *
 * Key leaf stats (unweighted):
 *   Node 26: rug 97% (N=379) — main rug catcher (reserve 154-167, holders<=5)
 *   Node 27: rug 85% (N=65)  — sub-rug zone
 *   Node 10: rug 62% (N=37)  — new: high liq_per_holder in low reserve
 */
export function classifyToken(features: ClassifierFeatures): ClassifierResult {
  const liqPerHolder = features.liquidityUsd / Math.max(features.holderCount, 1);
  const holderLiqInteraction = features.holderCount * features.liquidityUsd;
  const reserve = features.entrySolReserve ?? 0;

  // Primary tree: uses entry_sol_reserve (available for PumpSwap pools)
  if (reserve > 0) {
    if (reserve <= 154.08) {
      // Low-mid reserve zone
      const liqPerHolderV2 = features.liquidityUsd / Math.max(features.holderCount, 1);

      if (liqPerHolderV2 <= 6273.95) {
        if (liqPerHolder <= 3615.73) {
          if ((features.topHolderPct ?? 100) <= 56.09) {
            // Low top holder + low liq/holder: mixed signal (48% rug, N=73)
            if (liqPerHolder <= 1188.45) {
              return { prediction: 'safe', confidence: 0.52, node: 'v6_low_res_lowtp_lowlph' };
            }
            return { prediction: 'safe', confidence: 0.82, node: 'v6_low_res_lowtp_midlph' };
          }
          // Normal top holder concentration
          if (features.liquidityUsd <= 2055.46) {
            return { prediction: 'safe', confidence: 0.75, node: 'v6_low_res_vlowliq' };
          }
          return { prediction: 'safe', confidence: 0.91, node: 'v6_low_res_normal' };
        }
        // High liq per holder (>3615): few holders hold a lot → suspicious
        return { prediction: 'rug', confidence: 0.62, node: 'v6_low_res_concentrated' };
      }

      // Very high liq per holder (>6274)
      if (holderLiqInteraction <= -7020.81) {
        // Negative interaction = holder_count is 0 or negative (data anomaly)
        return { prediction: 'safe', confidence: 0.85, node: 'v6_low_res_anomaly' };
      }
      // Normal high-lph zone
      if (reserve <= 87.01) {
        if (reserve <= 84.99) {
          return { prediction: 'safe', confidence: 0.89, node: 'v6_low_reserve_high_lph' };
        }
        return { prediction: 'safe', confidence: 0.99, node: 'v6_low_reserve_peak_safe' };
      }
      if (features.liquidityUsd <= 7179.39) {
        return { prediction: 'safe', confidence: 0.82, node: 'v6_mid_reserve_lowliq' };
      }
      return { prediction: 'safe', confidence: 0.94, node: 'v6_mid_reserve_highliq' };
    }

    if (reserve <= 166.62) {
      // Reserve 154-167 SOL: rug zone, but holder count matters
      if (features.holderCount <= 5) {
        // Few holders in rug zone = very likely rug
        if (reserve <= 158.74) {
          if (liqPerHolder <= 5385.71) {
            return { prediction: 'rug', confidence: 0.97, node: 'v6_rug_zone_main' };
          }
          return { prediction: 'rug', confidence: 0.85, node: 'v6_rug_zone_highlph' };
        }
        return { prediction: 'rug', confidence: 0.66, node: 'v6_rug_zone_upper' };
      }
      // 6+ holders in rug zone = more likely legit
      return { prediction: 'safe', confidence: 0.67, node: 'v6_rug_zone_many_holders' };
    }

    // High reserve (>167 SOL): significant buying activity
    if (reserve <= 181.29) {
      return { prediction: 'safe', confidence: 0.68, node: 'v6_high_reserve_low' };
    }
    if (features.liquidityUsd <= 31521.48) {
      return { prediction: 'safe', confidence: 0.90, node: 'v6_high_reserve_midliq' };
    }
    return { prediction: 'safe', confidence: 0.72, node: 'v6_high_reserve_highliq' };
  }

  // Fallback: no reserve data (non-PumpSwap or data unavailable)
  // Kept from v4 — these paths rarely fire for PumpSwap pools
  if (features.liquidityUsd <= 26743) {
    if (liqPerHolder <= 809) {
      return { prediction: 'safe', confidence: 0.80, node: 'v6_fb_many_holders' };
    }
    if (features.liquidityUsd <= 7338) {
      return { prediction: 'safe', confidence: 0.70, node: 'v6_fb_very_low_liq' };
    }
    if (features.liquidityUsd <= 22061) {
      return { prediction: 'rug', confidence: 0.68, node: 'v6_fb_mid_liq_concentrated' };
    }
    return { prediction: 'safe', confidence: 0.56, node: 'v6_fb_high_mid_liq' };
  }

  if (liqPerHolder <= 28057) {
    return { prediction: 'safe', confidence: 0.75, node: 'v6_fb_high_liq_distributed' };
  }
  if (liqPerHolder <= 37196) {
    return { prediction: 'rug', confidence: 0.58, node: 'v6_fb_whale_trap' };
  }
  return { prediction: 'safe', confidence: 0.64, node: 'v6_fb_ultra_high_lph' };
}

/**
 * Wrapper: determines if a token should be blocked by the ML classifier.
 * v6: Retrained tree with better precision (70% vs 49% temporal).
 */
export async function shouldBlockByClassifier(
  security: SecurityResult,
  creatorProfile: CreatorDeepProfile | null,
  minConfidence: number = 0.70,
  poolSource?: string,
  observationResult?: { stable: boolean; dropPct: number } | null,
): Promise<{ blocked: boolean; reason: string; confidence: number; prediction: string }> {
  const features = extractFeatures(security, creatorProfile, poolSource, observationResult);
  const result = classifyToken(features);

  const blocked = result.prediction === 'rug' && result.confidence >= minConfidence;

  if (blocked) {
    logger.info(
      `[ml-v${CLASSIFIER_VERSION}] BLOCK: ${result.node} (${(result.confidence * 100).toFixed(0)}% conf) holders=${features.holderCount} liq=$${features.liquidityUsd.toFixed(0)} reserve=${(features.entrySolReserve ?? 0).toFixed(1)} SOL`,
    );
  } else {
    logger.info(
      `[ml-v${CLASSIFIER_VERSION}] PASS: ${result.prediction}@${result.node} (${(result.confidence * 100).toFixed(0)}% conf) reserve=${(features.entrySolReserve ?? 0).toFixed(1)}`,
    );
  }

  return {
    blocked,
    reason: blocked ? `ml_${result.node}` : '',
    confidence: result.confidence,
    prediction: result.prediction,
  };
}
