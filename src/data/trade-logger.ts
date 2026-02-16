import { getDb } from './database.js';
import { logger } from '../utils/logger.js';
import type { DetectedPool, SecurityResult, TradeResult, Position, ScoringBreakdown } from '../types.js';
import { BOT_VERSION } from '../constants.js';

export class TradeLogger {
  logDetection(pool: DetectedPool, security?: SecurityResult): void {
    try {
      const db = getDb();
      const bd = security?.breakdown;
      // v11h: Use UPSERT instead of INSERT OR REPLACE to preserve observation/wash/creator data
      // INSERT OR REPLACE deletes the entire row and re-inserts, wiping columns not in the INSERT.
      // ON CONFLICT DO UPDATE only modifies specified columns, keeping observation_initial_sol etc.
      db.prepare(`
        INSERT INTO detected_pools
        (id, source, pool_address, base_mint, quote_mint, base_decimals, quote_decimals, lp_mint,
         security_score, security_passed, slot, tx_signature, detected_at,
         dp_liquidity_usd, dp_holder_count, dp_top_holder_pct, dp_honeypot_verified,
         dp_mint_auth_revoked, dp_freeze_auth_revoked, dp_rugcheck_score, dp_lp_burned,
         dp_graduation_time_s, dp_bundle_penalty, dp_insiders_count,
         dp_early_tx_count, dp_tx_velocity, dp_unique_slots,
         dp_insider_wallets, dp_hidden_whale_count, bot_version,
         dp_hhi_value, dp_hhi_penalty, dp_concentrated_value, dp_concentrated_penalty,
         dp_holder_penalty, dp_graduation_bonus, dp_obs_bonus, dp_organic_bonus,
         dp_smart_wallet_bonus, dp_creator_age_penalty, dp_rugcheck_penalty,
         dp_velocity_penalty, dp_insider_penalty, dp_whale_penalty, dp_timing_cv_penalty,
         dp_fast_score, dp_deferred_delta, dp_final_score)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
         security_score = excluded.security_score,
         security_passed = excluded.security_passed,
         dp_liquidity_usd = excluded.dp_liquidity_usd,
         dp_holder_count = excluded.dp_holder_count,
         dp_top_holder_pct = excluded.dp_top_holder_pct,
         dp_honeypot_verified = excluded.dp_honeypot_verified,
         dp_mint_auth_revoked = excluded.dp_mint_auth_revoked,
         dp_freeze_auth_revoked = excluded.dp_freeze_auth_revoked,
         dp_rugcheck_score = excluded.dp_rugcheck_score,
         dp_lp_burned = excluded.dp_lp_burned,
         dp_graduation_time_s = excluded.dp_graduation_time_s,
         dp_bundle_penalty = excluded.dp_bundle_penalty,
         dp_insiders_count = excluded.dp_insiders_count,
         dp_early_tx_count = excluded.dp_early_tx_count,
         dp_tx_velocity = excluded.dp_tx_velocity,
         dp_unique_slots = excluded.dp_unique_slots,
         dp_insider_wallets = excluded.dp_insider_wallets,
         dp_hidden_whale_count = excluded.dp_hidden_whale_count,
         bot_version = excluded.bot_version,
         dp_hhi_value = excluded.dp_hhi_value,
         dp_hhi_penalty = excluded.dp_hhi_penalty,
         dp_concentrated_value = excluded.dp_concentrated_value,
         dp_concentrated_penalty = excluded.dp_concentrated_penalty,
         dp_holder_penalty = excluded.dp_holder_penalty,
         dp_graduation_bonus = excluded.dp_graduation_bonus,
         dp_obs_bonus = excluded.dp_obs_bonus,
         dp_organic_bonus = excluded.dp_organic_bonus,
         dp_smart_wallet_bonus = excluded.dp_smart_wallet_bonus,
         dp_creator_age_penalty = excluded.dp_creator_age_penalty,
         dp_rugcheck_penalty = excluded.dp_rugcheck_penalty,
         dp_velocity_penalty = excluded.dp_velocity_penalty,
         dp_insider_penalty = excluded.dp_insider_penalty,
         dp_whale_penalty = excluded.dp_whale_penalty,
         dp_timing_cv_penalty = excluded.dp_timing_cv_penalty,
         dp_fast_score = excluded.dp_fast_score,
         dp_deferred_delta = excluded.dp_deferred_delta,
         dp_final_score = excluded.dp_final_score
      `).run(
        pool.id,
        pool.source,
        pool.poolAddress.toBase58(),
        pool.baseMint.toBase58(),
        pool.quoteMint.toBase58(),
        pool.baseDecimals,
        pool.quoteDecimals,
        pool.lpMint?.toBase58() ?? null,
        security?.score ?? null,
        security?.passed ? 1 : 0,
        pool.slot,
        pool.txSignature,
        pool.detectedAt,
        security?.checks.liquidityUsd ?? null,
        security?.checks.holderCount ?? null,
        security?.checks.topHolderPct ?? null,
        security?.checks.honeypotVerified ? 1 : 0,
        security?.checks.mintAuthorityRevoked ? 1 : 0,
        security?.checks.freezeAuthorityRevoked ? 1 : 0,
        security?.checks.rugcheckScore ?? null,
        security?.checks.lpBurned ? 1 : 0,
        security?.checks.graduationTimeSeconds ?? null,
        security?.checks.bundlePenalty ?? null,
        security?.checks.insidersCount ?? null,
        security?.checks.earlyTxCount ?? null,
        security?.checks.txVelocity ?? null,
        security?.checks.uniqueSlots ?? null,
        security?.checks.insiderWallets?.join(',') ?? null,
        security?.checks.hiddenWhaleCount ?? null,
        BOT_VERSION,
        // v11o: Breakdown columns
        bd?.hhiValue ?? null,
        bd?.hhiPenalty ?? null,
        bd?.concentratedValue ?? null,
        bd?.concentratedPenalty ?? null,
        bd?.holderPenalty ?? null,
        bd?.graduationBonus ?? null,
        bd?.obsBonus ?? null,
        bd?.organicBonus ?? null,
        bd?.smartWalletBonus ?? null,
        bd?.creatorAgePenalty ?? null,
        bd?.rugcheckPenalty ?? null,
        bd?.velocityPenalty ?? null,
        bd?.insiderPenalty ?? null,
        bd?.whalePenalty ?? null,
        bd?.timingCvPenalty ?? null,
        bd?.fastScore ?? null,
        bd?.deferredDelta ?? null,
        bd?.finalScore ?? null,
      );
    } catch (err) {
      logger.error('[trade-logger] Failed to log detection', { error: String(err) });
    }
  }

