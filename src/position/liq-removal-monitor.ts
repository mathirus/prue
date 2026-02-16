import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { PUMPSWAP_AMM } from '../constants.js';

/**
 * v8s: WebSocket-based liquidity removal monitor.
 *
 * Subscribes to onLogs for each active pool. When a transaction touches
 * the pool AND involves the PumpSwap program, we check if it's a
 * removeLiquidity operation. This detects rugs 2-10s before polling.
 *
 * Cost: 0 RPC calls (WebSocket subscription is free).
 * Latency: ~200-500ms from TX confirmation vs ~1.5s polling interval.
 */

// v8t: severity levels for different pool events
export type LiqEventSeverity = 'critical' | 'warning';
// v8u: callback now includes burstCount for tracking/DB
type LiqRemovalCallback = (poolAddress: string, mintStr: string, severity: LiqEventSeverity, burstCount?: number) => void;

interface Subscription {
  subId: number;
  poolAddress: string;
  mintStr: string;
}

// PumpSwap removeLiquidity discriminator: SHA256("global:remove_liquidity") first 8 bytes
// Anchor uses Sighash = SHA256("global:<method_name>")[0..8]
// "global:remove_liquidity" = [80, 10, 228, 250, ...] but we match by program ID mention in logs
const PUMPSWAP_PROGRAM_STR = PUMPSWAP_AMM.toBase58();

export class LiquidityRemovalMonitor {
  private subscriptions = new Map<string, Subscription>(); // poolAddr → sub
  private callback: LiqRemovalCallback | null = null;
  // v8u: Sell burst detection — track sell count per pool in sliding window
  // Data: rugs show 10+ sells in <15s before price crashes. Normal trading = 1-3 sells/15s.
  private sellBurstTracker = new Map<string, number[]>(); // poolAddr → timestamps of recent sells
  // v11m: Buy tracking for buy/sell ratio (rug prediction signal)
  // Data: when sell ratio exceeds buys 2:1 for 30s+, momentum is dead → sell signal
  private buyTracker = new Map<string, number[]>(); // poolAddr → timestamps of recent buys
  // v8u: Cumulative sell counter per pool (lifetime total, not windowed) for ML features
  private cumulativeSellCount = new Map<string, number>(); // poolAddr → total sells observed
  // v9f: Cooldown after burst trigger — prevent re-triggering for 30s
  private burstCooldownUntil = new Map<string, number>(); // poolAddr → cooldown end timestamp
  private static readonly BURST_WINDOW_MS = 15_000; // 15-second sliding window
  private static readonly BURST_THRESHOLD = 8; // 8+ sells = likely rug dump
  private static readonly BURST_COOLDOWN_MS = 30_000; // 30s cooldown after burst trigger
  // v11m: Buy/sell ratio window for momentum detection
  private static readonly RATIO_WINDOW_MS = 30_000; // 30-second window for ratio calculation

  private readonly getConnection: () => Connection;
  constructor(getConn: (() => Connection) | Connection) {
    // v11j: Accept getter function or direct Connection for backward compat
    this.getConnection = typeof getConn === 'function' ? getConn : () => getConn;
  }

  private get connection(): Connection {
    return this.getConnection();
  }

  /**
   * Register callback for liquidity removal events.
   */
  onLiquidityRemoved(cb: LiqRemovalCallback): void {
    this.callback = cb;
  }

