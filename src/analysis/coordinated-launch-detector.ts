import { type Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { withAnalysisRetry } from '../utils/analysis-rpc.js';
import { getCachedBondingCurveSigs } from './bundle-detector.js';
import { PUMPFUN_PROGRAM } from '../constants.js';

export interface CoordinatedLaunchResult {
  buyerCount: number;         // Number of unique buyers analyzed
  sharedFunderCount: number;  // Buyers sharing funder with creator
  selfBuyDetected: boolean;   // Creator bought their own bonding curve
  penalty: number;            // 0 to -20
  reason: string;
}

const EMPTY_RESULT: CoordinatedLaunchResult = {
  buyerCount: 0,
  sharedFunderCount: 0,
  selfBuyDetected: false,
  penalty: 0,
  reason: 'no_data',
};

/**
 * Trace who funded a wallet by looking at its oldest transaction.
 * Same logic as creator-deep-checker.ts traceFundingSource, but exported.
 */
async function traceBuyerFunder(
  connection: Connection,
  walletAddress: string,
): Promise<string | null> {
  try {
    const pubkey = new PublicKey(walletAddress);
    const sigs = await withAnalysisRetry(
      (conn) => conn.getSignaturesForAddress(pubkey, { limit: 3 }),
      connection,
    );
    if (sigs.length === 0) return null;

    const oldestSig = sigs[sigs.length - 1].signature;
    const tx = await withAnalysisRetry(
      (conn) => conn.getParsedTransaction(oldestSig, { maxSupportedTransactionVersion: 0 }),
      connection,
    );
    if (!tx?.meta || !tx.transaction.message.accountKeys) return null;

    const accountKeys = tx.transaction.message.accountKeys.map(k =>
      typeof k === 'string' ? k : k.pubkey.toBase58(),
    );
    const preBalances = tx.meta.preBalances;
    const postBalances = tx.meta.postBalances;

    let maxDrop = 0;
    let funderIndex = -1;
    for (let i = 0; i < accountKeys.length; i++) {
      if (accountKeys[i] === walletAddress) continue;
      const drop = preBalances[i] - postBalances[i];
      if (drop > maxDrop) {
        maxDrop = drop;
        funderIndex = i;
      }
    }

    if (funderIndex >= 0 && maxDrop > 10000) {
      return accountKeys[funderIndex];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * v11m: Detect coordinated launches by analyzing bonding curve buyers' funding sources.
 *
 * Scam pattern: creator + sybil wallets all funded by the same source buy the
 * bonding curve to force graduation, then rug on PumpSwap.
 *
 * Checks:
 * 1. Self-buy: creator is one of the bonding curve buyers (-15 penalty)
 * 2. Shared funder: 2+ buyers share funding source with creator (-10 penalty)
 *
 * Cost: 2 RPC calls per unique buyer (getSignaturesForAddress + getParsedTransaction)
 * Max: 10 RPC calls for 5 buyers. Runs in parallel during observation window (0 extra latency).
 */
export async function checkCoordinatedLaunch(
  connection: Connection,
  tokenMint: PublicKey,
  creatorAddress: string | null,
  creatorFundingSource: string | null,
): Promise<CoordinatedLaunchResult> {
  if (!creatorAddress) return EMPTY_RESULT;

  try {
    // Get bonding curve sigs (from bundle-detector cache, 0 extra RPC)
    let sigs = getCachedBondingCurveSigs(tokenMint.toBase58());
    if (!sigs) {
      const [bondingCurve] = PublicKey.findProgramAddressSync(
        [Buffer.from('bonding-curve'), tokenMint.toBuffer()],
        PUMPFUN_PROGRAM,
      );
      sigs = await withAnalysisRetry(
        (conn) => conn.getSignaturesForAddress(bondingCurve, { limit: 20 }),
        connection,
      );
    }

    if (!sigs || sigs.length < 3) return EMPTY_RESULT;

    // Parse first 5 TXs to extract buyer addresses
    const recentSigs = sigs.slice(0, 5);
    const txPromises = recentSigs.map(sig =>
      withAnalysisRetry(
        (conn) => conn.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 }),
        connection,
      ).catch(() => null),
    );
    const txs = await Promise.all(txPromises);

    // Extract unique buyer addresses (signers)
    const buyers = new Set<string>();
    for (const tx of txs) {
      if (!tx?.transaction?.message) continue;
      const signer = tx.transaction.message.accountKeys.find(k => k.signer)?.pubkey?.toBase58();
      if (signer && signer !== creatorAddress) {
        buyers.add(signer);
      }
    }

    // Check 1: Self-buy (creator is a bonding curve buyer)
    let selfBuy = false;
    for (const tx of txs) {
      if (!tx?.transaction?.message) continue;
      const signer = tx.transaction.message.accountKeys.find(k => k.signer)?.pubkey?.toBase58();
      if (signer === creatorAddress) {
        selfBuy = true;
        break;
      }
    }

    if (buyers.size === 0) {
      if (selfBuy) {
        return {
          buyerCount: 0,
          sharedFunderCount: 0,
          selfBuyDetected: true,
          penalty: -15,
          reason: 'creator_self_buy',
        };
      }
      return EMPTY_RESULT;
    }

    // Check 2: Trace funding sources of first 5 unique buyers (in parallel)
    // Only trace if we know the creator's funding source
    let sharedFunderCount = 0;
    if (creatorFundingSource) {
      const buyerArray = Array.from(buyers).slice(0, 5);
      const funderPromises = buyerArray.map(buyer =>
        traceBuyerFunder(connection, buyer).catch(() => null),
      );
      const funderResults = await Promise.all(funderPromises);

      for (const funder of funderResults) {
        if (funder && funder === creatorFundingSource) {
          sharedFunderCount++;
        }
      }
    }

    // Calculate penalty
    let penalty = 0;
    let reason = 'clean';

    if (selfBuy) {
      penalty -= 15;
      reason = 'creator_self_buy';
    }

    if (sharedFunderCount >= 2) {
      penalty -= 10;
      reason = selfBuy ? 'self_buy_and_coordinated' : `coordinated_${sharedFunderCount}_shared_funder`;
    } else if (sharedFunderCount === 1) {
      penalty -= 5;
      reason = selfBuy ? 'self_buy_and_1_shared' : '1_shared_funder';
    }

    penalty = Math.max(penalty, -20);

    const result: CoordinatedLaunchResult = {
      buyerCount: buyers.size,
      sharedFunderCount,
      selfBuyDetected: selfBuy,
      penalty,
      reason,
    };

    if (penalty < 0) {
      logger.warn(
        `[coordinated] ${tokenMint.toBase58().slice(0, 8)}...: buyers=${buyers.size} sharedFunder=${sharedFunderCount} selfBuy=${selfBuy} penalty=${penalty} (${reason})`,
      );
    } else {
      logger.debug(
        `[coordinated] ${tokenMint.toBase58().slice(0, 8)}...: buyers=${buyers.size} sharedFunder=${sharedFunderCount} clean`,
      );
    }

    return result;
  } catch (err) {
    logger.debug(`[coordinated] Check failed for ${tokenMint.toBase58().slice(0, 8)}...: ${String(err)}`);
    return EMPTY_RESULT;
  }
}