  logTrade(
    poolId: string | null,
    type: 'buy' | 'sell',
    result: TradeResult,
    inputMint: string,
    outputMint: string,
  ): number {
    try {
      const db = getDb();
      const info = db.prepare(`
        INSERT INTO trades
        (pool_id, type, input_mint, output_mint, input_amount, output_amount, price_per_token, fee, tx_signature, status, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        poolId,
        type,
        inputMint,
        outputMint,
        result.inputAmount,
        result.outputAmount,
        result.pricePerToken,
        result.fee,
        result.txSignature ?? null,
        result.success ? 'confirmed' : 'failed',
        result.error ?? null,
      );
      return info.lastInsertRowid as number;
    } catch (err) {
      logger.error('[trade-logger] Failed to log trade', { error: String(err) });
      return -1;
    }
  }

  savePosition(position: Position): void {
    try {
      // Debug: log exit tracking fields when they have non-default values
      if (position.sellAttempts > 0 || position.exitReason) {
        logger.info(`[trade-logger] SAVE exit tracking: ${position.id.slice(0, 8)} sellAttempts=${position.sellAttempts} sellSuccesses=${position.sellSuccesses} exitReason=${position.exitReason} peakMult=${position.peakMultiplier?.toFixed(3)}${position.sellBurstCount ? ` burstCount=${position.sellBurstCount}` : ''}`);
      }
      const db = getDb();
      db.prepare(`
        INSERT OR REPLACE INTO positions
        (id, pool_id, token_mint, pool_address, source, entry_price, current_price, peak_price,
         token_amount, sol_invested, sol_returned, pnl_sol, pnl_pct, status,
         tp_levels_hit, security_score, opened_at, closed_at, updated_at,
         holder_count, liquidity_usd,
         exit_reason, peak_multiplier, time_to_peak_ms, sell_attempts, sell_successes,
         bot_version, entry_latency_ms, sell_burst_count, total_sell_events, max_sell_burst,
         entry_reserve_lamports, current_reserve_lamports)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        position.id,
        position.poolId ?? null,
        position.tokenMint.toBase58(),
        position.poolAddress.toBase58(),
        position.source,
        position.entryPrice,
        position.currentPrice,
        position.peakPrice,
        position.tokenAmount,
        position.solInvested,
        position.solReturned,
        position.pnlSol,
        position.pnlPct,
        position.status,
        JSON.stringify(position.tpLevelsHit),
        position.securityScore,
        position.openedAt,
        position.closedAt ?? null,
        Date.now(),
        position.holderCount ?? null,
        position.liquidityUsd ?? null,
        position.exitReason ?? null,
        position.peakMultiplier ?? null,
        position.timeToPeakMs ?? null,
        position.sellAttempts ?? 0,
        position.sellSuccesses ?? 0,
        BOT_VERSION,
        position.entryLatencyMs ?? null,
        position.sellBurstCount ?? 0,
        position.totalSellEvents ?? 0,
        position.maxSellBurst ?? 0,
        position.entryReserveLamports ?? null,
        position.currentReserveLamports ?? null,
      );
    } catch (err) {
      logger.error('[trade-logger] Failed to save position', { error: String(err) });
    }
  }

