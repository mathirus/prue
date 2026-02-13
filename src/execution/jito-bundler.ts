import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  type TransactionSignature,
} from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { JITO_TIP_ACCOUNTS } from '../constants.js';
import type { Wallet } from '../core/wallet.js';

/**
 * Jito bundle submission for MEV protection and fast inclusion.
 *
 * Bundles are atomic: all transactions succeed or all fail.
 * Tips incentivize validators to include the bundle.
 */
// Multiple Jito regions for redundancy
const JITO_REGIONS = {
  mainnet: 'https://mainnet.block-engine.jito.wtf',
  ny: 'https://ny.mainnet.block-engine.jito.wtf',
  amsterdam: 'https://amsterdam.mainnet.block-engine.jito.wtf',
  frankfurt: 'https://frankfurt.mainnet.block-engine.jito.wtf',
  tokyo: 'https://tokyo.mainnet.block-engine.jito.wtf',
};

export class JitoBundler {
  private blockEngineUrl: string;
  private useMultiRegion: boolean;

  constructor(
    private readonly connection: Connection,
    private readonly wallet: Wallet,
    blockEngineUrl: string,
    useMultiRegion: boolean = true,
  ) {
    this.blockEngineUrl = blockEngineUrl.replace(/\/$/, '');
    this.useMultiRegion = useMultiRegion;
  }

  /**
   * Sends a single transaction as a Jito bundle with tip.
   */
  async sendBundle(
    transaction: Transaction | VersionedTransaction,
    tipLamports: number,
  ): Promise<{ success: boolean; bundleId?: string; signature?: string; error?: string }> {
    try {
      // Create tip transaction
      const tipTx = await this.createTipTransaction(tipLamports);

      // Serialize transactions
      const serializedTxs: string[] = [];

      if (transaction instanceof VersionedTransaction) {
        transaction.sign([this.wallet.keypair]);
        serializedTxs.push(
          Buffer.from(transaction.serialize()).toString('base64'),
        );
      } else {
        transaction.sign(this.wallet.keypair);
        serializedTxs.push(
          transaction.serialize().toString('base64'),
        );
      }

      tipTx.sign(this.wallet.keypair);
      serializedTxs.push(tipTx.serialize().toString('base64'));

      // Submit bundle to multiple Jito regions simultaneously for better inclusion
      const regions = this.useMultiRegion
        ? ['ny', 'amsterdam', 'frankfurt'] as const
        : ['mainnet'] as const;

      const sendToRegion = async (region: keyof typeof JITO_REGIONS) => {
        const url = `${JITO_REGIONS[region]}/api/v1/bundles`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'sendBundle',
            params: [serializedTxs],
          }),
          signal: AbortSignal.timeout(5_000),
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = (await response.json()) as { error?: { message: string }; result?: string };
        if (result.error) throw new Error(result.error.message);
        return { region, bundleId: result.result };
      };

      // Send to all regions simultaneously
      const results = await Promise.allSettled(regions.map(sendToRegion));

      // Find first successful result
      let bundleId: string | undefined;
      let successRegion: string | undefined;

      for (const result of results) {
        if (result.status === 'fulfilled') {
          bundleId = result.value.bundleId;
          successRegion = result.value.region;
          break;
        }
      }

      if (!bundleId) {
        const errors = results
          .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
          .map((r) => r.reason)
          .join(', ');
        logger.error(`[jito] All regions failed: ${errors}`);
        return { success: false, error: errors };
      }

      logger.info(`[jito] Bundle ${bundleId} submitted via ${successRegion}`);

      // Wait for bundle confirmation
      if (bundleId) {
        const confirmed = await this.waitForBundle(bundleId);
        return {
          success: confirmed,
          bundleId,
        };
      }

      return { success: false, error: 'No bundle ID returned' };
    } catch (err) {
      logger.error('[jito] Bundle send failed', { error: String(err) });
      return { success: false, error: String(err) };
    }
  }

  private async createTipTransaction(tipLamports: number): Promise<Transaction> {
    const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: this.wallet.publicKey,
        toPubkey: tipAccount,
        lamports: tipLamports,
      }),
    );

    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.wallet.publicKey;

    return tx;
  }

  private async waitForBundle(bundleId: string, timeoutMs = 30_000): Promise<boolean> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const response = await fetch(`${this.blockEngineUrl}/api/v1/bundles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getBundleStatuses',
            params: [[bundleId]],
          }),
          signal: AbortSignal.timeout(5_000),
        });

        if (response.ok) {
          const result = (await response.json()) as {
            result?: {
              value: Array<{
                bundle_id: string;
                confirmation_status: string;
                err?: unknown;
              }>;
            };
          };

          const status = result.result?.value?.[0];
          if (status) {
            if (status.confirmation_status === 'confirmed' || status.confirmation_status === 'finalized') {
              logger.info(`[jito] Bundle confirmed: ${bundleId}`);
              return true;
            }
            if (status.err) {
              logger.error(`[jito] Bundle failed: ${JSON.stringify(status.err)}`);
              return false;
            }
          }
        }
      } catch {
        // Retry
      }

      await new Promise((r) => setTimeout(r, 2000));
    }

    logger.warn(`[jito] Bundle timeout: ${bundleId}`);
    return false;
  }
}
