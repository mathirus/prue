import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { botEmitter } from '../detection/event-emitter.js';
import { getDb } from '../data/database.js';
import { WSOL_MINT, TOKEN_PROGRAM } from '../constants.js';
import type { WalletTarget, WalletTrade } from '../types.js';
import type { WebSocketManager } from '../core/websocket-manager.js';

/**
 * Monitors tracked wallets for new token trades via WebSocket.
 * When a tracked wallet buys/sells, emits a walletTrade event.
 */
export class WalletTracker {
  private trackedWallets = new Map<string, WalletTarget>();
  private isRunning = false;

  constructor(
    private readonly connection: Connection,
    private readonly wsManager: WebSocketManager,
  ) {}

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    // Load wallets from DB
    await this.loadWallets();

    // Subscribe to each wallet
    for (const [address, target] of this.trackedWallets) {
      if (target.enabled) {
        await this.subscribeToWallet(address);
      }
    }

    logger.info(`[wallet-tracker] Started tracking ${this.trackedWallets.size} wallets`);
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    for (const address of this.trackedWallets.keys()) {
      await this.wsManager.unsubscribe(`wallet-${address}`);
    }
    logger.info('[wallet-tracker] Stopped');
  }

  async addWallet(target: WalletTarget): Promise<void> {
    const address = target.address.toBase58();
    this.trackedWallets.set(address, target);

    // Save to DB
    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO wallet_targets (address, label, enabled, max_copy_sol, added_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(address, target.label, target.enabled ? 1 : 0, target.maxCopySol, target.addedAt);

    if (target.enabled && this.isRunning) {
      await this.subscribeToWallet(address);
    }

    logger.info(`[wallet-tracker] Added wallet: ${target.label} (${address.slice(0, 8)}...)`);
  }

  async removeWallet(address: string): Promise<void> {
    this.trackedWallets.delete(address);
    await this.wsManager.unsubscribe(`wallet-${address}`);

    const db = getDb();
    db.prepare('DELETE FROM wallet_targets WHERE address = ?').run(address);

    logger.info(`[wallet-tracker] Removed wallet: ${address.slice(0, 8)}...`);
  }

  getTrackedWallets(): WalletTarget[] {
    return [...this.trackedWallets.values()];
  }

  private async loadWallets(): Promise<void> {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM wallet_targets').all() as Array<Record<string, unknown>>;

    for (const row of rows) {
      this.trackedWallets.set(String(row.address), {
        address: new PublicKey(String(row.address)),
        label: String(row.label),
        enabled: row.enabled === 1,
        maxCopySol: Number(row.max_copy_sol),
        winRate: row.win_rate as number | undefined,
        totalPnl: row.total_pnl as number | undefined,
        tradesCount: Number(row.trades_count ?? 0),
        addedAt: Number(row.added_at),
      });
    }
  }

  private async subscribeToWallet(address: string): Promise<void> {
    const pubkey = new PublicKey(address);

    await this.wsManager.subscribe(
      `wallet-${address}`,
      pubkey,
      (logs, ctx) => {
        if (logs.err) return;
        this.processWalletLogs(address, logs.signature, logs.logs, ctx.slot);
      },
    );
  }

  private processWalletLogs(
    walletAddress: string,
    signature: string,
    logs: string[],
    slot: number,
  ): void {
    // Check if this is a token swap/trade
    const isSwap = logs.some(
      (log) =>
        log.includes('Instruction: Transfer') ||
        log.includes('Instruction: TransferChecked') ||
        log.includes('Swap') ||
        log.includes('swap'),
    );

    if (!isSwap) return;

    // Fetch transaction details to determine buy/sell
    this.fetchTradeDetails(walletAddress, signature).catch((err) => {
      logger.debug(`[wallet-tracker] Error fetching trade: ${err}`);
    });
  }

  private async fetchTradeDetails(walletAddress: string, signature: string): Promise<void> {
    try {
      await new Promise((r) => setTimeout(r, 1000));

      const tx = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (!tx?.meta) return;

      const preBalances = tx.meta.preTokenBalances ?? [];
      const postBalances = tx.meta.postTokenBalances ?? [];

      // Find token changes for the tracked wallet
      const walletAccountIndex = tx.transaction.message.accountKeys.findIndex(
        (key: { pubkey?: { toBase58(): string }; toBase58?(): string }) => {
          const addr = key.pubkey ? key.pubkey.toBase58() : key.toBase58?.() ?? String(key);
          return addr === walletAddress;
        },
      );

      if (walletAccountIndex === -1) return;

      // Determine if buy or sell by checking SOL balance change
      const preSol = tx.meta.preBalances[walletAccountIndex] ?? 0;
      const postSol = tx.meta.postBalances[walletAccountIndex] ?? 0;
      const solChange = postSol - preSol;

      // Find the token that changed
      let tokenMint: string | undefined;
      for (const post of postBalances) {
        if (post.owner === walletAddress && post.mint !== WSOL_MINT.toBase58()) {
          tokenMint = post.mint;
          break;
        }
      }

      if (!tokenMint) return;

      const isBuy = solChange < 0; // SOL decreased = bought token

      const trade: WalletTrade = {
        walletAddress: new PublicKey(walletAddress),
        tokenMint: new PublicKey(tokenMint),
        type: isBuy ? 'buy' : 'sell',
        amount: Math.abs(solChange),
        txSignature: signature,
        timestamp: Date.now(),
      };

      const target = this.trackedWallets.get(walletAddress);
      logger.info(
        `[wallet-tracker] ${target?.label ?? walletAddress.slice(0, 8)} ${trade.type.toUpperCase()} ${tokenMint.slice(0, 8)}...`,
      );

      botEmitter.emit('walletTrade', trade);
    } catch {
      // Silently skip
    }
  }
}
