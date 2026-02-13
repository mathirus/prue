import { type Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { withAnalysisRetry } from '../utils/analysis-rpc.js';

export interface CreatorAgeResult {
  txCount: number;
  walletAgeSeconds: number;
  isNewWallet: boolean;   // < 1 hour old
  isSuspicious: boolean;  // Likely throwaway deployer wallet
}

/**
 * Checks the age and activity of a creator wallet.
 * Serial deployers typically use fresh wallets with very few transactions.
 *
 * Data shows:
 * - 98.6% of pump.fun tokens are scams (Solidus Labs)
 * - Serial deployers recycle wallets or use new ones per batch
 * - A wallet with < 5 transactions that is < 1 hour old is almost certainly a throwaway
 */
export async function checkCreatorWalletAge(
  connection: Connection,
  creatorAddress: string,
): Promise<CreatorAgeResult> {
  try {
    const pubkey = new PublicKey(creatorAddress);

    // Get recent signatures - limit 10 is enough to determine if wallet has history
    // If we get 10 results, the wallet has >= 10 txs (has history)
    // If we get < 10 results, we see ALL their transactions
    // v9k: Route through analysis RPC pool
    const sigs = await withAnalysisRetry(
      (conn) => conn.getSignaturesForAddress(pubkey, { limit: 10 }),
      connection,
    );

    if (sigs.length === 0) {
      logger.warn(`[creator-age] ${creatorAddress.slice(0, 8)}... NO transactions - brand new wallet`);
      return { txCount: 0, walletAgeSeconds: 0, isNewWallet: true, isSuspicious: true };
    }

    // Oldest visible signature gives lower bound on wallet age
    const oldest = sigs[sigs.length - 1];
    const now = Math.floor(Date.now() / 1000);
    const walletAgeSeconds = oldest.blockTime ? now - oldest.blockTime : 0;
    const txCount = sigs.length;

    // Heuristics based on research:
    // - throwaway wallets: < 5 txs AND < 1 hour old
    // - suspicious: < 3 txs regardless of age (wallet just for deploying)
    // - 10+ txs: has meaningful history (limit reached = at least 10)
    const isSuspicious =
      (txCount < 5 && walletAgeSeconds < 3600) ||   // < 5 txs, < 1 hour
      (txCount < 3 && walletAgeSeconds < 86400);     // < 3 txs, < 24 hours

    const ageStr = walletAgeSeconds > 86400
      ? `${(walletAgeSeconds / 86400).toFixed(1)}d`
      : walletAgeSeconds > 3600
        ? `${(walletAgeSeconds / 3600).toFixed(1)}h`
        : `${Math.round(walletAgeSeconds)}s`;

    logger.info(
      `[creator-age] ${creatorAddress.slice(0, 8)}... age=${ageStr} txs=${txCount}${txCount >= 10 ? '+' : ''} ${isSuspicious ? '⚠️ SUSPICIOUS' : '✓ OK'}`,
    );

    return {
      txCount,
      walletAgeSeconds,
      isNewWallet: walletAgeSeconds < 3600,
      isSuspicious,
    };
  } catch (err) {
    // On error, don't block the trade - return neutral result
    logger.debug(`[creator-age] Check failed for ${creatorAddress.slice(0, 8)}...: ${err}`);
    return { txCount: -1, walletAgeSeconds: -1, isNewWallet: false, isSuspicious: false };
  }
}