  /**
   * v8q: Save price snapshot during trade (called every ~10s from PositionManager).
   * Stores to position_price_log table for intra-trade trajectory analysis.
   */
  logPriceSnapshot(
    positionId: string,
    price: number,
    entryPrice: number,
    pnlPct: number,
    elapsedMs: number,
    solReserveLamports?: number,
    sellCount?: number,
    buyCount?: number,
    cumulativeSellCount?: number,
  ): void {
    try {
      const db = getDb();
      const multiplier = entryPrice > 0 ? price / entryPrice : 0;
      // v8u: Store sol_reserve in SOL (convert from lamports), sell_count for ML time-series
      const solReserveSol = solReserveLamports != null ? solReserveLamports / 1e9 : null;
      db.prepare(`
        INSERT INTO position_price_log
          (position_id, price, multiplier, pnl_pct, elapsed_ms, sol_reserve, sell_count, buy_count, cumulative_sell_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(positionId, price, multiplier, pnlPct, elapsedMs, solReserveSol, sellCount ?? 0, buyCount ?? 0, cumulativeSellCount ?? 0);
    } catch (err) {
      // Silently fail — non-critical data collection
    }
  }

  getOpenPositions(): Array<Record<string, unknown>> {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM positions WHERE status IN ('open', 'partial_close')
      ORDER BY opened_at DESC
    `).all() as Array<Record<string, unknown>>;
  }

  getRecentTrades(limit = 20): Array<Record<string, unknown>> {
    const db = getDb();
    return db.prepare(`
      SELECT t.*, dp.base_mint, dp.source
      FROM trades t
      LEFT JOIN detected_pools dp ON t.pool_id = dp.id
      ORDER BY t.created_at DESC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
  }

  getDetectedPools(limit = 50): Array<Record<string, unknown>> {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM detected_pools ORDER BY detected_at DESC LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
  }

  /**
   * Save detailed token analysis for ML/pattern learning.
   * Every detected token gets recorded with its security breakdown.
   */
  logTokenAnalysis(
    tokenMint: string,
    poolAddress: string,
    source: string,
    security: {
      score: number;
      passed: boolean;
      mintAuthorityRevoked?: boolean;
      freezeAuthorityRevoked?: boolean;
      honeypotSafe?: boolean;
      honeypotVerified?: boolean;
      liquidityUsd?: number;
      topHolderPct?: number;
      holderCount?: number;
      lpBurned?: boolean;
      rugcheckScore?: number;
      mlPrediction?: string;
      mlConfidence?: number;
    },
    detectionLatencyMs: number,
  ): void {
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO token_analysis
        (token_mint, pool_address, source, score, passed,
         mint_authority_revoked, freeze_authority_revoked, honeypot_safe,
         honeypot_verified, liquidity_usd, top_holder_pct, holder_count,
         lp_burned, rugcheck_score, detection_latency_ms,
         ml_prediction, ml_confidence, bot_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        tokenMint,
        poolAddress,
        source,
        security.score,
        security.passed ? 1 : 0,
        security.mintAuthorityRevoked ? 1 : 0,
        security.freezeAuthorityRevoked ? 1 : 0,
        security.honeypotSafe ? 1 : 0,
        security.honeypotVerified ? 1 : 0,
        security.liquidityUsd ?? null,
        security.topHolderPct ?? null,
        security.holderCount ?? null,
        security.lpBurned ? 1 : 0,
        security.rugcheckScore ?? null,
        detectionLatencyMs,
        security.mlPrediction ?? null,
        security.mlConfidence ?? null,
        BOT_VERSION,
      );
    } catch (err) {
      logger.error('[trade-logger] Failed to log token analysis', { error: String(err) });
    }
  }

  /**
   * v11o: Update breakdown bonuses applied in index.ts (obs, organic, smart wallet, creator age) + final score.
   */
  updateBreakdownBonuses(poolId: string, updates: {
    obsBonus?: number;
    organicBonus?: number;
    smartWalletBonus?: number;
    creatorAgePenalty?: number;
    finalScore?: number;
  }): void {
    try {
      const db = getDb();
      db.prepare(`
        UPDATE detected_pools SET
          dp_obs_bonus = COALESCE(?, dp_obs_bonus),
          dp_organic_bonus = COALESCE(?, dp_organic_bonus),
          dp_smart_wallet_bonus = COALESCE(?, dp_smart_wallet_bonus),
          dp_creator_age_penalty = COALESCE(?, dp_creator_age_penalty),
          dp_final_score = COALESCE(?, dp_final_score)
        WHERE id = ?
      `).run(
        updates.obsBonus ?? null,
        updates.organicBonus ?? null,
        updates.smartWalletBonus ?? null,
        updates.creatorAgePenalty ?? null,
        updates.finalScore ?? null,
        poolId,
      );
    } catch (err) {
      logger.debug(`[trade-logger] Failed to update breakdown bonuses: ${err}`);
    }
  }

  /**
   * v11o: Update HHI tracking data on positions (post-buy 60s check).
   */
  updatePositionHHI(positionId: string, data: {
    hhiEntry?: number;
    hhi60s?: number;
    holderCount60s?: number;
    concentratedEntry?: number;
    concentrated60s?: number;
  }): void {
    try {
      const db = getDb();
      db.prepare(`
        UPDATE positions SET
          hhi_entry = COALESCE(?, hhi_entry),
          hhi_60s = COALESCE(?, hhi_60s),
          holder_count_60s = COALESCE(?, holder_count_60s),
          concentrated_entry = COALESCE(?, concentrated_entry),
          concentrated_60s = COALESCE(?, concentrated_60s)
        WHERE id = ?
      `).run(
        data.hhiEntry ?? null,
        data.hhi60s ?? null,
        data.holderCount60s ?? null,
        data.concentratedEntry ?? null,
        data.concentrated60s ?? null,
        positionId,
      );
    } catch (err) {
      logger.debug(`[trade-logger] Failed to update position HHI: ${err}`);
    }
  }

  /**
   * v11r: Save funder fan-out detection data on a pool record.
   */
  updateFunderFanOut(poolId: string, fanOut: { detected: boolean; recentTxCount: number; uniformAmountSol: number }): void {
    try {
      const db = getDb();
      db.prepare('UPDATE detected_pools SET dp_funder_fan_out = ? WHERE id = ?')
        .run(JSON.stringify(fanOut), poolId);
    } catch (err) {
      logger.debug(`[trade-logger] Failed to update funder fan-out: ${err}`);
    }
  }

  /**
   * v11y: Save network rug penalty on a pool record.
   */
  updateNetworkRugPenalty(poolId: string, penalty: number): void {
    try {
      const db = getDb();
      db.prepare('UPDATE detected_pools SET dp_network_rug_penalty = ? WHERE id = ?')
        .run(penalty, poolId);
    } catch (err) {
      logger.debug(`[trade-logger] Failed to update network rug penalty: ${err}`);
    }
  }

  /**
   * Record why a token was rejected (for post-hoc analysis of false negatives).
   */
  updateRejectionReasons(poolId: string, reasons: string): void {
    try {
      const db = getDb();
      db.prepare(`UPDATE detected_pools SET rejection_reasons = ? WHERE id = ?`).run(reasons, poolId);
    } catch (err) {
      logger.debug(`[trade-logger] Failed to update rejection reasons: ${err}`);
    }
  }

  /**
   * Save observation window results for a pool (v8p: complete data logging).
   */
  updateObservationResult(poolId: string, result: {
    stable: boolean;
    dropPct: number;
    initialSolReserve: number;
    finalSolReserve: number;
  }): void {
    try {
      const db = getDb();
      db.prepare(`
        UPDATE detected_pools SET
          dp_observation_stable = ?,
          dp_observation_drop_pct = ?,
          dp_observation_initial_sol = ?,
          dp_observation_final_sol = ?
        WHERE id = ?
      `).run(
        result.stable ? 1 : 0,
        result.dropPct,
        result.initialSolReserve / 1e9,
        result.finalSolReserve / 1e9,
        poolId,
      );
    } catch (err) {
      logger.debug(`[trade-logger] Failed to update observation result: ${err}`);
    }
  }

  /**
   * Save wash trading detection metrics for a pool (v8p: complete data logging).
   */
  updateWashTradingResult(poolId: string, result: {
    walletConcentration: number;
    sameAmountRatio: number;
    penalty: number;
  }): void {
    try {
      const db = getDb();
      db.prepare(`
        UPDATE detected_pools SET
          dp_wash_concentration = ?,
          dp_wash_same_amount_ratio = ?,
          dp_wash_penalty = ?
        WHERE id = ?
      `).run(
        result.walletConcentration,
        result.sameAmountRatio,
        result.penalty,
        poolId,
      );
    } catch (err) {
      logger.debug(`[trade-logger] Failed to update wash trading result: ${err}`);
    }
  }

  /**
   * Save creator deep check results on the pool record (v8p: complete data logging).
   */
  updateCreatorDeepResult(poolId: string, reputationScore: number, fundingSource: string | null): void {
    try {
      const db = getDb();
      db.prepare(`
        UPDATE detected_pools SET dp_creator_reputation = ?, dp_creator_funding = ? WHERE id = ?
      `).run(reputationScore, fundingSource, poolId);
    } catch (err) {
      logger.debug(`[trade-logger] Failed to update creator deep result: ${err}`);
    }
  }

  /**
   * Save pipeline rejection stage (where in the pipeline was the token rejected).
   */
  updateRejectionStage(poolId: string, stage: string): void {
    try {
      const db = getDb();
      db.prepare(`UPDATE detected_pools SET dp_rejection_stage = ? WHERE id = ?`).run(stage, poolId);
    } catch (err) {
      logger.debug(`[trade-logger] Failed to update rejection stage: ${err}`);
    }
  }

  /**
   * Mark a buy attempt on token_analysis (v8p: track "approved but buy failed" vs "rejected").
   */
  markBuyAttempt(tokenMint: string, succeeded: boolean, error?: string): void {
    try {
      const db = getDb();
      db.prepare(`
        UPDATE token_analysis
        SET buy_attempted = 1, buy_succeeded = ?, buy_error = ?
        WHERE rowid = (
          SELECT rowid FROM token_analysis
          WHERE token_mint = ? ORDER BY created_at DESC LIMIT 1
        )
      `).run(succeeded ? 1 : 0, error ?? null, tokenMint);
    } catch (err) {
      logger.debug(`[trade-logger] Failed to mark buy attempt: ${err}`);
    }
  }

  /**
   * Save entry latency (detection → buy execution) on a position.
   */
  updateEntryLatency(positionId: string, latencyMs: number): void {
    try {
      const db = getDb();
      db.prepare(`UPDATE positions SET entry_latency_ms = ? WHERE id = ?`).run(latencyMs, positionId);
    } catch (err) {
      logger.debug(`[trade-logger] Failed to update entry latency: ${err}`);
    }
  }

  /**
   * Save real wallet balance snapshot (on-chain balance at this moment).
   */
  logBalanceSnapshot(balanceSol: number, event: string, tokenMint?: string, pnlSol?: number): void {
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO balance_snapshots (balance_sol, event, token_mint, pnl_sol, bot_version)
        VALUES (?, ?, ?, ?, ?)
      `).run(balanceSol, event, tokenMint ?? null, pnlSol ?? null, BOT_VERSION);
    } catch (err) {
      logger.debug(`[trade-logger] Failed to log balance snapshot: ${err}`);
    }
  }

