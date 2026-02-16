import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { botEmitter } from '../detection/event-emitter.js';
import { PriceMonitor } from './price-monitor.js';
import { LiquidityRemovalMonitor, type LiqEventSeverity } from './liq-removal-monitor.js';
import { CreatorWalletMonitor, type CreatorEventType } from './creator-wallet-monitor.js';
import { evaluateTakeProfit, calculateSellAmount, evaluateSmartTp, type TakeProfitAction, type SmartTpSignals } from './take-profit.js';
import { evaluateStopLoss } from './stop-loss.js';
import { calculateMoonBag, shouldKeepMoonBag } from './moon-bag.js';
import { TradeLogger } from '../data/trade-logger.js';
import { getDb } from '../data/database.js';
import { CreatorTracker } from '../analysis/creator-tracker.js';
import { analyzeHolders, computeNonPoolHHI } from '../analysis/holder-analyzer.js';
import { generateId, shortenAddress, formatSol, formatPct } from '../utils/helpers.js';
import type { BotConfig, DetectedPool, Position, PoolSource, TradeResult } from '../types.js';
import { WSOL_MINT } from '../constants.js';
import { setSellPriorityBoost, clearPriorityFeeCache } from '../execution/pumpswap-swap.js';

type SellFunction = (
  tokenMint: PublicKey,
  amount: number,
  poolAddress: PublicKey,
  source?: PoolSource,
  emergency?: boolean,
) => Promise<TradeResult>;

export class PositionManager {
  private positions = new Map<string, Position>();
  private priceMonitor: PriceMonitor;
  private liqMonitor: LiquidityRemovalMonitor | null = null; // v8s: WebSocket liquidity removal detection
  private creatorMonitor: CreatorWalletMonitor | null = null; // v11n: WebSocket creator wallet monitoring
  private tradeLogger: TradeLogger;
  private creatorTracker: CreatorTracker;
  // Lock to prevent concurrent sells on the same position
  private sellingPositions = new Set<string>();
  // Track sell retry attempts per position
  private sellRetries = new Map<string, number>();
  private static readonly MAX_SELL_RETRIES = 3; // v11m: was 2 → 3. Data: 4/39 trades failed max_retries. Extra retry at 8s saves ~50%.
  // v8s: Dust threshold — skip sell TX if estimated value is below this (saves ~0.002 SOL in fees)
  private static readonly DUST_THRESHOLD_SOL = 0.0005;
  // Exponential backoff for sell retries - don't hammer RPC
  private sellRetryAfter = new Map<string, number>(); // positionId → timestamp when retry is allowed
  private static readonly SELL_RETRY_BASE_DELAY_MS = 2_000; // v8j: was 5s → 2s (2s+4s=6s total vs 5+10+20=35s)
  // v11w: Faster retry for emergency sells (rug_pull, sell_burst, liq_removal) — 500ms flat
  private static readonly EMERGENCY_SELL_RETRY_DELAY_MS = 500;
  // v8l: TP sell cooldown — prevents cascading 429 when TP triggers every price poll
  private tpSellCooldownUntil = new Map<string, number>(); // positionId → timestamp
  private static readonly TP_SELL_COOLDOWN_MS = 15_000; // 15s between TP sell attempts
  // v9m: Progressive 429 cooldown: 5s → 10s → 15s (was fixed 45s — too slow, Df5J never sold)
  private tpSell429RetryCount = new Map<string, number>(); // positionId → retry count for progressive backoff
  // v8l: Track 429 errors for longer SL backoff too
  private static readonly SL_429_BACKOFF_MS = 30_000; // 30s for 429 errors in SL
  private static readonly MAX_SELL_RETRIES_429 = 6; // More retries for 429 (recoverable)
  // v8m: HARD CAP on total sell attempts per position (fixes exception-leak bug: 187-383 attempts observed)
  private static readonly ABSOLUTE_MAX_SELL_ATTEMPTS = 10;
  // v9i: Stranded position retry — when all immediate sell retries fail but pool isn't drained,
  // schedule background retries every 30s for 5 minutes before giving up.
  // This catches 429/RPC failures that resolve after a brief cooldown.
  private strandedTimers = new Map<string, ReturnType<typeof setInterval>>();
  private strandedStartedAt = new Map<string, number>(); // positionId → timestamp when stranding started
  private static readonly STRANDED_RETRY_INTERVAL_MS = 30_000; // Retry every 30s
  private static readonly STRANDED_MAX_DURATION_MS = 5 * 60_000; // Give up after 5 minutes

  // Throttle position saves to DB (not every price update)
  private lastDbSave = new Map<string, number>();
  private static readonly DB_SAVE_INTERVAL_MS = 10_000; // Save every 10s max
  // Periodic status log for open positions
  private lastStatusLog = 0;
  private static readonly STATUS_LOG_INTERVAL_MS = 15_000; // Log every 15s
  // v8v: Reserve drop threshold for confirming sell burst as real rug
  // Data: 3/7 burst exits were false positives with healthy reserves ($50-80K liq)
  // Only emergency sell if reserve actually dropped, confirming drain
  private static readonly BURST_RESERVE_DROP_PCT = 20; // 20% reserve drop = confirmed rug
  // v11o: HHI check timers — schedule 60s post-buy HHI check (data collection only)
  private hhiCheckTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private getConnectionFn: (() => Connection) | undefined;
  // Track consecutive stale (price=0) updates to detect drained pools
  private stalePriceCount = new Map<string, number>();
  // v11p: Track positions where creator transfer was detected (combo accelerator: skip stale grace period)
  private creatorTransferPositions = new Set<string>();
  // v11u: Buy drought detector — consecutive snapshots with 0 buys
  private buyDroughtCount = new Map<string, number>(); // positionId → consecutive 0-buy snapshots
  private buyDroughtTightened = new Set<string>();      // positions where trailing was already tightened
  // v11x: Early exit — tick counter per position (increments every DB_SAVE_INTERVAL_MS ~10s)
  // Strategy C: if mul < 1.02 at tick 2 AND mul < 1.03 at tick 3 → emergency sell
  // Validated: 12/12 rugs caught at tick2 < 1.02 (N=111 v11o-v11w), 0/44 safe positions misclassified
  private earlyExitTickCount = new Map<string, number>(); // positionId → tick number
  private earlyExitDanger = new Set<string>(); // positions flagged DANGER at tick 2
  // v9h: After N consecutive stale prices, trigger emergency sell
  // History: 3→6 (v9h, 429 false positives). 6→4 (v9y, sell-priority reduces 429 during sells)
  // v9y: With sell-priority mode, non-sell RPCs pause during sells → fewer false 429 stales.
  // Data (v9x): Fh8a drained in ~40s but stale drain took 81s to trigger (6 threshold too slow).
  // At 4 threshold + ~15s effective poll interval (RPC busy) = ~60s detection. Acceptable.
  private static readonly STALE_DRAIN_THRESHOLD = 4;
  // v9h: Grace period — don't trigger STALE DRAIN in the first 30s of a position
  // Newly opened positions naturally have stale data while PriceMonitor initializes.
  // v11q: Reduced from 30s to 15s — with 1.5s polls, 15s = 8-10 data points. 30s was too long.
  private static readonly STALE_DRAIN_GRACE_MS = 15_000;

  constructor(
    private readonly config: BotConfig,
    private readonly sellFn: SellFunction,
    getConnection?: () => Connection,
  ) {
    this.priceMonitor = new PriceMonitor(config.position.pricePollMs, getConnection);
    this.tradeLogger = new TradeLogger();
    this.creatorTracker = new CreatorTracker();
    this.getConnectionFn = getConnection; // v11o: store for HHI tracking

    // v8s: WebSocket-based liquidity removal monitor (detects rugs 2-10s before polling)
    if (getConnection) {
      this.liqMonitor = new LiquidityRemovalMonitor(getConnection);
      this.liqMonitor.onLiquidityRemoved((poolAddr, mintStr, severity, burstCount) => {
        this.onLiquidityRemoved(poolAddr, mintStr, severity, burstCount);
      });

      // v11n: WebSocket-based creator wallet monitor (detects creator sells 200-500ms from TX confirm)
      this.creatorMonitor = new CreatorWalletMonitor(getConnection);
      this.creatorMonitor.onCreatorAction((poolAddr, mintStr, eventType) => {
        this.onCreatorAction(poolAddr, mintStr, eventType);
      });
    }

    this.priceMonitor.onPriceUpdate((mint, price, solReserveLamports) => {
      this.onPriceUpdate(mint, price, solReserveLamports);
    });

    // v10d: Listen for background sell completions (when parallel sell races cause both to succeed)
    // Updates solReturned so PnL is accurate even when double-sell happens
    botEmitter.on('backgroundSellCompleted', (data: { tokenMint: string; outputAmountLamports: number }) => {
      this.onBackgroundSellCompleted(data.tokenMint, data.outputAmountLamports);
    });

    // Anti-rug: emergency sell when liquidity drain detected
    this.priceMonitor.onRugPullDetected((mint, reserveDropPct) => {
      this.onRugPullDetected(mint, reserveDropPct);
    });

    // v8r: Emergency sell when authority re-enabled post-purchase
    this.priceMonitor.onAuthorityReenabled((mint, authorityType) => {
      this.onAuthorityReenabled(mint, authorityType);
    });
  }

  start(): void {
    this.loadFromDb();
    this.priceMonitor.start();
    logger.info(`[positions] Manager started (${this.positions.size} open positions)`);
  }

  /**
   * Reload open/partial_close positions from SQLite so they survive restarts.
   */
  private loadFromDb(): void {
    try {
      const db = getDb();
      const rows = db.prepare(
        `SELECT * FROM positions WHERE status IN ('open', 'partial_close')`,
      ).all() as Array<Record<string, unknown>>;

      for (const row of rows) {
        const position: Position = {
          id: row.id as string,
          tokenMint: new PublicKey(row.token_mint as string),
          poolAddress: new PublicKey(row.pool_address as string),
          source: (row.source as PoolSource) || 'pumpswap',
          entryPrice: row.entry_price as number,
          currentPrice: row.current_price as number,
          peakPrice: row.peak_price as number,
          tokenAmount: row.token_amount as number,
          solInvested: row.sol_invested as number,
          solReturned: (row.sol_returned as number) || 0,
          pnlSol: (row.pnl_sol as number) || 0,
          pnlPct: (row.pnl_pct as number) || 0,
          status: row.status as Position['status'],
          tpLevelsHit: JSON.parse((row.tp_levels_hit as string) || '[]'),
          openedAt: row.opened_at as number,
          closedAt: row.closed_at as number | undefined,
          securityScore: (row.security_score as number) || 0,
          holderCount: (row.holder_count as number) ?? undefined,
          liquidityUsd: (row.liquidity_usd as number) ?? undefined,
          exitReason: (row.exit_reason as string) ?? undefined,
          peakMultiplier: (row.peak_multiplier as number) ?? undefined,
          timeToPeakMs: (row.time_to_peak_ms as number) ?? undefined,
          sellAttempts: (row.sell_attempts as number) ?? 0,
          sellSuccesses: (row.sell_successes as number) ?? 0,
        };

        this.positions.set(position.id, position);
        this.priceMonitor.addToken(position.tokenMint, position.poolAddress, position.source);

        // v8u: Subscribe reloaded positions to liq monitor (was missing — 3H6F lost moon bag to unmonitored drain)
        if (this.liqMonitor) {
          this.liqMonitor.subscribe(position.poolAddress, position.tokenMint);
        }

        logger.info(
          `[positions] Reloaded: ${shortenAddress(position.tokenMint)} | ${position.status} | ${formatSol(position.solInvested)} SOL | PnL: ${formatPct(position.pnlPct)}`,
        );
      }

      if (rows.length > 0) {
        logger.info(`[positions] Reloaded ${rows.length} positions from database`);
      }
    } catch (err) {
      logger.error(`[positions] Failed to reload positions: ${err}`);
    }
  }

