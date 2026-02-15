import { type Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { withAnalysisRetry } from '../utils/analysis-rpc.js';

/**
 * v11n: Organic buyer checker — counts unique buyers on the pool in early lifecycle.
 *
 * Scam pattern: <2 unique buyers = coordinated launch with sybil wallets.
 * Organic tokens: 5+ unique buyers in the first 20 TXs.
 *
 * Uses getSignaturesForAddress on the pool (already fetched partially by observation),
 * then getParsedTransaction on a sample of TXs to extract signers.
 *
 * Cost: 1 RPC call (getSignaturesForAddress) + up to 5 getParsedTransaction calls.
 * Runs during observation window in parallel (0 extra latency).
 */

export interface OrganicBuyerResult {
  uniqueBuyers: number;       // Number of unique non-creator buyer addresses
  totalTxsSampled: number;    // Total TXs sampled
  buyerConcentration: number; // % of buys from the most active single buyer (0-100)
  bonus: number;              // Score bonus/penalty (-10 to +5)
  reason: string;
}

const EMPTY_RESULT: OrganicBuyerResult = {
  uniqueBuyers: 0,
  totalTxsSampled: 0,
  buyerConcentration: 0,
  bonus: 0,
  reason: 'no_data',
};

/**
 * Count unique organic buyers on a pool by sampling recent transactions.
 * Excludes the creator address from buyer count.
 */
export async function checkOrganicBuyers(
  connection: Connection,
  poolAddress: PublicKey,
  creatorAddress: string | null,
): Promise<OrganicBuyerResult> {
  try {
    // Step 1: Get recent transaction signatures on the pool
    const sigs = await withAnalysisRetry(
      (conn) => conn.getSignaturesForAddress(poolAddress, { limit: 20 }),
      connection,
    );

    if (sigs.length < 3) return EMPTY_RESULT;

    // Step 2: Parse a sample of TXs to extract signers (max 10 TXs for cost control)
    const sampleSigs = sigs.slice(0, 10);
    const txPromises = sampleSigs.map(sig =>
      withAnalysisRetry(
        (conn) => conn.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 }),
        connection,
      ).catch(() => null),
    );
    const txs = await Promise.all(txPromises);

    // Step 3: Extract unique signers (fee payers = actual users interacting with pool)
    const buyerCounts = new Map<string, number>(); // address → count of TXs

    for (const tx of txs) {
      if (!tx?.transaction?.message) continue;
      const signer = tx.transaction.message.accountKeys.find(k => k.signer)?.pubkey?.toBase58();
      if (!signer) continue;
      // Exclude creator — we want to count organic buyers, not the token creator
      if (signer === creatorAddress) continue;
      buyerCounts.set(signer, (buyerCounts.get(signer) ?? 0) + 1);
    }

    const uniqueBuyers = buyerCounts.size;
    const totalTxsSampled = txs.filter(t => t != null).length;

    // Step 4: Calculate buyer concentration (single most active buyer as % of total)
    let maxBuyerCount = 0;
    for (const count of buyerCounts.values()) {
      if (count > maxBuyerCount) maxBuyerCount = count;
    }
    const buyerConcentration = totalTxsSampled > 0
      ? (maxBuyerCount / totalTxsSampled) * 100
      : 0;

    // Step 5: Score
    let bonus = 0;
    let reason = 'clean';

    if (uniqueBuyers < 2) {
      bonus = -10;
      reason = `only_${uniqueBuyers}_unique_buyers`;
    } else if (uniqueBuyers < 3) {
      bonus = -5;
      reason = `low_${uniqueBuyers}_unique_buyers`;
    } else if (uniqueBuyers >= 5) {
      bonus = 5;
      reason = `organic_${uniqueBuyers}_unique_buyers`;
    }

    // Single buyer dominates >40% of TXs = suspicious (possible wash trading)
    if (buyerConcentration > 40 && uniqueBuyers >= 2) {
      bonus = Math.min(bonus, -5);
      reason = `high_concentration_${buyerConcentration.toFixed(0)}pct`;
    }

    const result: OrganicBuyerResult = {
      uniqueBuyers,
      totalTxsSampled,
      buyerConcentration,
      bonus,
      reason,
    };

    if (bonus !== 0) {
      logger.info(
        `[organic-buyers] ${poolAddress.toBase58().slice(0, 8)}...: ${uniqueBuyers} unique buyers in ${totalTxsSampled} TXs, concentration=${buyerConcentration.toFixed(0)}% → ${bonus > 0 ? '+' : ''}${bonus} (${reason})`,
      );
    } else {
      logger.debug(
        `[organic-buyers] ${poolAddress.toBase58().slice(0, 8)}...: ${uniqueBuyers} unique buyers in ${totalTxsSampled} TXs`,
      );
    }

    return result;
  } catch (err) {
    logger.debug(`[organic-buyers] Check failed for ${poolAddress.toBase58().slice(0, 8)}...: ${String(err)}`);
    return EMPTY_RESULT;
  }
}