  /**
   * Get recent balance snapshots for analysis.
   */
  getBalanceHistory(limit = 50): Array<Record<string, unknown>> {
    const db = getDb();
    return db.prepare(`
      SELECT balance_sol, event, token_mint, pnl_sol, bot_version, created_at
      FROM balance_snapshots ORDER BY created_at DESC LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
  }

  // ─── v11s: TP1 snapshot methods ──────────────────────────────────────

  /**
   * v11s: Capture signals at the moment TP1 is hit for smart TP analysis.
   */
  logTp1Snapshot(data: {
    positionId: string;
    tokenMint: string;
    timeToTp1Ms: number;
    entryReserveLamports: number | null;
    tp1ReserveLamports: number | null;
    reserveChangePct: number | null;
    buyCount30s: number;
    sellCount15s: number;
    buySellRatio: number;
    cumulativeSellCount: number;
    currentMultiplier: number;
    smartTpDecision?: string;
    smartTpSignalsPassed?: number;
    smartTpReason?: string;
  }): void {
    try {
      const db = getDb();
      db.prepare(`
        INSERT OR REPLACE INTO tp1_snapshots
        (position_id, token_mint, time_to_tp1_ms, entry_reserve_lamports, tp1_reserve_lamports,
         reserve_change_pct, buy_count_30s, sell_count_15s, buy_sell_ratio,
         cumulative_sell_count, current_multiplier,
         smart_tp_decision, smart_tp_signals_passed, smart_tp_reason,
         bot_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        data.positionId,
        data.tokenMint,
        data.timeToTp1Ms,
        data.entryReserveLamports,
        data.tp1ReserveLamports,
        data.reserveChangePct,
        data.buyCount30s,
        data.sellCount15s,
        data.buySellRatio,
        data.cumulativeSellCount,
        data.currentMultiplier,
        data.smartTpDecision ?? null,
        data.smartTpSignalsPassed ?? null,
        data.smartTpReason ?? null,
        BOT_VERSION,
      );
    } catch (err) {
      logger.debug(`[trade-logger] Failed to log TP1 snapshot: ${err}`);
    }
  }

