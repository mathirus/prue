import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { PUMPSWAP_AMM } from '../constants.js';

/**
 * v11n: WebSocket-based creator wallet monitor.
 *
 * After buying a token, subscribes to onLogs for the creator's wallet.
 * Detects when the creator sells tokens or transfers them — a strong rug signal
 * that arrives 200-500ms after TX confirm (vs 1.5-5s reserve polling).
 *
 * PumpSwap rug mechanism: creator has ~200M tokens (20% supply) from bonding curve.
 * They rug by SELLING these tokens via PumpSwap `sell` instruction, draining SOL.
 *
 * Cost: 0 RPC calls (WebSocket subscription is free on Helius Developer plan).
 */

export type CreatorEventType = 'sell' | 'transfer' | 'close_account';

type CreatorActionCallback = (
  poolAddress: string,
  mintStr: string,
  eventType: CreatorEventType,
) => void;

interface CreatorSubscription {
  subId: number;
  creatorAddress: string;
  poolAddress: string;
  mintStr: string;
}

const PUMPSWAP_PROGRAM_STR = PUMPSWAP_AMM.toBase58();

export class CreatorWalletMonitor {
  private subscriptions = new Map<string, CreatorSubscription>(); // poolAddr → sub
  private callback: CreatorActionCallback | null = null;

  private readonly getConnection: () => Connection;
  constructor(getConn: (() => Connection) | Connection) {
    this.getConnection = typeof getConn === 'function' ? getConn : () => getConn;
  }

  private get connection(): Connection {
    return this.getConnection();
  }

  /**
   * Register callback for creator wallet events.
   */
  onCreatorAction(cb: CreatorActionCallback): void {
    this.callback = cb;
  }

  /**
   * Start monitoring a creator's wallet for sell/transfer activity.
   * Called from PositionManager.openPosition() with the token's creator address.
   */
  subscribe(
    creatorAddress: string,
    poolAddress: PublicKey,
    tokenMint: PublicKey,
  ): void {
    const poolStr = poolAddress.toBase58();
    if (this.subscriptions.has(poolStr)) return;

    try {
      const creatorPubkey = new PublicKey(creatorAddress);
      const mintStr = tokenMint.toBase58();

      const subId = this.connection.onLogs(
        creatorPubkey,
        (logs) => {
          if (!logs.logs) return;

          // Only care about PumpSwap interactions (creator selling tokens back to pool)
          const hasPumpSwap = logs.logs.some(
            (line) => line.includes(PUMPSWAP_PROGRAM_STR),
          );

          if (!hasPumpSwap) {
            // Check for SPL Token transfer/close that might indicate moving tokens to another wallet
            const isTransfer = logs.logs.some(
              (line) => line.includes('Instruction: Transfer') || line.includes('Instruction: TransferChecked'),
            );
            const isClose = logs.logs.some(
              (line) => line.includes('Instruction: CloseAccount'),
            );

            if (isTransfer) {
              logger.warn(
                `[creator-monitor] TRANSFER detected from creator ${creatorAddress.slice(0, 8)}... (token ${mintStr.slice(0, 8)}...) TX: ${logs.signature}`,
              );
              if (this.callback) {
                this.callback(poolStr, mintStr, 'transfer');
              }
            }
            if (isClose) {
              logger.info(
                `[creator-monitor] CloseAccount from creator ${creatorAddress.slice(0, 8)}... TX: ${logs.signature}`,
              );
              if (this.callback) {
                this.callback(poolStr, mintStr, 'close_account');
              }
            }
            return;
          }

          // PumpSwap interaction — check if it's a sell (creator dumping tokens)
          const isSell = logs.logs.some(
            (line) =>
              line.includes('Instruction: Sell') ||
              line.includes('Instruction: SellExactIn'),
          );

          if (isSell) {
            logger.warn(
              `[creator-monitor] CREATOR SELL detected: ${creatorAddress.slice(0, 8)}... selling on pool ${poolStr.slice(0, 8)}... TX: ${logs.signature}`,
            );
            if (this.callback) {
              this.callback(poolStr, mintStr, 'sell');
            }
          }
        },
        'confirmed',
      );

      this.subscriptions.set(poolStr, {
        subId,
        creatorAddress,
        poolAddress: poolStr,
        mintStr,
      });

      logger.debug(
        `[creator-monitor] Subscribed to creator ${creatorAddress.slice(0, 8)}... for pool ${poolStr.slice(0, 8)}... (subId: ${subId})`,
      );
    } catch (err) {
      // Non-fatal — liq monitor + reserve polling still catch rugs
      logger.debug(`[creator-monitor] Failed to subscribe to creator ${creatorAddress.slice(0, 8)}...: ${err}`);
    }
  }

  /**
   * Stop monitoring a creator for a specific pool.
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
    logger.debug(`[creator-monitor] Unsubscribed from creator ${sub.creatorAddress.slice(0, 8)}... (pool ${poolStr.slice(0, 8)}...)`);
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
    logger.debug('[creator-monitor] All subscriptions cleared');
  }
}
