import { PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { botEmitter } from '../detection/event-emitter.js';
import { getDb } from '../data/database.js';
import { sleep, shortenAddress, solToLamports } from '../utils/helpers.js';
import { WSOL_MINT } from '../constants.js';
import type { BotConfig, WalletTrade, TradeOrder, TradeResult } from '../types.js';
import type { TokenScorer } from '../analysis/token-scorer.js';

type BuyFunction = (order: TradeOrder) => Promise<TradeResult>;

/**
 * Automatically replicates trades from tracked wallets.
 * Applies configurable delay, position sizing, and security checks.
 */
export class CopyExecutor {
  private isRunning = false;

  constructor(
    private readonly config: BotConfig,
    private readonly buyFn: BuyFunction,
    private readonly scorer: TokenScorer,
  ) {}

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    botEmitter.on('walletTrade', (trade: WalletTrade) => {
      this.handleTrade(trade).catch((err) => {
        logger.error('[copy-executor] Error handling trade', { error: String(err) });
      });
    });

    logger.info('[copy-executor] Started');
  }

  stop(): void {
    this.isRunning = false;
    botEmitter.removeAllListeners('walletTrade');
    logger.info('[copy-executor] Stopped');
  }

  private async handleTrade(trade: WalletTrade): Promise<void> {
    // Only copy buy trades
    if (trade.type !== 'buy') {
      logger.debug(`[copy-executor] Skipping sell from ${shortenAddress(trade.walletAddress)}`);
      return;
    }

    // Check if wallet is enabled
    const db = getDb();
    const walletRow = db.prepare(
      'SELECT * FROM wallet_targets WHERE address = ? AND enabled = 1',
    ).get(trade.walletAddress.toBase58()) as Record<string, unknown> | undefined;

    if (!walletRow) {
      logger.debug('[copy-executor] Wallet not enabled, skipping');
      return;
    }

    const maxCopySol = Number(walletRow.max_copy_sol) || this.config.copyTrading.maxCopySol;
    const label = String(walletRow.label);

    logger.info(
      `[copy-executor] Copying ${label}: BUY ${shortenAddress(trade.tokenMint)}`,
    );

    // Apply delay
    if (this.config.copyTrading.delayMs > 0) {
      await sleep(this.config.copyTrading.delayMs);
    }

    // Security check on the token
    const mockPool = {
      id: `copy-${Date.now()}`,
      source: 'pumpswap' as const,
      poolAddress: trade.tokenMint, // Will be resolved
      baseMint: trade.tokenMint,
      quoteMint: WSOL_MINT,
      baseDecimals: 6,
      quoteDecimals: 9,
      detectedAt: Date.now(),
      slot: 0,
      txSignature: trade.txSignature,
    };

    const security = await this.scorer.score(mockPool);

    if (!security.passed) {
      logger.warn(
        `[copy-executor] Token ${shortenAddress(trade.tokenMint)} failed security (${security.score}/100), skipping`,
      );
      return;
    }

    // Dry run check
    if (this.config.risk.dryRun) {
      logger.info(
        `[copy-executor] DRY RUN: Would buy ${maxCopySol} SOL of ${shortenAddress(trade.tokenMint)}`,
      );
      return;
    }

    // Execute buy
    const order: TradeOrder = {
      type: 'buy',
      inputMint: WSOL_MINT,
      outputMint: trade.tokenMint,
      amountIn: solToLamports(maxCopySol),
      slippageBps: this.config.execution.slippageBps,
      useJito: this.config.execution.useJito,
      jitoTipLamports: this.config.execution.jitoTipLamports,
    };

    const result = await this.buyFn(order);

    if (result.success) {
      logger.info(
        `[copy-executor] Copied ${label}: ${maxCopySol} SOL -> ${result.outputAmount} tokens | TX: ${result.txSignature}`,
      );

      // Update wallet stats
      db.prepare(
        'UPDATE wallet_targets SET trades_count = trades_count + 1 WHERE address = ?',
      ).run(trade.walletAddress.toBase58());
    } else {
      logger.error(`[copy-executor] Copy trade failed: ${result.error}`);
    }
  }
}