  /**
   * v11s: Update TP1 snapshot with post-close outcome data.
   */
  updateTp1Outcome(positionId: string, peak: number, exitReason: string, durationMs: number): void {
    try {
      const db = getDb();
      db.prepare(`
        UPDATE tp1_snapshots SET
          post_tp1_peak = ?,
          post_tp1_exit_reason = ?,
          post_tp1_duration_ms = ?
        WHERE position_id = ?
      `).run(peak, exitReason, durationMs, positionId);
    } catch (err) {
      logger.debug(`[trade-logger] Failed to update TP1 outcome: ${err}`);
    }
  }

  /**
   * v11s: Check if a position has a TP1 snapshot (used for outcome tracking on close).
   */
  hasTp1Snapshot(positionId: string): boolean {
    try {
      const db = getDb();
      const row = db.prepare('SELECT 1 FROM tp1_snapshots WHERE position_id = ? LIMIT 1').get(positionId);
      return !!row;
    } catch {
      return false;
    }
  }

  /**
   * v11s: Get TP1 snapshot for shadow analysis on position close.
   */
  getTp1Snapshot(positionId: string): Record<string, unknown> | undefined {
    try {
      const db = getDb();
      return db.prepare('SELECT * FROM tp1_snapshots WHERE position_id = ?').get(positionId) as Record<string, unknown> | undefined;
    } catch {
      return undefined;
    }
  }

