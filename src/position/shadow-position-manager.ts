/**
 * v9a: Shadow Position Manager — virtual positions for ML data collection.
 *
 * Tracks pool prices passively (no buying/selling). For each pool that passes
 * analysis, creates a "shadow position" and monitors price/reserves for 15 min.
 * Records: peak price, min price, time to peak, virtual TP/SL hits with timestamps,
 * rug detection via reserve drain, and a full price time series (every 5s).
 *
 * Cost: 0 SOL. Only RPC reads (batched via PriceMonitor).
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { PriceMonitor } from './price-monitor.js';
import { TradeLogger } from '../data/trade-logger.js';
import { generateId } from '../utils/helpers.js';
import { BOT_VERSION } from '../constants.js';
import { getExitPrediction, type PriceLogEntry } from '../analysis/exit-ml-classifier.js';
import type { LiquidityRemovalMonitor } from './liq-removal-monitor.js';
import type { BotConfig, PoolSource } from '../types.js';

interface ShadowPosition {
  id: string;
  poolId: string;
  tokenMint: string;
  poolAddress: string;
  source: PoolSource;
  securityScore: number;
  entryPrice: number;
  entrySolReserve: number | null;
  currentPrice: number;
  peakPrice: number;
  minPrice: number;
  peakMultiplier: number;
  timeToPeakMs: number;
  // Virtual TP/SL tracking
  tp1Hit: boolean; tp1TimeMs: number | null;
  tp2Hit: boolean; tp2TimeMs: number | null;
  tp3Hit: boolean; tp3TimeMs: number | null;
  slHit: boolean; slTimeMs: number | null;
  // State
  status: 'tracking' | 'closed';
  exitReason: string | null;
  finalMultiplier: number | null;
  totalPolls: number;
  rugDetected: boolean;
  rugReserveDropPct: number | null;
  // Reserve tracking
  currentSolReserve: number | null;
  // ML prediction at open time
  mlPrediction: string | null;
  mlConfidence: number | null;
  // v9f: Price history buffer for exit ML feature computation
  priceHistory: PriceLogEntry[];
  // v9f: Liquidity USD from detected_pools (static per trade)
  liquidityUsd: number;
  // Timestamps
  openedAt: number;
  closedAt: number | null;
  lastDbSave: number;
}

export class ShadowPositionManager {
  private positions = new Map<string, ShadowPosition>();
  private priceMonitor: PriceMonitor;
  private tradeLogger: TradeLogger;
  private readonly maxConcurrent: number;
  private readonly timeoutMs: number;
  private timeoutChecker?: ReturnType<typeof setInterval>;
  // Throttle DB saves (every 10s per position)
  private static readonly DB_SAVE_INTERVAL_MS = 10_000;
  // Reserve drop threshold for rug detection
  private static readonly RUG_RESERVE_DROP_PCT = 80;
  // Track all mints ever opened this session (prevent duplicates after close)
  private trackedMints = new Set<string>();
  // v9h: Data-only mode — no RPC polling, just record positions for DexScreener
  private dataOnlyMode = false;

  constructor(
    private readonly config: BotConfig,
    getConnection: (() => Connection) | Connection,
    private readonly liqMonitor?: LiquidityRemovalMonitor,
  ) {
    this.maxConcurrent = config.risk.shadowMaxConcurrent;
    this.timeoutMs = config.risk.shadowTimeoutMinutes * 60 * 1000;
    const connGetter = typeof getConnection === 'function' ? getConnection : () => getConnection;
    this.priceMonitor = new PriceMonitor(config.risk.shadowPollMs, connGetter);
    this.tradeLogger = new TradeLogger();

    // Price updates
    this.priceMonitor.onPriceUpdate((mint, price, solReserveLamports) => {
      this.onPriceUpdate(mint, price, solReserveLamports);
    });

    // Rug pull detection from PriceMonitor (>15% reserve drop)
    this.priceMonitor.onRugPullDetected((mint, reserveDropPct) => {
      this.onRugPullDetected(mint, reserveDropPct);
    });
  }

  start(): void {
    this.priceMonitor.start();
    // Check timeouts every 10s
    this.timeoutChecker = setInterval(() => this.checkTimeouts(), 10_000);
    logger.info(`[shadow] Manager started (poll=${this.config.risk.shadowPollMs}ms, max=${this.maxConcurrent}, timeout=${this.config.risk.shadowTimeoutMinutes}min)`);
  }

  /** v9h: Data-only mode — no RPC polling, just record positions + timeouts for DexScreener */
  startDataOnly(): void {
    this.dataOnlyMode = true;
    // Timeout checker closes positions after configured time (DexScreener picks them up)
    this.timeoutChecker = setInterval(() => this.checkTimeouts(), 30_000); // 30s check interval
    logger.info(`[shadow] Manager started DATA-ONLY mode (no RPC polling, max=${this.maxConcurrent})`);
  }

  stop(): void {
    this.priceMonitor.stop();
    if (this.timeoutChecker) {
      clearInterval(this.timeoutChecker);
      this.timeoutChecker = undefined;
    }
    // Close all remaining positions
    for (const pos of this.positions.values()) {
      if (pos.status === 'tracking') {
        this.closeShadowPosition(pos, 'shutdown');
      }
    }
    logger.info(`[shadow] Manager stopped`);
  }

  get activeCount(): number {
    return [...this.positions.values()].filter(p => p.status === 'tracking').length;
  }

  /**
   * Open a shadow position for passive tracking.
   * Returns the position if created, null if max concurrent reached.
   */
  openShadowPosition(
    pool: { id: string; baseMint: PublicKey; poolAddress: PublicKey; source: PoolSource },
    securityScore: number,
    entryPrice: number,
    entrySolReserve: number | null,
    mlPrediction?: string | null,
    mlConfidence?: number | null,
    liquidityUsd?: number,
  ): ShadowPosition | null {
    if (this.activeCount >= this.maxConcurrent) {
      return null;
    }

    // Don't double-track same token (even if previously closed)
    const mintStr = pool.baseMint.toBase58();
    if (this.trackedMints.has(mintStr)) {
      logger.debug(`[shadow] DEDUP-MINT: ${mintStr.slice(0, 8)} already tracked (set size=${this.trackedMints.size})`);
      return null;
    }

    // v9f: DB-level dedup — final defense against all upstream dedup failures
    if (this.tradeLogger.hasShadowPosition(mintStr)) {
      logger.warn(`[shadow] DB-DEDUP: ${mintStr.slice(0, 8)} already in DB, syncing trackedMints`);
      this.trackedMints.add(mintStr);
      return null;
    }

    const now = Date.now();
    const pos: ShadowPosition = {
      id: generateId(),
      poolId: pool.id,
      tokenMint: mintStr,
      poolAddress: pool.poolAddress.toBase58(),
      source: pool.source,
      securityScore,
      entryPrice,
      entrySolReserve,
      currentPrice: entryPrice,
      peakPrice: entryPrice,
      minPrice: entryPrice,
      peakMultiplier: 1,
      timeToPeakMs: 0,
      tp1Hit: false, tp1TimeMs: null,
      tp2Hit: false, tp2TimeMs: null,
      tp3Hit: false, tp3TimeMs: null,
      slHit: false, slTimeMs: null,
      status: 'tracking',
      exitReason: null,
      finalMultiplier: null,
      totalPolls: 0,
      rugDetected: false,
      rugReserveDropPct: null,
      currentSolReserve: entrySolReserve,
      mlPrediction: mlPrediction ?? null,
      mlConfidence: mlConfidence ?? null,
      priceHistory: [],
      liquidityUsd: liquidityUsd ?? 0,
      openedAt: now,
      closedAt: null,
      lastDbSave: now,
    };

    this.positions.set(pos.id, pos);
    this.trackedMints.add(mintStr);
    // v9h: Only add to PriceMonitor if NOT in data-only mode (live mode = no RPC polling)
    if (!this.dataOnlyMode) {
      this.priceMonitor.addToken(pool.baseMint, pool.poolAddress, pool.source);
    }

    // v9f: Subscribe to sell pressure tracking for exit ML features
    if (this.liqMonitor) {
      try {
        this.liqMonitor.subscribe(pool.poolAddress, pool.baseMint);
      } catch (err) {
        logger.debug(`[shadow] LiqMonitor subscribe failed for ${mintStr.slice(0, 8)}: ${err}`);
      }
    }

    // Initial DB save — INSERT OR IGNORE with UNIQUE(token_mint)
    const inserted = this.tradeLogger.insertShadowPosition({
      id: pos.id,
      poolId: pos.poolId,
      tokenMint: pos.tokenMint,
      poolAddress: pos.poolAddress,
      source: pos.source,
      securityScore: pos.securityScore,
      entryPrice: pos.entryPrice,
      entrySolReserve: pos.entrySolReserve,
      currentPrice: pos.currentPrice,
      peakPrice: pos.peakPrice,
      minPrice: pos.minPrice,
      peakMultiplier: pos.peakMultiplier,
      timeToPeakMs: pos.timeToPeakMs,
      tp1Hit: pos.tp1Hit, tp1TimeMs: pos.tp1TimeMs,
      tp2Hit: pos.tp2Hit, tp2TimeMs: pos.tp2TimeMs,
      tp3Hit: pos.tp3Hit, tp3TimeMs: pos.tp3TimeMs,
      slHit: pos.slHit, slTimeMs: pos.slTimeMs,
      status: pos.status,
      exitReason: pos.exitReason,
      finalMultiplier: pos.finalMultiplier,
      totalPolls: pos.totalPolls,
      rugDetected: pos.rugDetected,
      rugReserveDropPct: pos.rugReserveDropPct,
      openedAt: pos.openedAt,
      closedAt: pos.closedAt,
      botVersion: BOT_VERSION,
      mlPrediction: pos.mlPrediction,
      mlConfidence: pos.mlConfidence,
    });

    if (!inserted) {
      // UNIQUE constraint caught a duplicate — clean up and return null
      logger.warn(`[shadow] UNIQUE-DEDUP: ${mintStr.slice(0, 8)} already exists in DB (INSERT OR IGNORE)`);
      this.positions.delete(pos.id);
      this.priceMonitor.removeToken(pool.baseMint);
      if (this.liqMonitor) {
        try { this.liqMonitor.unsubscribe(pool.poolAddress); } catch { /* */ }
      }
      return null;
    }

    logger.info(`[shadow] Opened: ${mintStr.slice(0, 8)} | score=${securityScore} | entry=${entryPrice.toExponential(3)} | active=${this.activeCount}/${this.maxConcurrent}`);
    return pos;
  }

  private onPriceUpdate(mintStr: string, newPrice: number, solReserveLamports?: number): void {
    for (const pos of this.positions.values()) {
      if (pos.tokenMint !== mintStr || pos.status !== 'tracking') continue;

      const now = Date.now();
      const elapsedMs = now - pos.openedAt;
      pos.totalPolls++;

      // Update reserve tracking
      if (solReserveLamports !== undefined && solReserveLamports > 0) {
        pos.currentSolReserve = solReserveLamports / 1e9; // Store in SOL
      }

      // Check reserve drain (rug detection)
      if (pos.entrySolReserve && pos.currentSolReserve != null && pos.entrySolReserve > 0) {
        const reserveDropPct = ((pos.entrySolReserve - pos.currentSolReserve) / pos.entrySolReserve) * 100;
        if (reserveDropPct >= ShadowPositionManager.RUG_RESERVE_DROP_PCT && !pos.rugDetected) {
          pos.rugDetected = true;
          pos.rugReserveDropPct = reserveDropPct;
          logger.info(`[shadow] RUG DETECTED: ${mintStr.slice(0, 8)} reserve dropped ${reserveDropPct.toFixed(0)}%`);
          this.closeShadowPosition(pos, 'rug_reserve_drain');
          continue;
        }
      }

      if (newPrice <= 0) continue; // Skip stale reads

      // Set entry price on first real price update (if opened with price=0)
      if (pos.entryPrice === 0) {
        pos.entryPrice = newPrice;
        pos.peakPrice = newPrice;
        pos.minPrice = newPrice;
        // Also capture entry SOL reserve from this first poll
        if (pos.entrySolReserve === null && pos.currentSolReserve != null) {
          pos.entrySolReserve = pos.currentSolReserve;
        }
        logger.info(`[shadow] ${mintStr.slice(0, 8)} entry price set: ${newPrice.toExponential(3)} | reserve: ${pos.entrySolReserve?.toFixed(2) ?? 'N/A'} SOL`);
        this.saveToDb(pos);
      }

      pos.currentPrice = newPrice;

      // Peak tracking
      if (newPrice > pos.peakPrice) {
        pos.peakPrice = newPrice;
        pos.peakMultiplier = pos.entryPrice > 0 ? newPrice / pos.entryPrice : 1;
        pos.timeToPeakMs = elapsedMs;
      }

      // Min tracking
      if (newPrice < pos.minPrice) {
        pos.minPrice = newPrice;
      }

      // Virtual TP hits
      if (pos.entryPrice > 0) {
        const multiplier = newPrice / pos.entryPrice;

        if (!pos.tp1Hit && multiplier >= 1.2) {
          pos.tp1Hit = true;
          pos.tp1TimeMs = elapsedMs;
          logger.debug(`[shadow] ${mintStr.slice(0, 8)} hit TP1 (1.2x) at ${elapsedMs}ms`);
        }
        if (!pos.tp2Hit && multiplier >= 1.5) {
          pos.tp2Hit = true;
          pos.tp2TimeMs = elapsedMs;
          logger.debug(`[shadow] ${mintStr.slice(0, 8)} hit TP2 (1.5x) at ${elapsedMs}ms`);
        }
        if (!pos.tp3Hit && multiplier >= 3.0) {
          pos.tp3Hit = true;
          pos.tp3TimeMs = elapsedMs;
          logger.debug(`[shadow] ${mintStr.slice(0, 8)} hit TP3 (3.0x) at ${elapsedMs}ms`);
        }
        if (!pos.slHit && multiplier <= 0.7) {
          pos.slHit = true;
          pos.slTimeMs = elapsedMs;
          logger.debug(`[shadow] ${mintStr.slice(0, 8)} hit SL (-30%) at ${elapsedMs}ms`);
        }

        // Log price snapshot to DB (every poll = every 5s)
        // v9f: Include sell pressure data from LiqRemovalMonitor for exit ML
        const sellCount = this.liqMonitor?.getSellCount(pos.poolAddress) ?? 0;
        const cumSellCount = this.liqMonitor?.getCumulativeSellCount(pos.poolAddress) ?? 0;

        // v9f: Track price history for exit ML feature computation
        pos.priceHistory.push({
          price: newPrice,
          multiplier,
          solReserve: pos.currentSolReserve,
          elapsedMs,
          sellCount,
          cumulativeSellCount: cumSellCount,
        });

        // v9f: Exit ML prediction (shadow: log only, never act)
        let exitMlPrediction: string | null = null;
        let exitMlConfidence: number | null = null;
        const exitPred = getExitPrediction(
          pos.priceHistory, pos.entryPrice, pos.securityScore, pos.liquidityUsd,
        );
        if (exitPred) {
          exitMlPrediction = exitPred.prediction;
          exitMlConfidence = exitPred.confidence;
          if (exitPred.prediction === 'SELL' && exitPred.confidence >= 0.75) {
            logger.info(`[shadow-ml] EXIT_ML SELL: ${pos.tokenMint.slice(0, 8)} conf=${exitPred.confidence.toFixed(2)} mult=${multiplier.toFixed(3)} reason=${exitPred.reason}`);
          }
        }

        this.tradeLogger.logShadowPriceSnapshot(
          pos.id, newPrice, multiplier, pos.currentSolReserve, elapsedMs,
          sellCount, cumSellCount,
          exitMlPrediction, exitMlConfidence,
        );
      }

      // Periodic DB save (every 10s)
      if (now - pos.lastDbSave >= ShadowPositionManager.DB_SAVE_INTERVAL_MS) {
        this.saveToDb(pos);
        pos.lastDbSave = now;
      }
    }
  }

  private onRugPullDetected(mintStr: string, reserveDropPct: number): void {
    for (const pos of this.positions.values()) {
      if (pos.tokenMint !== mintStr || pos.status !== 'tracking') continue;

      pos.rugDetected = true;
      pos.rugReserveDropPct = reserveDropPct;
      logger.info(`[shadow] RUG PULL: ${mintStr.slice(0, 8)} (reserve -${reserveDropPct.toFixed(0)}%)`);
      this.closeShadowPosition(pos, 'rug_pull_detected');
    }
  }

  private checkTimeouts(): void {
    const now = Date.now();
    for (const pos of this.positions.values()) {
      if (pos.status !== 'tracking') continue;
      if (now - pos.openedAt >= this.timeoutMs) {
        this.closeShadowPosition(pos, 'timeout');
      }
    }
  }

  private closeShadowPosition(pos: ShadowPosition, reason: string): void {
    pos.status = 'closed';
    pos.closedAt = Date.now();
    pos.exitReason = reason;
    pos.finalMultiplier = pos.entryPrice > 0 ? pos.currentPrice / pos.entryPrice : null;

    this.priceMonitor.removeToken(new PublicKey(pos.tokenMint));
    // v9f: Unsubscribe from sell pressure tracking
    if (this.liqMonitor) {
      try {
        this.liqMonitor.unsubscribe(new PublicKey(pos.poolAddress));
      } catch { /* non-critical */ }
    }
    this.saveToDb(pos);

    const mult = pos.peakMultiplier.toFixed(2);
    const final = pos.finalMultiplier?.toFixed(2) ?? '?';
    const tp1 = pos.tp1Hit ? 'Y' : 'N';
    const tp2 = pos.tp2Hit ? 'Y' : 'N';
    const tp3 = pos.tp3Hit ? 'Y' : 'N';
    const sl = pos.slHit ? 'Y' : 'N';
    const rug = pos.rugDetected ? ' RUG' : '';
    logger.info(
      `[shadow] Closed: ${pos.tokenMint.slice(0, 8)} | reason=${reason} | peak=${mult}x final=${final}x | TP1=${tp1} TP2=${tp2} TP3=${tp3} SL=${sl}${rug} | polls=${pos.totalPolls}`,
    );
  }

  private saveToDb(pos: ShadowPosition): void {
    this.tradeLogger.updateShadowPosition({
      id: pos.id,
      currentPrice: pos.currentPrice,
      peakPrice: pos.peakPrice,
      minPrice: pos.minPrice,
      peakMultiplier: pos.peakMultiplier,
      timeToPeakMs: pos.timeToPeakMs,
      tp1Hit: pos.tp1Hit, tp1TimeMs: pos.tp1TimeMs,
      tp2Hit: pos.tp2Hit, tp2TimeMs: pos.tp2TimeMs,
      tp3Hit: pos.tp3Hit, tp3TimeMs: pos.tp3TimeMs,
      slHit: pos.slHit, slTimeMs: pos.slTimeMs,
      status: pos.status,
      exitReason: pos.exitReason,
      finalMultiplier: pos.finalMultiplier,
      totalPolls: pos.totalPolls,
      rugDetected: pos.rugDetected,
      rugReserveDropPct: pos.rugReserveDropPct,
      closedAt: pos.closedAt,
      mlPrediction: pos.mlPrediction,
      mlConfidence: pos.mlConfidence,
    });
  }
}