  stop(): void {
    this.priceMonitor.stop();
    this.liqMonitor?.stop(); // v8s
    this.creatorMonitor?.stop(); // v11n
    // v9i: Clean up stranded retry timers
    for (const [posId, timer] of this.strandedTimers) {
      clearInterval(timer);
      logger.info(`[positions] Cleared stranded retry timer for ${posId.slice(0, 8)}`);
    }
    this.strandedTimers.clear();
    this.strandedStartedAt.clear();
    // v11o: Clean up HHI check timers
    for (const [, timer] of this.hhiCheckTimers) {
      clearTimeout(timer);
    }
    this.hhiCheckTimers.clear();
    logger.info('[positions] Manager stopped');
  }

  /** Check if there's already an active position for this token mint */
  hasActivePosition(tokenMint: PublicKey): boolean {
    for (const pos of this.positions.values()) {
      if (pos.tokenMint.equals(tokenMint) && (pos.status === 'open' || pos.status === 'partial_close')) {
        return true;
      }
    }
    return false;
  }

  openPosition(
    pool: DetectedPool,
    entryPrice: number,
    tokenAmount: number,
    solInvested: number,
    securityScore: number,
    initialSolReserve?: number,
    extra?: { holderCount?: number; liquidityUsd?: number; mintAuthRevoked?: boolean; freezeAuthRevoked?: boolean; creatorAddress?: string; vaultCache?: { baseVault: PublicKey; quoteVault: PublicKey; isReversed: boolean } },
  ): Position {
    // Prevent duplicate positions for the same token
    if (this.hasActivePosition(pool.baseMint)) {
      logger.warn(`[positions] DEDUP: Already have active position for ${shortenAddress(pool.baseMint)}, skipping`);
      throw new Error(`Duplicate position for ${pool.baseMint.toBase58()}`);
    }

    const position: Position = {
      id: generateId(),
      poolId: pool.id,
      tokenMint: pool.baseMint,
      poolAddress: pool.poolAddress,
      source: pool.source,
      entryPrice,
      currentPrice: entryPrice,
      peakPrice: entryPrice,
      tokenAmount,
      solInvested,
      solReturned: 0,
      pnlSol: 0,
      pnlPct: 0,
      status: 'open',
      tpLevelsHit: [],
      openedAt: Date.now(),
      securityScore,
      holderCount: extra?.holderCount,
      liquidityUsd: extra?.liquidityUsd,
      sellAttempts: 0,
      sellSuccesses: 0,
      // v8v: Store initial reserve for smart burst detection (compare vs current to detect real drain)
      entryReserveLamports: initialSolReserve,
      currentReserveLamports: initialSolReserve, // Start equal; updated each price poll
    };

    this.positions.set(position.id, position);
    this.priceMonitor.addToken(
      pool.baseMint, pool.poolAddress, pool.source, initialSolReserve,
      // v8r: Pass initial authority state for re-enablement detection
      (extra?.mintAuthRevoked !== undefined || extra?.freezeAuthRevoked !== undefined)
        ? { mintRevoked: extra?.mintAuthRevoked ?? false, freezeRevoked: extra?.freezeAuthRevoked ?? false }
        : undefined,
      // v11t: Pre-cached vault addresses from buy (saves 1 poll cycle)
      extra?.vaultCache,
    );
    // v8s: Subscribe to WebSocket liquidity removal monitor for instant rug detection
    if (this.liqMonitor && pool.source === 'pumpswap') {
      this.liqMonitor.subscribe(pool.poolAddress, pool.baseMint);
    }
    // v11n: Subscribe to creator wallet monitor (detects creator sells ~200-500ms from TX)
    if (this.creatorMonitor && extra?.creatorAddress && pool.source === 'pumpswap') {
      this.creatorMonitor.subscribe(extra.creatorAddress, pool.poolAddress, pool.baseMint);
    }

    // v11o: Schedule 60s HHI check (data collection only — NO action taken)
    // Compares holder distribution at entry vs t+60s for outcome prediction research
    if (this.getConnectionFn && pool.source === 'pumpswap') {
      this.scheduleHHICheck(position.id, pool.baseMint);
    }

    this.tradeLogger.savePosition(position);

    logger.info(
      `[positions] Opened: ${shortenAddress(pool.baseMint)} | ${formatSol(solInvested)} SOL | Score: ${securityScore}`,
    );

    botEmitter.emit('positionOpened', position);
    return position;
  }

  /**
   * v11o: Schedule HHI check 60s after opening a position.
   * Compares holder distribution at entry vs t+60s.
   * Data collection only — NO trade action taken.
   */
  private scheduleHHICheck(positionId: string, tokenMint: PublicKey): void {
    const timer = setTimeout(async () => {
      this.hhiCheckTimers.delete(positionId);
      const position = this.positions.get(positionId);
      if (!position || (position.status !== 'open' && position.status !== 'partial_close')) {
        return; // Position already closed, skip RPC call
      }
      if (!this.getConnectionFn) return;
      try {
        const conn = this.getConnectionFn();
        const hold = await analyzeHolders(conn, tokenMint);
        const nonPoolHolders = hold.holders.slice(1, 6);
        const concentrated60s = nonPoolHolders.reduce((sum, h) => sum + h.pct, 0);

        this.tradeLogger.updatePositionHHI(positionId, {
          hhi60s: hold.holderHHI,
          holderCount60s: hold.holderCount,
          concentrated60s,
        });

        logger.info(
          `[hhi-track] ${shortenAddress(tokenMint)}: HHI=${hold.holderHHI.toFixed(2)}, ` +
          `holders=${hold.holderCount}, concentrated=${concentrated60s.toFixed(1)}% (at t+60s)`,
        );
      } catch (err) {
        logger.debug(`[hhi-track] Failed for ${shortenAddress(tokenMint)}: ${String(err).slice(0, 80)}`);
      }
    }, 60_000);

    this.hhiCheckTimers.set(positionId, timer);
  }

  /** v11o: Cancel pending HHI check timer for a position */
  private cancelHHICheck(positionId: string): void {
    const timer = this.hhiCheckTimers.get(positionId);
    if (timer) {
      clearTimeout(timer);
      this.hhiCheckTimers.delete(positionId);
    }
  }

  getOpenPositions(): Position[] {
    return [...this.positions.values()].filter(
      (p) => p.status === 'open' || p.status === 'partial_close',
    );
  }

  getPosition(id: string): Position | undefined {
    return this.positions.get(id);
  }

  get openCount(): number {
    return this.getOpenPositions().length;
  }

  /** Count only 'open' positions (not moon bags) for max_concurrent check */
  get activeTradeCount(): number {
    return [...this.positions.values()].filter((p) => p.status === 'open').length;
  }

  /** v9j: True if any position is currently being sold — used to pause analysis during sells */
  get isSelling(): boolean {
    return this.sellingPositions.size > 0;
  }

  /**
   * Emergency sell when pool liquidity drops >50% (rug pull detection).
   * Sells immediately without waiting for normal price-based stop loss.
   */
  private onRugPullDetected(mintStr: string, reserveDropPct: number): void {
    for (const position of this.positions.values()) {
      if (position.tokenMint.toBase58() !== mintStr) continue;
      if (position.status !== 'open' && position.status !== 'partial_close') continue;
      if (this.sellingPositions.has(position.id)) continue;

      logger.warn(
        `[positions] RUG PULL: Emergency selling ${shortenAddress(position.tokenMint)} (liquidity -${reserveDropPct.toFixed(0)}%)`,
      );

      this.sellingPositions.add(position.id);
      this.priceMonitor.pause();
      this.executeStopLoss(position, 'rug_pull', true)
        .catch((err) => {
          logger.error(`[positions] Rug pull sell error: ${err}`);
        })
        .finally(() => {
          this.sellingPositions.delete(position.id);
          this.priceMonitor.resume();
        });
    }
  }

  /**
   * v8r: Emergency sell when mint/freeze authority re-enabled after purchase.
   * This is a known scam vector: revoke authority to pass checks, then re-enable to freeze/mint.
   */
  private onAuthorityReenabled(mintStr: string, authorityType: 'mint' | 'freeze'): void {
    for (const position of this.positions.values()) {
      if (position.tokenMint.toBase58() !== mintStr) continue;
      if (position.status !== 'open' && position.status !== 'partial_close') continue;
      if (this.sellingPositions.has(position.id)) continue;

      logger.warn(
        `[positions] 🚨 AUTHORITY RE-ENABLED: ${authorityType} authority on ${shortenAddress(position.tokenMint)} — emergency sell`,
      );

      this.sellingPositions.add(position.id);
      this.priceMonitor.pause();
      this.executeStopLoss(position, 'authority_reenabled', true)
        .catch((err) => {
          logger.error(`[positions] Authority re-enabled sell error: ${err}`);
        })
        .finally(() => {
          this.sellingPositions.delete(position.id);
          this.priceMonitor.resume();
        });
    }
  }