  /**
   * Start monitoring a pool for liquidity removal.
   * Uses connection.onLogs to watch for PumpSwap interactions on the pool account.
   */
  subscribe(poolAddress: PublicKey, tokenMint: PublicKey): void {
    const poolStr = poolAddress.toBase58();
    if (this.subscriptions.has(poolStr)) return;

    try {
      const subId = this.connection.onLogs(
        poolAddress,
        (logs) => {
          // Check if this transaction involves PumpSwap and looks like a remove liquidity
          if (!logs.logs) return;

          // Look for PumpSwap program invocation
          const hasPumpSwap = logs.logs.some(
            (line) => line.includes(PUMPSWAP_PROGRAM_STR),
          );
          if (!hasPumpSwap) return;

          // v8t: Detect BOTH liquidity removal AND massive sells (creator rug dumps)
          // PumpSwap rugs are mostly done via massive sells, NOT removeLiquidity
          // Key patterns:
          //   - "Instruction: RemoveLiquidity" = formal liquidity removal
          //   - "Instruction: Sell" / "SellExactIn" = token dump (most common rug method)
          //   - "Withdraw" = SOL withdrawal from pool
          const isRemoveLiq = logs.logs.some(
            (line) =>
              line.includes('RemoveLiquidity') ||
              line.includes('remove_liquidity') ||
              (line.includes('Withdraw') && line.includes(PUMPSWAP_PROGRAM_STR)),
          );

          // v8t: Detect sells/swaps on the pool (creator dumping tokens)
          // Only trigger if it's a Sell instruction (not Buy — buys are good)
          const isSuspiciousSell = !isRemoveLiq && logs.logs.some(
            (line) =>
              (line.includes('Instruction: Sell') || line.includes('Instruction: SellExactIn')) &&
              !line.includes('Buy'), // Make sure it's not a buy instruction
          );

          // v11m: Detect buys for buy/sell ratio tracking
          // v11s fix: Buy detection is independent of sell detection.
          // PumpSwap logs can contain both "Sell" and "Buy" patterns in the same TX,
          // so gating on !isSuspiciousSell caused buy_count to always be 0.
          const isBuy = !isRemoveLiq && logs.logs.some(
            (line) =>
              (line.includes('Instruction: Buy') || line.includes('Instruction: BuyExactIn'))
              && !line.includes('Sell'), // Ensure it's a buy-only instruction line
          );
          if (isBuy) {
            const buyTimestamps = this.buyTracker.get(poolStr) ?? [];
            buyTimestamps.push(Date.now());
            // Trim to ratio window
            const buyCutoff = Date.now() - LiquidityRemovalMonitor.RATIO_WINDOW_MS;
            this.buyTracker.set(poolStr, buyTimestamps.filter(t => t > buyCutoff));
          }

          if (isRemoveLiq) {
            const mintStr = this.subscriptions.get(poolStr)?.mintStr ?? '';
            logger.warn(
              `[liq-monitor] LIQUIDITY REMOVAL detected on pool ${poolStr.slice(0, 8)}... (token ${mintStr.slice(0, 8)}...) TX: ${logs.signature}`,
            );
            if (this.callback) {
              this.callback(poolStr, mintStr, 'critical');
            }
          } else if (isSuspiciousSell) {
            const mintStr = this.subscriptions.get(poolStr)?.mintStr ?? '';

            // v8u: Track sell burst — 8+ sells in 15s = likely rug dump
            // Data: 4fhuFk5G had 17 sells in 32s before 100% drain. Emergency sell
            // at sell #8 (~15s) would have saved +50% instead of losing -50%.
            const now = Date.now();
            const timestamps = this.sellBurstTracker.get(poolStr) ?? [];
            timestamps.push(now);
            // v8u: Increment cumulative counter (lifetime total for ML)
            this.cumulativeSellCount.set(poolStr, (this.cumulativeSellCount.get(poolStr) ?? 0) + 1);
            // Trim to window
            const cutoff = now - LiquidityRemovalMonitor.BURST_WINDOW_MS;
            const recent = timestamps.filter(t => t > cutoff);
            this.sellBurstTracker.set(poolStr, recent);

            if (recent.length >= LiquidityRemovalMonitor.BURST_THRESHOLD) {
              // v9f: Check cooldown — don't re-trigger burst for same pool within 30s
              const cooldownEnd = this.burstCooldownUntil.get(poolStr) ?? 0;
              if (now < cooldownEnd) {
                // Still in cooldown, just count sells silently
              } else {
                // Burst detected — escalate to critical (emergency sell)
                const burstCount = recent.length;
                logger.warn(
                  `[liq-monitor] SELL BURST: ${burstCount} sells in ${LiquidityRemovalMonitor.BURST_WINDOW_MS / 1000}s on pool ${poolStr.slice(0, 8)}... — emergency sell`,
                );
                this.burstCooldownUntil.set(poolStr, now + LiquidityRemovalMonitor.BURST_COOLDOWN_MS);
                this.sellBurstTracker.delete(poolStr); // Reset tracker
                if (this.callback) {
                  this.callback(poolStr, mintStr, 'critical', burstCount);
                }
              }
            } else {
              // Normal sell activity — just accelerate drain check
              logger.debug(
                `[liq-monitor] Sell activity on pool ${poolStr.slice(0, 8)}... TX: ${logs.signature}`,
              );
              if (this.callback) {
                this.callback(poolStr, mintStr, 'warning');
              }
            }
          }
        },
        'confirmed',
      );

      this.subscriptions.set(poolStr, {
        subId,
        poolAddress: poolStr,
        mintStr: tokenMint.toBase58(),
      });

      logger.debug(
        `[liq-monitor] Subscribed to pool ${poolStr.slice(0, 8)}... (subId: ${subId})`,
      );
    } catch (err) {
      // Non-fatal — polling still catches rugs, this is just faster
      logger.debug(`[liq-monitor] Failed to subscribe to ${poolStr.slice(0, 8)}...: ${err}`);
    }
  }