  // ─── v7 ML pipeline: prediction tracking ─────────────────────────────

  /**
   * v7: Log an ML prediction for later accuracy analysis.
   * Fire-and-forget — non-critical data collection.
   */
  logMlPrediction(data: {
    poolAddress: string;
    tokenMint: string;
    modelId: string;
    prediction: string;
    confidence: number;
    features: Record<string, unknown>;
    wasBlocked: boolean;
  }): void {
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO ml_predictions
        (pool_address, token_mint, model_id, prediction, confidence, features, was_blocked, predicted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        data.poolAddress,
        data.tokenMint,
        data.modelId,
        data.prediction,
        data.confidence,
        JSON.stringify(data.features),
        data.wasBlocked ? 1 : 0,
        Date.now(),
      );
    } catch (err) {
      logger.debug(`[trade-logger] Failed to log ML prediction: ${err}`);
    }
  }

  /**
   * v7: Backfill actual_outcome on ml_predictions from detected_pools.pool_outcome.
   * Returns number of rows updated.
   */
  backfillMlPredictionOutcomes(): number {
    try {
      const db = getDb();
      const result = db.prepare(`
        UPDATE ml_predictions SET actual_outcome = dp.pool_outcome
        FROM detected_pools dp
        WHERE ml_predictions.pool_address = dp.pool_address
          AND dp.pool_outcome IN ('rug', 'survivor')
          AND ml_predictions.actual_outcome IS NULL
      `).run();
      return result.changes;
    } catch (err) {
      logger.debug(`[trade-logger] Failed to backfill ML prediction outcomes: ${err}`);
      return 0;
    }
  }

  // ─── v9a: Shadow mode methods ────────────────────────────────────────

  /**
   * v9f: Check if a shadow position already exists for this token mint (DB-level dedup).
   */
  hasShadowPosition(tokenMint: string): boolean {
    try {
      const db = getDb();
      const row = db.prepare('SELECT 1 FROM shadow_positions WHERE token_mint = ? LIMIT 1').get(tokenMint);
      return !!row;
    } catch {
      return false;
    }
  }

  /**
   * Insert a new shadow position. Returns true if inserted, false if token_mint already exists.
   * Uses INSERT OR IGNORE with UNIQUE index on token_mint — bulletproof dedup.
   */
  insertShadowPosition(pos: {
    id: string;
    poolId: string;
    tokenMint: string;
    poolAddress: string;
    source: string;
    securityScore: number;
    entryPrice: number;
    entrySolReserve: number | null;
    currentPrice: number;
    peakPrice: number;
    minPrice: number;
    peakMultiplier: number;
    timeToPeakMs: number;
    tp1Hit: boolean; tp1TimeMs: number | null;
    tp2Hit: boolean; tp2TimeMs: number | null;
    tp3Hit: boolean; tp3TimeMs: number | null;
    slHit: boolean; slTimeMs: number | null;
    status: string;
    exitReason: string | null;
    finalMultiplier: number | null;
    totalPolls: number;
    rugDetected: boolean;
    rugReserveDropPct: number | null;
    openedAt: number;
    closedAt: number | null;
    botVersion: string;
    mlPrediction?: string | null;
    mlConfidence?: number | null;
  }): boolean {
    try {
      const db = getDb();
      const result = db.prepare(`
        INSERT OR IGNORE INTO shadow_positions
        (id, pool_id, token_mint, pool_address, source, security_score,
         entry_price, entry_sol_reserve, current_price, peak_price, min_price,
         peak_multiplier, time_to_peak_ms,
         tp1_hit, tp1_time_ms, tp2_hit, tp2_time_ms, tp3_hit, tp3_time_ms,
         sl_hit, sl_time_ms,
         status, exit_reason, final_multiplier, total_polls,
         rug_detected, rug_reserve_drop_pct,
         opened_at, closed_at, bot_version,
         ml_prediction, ml_confidence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        pos.id, pos.poolId, pos.tokenMint, pos.poolAddress, pos.source, pos.securityScore,
        pos.entryPrice, pos.entrySolReserve, pos.currentPrice, pos.peakPrice, pos.minPrice,
        pos.peakMultiplier, pos.timeToPeakMs,
        pos.tp1Hit ? 1 : 0, pos.tp1TimeMs, pos.tp2Hit ? 1 : 0, pos.tp2TimeMs,
        pos.tp3Hit ? 1 : 0, pos.tp3TimeMs, pos.slHit ? 1 : 0, pos.slTimeMs,
        pos.status, pos.exitReason, pos.finalMultiplier, pos.totalPolls,
        pos.rugDetected ? 1 : 0, pos.rugReserveDropPct,
        pos.openedAt, pos.closedAt, pos.botVersion,
        pos.mlPrediction, pos.mlConfidence,
      );
      return result.changes > 0;
    } catch (err) {
      logger.error(`[trade-logger] Failed to insert shadow position: ${err}`);
      return false;
    }
  }

  /**
   * Update an existing shadow position by id. Used for periodic state saves during tracking.
   */
  updateShadowPosition(pos: {
    id: string;
    currentPrice: number;
    peakPrice: number;
    minPrice: number;
    peakMultiplier: number;
    timeToPeakMs: number;
    tp1Hit: boolean; tp1TimeMs: number | null;
    tp2Hit: boolean; tp2TimeMs: number | null;
    tp3Hit: boolean; tp3TimeMs: number | null;
    slHit: boolean; slTimeMs: number | null;
    status: string;
    exitReason: string | null;
    finalMultiplier: number | null;
    totalPolls: number;
    rugDetected: boolean;
    rugReserveDropPct: number | null;
    closedAt: number | null;
    mlPrediction?: string | null;
    mlConfidence?: number | null;
  }): void {
    try {
      const db = getDb();
      db.prepare(`
        UPDATE shadow_positions SET
          current_price = ?, peak_price = ?, min_price = ?,
          peak_multiplier = ?, time_to_peak_ms = ?,
          tp1_hit = ?, tp1_time_ms = ?, tp2_hit = ?, tp2_time_ms = ?,
          tp3_hit = ?, tp3_time_ms = ?, sl_hit = ?, sl_time_ms = ?,
          status = ?, exit_reason = ?, final_multiplier = ?, total_polls = ?,
          rug_detected = ?, rug_reserve_drop_pct = ?,
          closed_at = ?,
          ml_prediction = ?, ml_confidence = ?
        WHERE id = ?
      `).run(
        pos.currentPrice, pos.peakPrice, pos.minPrice,
        pos.peakMultiplier, pos.timeToPeakMs,
        pos.tp1Hit ? 1 : 0, pos.tp1TimeMs, pos.tp2Hit ? 1 : 0, pos.tp2TimeMs,
        pos.tp3Hit ? 1 : 0, pos.tp3TimeMs, pos.slHit ? 1 : 0, pos.slTimeMs,
        pos.status, pos.exitReason, pos.finalMultiplier, pos.totalPolls,
        pos.rugDetected ? 1 : 0, pos.rugReserveDropPct,
        pos.closedAt,
        pos.mlPrediction ?? null, pos.mlConfidence ?? null,
        pos.id,
      );
    } catch (err) {
      logger.error(`[trade-logger] Failed to update shadow position: ${err}`);
    }
  }

  /**
   * Log a price snapshot for a shadow position (time series for exit ML).
   * v9f: Added sell_count/cumulative_sell_count for sell pressure features,
   * and exit_ml_prediction/confidence for shadow-mode exit ML logging.
   */
  logShadowPriceSnapshot(
    shadowId: string,
    price: number,
    multiplier: number,
    solReserve: number | null,
    elapsedMs: number,
    sellCount: number = 0,
    cumulativeSellCount: number = 0,
    exitMlPrediction?: string | null,
    exitMlConfidence?: number | null,
  ): void {
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO shadow_price_log
          (shadow_id, price, multiplier, sol_reserve, elapsed_ms,
           sell_count, cumulative_sell_count, exit_ml_prediction, exit_ml_confidence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        shadowId, price, multiplier, solReserve, elapsedMs,
        sellCount, cumulativeSellCount,
        exitMlPrediction ?? null, exitMlConfidence ?? null,
      );
    } catch {
      // Non-critical — silently fail
    }
  }

  /**
   * Save a DexScreener outcome check for any pool (shadow or not).
   */
  savePoolOutcomeCheck(
    poolId: string,
    tokenMint: string,
    label: string,
    delayMinutes: number,
    data: {
      priceNative: number;
      marketCap: number;
      liquidityUsd: number;
      volume24h: number;
      txns24h: number;
      alive: boolean;
    },
  ): void {
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO pool_outcome_checks
        (pool_id, token_mint, check_label, delay_minutes,
         price_native, market_cap, liquidity_usd, volume_24h, txns_24h, is_alive)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        poolId, tokenMint, label, delayMinutes,
        data.priceNative, data.marketCap, data.liquidityUsd,
        data.volume24h, data.txns24h, data.alive ? 1 : 0,
      );

      // v9b: Auto-label pool_outcome based on DexScreener data at 30+ min
      // This gives us much better rug labels for ML training
      if (delayMinutes >= 30) {
        let outcome: string;
        if (!data.alive || data.liquidityUsd < 500) {
          outcome = 'rug';
        } else if (data.liquidityUsd >= 2000) {
          outcome = 'survivor';
        } else {
          outcome = 'unknown'; // $500-$2000 is ambiguous
        }
        db.prepare(`
          UPDATE detected_pools SET pool_outcome = ?, checked_at = ?
          WHERE id = ? AND (pool_outcome IS NULL OR pool_outcome = 'unknown')
        `).run(outcome, Date.now(), poolId);
      }
    } catch (err) {
      logger.debug(`[trade-logger] Failed to save pool outcome check: ${err}`);
    }
  }

  /**
   * v11t: Backfill shadow position outcomes from detected_pools.pool_outcome.
   * In data-only mode, shadow positions never get price updates, so rug_detected/tp1_hit
   * are always 0. This syncs the rug label from DexScreener outcome checks.
   * Returns number of rows updated.
   */
  backfillShadowOutcomes(): number {
    try {
      const db = getDb();
      const result = db.prepare(`
        UPDATE shadow_positions SET
          rug_detected = CASE WHEN dp.pool_outcome = 'rug' THEN 1 ELSE 0 END,
          exit_reason = CASE
            WHEN dp.pool_outcome = 'rug' THEN 'rug_backfill'
            WHEN dp.pool_outcome = 'survivor' THEN 'survivor_backfill'
            ELSE exit_reason
          END
        FROM detected_pools dp
        WHERE shadow_positions.pool_id = dp.id
          AND dp.pool_outcome IN ('rug', 'survivor')
          AND shadow_positions.total_polls = 0
          AND shadow_positions.exit_reason NOT IN ('rug_backfill', 'survivor_backfill')
      `).run();
      return result.changes;
    } catch (err) {
      logger.error(`[trade-logger] Failed to backfill shadow outcomes: ${err}`);
      return 0;
    }
  }

  /**
   * Update final PnL on a token analysis record after position closes.
   */
  updateTokenAnalysisPnl(tokenMint: string, pnlPct: number, buyAttempted: boolean, buySucceeded: boolean): void {
    try {
      const db = getDb();
      db.prepare(`
        UPDATE token_analysis
        SET final_pnl_pct = ?, buy_attempted = ?, buy_succeeded = ?
        WHERE token_mint = ? AND final_pnl_pct IS NULL
        ORDER BY created_at DESC LIMIT 1
      `).run(pnlPct, buyAttempted ? 1 : 0, buySucceeded ? 1 : 0, tokenMint);
    } catch {
      // SQLite doesn't support ORDER BY in UPDATE, use subquery
      try {
        const db = getDb();
        db.prepare(`
          UPDATE token_analysis
          SET final_pnl_pct = ?, buy_attempted = ?, buy_succeeded = ?
          WHERE rowid = (
            SELECT rowid FROM token_analysis
            WHERE token_mint = ? AND final_pnl_pct IS NULL
            ORDER BY created_at DESC LIMIT 1
          )
        `).run(pnlPct, buyAttempted ? 1 : 0, buySucceeded ? 1 : 0, tokenMint);
      } catch (err) {
        logger.error('[trade-logger] Failed to update token analysis PnL', { error: String(err) });
      }
    }
  }
}