  /**
   * v8s/v8t: Handle pool activity detected by WebSocket liq monitor.
   * - 'critical' (removeLiquidity): Emergency sell immediately
   * - 'warning' (sell detected): Force immediate stale drain check (reduce threshold to 1)
   *   This catches creator dumps faster without false-positive selling on normal trades.
   */
  private onLiquidityRemoved(poolAddr: string, mintStr: string, severity: LiqEventSeverity, burstCount?: number): void {
    for (const position of this.positions.values()) {
      if (position.tokenMint.toBase58() !== mintStr) continue;
      if (position.status !== 'open' && position.status !== 'partial_close') continue;
      if (this.sellingPositions.has(position.id)) continue;

      if (severity === 'critical') {
        // v8u: Differentiate sell burst vs formal liquidity removal
        const isBurst = burstCount !== undefined && burstCount > 0;

        if (isBurst) {
          // v9j: Skip burst-triggered sells if stranded retry is already handling this position
          // Data (v9i): sell burst kept re-triggering sells every 15s even when stranded retry was active,
          // creating cascading 429 storms. Stranded retry (30s interval) is enough.
          if (this.strandedTimers.has(position.id)) {
            logger.info(
              `[positions] SELL BURST (${burstCount} sells) but stranded retry active for ${shortenAddress(position.tokenMint)} — skipping (stranded handles retries)`,
            );
            continue;
          }

          // v8v: Smart burst detection — check reserve health before panic-selling
          // Data (v8u session): 3/7 burst exits were false positives (pools grew to $50-80K liq)
          // Real rugs show reserve drop alongside high sell count; normal trading has stable reserves
          const entryRes = position.entryReserveLamports ?? 0;
          const currentRes = position.currentReserveLamports ?? entryRes;
          const reserveDropPct = entryRes > 0 ? ((entryRes - currentRes) / entryRes) * 100 : 0;

          // v8v fix: if reserve never updated (entry === current within 0.1%), we have no independent
          // data to confirm pool is healthy. Edge case: 4sxgLWpy was rugged in <3s before first price poll,
          // reserve showed 0% change → "OK" → didn't sell → lost 0.02 SOL.
          const reserveNeverUpdated = entryRes > 0 && Math.abs(entryRes - currentRes) / entryRes < 0.001;

          // v9h: If reserve data is missing/stale, check position age first
          // In the first 30s, PriceMonitor hasn't had time to populate reserves.
          // Data (v9g): 4ZF4 had NO RESERVE DATA at 11s → false positive emergency sell.
          const posAge = Date.now() - position.openedAt;
          const noReserveInGrace = (entryRes === 0 || reserveNeverUpdated) && posAge < PositionManager.STALE_DRAIN_GRACE_MS;

          if (noReserveInGrace) {
            // v11q: Conditional Grace — instead of blindly waiting, fetch reserves NOW (1 RPC call)
            // Then decide: reserves dropped → sell, reserves OK → monitor
            // Data: BLQrAJ8d burst at 4s during grace, pool was drained but bot waited 30s to act
            logger.warn(
              `[positions] SELL BURST in GRACE (${burstCount} sells, age=${Math.round(posAge/1000)}s) — fetching reserves to decide...`,
            );
            const mintStr = position.tokenMint.toBase58();
            this.priceMonitor.fetchSinglePoolReserves(mintStr).then(currentReserveLamports => {
              if (this.sellingPositions.has(position.id)) return; // Already selling
              if (currentReserveLamports === null) {
                // RPC failed — can't confirm, accelerate stale counter as before
                logger.warn(`[positions] Grace reserve fetch failed for ${shortenAddress(position.tokenMint)} — accelerating stale check`);
                const currentStale = this.stalePriceCount.get(position.id) ?? 0;
                if (currentStale < PositionManager.STALE_DRAIN_THRESHOLD - 1) {
                  this.stalePriceCount.set(position.id, PositionManager.STALE_DRAIN_THRESHOLD - 1);
                }
                return;
              }
              const entryResCheck = position.entryReserveLamports ?? 0;
              const dropPct = entryResCheck > 0 ? ((entryResCheck - currentReserveLamports) / entryResCheck) * 100 : 0;
              if (dropPct >= PositionManager.BURST_RESERVE_DROP_PCT) {
                // Reserves confirmed dropping → SELL
                logger.warn(
                  `[positions] GRACE CONFIRMED RUG: ${shortenAddress(position.tokenMint)} reserves dropped ${dropPct.toFixed(0)}% — emergency sell`,
                );
                position.sellBurstCount = burstCount;
                this.sellingPositions.add(position.id);
                this.priceMonitor.pause();
                this.executeStopLoss(position, 'rug_pull', true)
                  .catch(err => logger.error(`[positions] Grace rug sell error: ${err}`))
                  .finally(() => {
                    this.sellingPositions.delete(position.id);
                    this.priceMonitor.resume();
                  });
              } else {
                // Reserves OK — false alarm, monitor normally
                logger.info(
                  `[positions] Grace reserves OK for ${shortenAddress(position.tokenMint)}: drop ${dropPct.toFixed(1)}% < ${PositionManager.BURST_RESERVE_DROP_PCT}% — continuing`,
                );
                // Update position with fresh reserve data
                position.currentReserveLamports = currentReserveLamports;
              }
            }).catch(err => {
              logger.debug(`[positions] Grace reserve check error: ${err}`);
            });
          } else if (entryRes === 0 || reserveDropPct >= PositionManager.BURST_RESERVE_DROP_PCT) {
            // Reserve dropped 20%+ OR no reserve data → sell immediately
            position.sellBurstCount = burstCount;
            const reason = entryRes === 0 ? 'NO RESERVE DATA' : 'RESERVE DROP';
            logger.warn(
              `[positions] SELL BURST + ${reason}: Emergency selling ${shortenAddress(position.tokenMint)} (${burstCount} sells, reserve ${reserveDropPct >= 0 ? '-' : '+'}${Math.abs(reserveDropPct).toFixed(0)}%)`,
            );
            this.sellingPositions.add(position.id);
            this.priceMonitor.pause();
            this.executeStopLoss(position, 'sell_burst_detected', true)
              .catch((err) => {
                logger.error(`[positions] Burst sell error: ${err}`);
              })
              .finally(() => {
                this.sellingPositions.delete(position.id);
                this.priceMonitor.resume();
              });
          } else if (reserveNeverUpdated) {
            // v11v: Reserve looks stale (entry ≈ current within 0.1%) but we're past grace period.
            // Could be stale data (real rug) OR stable pool (false positive like 7WMpj4tZ).
            // Instead of selling immediately, fetch fresh reserves to confirm — same pattern as grace.
            // Data: 7WMpj4tZ was sold at -0.7% due to stale reserve, pool went +239% after.
            logger.warn(
              `[positions] SELL BURST + STALE RESERVE: ${shortenAddress(position.tokenMint)} (${burstCount} sells, age=${Math.round(posAge/1000)}s) — fetching fresh reserves...`,
            );
            const mintStr = position.tokenMint.toBase58();
            this.priceMonitor.fetchSinglePoolReserves(mintStr).then(freshReserve => {
              if (this.sellingPositions.has(position.id)) return;
              if (freshReserve === null) {
                // RPC failed — can't confirm, sell conservatively
                logger.warn(`[positions] Stale reserve fetch FAILED for ${shortenAddress(position.tokenMint)} — emergency sell (can't confirm)`);
                position.sellBurstCount = burstCount;
                this.sellingPositions.add(position.id);
                this.priceMonitor.pause();
                this.executeStopLoss(position, 'sell_burst_detected', true)
                  .catch(err => logger.error(`[positions] Stale burst sell error: ${err}`))
                  .finally(() => {
                    this.sellingPositions.delete(position.id);
                    this.priceMonitor.resume();
                  });
                return;
              }
              const entryResCheck = position.entryReserveLamports ?? 0;
              const dropPct = entryResCheck > 0 ? ((entryResCheck - freshReserve) / entryResCheck) * 100 : 0;
              if (dropPct >= PositionManager.BURST_RESERVE_DROP_PCT) {
                // Fresh reserves confirm drain → SELL
                logger.warn(
                  `[positions] STALE CONFIRMED RUG: ${shortenAddress(position.tokenMint)} fresh reserves dropped ${dropPct.toFixed(0)}% — emergency sell`,
                );
                position.sellBurstCount = burstCount;
                this.sellingPositions.add(position.id);
                this.priceMonitor.pause();
                this.executeStopLoss(position, 'sell_burst_detected', true)
                  .catch(err => logger.error(`[positions] Stale rug sell error: ${err}`))
                  .finally(() => {
                    this.sellingPositions.delete(position.id);
                    this.priceMonitor.resume();
                  });
              } else {
                // Fresh reserves OK → pool is stable, not stale. False alarm.
                logger.info(
                  `[positions] STALE reserve was STABLE: ${shortenAddress(position.tokenMint)} fresh drop ${dropPct.toFixed(1)}% < ${PositionManager.BURST_RESERVE_DROP_PCT}% — continuing`,
                );
                position.currentReserveLamports = freshReserve;
              }
            }).catch(err => {
              logger.debug(`[positions] Stale reserve check error: ${err}`);
            });
          } else {
            // Reserve healthy despite burst → normal high-activity trading, NOT a rug
            // Just accelerate drain check (same as warning severity)
            logger.info(
              `[positions] SELL BURST but reserve OK: ${shortenAddress(position.tokenMint)} (${burstCount} sells, reserve ${reserveDropPct >= 0 ? '-' : '+'}${Math.abs(reserveDropPct).toFixed(0)}%) — monitoring, NOT selling`,
            );
            const currentStale = this.stalePriceCount.get(position.id) ?? 0;
            if (currentStale < PositionManager.STALE_DRAIN_THRESHOLD - 1) {
              this.stalePriceCount.set(position.id, PositionManager.STALE_DRAIN_THRESHOLD - 1);
            }
          }
        } else {
          // Formal RemoveLiquidity instruction — ALWAYS emergency sell (no reserve check needed)
          logger.warn(
            `[positions] LIQ REMOVAL: Emergency selling ${shortenAddress(position.tokenMint)} (WebSocket detected removeLiquidity on pool)`,
          );
          this.sellingPositions.add(position.id);
          this.priceMonitor.pause();
          this.executeStopLoss(position, 'liq_removal_detected', true)
            .catch((err) => {
              logger.error(`[positions] Liq removal sell error: ${err}`);
            })
            .finally(() => {
              this.sellingPositions.delete(position.id);
              this.priceMonitor.resume();
            });
        }
      } else {
        // v8t: Sell activity detected — accelerate stale drain detection
        // Set stale count to threshold-1 so next failed price poll triggers emergency sell
        const currentStale = this.stalePriceCount.get(position.id) ?? 0;
        if (currentStale < PositionManager.STALE_DRAIN_THRESHOLD - 1) {
          this.stalePriceCount.set(position.id, PositionManager.STALE_DRAIN_THRESHOLD - 1);
          logger.info(
            `[positions] Pool sell detected for ${shortenAddress(position.tokenMint)} — accelerating drain check`,
          );
        }
      }
    }
  }

  /**
   * v11n/v11p: Handle creator wallet events (sell/transfer/close_account).
   * Creator selling OR transferring tokens is a rug signal on PumpSwap.
   * v11p: Transfer now triggers emergency sell (HTxSdjmZ case: 7 transfers evaded detection).
   */
  private onCreatorAction(poolAddr: string, mintStr: string, eventType: CreatorEventType): void {
    for (const position of this.positions.values()) {
      if (position.tokenMint.toBase58() !== mintStr) continue;
      if (position.status !== 'open' && position.status !== 'partial_close') continue;
      if (this.sellingPositions.has(position.id)) continue;

      if (eventType === 'sell' || eventType === 'transfer') {
        // v11p: Both sell AND transfer = rug signal → emergency sell
        // Data: HTxSdjmZ creator did 7 transfers (not sells) to evade detection, -100% loss
        const label = eventType === 'sell' ? 'SELL' : 'TRANSFER';
        const reason = eventType === 'sell' ? 'creator_sell_detected' : 'creator_transfer_detected';
        // v11p: Mark transfer for combo accelerator (skips stale grace period)
        if (eventType === 'transfer') {
          this.creatorTransferPositions.add(position.id);
        }
        logger.warn(
          `[positions] CREATOR ${label} detected for ${shortenAddress(position.tokenMint)} — emergency sell`,
        );
        this.sellingPositions.add(position.id);
        this.priceMonitor.pause();
        this.executeStopLoss(position, reason, true)
          .catch((err) => {
            logger.error(`[positions] Creator ${label.toLowerCase()} emergency error: ${err}`);
          })
          .finally(() => {
            this.sellingPositions.delete(position.id);
            this.priceMonitor.resume();
          });
      }
      // close_account: just logged, no action needed (creator closing empty ATAs is normal)
    }
  }