  /**
   * v8u: Get current sell count in the sliding window for a pool.
   * Used by position-manager to log sell velocity in price snapshots for ML.
   */
  getSellCount(poolAddress: string): number {
    const timestamps = this.sellBurstTracker.get(poolAddress);
    if (!timestamps || timestamps.length === 0) return 0;
    const cutoff = Date.now() - LiquidityRemovalMonitor.BURST_WINDOW_MS;
    return timestamps.filter(t => t > cutoff).length;
  }

  /**
   * v8u: Get cumulative (lifetime) sell count for a pool.
   * Total sells observed since subscription, not windowed.
   * Used for ML aggregate features on position close.
   */
  getCumulativeSellCount(poolAddress: string): number {
    return this.cumulativeSellCount.get(poolAddress) ?? 0;
  }

  /**
   * v11m: Get buy/sell ratio for a pool in the last 30 seconds.
   * Returns { buys, sells, ratio } where ratio = sells / max(buys, 1).
   * ratio > 2.0 = bearish (2x more sells than buys) → potential dump signal.
   * ratio < 0.5 = bullish (2x more buys than sells) → healthy momentum.
   */
  getBuySellRatio(poolAddress: string): { buys: number; sells: number; ratio: number } {
    const now = Date.now();
    const cutoff = now - LiquidityRemovalMonitor.RATIO_WINDOW_MS;

    const buyTimestamps = this.buyTracker.get(poolAddress) ?? [];
    const sellTimestamps = this.sellBurstTracker.get(poolAddress) ?? [];

    const recentBuys = buyTimestamps.filter(t => t > cutoff).length;
    const recentSells = sellTimestamps.filter(t => t > cutoff).length;
    const ratio = recentSells / Math.max(recentBuys, 1);

    return { buys: recentBuys, sells: recentSells, ratio };
  }

  /**
   * Stop monitoring a pool.
   */
  unsubscribe(poolAddress: PublicKey): void {
    const poolStr = poolAddress.toBase58();
    const sub = this.subscriptions.get(poolStr);
    if (!sub) return;

    try {
      this.connection.removeOnLogsListener(sub.subId);
    } catch {
      // Ignore cleanup errors
    }
    this.subscriptions.delete(poolStr);
    this.sellBurstTracker.delete(poolStr); // v8u: cleanup burst tracker
    this.buyTracker.delete(poolStr); // v11m: cleanup buy tracker
    this.burstCooldownUntil.delete(poolStr); // v9f: cleanup cooldown
    // Note: cumulativeSellCount NOT deleted here — recordOutcome reads it after unsubscribe.
    // Cleaned up in stop() or naturally garbage collected when monitor is destroyed.
    logger.debug(`[liq-monitor] Unsubscribed from pool ${poolStr.slice(0, 8)}...`);
  }

  /**
   * Cleanup all subscriptions.
   */
  stop(): void {
    for (const [, sub] of this.subscriptions) {
      try {
        this.connection.removeOnLogsListener(sub.subId);
      } catch {
        // Ignore
      }
    }
    this.subscriptions.clear();
    this.sellBurstTracker.clear(); // v8u: cleanup
    this.buyTracker.clear(); // v11m: cleanup
    this.cumulativeSellCount.clear(); // v8u: cleanup
    this.burstCooldownUntil.clear(); // v9f: cleanup
    logger.debug('[liq-monitor] All subscriptions cleared');
  }
}