  private onPriceUpdate(mintStr: string, newPrice: number, solReserveLamports?: number): void {
    // Periodic status log for all open positions
    const now = Date.now();
    if (now - this.lastStatusLog >= PositionManager.STATUS_LOG_INTERVAL_MS && this.getOpenPositions().length > 0) {
      this.lastStatusLog = now;
      for (const pos of this.getOpenPositions()) {
        const elapsed = ((now - pos.openedAt) / 1000).toFixed(0);
        const mult = pos.entryPrice > 0 ? (pos.currentPrice / pos.entryPrice).toFixed(3) : '?';
        logger.info(
          `[positions] ${shortenAddress(pos.tokenMint)} | ${formatPct(pos.pnlPct)} | ${mult}x | ${elapsed}s | peak=${pos.peakPrice > 0 ? (pos.peakPrice / pos.entryPrice).toFixed(3) : '?'}x`,
        );
      }
    }

    for (const position of this.positions.values()) {
      if (position.tokenMint.toBase58() !== mintStr) continue;
      if (position.status !== 'open' && position.status !== 'partial_close') continue;

      // Skip if this position is currently being sold (prevent double-sell)
      if (this.sellingPositions.has(position.id)) continue;

      // Detect stale/drained pool: when price is 0 for N consecutive polls, trigger emergency sell
      if (newPrice === 0) {
        const staleCount = (this.stalePriceCount.get(position.id) ?? 0) + 1;
        this.stalePriceCount.set(position.id, staleCount);

        // v9h: Grace period — don't trigger STALE DRAIN in the first 30s
        // PriceMonitor needs time to initialize, and 429 storms cause temporary stale data
        // v11p: Skip grace period if creator transfer was detected (combo accelerator)
        const positionAge = Date.now() - position.openedAt;
        const graceSkipped = this.creatorTransferPositions.has(position.id);
        const pastGrace = graceSkipped || positionAge >= PositionManager.STALE_DRAIN_GRACE_MS;

        // v11p: Changed === to >= so stale drain retries every poll (sellingPositions guard prevents concurrent)
        // Previously only triggered once at exactly threshold=4, then never again if sell failed
        if (staleCount >= PositionManager.STALE_DRAIN_THRESHOLD && pastGrace) {
          if (staleCount === PositionManager.STALE_DRAIN_THRESHOLD) {
            logger.warn(
              `[positions] STALE DRAIN: ${shortenAddress(position.tokenMint)} price unreadable for ${staleCount} polls (age=${Math.round(positionAge/1000)}s${graceSkipped ? ', grace skipped: creator transfer' : ''}) - likely drained, emergency sell`,
            );
          }
          this.sellingPositions.add(position.id);
          this.priceMonitor.pause();
          this.executeStopLoss(position, 'rug_pull', true)
            .catch((err) => {
              logger.error(`[positions] Stale drain sell error: ${err}`);
            })
            .finally(() => {
              this.sellingPositions.delete(position.id);
              this.priceMonitor.resume();
            });
          continue;
        } else if (staleCount >= PositionManager.STALE_DRAIN_THRESHOLD && !pastGrace) {
          // v9h: Within grace period — log warning but don't sell
          if (staleCount === PositionManager.STALE_DRAIN_THRESHOLD) {
            logger.warn(
              `[positions] STALE but in GRACE period: ${shortenAddress(position.tokenMint)} (${staleCount} stale polls, age=${Math.round(positionAge/1000)}s < ${PositionManager.STALE_DRAIN_GRACE_MS/1000}s) — waiting`,
            );
          }
        }
      } else {
        // Reset stale counter on successful price read
        this.stalePriceCount.delete(position.id);
      }

      // v8v: Update current reserve for smart burst detection
      if (solReserveLamports !== undefined && solReserveLamports > 0) {
        position.currentReserveLamports = solReserveLamports;
      }

      // Update position (only if price > 0, otherwise just check timeout)
      if (newPrice > 0) {
        position.currentPrice = newPrice;
        if (newPrice > position.peakPrice) {
          position.peakPrice = newPrice;
          // Track peak metrics for analysis
          if (position.entryPrice > 0) {
            position.peakMultiplier = newPrice / position.entryPrice;
            position.timeToPeakMs = Date.now() - position.openedAt;
          }
        }

        // Calculate PnL
        const currentValue = position.tokenAmount * newPrice;
        position.pnlSol = currentValue - position.solInvested + position.solReturned;
        position.pnlPct =
          position.solInvested > 0
            ? ((currentValue + position.solReturned - position.solInvested) / position.solInvested) * 100
            : 0;
      }

      // Save position to DB periodically (throttled to avoid DB thrashing)
      const now = Date.now();
      const lastSave = this.lastDbSave.get(position.id) ?? 0;
      if (now - lastSave >= PositionManager.DB_SAVE_INTERVAL_MS) {
        this.tradeLogger.savePosition(position);
        // v8q: Log price snapshot for intra-trade trajectory analysis
        // v8u: Now includes solReserve + sell count for ML time-series
        if (position.currentPrice > 0) {
          const poolStr = position.poolAddress.toBase58();
          const sellCount = this.liqMonitor?.getSellCount(poolStr) ?? 0;
          // v11o-data: Also log buy_count and cumulative_sell_count for ML time-series
          const { buys: recentBuys } = this.liqMonitor?.getBuySellRatio(poolStr) ?? { buys: 0 };
          // v11s fix: pass actual cumulative sell count (was passing windowed sellCount — copypaste bug)
          const cumulativeSells = this.liqMonitor?.getCumulativeSellCount(poolStr) ?? 0;
          this.tradeLogger.logPriceSnapshot(
            position.id,
            position.currentPrice,
            position.entryPrice,
            position.pnlPct,
            now - position.openedAt,
            solReserveLamports,
            sellCount,
            recentBuys,
            cumulativeSells,
          );
        }
        this.lastDbSave.set(position.id, now);

        // v11x: Early exit tick counter — increment on each DB save (~10s intervals)
        // Strategy C: tick2 < 1.02 → DANGER, tick3 < 1.03 → emergency sell
        if (position.entryPrice > 0 && position.currentPrice > 0 && !this.sellingPositions.has(position.id)) {
          const tickNum = (this.earlyExitTickCount.get(position.id) ?? 0) + 1;
          this.earlyExitTickCount.set(position.id, tickNum);
          const mul = position.currentPrice / position.entryPrice;

          if (tickNum === 2) {
            // Tick 2 (~10s): flag DANGER if multiplier < 1.02
            if (mul < 1.02) {
              this.earlyExitDanger.add(position.id);
              const reserveChg = position.entryReserveLamports && position.currentReserveLamports
                ? ((position.currentReserveLamports - position.entryReserveLamports) / position.entryReserveLamports * 100).toFixed(1)
                : '?';
              logger.warn(
                `[positions] EARLY EXIT DANGER: ${shortenAddress(position.tokenMint)} tick2 mul=${mul.toFixed(3)}x (<1.02) res=${reserveChg}% — watching tick3`,
              );
            } else {
              logger.debug(`[positions] Early exit OK: ${shortenAddress(position.tokenMint)} tick2 mul=${mul.toFixed(3)}x (>=1.02)`);
            }
          } else if (tickNum === 3 && this.earlyExitDanger.has(position.id)) {
            // Tick 3 (~20s): if still below 1.03 → emergency sell
            if (mul < 1.03) {
              logger.warn(
                `[positions] EARLY EXIT SELL: ${shortenAddress(position.tokenMint)} tick2<1.02 AND tick3 mul=${mul.toFixed(3)}x (<1.03) — no traction, selling`,
              );
              this.earlyExitDanger.delete(position.id);
              this.sellingPositions.add(position.id);
              this.priceMonitor.pause();
              this.executeStopLoss(position, 'early_exit')
                .catch((err) => {
                  logger.error(`[positions] Early exit sell error: ${err}`);
                  const retries = (this.sellRetries.get(position.id) ?? 0) + 1;
                  this.sellRetries.set(position.id, retries);
                  this.sellRetryAfter.set(position.id, Date.now() + PositionManager.SELL_RETRY_BASE_DELAY_MS * Math.pow(2, retries - 1));
                })
                .finally(() => {
                  this.sellingPositions.delete(position.id);
                  this.priceMonitor.resume();
                });
              continue;
            } else {
              // Recovered above 1.03 at tick 3 — clear danger
              logger.info(
                `[positions] EARLY EXIT CLEARED: ${shortenAddress(position.tokenMint)} tick3 mul=${mul.toFixed(3)}x (>=1.03) — recovered, continuing`,
              );
              this.earlyExitDanger.delete(position.id);
            }
          }
        }
      }

      // v8m/v9i: HARD CAP — if position already has too many sell attempts
      // v9i: If sell_successes=0, tokens are still in wallet — start stranded retry instead of closing
      if ((position.sellAttempts ?? 0) >= PositionManager.ABSOLUTE_MAX_SELL_ATTEMPTS) {
        const already = position.sellAttempts ?? 0;
        if (!this.sellingPositions.has(position.id)) {
          if ((position.sellSuccesses ?? 0) === 0 && !this.strandedTimers.has(position.id)) {
            // v9i: No successful sells → tokens still in wallet → start stranded retry
            logger.warn(
              `[positions] HARD CAP but 0 sells succeeded: ${shortenAddress(position.tokenMint)} (${already} attempts) — starting stranded retry (30s intervals, 5min max)`,
            );
            this.startStrandedRetry(position, 'max_retries_hard_cap');
          } else if ((position.sellSuccesses ?? 0) > 0) {
            // Partial sells succeeded — remaining tokens are likely dust, close normally
            logger.error(
              `[positions] HARD CAP: ${shortenAddress(position.tokenMint)} hit ${already} sell attempts (${position.sellSuccesses} succeeded) — closing as loss`,
            );
            this.forceCloseAsLoss(position, 'max_retries_hard_cap');
          }
          // else: strandedTimers already running, let it handle
        }
        continue;
      }

      // Check take profit (only if we have a real price)
      const tpAction = newPrice > 0 ? evaluateTakeProfit(position, this.config.position.takeProfit) : { shouldSell: false } as TakeProfitAction;
      if (tpAction.shouldSell) {
        // v8l: Check TP sell cooldown (prevents cascading 429 from repeated attempts)
        const tpCooldown = this.tpSellCooldownUntil.get(position.id) ?? 0;
        if (now < tpCooldown) {
          continue; // Wait for cooldown to expire
        }
        // Mark level as pending immediately to prevent duplicate triggers
        position.tpLevelsHit.push(tpAction.level);
        this.sellingPositions.add(position.id);
        this.priceMonitor.pause(); // Pause price polling during sell to avoid RPC contention
        this.executeTakeProfit(position, tpAction.sellPct, tpAction.level)
          .catch((err) => {
            logger.error(`[positions] TP execution error (exception): ${err}`);
            // Rollback level on failure
            position.tpLevelsHit = position.tpLevelsHit.filter((l) => l !== tpAction.level);
            // v8m: Set cooldown even on exceptions (was missing → infinite retry loop)
            this.tpSellCooldownUntil.set(position.id, Date.now() + PositionManager.TP_SELL_COOLDOWN_MS);
          })
          .finally(() => {
            this.sellingPositions.delete(position.id);
            this.priceMonitor.resume();
          });
        continue;
      }

      // v9i: Skip normal SL path for stranded positions — stranded retry handles sells
      if (this.strandedTimers.has(position.id)) {
        continue;
      }

      // v11m: Buy/sell ratio momentum check — if sells overwhelm buys, momentum is dead
      // Only check after position has been open >30s (needs time for data to accumulate)
      // and only trigger if position has already hit TP1 (protect existing gains)
      if (this.liqMonitor && (Date.now() - position.openedAt) > 30_000) {
        const poolStr = position.poolAddress.toBase58();
        const { buys, sells, ratio } = this.liqMonitor.getBuySellRatio(poolStr);
        // Ratio > 3.0 = 3x more sells than buys in last 30s → dump signal
        // Only trigger if there's meaningful activity (5+ events total)
        if (ratio >= 3.0 && (buys + sells) >= 5 && !this.sellingPositions.has(position.id)) {
          const retryAfter = this.sellRetryAfter.get(position.id) ?? 0;
          if (now >= retryAfter) {
            logger.warn(
              `[positions] SELL MOMENTUM: ${shortenAddress(position.tokenMint)} sell/buy ratio ${ratio.toFixed(1)}:1 (${sells}S/${buys}B in 30s) — triggering sell`,
            );
            this.sellingPositions.add(position.id);
            this.priceMonitor.pause();
            this.executeStopLoss(position, 'trailing_stop')
              .catch((err) => {
                logger.error(`[positions] Momentum sell error: ${err}`);
                const retries = (this.sellRetries.get(position.id) ?? 0) + 1;
                this.sellRetries.set(position.id, retries);
                this.sellRetryAfter.set(position.id, Date.now() + PositionManager.SELL_RETRY_BASE_DELAY_MS * Math.pow(2, retries - 1));
              })
              .finally(() => {
                this.sellingPositions.delete(position.id);
                this.priceMonitor.resume();
              });
            continue;
          }
        }
      }

      // v11u: Micro trailing — tight trailing in first 60s to catch ultra-fast rugs
      // Data: 7/22 rugs peaked 1.01-1.05x in <60s then collapsed. Normal trailing never activates.
      const microCfg = this.config.position.microTrailing;
      if (microCfg.enabled && position.tpLevelsHit.length === 0 && !this.sellingPositions.has(position.id)) {
        const posAge = now - position.openedAt;
        if (posAge <= microCfg.windowMs && position.entryPrice > 0) {
          const peakMult = position.peakPrice / position.entryPrice;
          if (peakMult >= microCfg.minPeakMultiplier) {
            const dropFromPeak = ((position.peakPrice - position.currentPrice) / position.peakPrice) * 100;
            if (dropFromPeak >= microCfg.dropFromPeakPct) {
              const currentMult = position.currentPrice / position.entryPrice;
              logger.warn(
                `[positions] MICRO TRAILING: ${shortenAddress(position.tokenMint)} peak=${peakMult.toFixed(3)}x now=${currentMult.toFixed(3)}x drop=${dropFromPeak.toFixed(1)}% in ${(posAge / 1000).toFixed(0)}s — selling`,
              );
              const retryAfter = this.sellRetryAfter.get(position.id) ?? 0;
              if (now >= retryAfter) {
                this.sellingPositions.add(position.id);
                this.priceMonitor.pause();
                this.executeStopLoss(position, 'trailing_stop')
                  .catch((err) => {
                    logger.error(`[positions] Micro trailing sell error: ${err}`);
                    const retries = (this.sellRetries.get(position.id) ?? 0) + 1;
                    this.sellRetries.set(position.id, retries);
                    this.sellRetryAfter.set(position.id, Date.now() + PositionManager.SELL_RETRY_BASE_DELAY_MS * Math.pow(2, retries - 1));
                  })
                  .finally(() => {
                    this.sellingPositions.delete(position.id);
                    this.priceMonitor.resume();
                  });
                continue;
              }
            }
          }
        }
      }

      // v11u: Buy drought detector — no buyers while sellers active = dead token
      // Data: Rugs have sell/buy ratio 21:1 vs winners 4.6:1
      const droughtCfg = this.config.position.buyDrought;
      if (droughtCfg.enabled && this.liqMonitor && !this.sellingPositions.has(position.id)) {
        const poolStr = position.poolAddress.toBase58();
        const { buys, sells } = this.liqMonitor.getBuySellRatio(poolStr);

        if (buys === 0 && sells > 0) {
          const count = (this.buyDroughtCount.get(position.id) ?? 0) + 1;
          this.buyDroughtCount.set(position.id, count);

          // Emergency sell: 30s+ drought with heavy selling
          if (count >= droughtCfg.snapshotsForEmergency && sells >= droughtCfg.sellCountForEmergency) {
            logger.warn(
              `[positions] BUY DROUGHT EMERGENCY: ${shortenAddress(position.tokenMint)} ${count} snapshots no buys, ${sells} sells — selling`,
            );
            const retryAfter = this.sellRetryAfter.get(position.id) ?? 0;
            if (now >= retryAfter) {
              this.sellingPositions.add(position.id);
              this.priceMonitor.pause();
              this.executeStopLoss(position, 'trailing_stop')
                .catch((err) => {
                  logger.error(`[positions] Buy drought sell error: ${err}`);
                  const retries = (this.sellRetries.get(position.id) ?? 0) + 1;
                  this.sellRetries.set(position.id, retries);
                  this.sellRetryAfter.set(position.id, Date.now() + PositionManager.SELL_RETRY_BASE_DELAY_MS * Math.pow(2, retries - 1));
                })
                .finally(() => {
                  this.sellingPositions.delete(position.id);
                  this.priceMonitor.resume();
                  this.buyDroughtCount.delete(position.id);
                  this.buyDroughtTightened.delete(position.id);
                });
              continue;
            }
          }
          // Tighten trailing: 20s+ drought with moderate selling
          else if (count >= droughtCfg.snapshotsForTighten && sells >= droughtCfg.sellCountForTighten
            && !this.buyDroughtTightened.has(position.id)) {
            logger.warn(
              `[positions] BUY DROUGHT TIGHTEN: ${shortenAddress(position.tokenMint)} ${count} snapshots no buys, ${sells} sells — trailing ${this.config.position.trailingStopPct}%→${droughtCfg.tightenTrailingPct}%`,
            );
            this.buyDroughtTightened.add(position.id);
          }
        } else if (buys > 0) {
          // Reset drought counter when buys resume
          if (this.buyDroughtCount.has(position.id)) {
            this.buyDroughtCount.delete(position.id);
            this.buyDroughtTightened.delete(position.id);
          }
        }
      }

      // Check stop loss
      // v11u: Use tightened trailing if buy drought detected
      const effectiveTrailing = this.buyDroughtTightened.has(position.id)
        ? this.config.position.buyDrought.tightenTrailingPct
        : this.config.position.trailingStopPct;
      const slAction = evaluateStopLoss(
        position,
        this.config.position.stopLossPct,
        effectiveTrailing,
        this.config.position.timeoutMinutes,
      );
      if (slAction.shouldSell) {
        // Exponential backoff: don't retry sell too fast (wastes RPC calls + fees)
        const retryAfter = this.sellRetryAfter.get(position.id) ?? 0;
        if (now < retryAfter) {
          continue; // Wait for backoff to expire
        }

        this.sellingPositions.add(position.id);
        this.priceMonitor.pause(); // Pause price polling during sell to avoid RPC contention
        this.executeStopLoss(position, slAction.reason)
          .catch((err) => {
            logger.error(`[positions] SL execution error (exception): ${err}`);
            // v8m: Increment retry + set backoff even on exceptions (was missing → infinite retry loop)
            const retries = (this.sellRetries.get(position.id) ?? 0) + 1;
            this.sellRetries.set(position.id, retries);
            this.sellRetryAfter.set(position.id, Date.now() + PositionManager.SELL_RETRY_BASE_DELAY_MS * Math.pow(2, retries - 1));
          })
          .finally(() => {
            this.sellingPositions.delete(position.id);
            this.priceMonitor.resume();
          });
        continue;
      }

      botEmitter.emit('positionUpdated', position);
    }
  }

  private async executeTakeProfit(
    position: Position,
    sellPct: number,
    level: number,
  ): Promise<void> {
    let sellAmount = calculateSellAmount(position.tokenAmount, sellPct);
    if (sellAmount <= 0) return;

    // v8s: Safety valve — skip sell TX for dust amounts (would cost more in fees than value)
    const sellValue = sellAmount * position.currentPrice;
    if (sellValue < PositionManager.DUST_THRESHOLD_SOL && sellValue >= 0) {
      // v9n: If TP portion is dust but total remaining is NOT dust, sell ALL remaining
      // This prevents the scenario where TP2 (30% of original) is dust-skipped but 50% remains,
      // then trailing stop sells later at a worse price
      const totalRemainingValue = position.tokenAmount * position.currentPrice;
      if (totalRemainingValue >= PositionManager.DUST_THRESHOLD_SOL) {
        logger.info(
          `[positions] TP${level + 1} portion is dust (${formatSol(sellValue)}) but total remaining (${formatSol(totalRemainingValue)}) is above threshold — selling ALL remaining`,
        );
        sellAmount = position.tokenAmount; // Sell everything
      } else {
        logger.info(
          `[positions] Dust skip TP${level + 1}: ${shortenAddress(position.tokenMint)} sell value ${formatSol(sellValue)} SOL < ${PositionManager.DUST_THRESHOLD_SOL} threshold`,
        );
        return;
      }
    }

    // v11s: TP1 snapshot + smart TP evaluation
    if (level === 0) {
      const poolStr = position.poolAddress.toBase58();
      const timeToTp1 = Date.now() - position.openedAt;
      const entryRes = position.entryReserveLamports ?? null;
      const currentRes = position.currentReserveLamports ?? null;
      const reserveChangePct = (entryRes && currentRes && entryRes > 0)
        ? ((currentRes - entryRes) / entryRes) * 100
        : null;
      const { buys: buyCount30s, sells: sellCount15s, ratio: buySellRatio } =
        this.liqMonitor?.getBuySellRatio(poolStr) ?? { buys: 0, sells: 0, ratio: 0 };
      const cumulativeSells = this.liqMonitor?.getCumulativeSellCount(poolStr) ?? 0;
      const currentMultiplier = position.entryPrice > 0 ? position.currentPrice / position.entryPrice : 1;

      // Evaluate smart TP (shadow or active)
      const smartTpSignals: SmartTpSignals = {
        reserveChangePct,
        buySellRatio,
        timeToTp1Ms: timeToTp1,
        cumulativeSellCount: cumulativeSells,
        positionSolValue: position.tokenAmount * position.currentPrice,
        entryReserveLamports: position.entryReserveLamports,
      };
      const smartTpResult = evaluateSmartTp(smartTpSignals, this.config.position.smartTp);

      logger.info(
        `[positions] TP1 SNAPSHOT: ${shortenAddress(position.tokenMint)} | ` +
        `reserve${reserveChangePct !== null ? (reserveChangePct >= 0 ? '+' : '') + reserveChangePct.toFixed(1) + '%' : '?'} | ` +
        `ratio=${buySellRatio.toFixed(1)} (${buyCount30s}B/${sellCount15s}S) | ` +
        `tp1_in=${(timeToTp1 / 1000).toFixed(0)}s | sells=${cumulativeSells} | ` +
        `SMART TP: ${smartTpResult.isConfident ? 'CONFIDENT' : 'DEFAULT'} ${smartTpResult.sellPct}% (${smartTpResult.reason})`,
      );

      // Log snapshot to DB
      this.tradeLogger.logTp1Snapshot({
        positionId: position.id,
        tokenMint: position.tokenMint.toBase58(),
        timeToTp1Ms: timeToTp1,
        entryReserveLamports: entryRes,
        tp1ReserveLamports: currentRes,
        reserveChangePct,
        buyCount30s,
        sellCount15s,
        buySellRatio,
        cumulativeSellCount: cumulativeSells,
        currentMultiplier,
        // Record decision based on SIGNALS only (ignoring position size) for data collection
        smartTpDecision: smartTpResult.signalsPassed >= this.config.position.smartTp.minSignalsRequired ? 'HOLD' : 'SELL',
        smartTpSignalsPassed: smartTpResult.signalsPassed,
        smartTpReason: smartTpResult.reason,
      });

      // v11s: If smart TP is ENABLED (not shadow) and confident → override sell percentage
      if (this.config.position.smartTp.enabled && smartTpResult.isConfident) {
        sellPct = smartTpResult.sellPct;
        sellAmount = calculateSellAmount(position.tokenAmount, sellPct);
        logger.info(
          `[positions] SMART TP ACTIVE: Selling ${sellPct}% (${100 - sellPct}% held for TP2@1.20x)`,
        );
      }
    }

    logger.info(
      `[positions] TP Level ${level + 1}: Selling ${sellPct}% of ${shortenAddress(position.tokenMint)}`,
    );

    if (this.config.risk.dryRun) {
      logger.info('[positions] DRY RUN - would sell');
      position.status = 'partial_close';
      botEmitter.emit('takeProfitHit', position, level);
      return;
    }

    position.sellAttempts++;
    const result = await this.sellFn(position.tokenMint, sellAmount, position.poolAddress, position.source);

    if (result.success) {
      // v11m: Zero-output guard — TX confirmed but swap returned 0 SOL (pool drained between sim and execution)
      // Bug found: FtnWkqsa peaked 2.25x, 2 "successful" sells returned 0 SOL, PnL = -100%
      // Don't count as real success if outputAmount is 0 — tokens are still in wallet, retry
      if (result.outputAmount === 0) {
        logger.warn(
          `[positions] TP${level + 1} TX confirmed but outputAmount=0 for ${shortenAddress(position.tokenMint)} — pool likely drained, treating as failed sell`,
        );
        // Set cooldown and let normal retry logic handle it
        this.tpSellCooldownUntil.set(position.id, Date.now() + PositionManager.TP_SELL_COOLDOWN_MS);
        // Rollback level so it can be re-triggered
        position.tpLevelsHit = position.tpLevelsHit.filter((l) => l !== level);
        return;
      }

      position.sellSuccesses++;
      // v9q: Use actual inputAmount from result (handles double-sell where both protocols sold)
      const actualSold = Math.min(result.inputAmount || sellAmount, position.tokenAmount);
      position.tokenAmount -= actualSold;
      if (actualSold > sellAmount * 1.5) {
        logger.warn(`[positions] Double-sell detected: sold ${actualSold} tokens (requested ${sellAmount}) — position tokenAmount now ${position.tokenAmount}`);
      }
      position.solReturned += result.outputAmount / 1e9; // lamports to SOL
      // v8l: Clear TP cooldown on success
      this.tpSellCooldownUntil.delete(position.id);
      // v9m: Reset progressive 429 retry counter on success
      this.tpSell429RetryCount.delete(position.id);

      // v9q: If all tokens sold (e.g. double-sell), close position immediately
      if (position.tokenAmount <= 0) {
        logger.info(`[positions] All tokens sold after TP${level + 1} (double-sell) — closing position`);
        position.tokenAmount = 0;
        position.status = 'closed';
        position.closedAt = Date.now();
        position.exitReason = 'tp_complete';
        position.pnlSol = position.solReturned - position.solInvested;
        position.pnlPct = position.solInvested > 0
          ? ((position.solReturned - position.solInvested) / position.solInvested) * 100
          : 0;
        this.priceMonitor.removeToken(position.tokenMint);
        this.liqMonitor?.unsubscribe(position.poolAddress);
        this.creatorMonitor?.unsubscribe(position.poolAddress);
        this.tradeLogger.savePosition(position);
        this.recordOutcome(position);
        this.sellRetries.delete(position.id);
        this.sellRetryAfter.delete(position.id);
        this.tpSellCooldownUntil.delete(position.id);
        this.tpSell429RetryCount.delete(position.id);
        botEmitter.emit('takeProfitHit', position, level);
        botEmitter.emit('positionClosed', position);
        return;
      }

      // Check if all TP levels hit
      if (position.tpLevelsHit.length >= this.config.position.takeProfit.length) {
        if (this.config.position.moonBagPct > 0 && shouldKeepMoonBag(position, this.config.position.takeProfit.length)) {
          const { keepAmount } = calculateMoonBag(position, this.config.position.moonBagPct);
          position.tokenAmount = keepAmount;
          position.status = 'partial_close';
          // v11i: Reset peak for moonbag trailing — start fresh from current price
          position.peakPrice = position.currentPrice;
        } else {
          position.status = 'closed';
          position.closedAt = Date.now();
          position.exitReason = 'tp_complete';
          this.priceMonitor.removeToken(position.tokenMint);
          this.liqMonitor?.unsubscribe(position.poolAddress);
        this.creatorMonitor?.unsubscribe(position.poolAddress);
          this.recordOutcome(position);
        }
      } else {
        position.status = 'partial_close';
      }

      // Recalculate PnL after sell
      position.pnlSol = position.solReturned - position.solInvested;
      position.pnlPct = position.solInvested > 0
        ? ((position.solReturned - position.solInvested) / position.solInvested) * 100
        : 0;

      this.tradeLogger.savePosition(position);
      this.tradeLogger.logTrade(
        null, // pool_id: null for sell trades (position.id is not a detected_pool id)
        'sell',
        result,
        position.tokenMint.toBase58(),
        WSOL_MINT.toBase58(),
      );

      botEmitter.emit('takeProfitHit', position, level);
      // Emit positionClosed when trade is fully done (not partial)
      if (position.status === 'closed') {
        botEmitter.emit('positionClosed', position);
      }
    } else {
      // ROLLBACK: sell returned success=false (not an exception), undo the optimistic TP level
      position.tpLevelsHit = position.tpLevelsHit.filter((l) => l !== level);

      // v9m: Progressive cooldown for 429 errors: 5s → 10s → 15s max (was fixed 45s)
      // Df5J TP1 hit 1.20x but sell never executed because 45s cooldown was too long
      const is429 = result.error && /429|rate.limit|Too many/i.test(result.error);
      let cooldownMs: number;
      if (is429) {
        const retryCount = this.tpSell429RetryCount.get(position.id) ?? 0;
        cooldownMs = Math.min(5_000 * (retryCount + 1), 15_000); // 5s, 10s, 15s max
        this.tpSell429RetryCount.set(position.id, retryCount + 1);
      } else {
        cooldownMs = PositionManager.TP_SELL_COOLDOWN_MS;
      }
      this.tpSellCooldownUntil.set(position.id, Date.now() + cooldownMs);

      logger.warn(
        `[positions] TP Level ${level + 1} sell FAILED for ${shortenAddress(position.tokenMint)} (${result.error ?? 'unknown'}) - cooldown ${(cooldownMs / 1000).toFixed(0)}s${is429 ? ` (429, retry #${this.tpSell429RetryCount.get(position.id)})` : ''}`,
      );

      // v10e: Honeypot one-sell pattern detection
      // If position has 1+ successful sell (partial_close) but failures with Custom:60xx (PumpSwap errors)
      // OR Simulation FAILED, the token likely allows one small sell then blocks everything else.
      // Also count general sell failures (RPC timeouts) toward a higher threshold.
      if (position.solReturned > 0) {
        const honeypotKey = `honeypot_${position.id}`;
        const currentCount = this.tpSell429RetryCount.get(honeypotKey) ?? 0;
        const isSimulationFail = result.error && /Custom:60\d{2}|Simulation failed|Simulation FAILED/.test(result.error);
        // Simulation failures count double (stronger signal)
        const increment = isSimulationFail ? 2 : 1;
        const newCount = currentCount + increment;
        this.tpSell429RetryCount.set(honeypotKey, newCount);
        // Threshold: 3 simulation-weighted points (2 sim fails OR 1 sim + 1 timeout OR 3 timeouts)
        if (newCount >= 3) {
          logger.warn(`[positions] 🚨 HONEYPOT DETECTED: ${shortenAddress(position.tokenMint)} — ${newCount} weighted sell failures after successful first sell. Closing.`);
          position.status = 'stopped';
          position.closedAt = Date.now();
          position.exitReason = 'honeypot_partial';
          position.pnlSol = position.solReturned - position.solInvested;
          position.pnlPct = position.solInvested > 0
            ? ((position.solReturned - position.solInvested) / position.solInvested) * 100
            : 0;
          this.priceMonitor.removeToken(position.tokenMint);
          this.liqMonitor?.unsubscribe(position.poolAddress);
        this.creatorMonitor?.unsubscribe(position.poolAddress);
          this.tradeLogger.savePosition(position);
          this.positions.delete(position.id);
          this.sellingPositions.delete(position.id);
          return;
        }
      }
    }
  }

  private async executeStopLoss(
    position: Position,
    reason: string,
    emergency = false,
  ): Promise<void> {
    const retries = this.sellRetries.get(position.id) ?? 0;

    // v8s: Safety valve — skip sell TX for dust positions (value < 0.0005 SOL)
    // Selling would cost ~0.002 SOL in fees, netting a loss
    const estimatedValue = position.tokenAmount * position.currentPrice;
    if (estimatedValue < PositionManager.DUST_THRESHOLD_SOL && estimatedValue >= 0) {
      logger.info(
        `[positions] Dust skip: ${shortenAddress(position.tokenMint)} value ${formatSol(estimatedValue)} SOL < ${PositionManager.DUST_THRESHOLD_SOL} threshold — closing without sell TX`,
      );
      position.status = 'stopped';
      position.closedAt = Date.now();
      position.exitReason = 'dust_skip';
      position.pnlSol = position.solReturned - position.solInvested;
      position.pnlPct = position.solInvested > 0
        ? ((position.solReturned - position.solInvested) / position.solInvested) * 100
        : 0;
      this.priceMonitor.removeToken(position.tokenMint);
      this.liqMonitor?.unsubscribe(position.poolAddress);
        this.creatorMonitor?.unsubscribe(position.poolAddress);
      this.tradeLogger.savePosition(position);
      this.recordOutcome(position);
      this.sellRetries.delete(position.id);
      this.sellRetryAfter.delete(position.id);
      this.tpSellCooldownUntil.delete(position.id);
      this.tpSell429RetryCount.delete(position.id);
      this.creatorTransferPositions.delete(position.id);
      botEmitter.emit('stopLossHit', position);
      botEmitter.emit('positionClosed', position);
      return;
    }

    // Moon bag on trailing stop: if profitable, keep moonBagPct% for potential further upside
    // Data showed 5/9 tokens went 2-3.5x AFTER our trailing stop sold at +20-30%
    // v11i: Only create moonbag from 'open' positions (not from existing moonbags — prevents cascading)
    // FIX: Don't create micro moon bags (cascading bug) - if value < 0.0005 SOL, sell 100%
    const moonBagPct = this.config.position.moonBagPct;
    const potentialMoonBagValue = position.tokenAmount * (moonBagPct / 100) * position.currentPrice;
    const keepMoonBag = position.status === 'open' && reason === 'trailing_stop' && position.pnlPct > 5 && moonBagPct > 0 && potentialMoonBagValue >= 0.0005;
    const sellPct = keepMoonBag ? (100 - moonBagPct) : 100;
    const sellAmount = keepMoonBag
      ? Math.floor(position.tokenAmount * (sellPct / 100))
      : position.tokenAmount;

    logger.info(
      `[positions] STOP LOSS (${reason}): Selling ${sellPct}% of ${shortenAddress(position.tokenMint)} | PnL: ${formatPct(position.pnlPct)}${keepMoonBag ? ` | keeping ${moonBagPct}% moon bag` : ''} | attempt ${retries + 1}/${PositionManager.MAX_SELL_RETRIES}`,
    );

    if (this.config.risk.dryRun) {
      logger.info('[positions] DRY RUN - would sell');
      position.status = 'stopped';
      position.closedAt = Date.now();
      position.exitReason = reason;
      this.priceMonitor.removeToken(position.tokenMint);
      this.liqMonitor?.unsubscribe(position.poolAddress);
        this.creatorMonitor?.unsubscribe(position.poolAddress);
      this.sellRetries.delete(position.id);
      botEmitter.emit('stopLossHit', position);
      botEmitter.emit('positionClosed', position);
      return;
    }

    position.sellAttempts++;
    let result: TradeResult;
    try {
      result = await this.sellFn(
        position.tokenMint,
        sellAmount,
        position.poolAddress,
        position.source,
        emergency,
      );
    } catch (err) {
      // v9j: Ensure sellFn exceptions don't leave position in limbo
      result = {
        success: false, inputAmount: sellAmount, outputAmount: 0,
        pricePerToken: 0, fee: 0, timestamp: Date.now(),
        error: `sellFn exception: ${String(err).slice(0, 100)}`,
      };
    }

    if (result.success) {
      setSellPriorityBoost(1); // v11w: reset priority boost on success

      // v11m: Zero-output guard for stop-loss path too — same bug as TP path (FtnWkqsa)
      // TX confirmed but swap returned 0 SOL = pool drained, tokens still in wallet
      if (result.outputAmount === 0 && reason !== 'rug_pull') {
        logger.warn(
          `[positions] SL sell TX confirmed but outputAmount=0 for ${shortenAddress(position.tokenMint)} — treating as failed, will retry`,
        );
        const newRetries = (this.sellRetries.get(position.id) ?? 0) + 1;
        this.sellRetries.set(position.id, newRetries);
        this.sellRetryAfter.set(position.id, Date.now() + PositionManager.SELL_RETRY_BASE_DELAY_MS * Math.pow(2, newRetries - 1));
        return;
      }

      // v9j: Wrap ALL post-sell logic in try/catch — position MUST close even if logging fails
      // Data (v9i): sell TX confirmed on-chain but position stayed 'open' in memory,
      // blocking new trades for 3+ minutes until bot crashed
      try {
        position.sellSuccesses++;
        position.solReturned += result.outputAmount / 1e9;
        position.tokenAmount -= sellAmount;

        if (keepMoonBag && position.tokenAmount > 0) {
          // Moon bag: keep remaining tokens, reset peak so trailing stop starts fresh
          position.status = 'partial_close';
          position.peakPrice = position.currentPrice;
          logger.info(
            `[positions] Moon bag: keeping ${position.tokenAmount} tokens (${moonBagPct}%) of ${shortenAddress(position.tokenMint)} | reset peak for fresh trailing stop`,
          );
        } else {
          // Full close
          position.tokenAmount = 0;
          position.status = 'stopped';
          position.closedAt = Date.now();
          position.exitReason = reason;
          this.priceMonitor.removeToken(position.tokenMint);
          this.liqMonitor?.unsubscribe(position.poolAddress);
        this.creatorMonitor?.unsubscribe(position.poolAddress);
          this.recordOutcome(position);
        }

        position.pnlSol = position.solReturned - position.solInvested;
        position.pnlPct =
          position.solInvested > 0
            ? ((position.solReturned - position.solInvested) / position.solInvested) * 100
            : 0;

        this.tradeLogger.savePosition(position);
        this.sellRetries.delete(position.id);
        this.sellRetryAfter.delete(position.id);
        this.creatorTransferPositions.delete(position.id);
      } catch (postSellErr) {
        // v9j: CRITICAL SAFETY NET — sell TX confirmed but post-processing failed
        // Force-close position so it doesn't block new trades
        logger.error(`[positions] POST-SELL ERROR for ${shortenAddress(position.tokenMint)}: ${postSellErr}`);
        logger.error(`[positions] Force-closing position to prevent blocking`);
        position.status = 'stopped';
        position.closedAt = Date.now();
        position.exitReason = reason;
        position.tokenAmount = 0;
        try { this.tradeLogger.savePosition(position); } catch { /* last resort */ }
        try { this.priceMonitor.removeToken(position.tokenMint); } catch { /* */ }
        try { this.liqMonitor?.unsubscribe(position.poolAddress);
        this.creatorMonitor?.unsubscribe(position.poolAddress); } catch { /* */ }
      }

      this.tradeLogger.logTrade(
        null,
        'sell',
        result,
        position.tokenMint.toBase58(),
        WSOL_MINT.toBase58(),
      );

      botEmitter.emit('stopLossHit', position);
      // Emit positionClosed when trade is fully done (not moon bag)
      if (position.status === 'stopped') {
        botEmitter.emit('positionClosed', position);
      }
    } else {
      // Sell failed - set exponential backoff before retry
      const newRetries = retries + 1;
      this.sellRetries.set(position.id, newRetries);

      // v8l: Detect 429 rate limit for longer backoff and more retries
      const is429 = result.error && /429|rate.limit|Too many/i.test(result.error);

      // Pool drained (Custom:6001/6024 = zero output): retrying is pointless AFTER 2 quick retries
      // v9w: Added 'SOL output is 0', 'Pool has 0 SOL', 'Token balance is 0' — overnight 4/10 tokens stranded 7+ min retrying
      // v9z: Added Custom:6025 (PumpSwap pool closed/depleted — CUbA blocked all detection with infinite retries)
      // v11w: Allow 2 fast retries on drained pools (pool may be partially drained, worth trying with higher fee)
      const isDrainedPool = result.error && /Custom[:(]600[1245]|Custom[:(]602[45]|ZeroBase|InsufficientOutput|SOL output is 0|Pool has 0 SOL|Token balance is 0/i.test(result.error);
      const isEmergencyReason = /rug_pull|sell_burst_detected|liq_removal/.test(reason);

      // Exponential backoff: 2s, 4s normally. 30s for 429 errors. 500ms flat for emergencies (rug/burst/liq).
      // v11w: Emergency sells use fast fixed delay instead of exponential backoff
      const backoffMs = is429
        ? PositionManager.SL_429_BACKOFF_MS
        : isEmergencyReason
          ? PositionManager.EMERGENCY_SELL_RETRY_DELAY_MS
          : PositionManager.SELL_RETRY_BASE_DELAY_MS * Math.pow(2, retries);
      this.sellRetryAfter.set(position.id, Date.now() + backoffMs);

      // v11w: Escalate priority fee on emergency sell retries to land TX faster
      if (isEmergencyReason && newRetries <= 3) {
        clearPriorityFeeCache(); // Force fresh fee estimation
        setSellPriorityBoost(newRetries * 2); // 2x, 4x, 6x
        logger.info(`[positions] Priority boost ${newRetries * 2}x for ${reason} retry #${newRetries}`);
      }
      if (isDrainedPool && newRetries >= 2) {
        // Exhausted 2 fast retries on drained pool — give up
        logger.warn(
          `[positions] Pool drained: sell failed for ${shortenAddress(position.tokenMint)} after ${newRetries} retries - closing as loss`,
        );
        setSellPriorityBoost(1); // v11w: reset boost
        position.status = 'stopped';
        position.closedAt = Date.now();
        position.exitReason = 'pool_drained';
        position.pnlSol = position.solReturned - position.solInvested;
        position.pnlPct =
          position.solInvested > 0
            ? ((position.solReturned - position.solInvested) / position.solInvested) * 100
            : 0;
        this.priceMonitor.removeToken(position.tokenMint);
        this.liqMonitor?.unsubscribe(position.poolAddress);
        this.creatorMonitor?.unsubscribe(position.poolAddress);
        this.tradeLogger.savePosition(position);
        this.recordOutcome(position);
        this.sellRetries.delete(position.id);
        this.sellRetryAfter.delete(position.id);
        botEmitter.emit('stopLossHit', position);
        botEmitter.emit('positionClosed', position);
      // v8l: Allow more retries for 429 errors (recoverable, just need cooldown)
      } else if (newRetries >= (is429 ? PositionManager.MAX_SELL_RETRIES_429 : PositionManager.MAX_SELL_RETRIES)) {
        setSellPriorityBoost(1); // v11w: reset priority boost
        const maxR = is429 ? PositionManager.MAX_SELL_RETRIES_429 : PositionManager.MAX_SELL_RETRIES;
        // v9i: If no successful sells, tokens are still in wallet — start stranded retry
        if ((position.sellSuccesses ?? 0) === 0 && !this.strandedTimers.has(position.id)) {
          const exitReason = is429 ? 'max_retries_429' : 'max_retries';
          logger.warn(
            `[positions] SELL FAILED after ${maxR} attempts for ${shortenAddress(position.tokenMint)}${is429 ? ' (429 rate limit)' : ''} — 0 sells succeeded, starting stranded retry (30s intervals, 5min max)`,
          );
          this.startStrandedRetry(position, exitReason);
        } else {
          // Partial sells succeeded — remaining tokens may be dust, close normally
          logger.error(
            `[positions] SELL FAILED after ${maxR} attempts for ${shortenAddress(position.tokenMint)}${is429 ? ' (429 rate limit)' : ''} (${position.sellSuccesses} sells succeeded) — closing as loss`,
          );
          this.forceCloseAsLoss(position, is429 ? 'max_retries_429' : 'max_retries');
        }
      } else {
        logger.warn(
          `[positions] Sell failed for ${shortenAddress(position.tokenMint)} (${result.error}), retry ${newRetries}/${PositionManager.MAX_SELL_RETRIES} in ${(backoffMs / 1000).toFixed(0)}s`,
        );
      }
    }
  }

  /**
   * v9i: Force close a position as loss (used when partial sells succeeded or stranded retry exhausted).
   * Centralizes the close-as-loss logic to avoid duplication.
   */
  private forceCloseAsLoss(position: Position, exitReason: string): void {
    setSellPriorityBoost(1); // v11w: reset priority boost
    position.status = 'stopped';
    position.closedAt = Date.now();
    position.exitReason = exitReason;
    position.pnlSol = position.solReturned - position.solInvested;
    position.pnlPct = position.solInvested > 0
      ? ((position.solReturned - position.solInvested) / position.solInvested) * 100
      : 0;
    this.priceMonitor.removeToken(position.tokenMint);
    this.liqMonitor?.unsubscribe(position.poolAddress);
        this.creatorMonitor?.unsubscribe(position.poolAddress);
    this.tradeLogger.savePosition(position);
    this.recordOutcome(position);
    this.sellRetries.delete(position.id);
    this.sellRetryAfter.delete(position.id);
    this.tpSellCooldownUntil.delete(position.id);
    this.tpSell429RetryCount.delete(position.id);
    this.creatorTransferPositions.delete(position.id);
    this.earlyExitTickCount.delete(position.id);
    this.earlyExitDanger.delete(position.id);
    botEmitter.emit('stopLossHit', position);
    botEmitter.emit('positionClosed', position);
  }

  /**
   * v9i: Start stranded retry for a position whose sell failed but tokens remain in wallet.
   * Retries every 30s for 5 minutes. If all retries fail, closes as loss.
   * The position stays 'open' and visible to the bot during retries.
   * Price monitoring continues so we can still detect price recovery.
   */
  private startStrandedRetry(position: Position, originalExitReason: string): void {
    if (this.strandedTimers.has(position.id)) {
      return; // Already running
    }

    const startedAt = Date.now();
    this.strandedStartedAt.set(position.id, startedAt);

    // Reset sell retries so the normal SL path doesn't interfere
    this.sellRetries.delete(position.id);
    this.sellRetryAfter.delete(position.id);

    logger.warn(
      `[positions] STRANDED: ${shortenAddress(position.tokenMint)} — scheduling sell retries every ${PositionManager.STRANDED_RETRY_INTERVAL_MS / 1000}s for ${PositionManager.STRANDED_MAX_DURATION_MS / 60000}min`,
    );

    const timer = setInterval(() => {
      this.executeStrandedRetry(position, originalExitReason).catch((err) => {
        logger.error(`[positions] Stranded retry error for ${shortenAddress(position.tokenMint)}: ${err}`);
      });
    }, PositionManager.STRANDED_RETRY_INTERVAL_MS);

    this.strandedTimers.set(position.id, timer);
  }

  /**
   * v9i: Execute a single stranded retry attempt.
   * If sell succeeds, close position normally.
   * If max duration exceeded, close as loss.
   */
  private async executeStrandedRetry(position: Position, originalExitReason: string): Promise<void> {
    // Position already closed by another path (e.g. manual close, price recovery TP)
    if (position.status === 'stopped' || position.status === 'closed') {
      this.cleanupStrandedRetry(position.id);
      return;
    }

    // Check if already selling
    if (this.sellingPositions.has(position.id)) {
      return;
    }

    const startedAt = this.strandedStartedAt.get(position.id) ?? Date.now();
    const elapsed = Date.now() - startedAt;

    // Time's up — close as loss
    if (elapsed >= PositionManager.STRANDED_MAX_DURATION_MS) {
      logger.error(
        `[positions] STRANDED TIMEOUT: ${shortenAddress(position.tokenMint)} — ${(elapsed / 60000).toFixed(1)}min elapsed, all retries failed. Closing as loss.`,
      );
      this.cleanupStrandedRetry(position.id);
      this.forceCloseAsLoss(position, `stranded_timeout_${originalExitReason}`);
      return;
    }

    const retryNum = Math.floor(elapsed / PositionManager.STRANDED_RETRY_INTERVAL_MS) + 1;
    const maxRetries = Math.floor(PositionManager.STRANDED_MAX_DURATION_MS / PositionManager.STRANDED_RETRY_INTERVAL_MS);

    logger.info(
      `[positions] STRANDED RETRY ${retryNum}/${maxRetries}: ${shortenAddress(position.tokenMint)} — attempting sell...`,
    );

    this.sellingPositions.add(position.id);
    position.sellAttempts++;

    try {
      const result = await this.sellFn(
        position.tokenMint,
        position.tokenAmount,
        position.poolAddress,
        position.source,
        false, // not emergency — use simulation to avoid wasting fees
      );

      if (result.success) {
        position.sellSuccesses++;
        position.solReturned += result.outputAmount / 1e9;
        position.tokenAmount = 0;
        position.status = 'stopped';
        position.closedAt = Date.now();
        position.exitReason = `stranded_recovered_${originalExitReason}`;
        position.pnlSol = position.solReturned - position.solInvested;
        position.pnlPct = position.solInvested > 0
          ? ((position.solReturned - position.solInvested) / position.solInvested) * 100
          : 0;

        this.priceMonitor.removeToken(position.tokenMint);
        this.liqMonitor?.unsubscribe(position.poolAddress);
        this.creatorMonitor?.unsubscribe(position.poolAddress);
        this.tradeLogger.savePosition(position);
        this.recordOutcome(position);

        this.tradeLogger.logTrade(
          null,
          'sell',
          result,
          position.tokenMint.toBase58(),
          WSOL_MINT.toBase58(),
        );

        this.cleanupStrandedRetry(position.id);

        logger.info(
          `[positions] STRANDED RECOVERED: ${shortenAddress(position.tokenMint)} sold after ${(elapsed / 1000).toFixed(0)}s stranded | PnL: ${formatPct(position.pnlPct)} (${formatSol(position.pnlSol)} SOL)`,
        );

        botEmitter.emit('stopLossHit', position);
        botEmitter.emit('positionClosed', position);
      } else {
        // Check if pool is drained or honeypot — no point retrying
        // v10f: Extended regex to match SL path — was missing Custom:6024/6025 (honeypot errors)
        const isDrainedPool = result.error && /Custom[:(]600[1245]|Custom[:(]602[45]|ZeroBase|InsufficientOutput|SOL output is 0|Pool has 0 SOL|Token balance is 0/i.test(result.error);
        if (isDrainedPool) {
          logger.warn(
            `[positions] STRANDED: Pool drained for ${shortenAddress(position.tokenMint)} — closing as loss`,
          );
          this.cleanupStrandedRetry(position.id);
          this.forceCloseAsLoss(position, 'stranded_pool_drained');
        } else {
          logger.warn(
            `[positions] STRANDED RETRY FAILED: ${shortenAddress(position.tokenMint)} (${result.error ?? 'unknown'}) — will retry in ${PositionManager.STRANDED_RETRY_INTERVAL_MS / 1000}s`,
          );
        }
      }
    } catch (err) {
      logger.error(`[positions] Stranded retry exception for ${shortenAddress(position.tokenMint)}: ${err}`);
    } finally {
      this.sellingPositions.delete(position.id);
    }
  }

  /** v9i: Clean up stranded retry state for a position */
  private cleanupStrandedRetry(positionId: string): void {
    const timer = this.strandedTimers.get(positionId);
    if (timer) {
      clearInterval(timer);
      this.strandedTimers.delete(positionId);
    }
    this.strandedStartedAt.delete(positionId);
    this.sellRetries.delete(positionId);
    this.sellRetryAfter.delete(positionId);
    this.tpSellCooldownUntil.delete(positionId);
    this.tpSell429RetryCount.delete(positionId);
    this.creatorTransferPositions.delete(positionId);
    this.buyDroughtCount.delete(positionId);
    this.buyDroughtTightened.delete(positionId);
    this.earlyExitTickCount.delete(positionId);
    this.earlyExitDanger.delete(positionId);
  }

  async closeAll(): Promise<void> {
    const open = this.getOpenPositions();
    logger.info(`[positions] Closing all ${open.length} positions...`);

    for (const position of open) {
      await this.executeStopLoss(position, 'manual_close');
    }
  }

  /** Record outcome in creator tracker + token_analysis when a position fully closes */
  private recordOutcome(position: Position): void {
    const mint = position.tokenMint.toBase58();
    const poolStr = position.poolAddress.toBase58();

    // v8u: Capture aggregate sell event data from liq monitor before unsubscribe clears it
    if (this.liqMonitor) {
      position.totalSellEvents = this.liqMonitor.getCumulativeSellCount(poolStr);
      // maxSellBurst: use the burst that triggered emergency sell, or 0 if no burst
      position.maxSellBurst = position.sellBurstCount ?? 0;
    }

    this.creatorTracker.updateOutcome(mint, position.pnlPct);
    this.tradeLogger.updateTokenAnalysisPnl(mint, position.pnlPct, true, true);

    // v11s: Update TP1 snapshot outcome + send shadow Telegram notification
    this.updateTp1OutcomeAndShadow(position);
  }

  /**
   * v11s: If this position had a TP1 hit (snapshot exists), fill in the post-TP1 outcome
   * and emit a shadow Telegram notification showing what smart TP would have done.
   */
  private updateTp1OutcomeAndShadow(position: Position): void {
    if (!this.tradeLogger.hasTp1Snapshot(position.id)) return;

    const peakMult = position.peakMultiplier ?? (position.entryPrice > 0 ? position.peakPrice / position.entryPrice : 1);
    const durationMs = (position.closedAt ?? Date.now()) - position.openedAt;
    this.tradeLogger.updateTp1Outcome(
      position.id,
      peakMult,
      position.exitReason ?? 'unknown',
      durationMs,
    );

    // Attach shadow data to position so formatTradeClosed can show it inline
    try {
      const snapshot = this.tradeLogger.getTp1Snapshot(position.id);
      if (!snapshot) return;

      const decision = snapshot.smart_tp_decision as string;
      const signalsPassed = snapshot.smart_tp_signals_passed as number;
      const confidentSellPct = this.config.position.smartTp.confidentSellPct;
      const realPnl = position.pnlSol;
      let delta = 0;

      if (decision === 'HOLD') {
        const tp1Mult = 1.08;
        const solInvested = position.solInvested;
        const tp1Portion = confidentSellPct / 100;
        const holdPortion = 1 - tp1Portion;
        const tp1PnlSol = solInvested * tp1Portion * (tp1Mult - 1);
        const holdPnlSolAtPeak = solInvested * holdPortion * (peakMult - 1);
        const extraFee = 0.0004;
        const hypotheticalPnl = tp1PnlSol + holdPnlSolAtPeak - extraFee;
        delta = hypotheticalPnl - realPnl;

        logger.info(
          `[positions] SMART TP SHADOW: ${shortenAddress(position.tokenMint)} | ` +
          `decision=HOLD ${100 - confidentSellPct}% | signals=${signalsPassed}/4 | ` +
          `peak=${peakMult.toFixed(2)}x | real=${realPnl.toFixed(4)} vs hypo=${hypotheticalPnl.toFixed(4)} | ` +
          `delta=${delta >= 0 ? '+' : ''}${delta.toFixed(4)} SOL`,
        );
      } else {
        logger.info(
          `[positions] SMART TP SHADOW: ${shortenAddress(position.tokenMint)} | ` +
          `decision=SELL 100% | signals=${signalsPassed}/4 | agrees with actual`,
        );
      }

      // Attach to position — formatTradeClosed reads this
      position.smartTpShadow = {
        decision: decision === 'HOLD' ? 'HOLD' : 'SELL',
        signalsPassed,
        delta,
      };
    } catch (err) {
      logger.debug(`[positions] Smart TP shadow error: ${err}`);
    }
  }

  /**
   * v10d: Handle background sell completion — when parallel sell race causes both PumpSwap
   * and Jupiter to succeed, the "losing" promise completes in background. This captures
   * that extra SOL so PnL is accurate. Without this, DB only records the first sell's return.
   */
  private onBackgroundSellCompleted(mintStr: string, outputAmountLamports: number): void {
    const solAmount = outputAmountLamports / 1e9;

    // First: try in-memory positions (still open or recently closed)
    for (const position of this.positions.values()) {
      if (position.tokenMint.toBase58() !== mintStr) continue;
      position.solReturned += solAmount;
      position.tokenAmount = 0; // All tokens are gone after double-sell
      position.pnlSol = position.solReturned - position.solInvested;
      position.pnlPct = position.solInvested > 0
        ? ((position.solReturned - position.solInvested) / position.solInvested) * 100
        : 0;

      logger.info(
        `[positions] BACKGROUND SELL recorded for ${shortenAddress(position.tokenMint)}: +${formatSol(solAmount)} SOL | Total returned: ${formatSol(position.solReturned)} | PnL: ${formatPct(position.pnlPct)}`,
      );

      this.tradeLogger.savePosition(position);
      return; // Only one position per mint
    }

    // v10e: Position already closed and removed from map — update DB directly
    // This handles the case where tp_complete removed the position before background sell fired
    try {
      const db = getDb();
      const row = db.prepare(
        `SELECT id, sol_invested, sol_returned FROM positions WHERE token_mint = ? ORDER BY opened_at DESC LIMIT 1`,
      ).get(mintStr) as { id: string; sol_invested: number; sol_returned: number } | undefined;

      if (row) {
        const newReturned = row.sol_returned + solAmount;
        const pnlSol = newReturned - row.sol_invested;
        const pnlPct = row.sol_invested > 0 ? ((newReturned - row.sol_invested) / row.sol_invested) * 100 : 0;

        db.prepare(
          `UPDATE positions SET sol_returned = ?, pnl_sol = ?, pnl_pct = ?, token_amount = 0 WHERE id = ?`,
        ).run(newReturned, pnlSol, pnlPct, row.id);

        logger.info(
          `[positions] BACKGROUND SELL (DB update) for ${mintStr.slice(0, 8)}: +${formatSol(solAmount)} SOL | Total: ${formatSol(newReturned)} | PnL: ${pnlPct.toFixed(1)}%`,
        );
      } else {
        logger.warn(`[positions] BACKGROUND SELL for unknown mint ${mintStr.slice(0, 8)}: +${formatSol(solAmount)} SOL (no position in DB)`);
      }
    } catch (err) {
      logger.error(`[positions] Failed to update DB for background sell: ${err}`);
    }
  }

  async forceClosePosition(positionId: string, reason: string): Promise<void> {
    const position = this.positions.get(positionId);
    if (!position) {
      logger.warn(`[positions] forceClose: position ${positionId.slice(0, 8)} not found`);
      return;
    }
    await this.executeStopLoss(position, reason);
  }
}
