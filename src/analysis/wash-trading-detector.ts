import { type Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { withAnalysisRetry } from '../utils/analysis-rpc.js';
import { getCachedBondingCurveSigs } from './bundle-detector.js';
import { PUMPFUN_PROGRAM } from '../constants.js';

export interface WashTradingResult {
  uniqueWallets: number;       // Unique wallets in sampled TXs
  totalTxsSampled: number;     // TXs analyzed
  walletConcentration: number; // % of TXs from top wallet (0-100)
  sameAmountRatio: number;     // % of buys with identical amount ±5% (0-100)
  penalty: number;             // 0 to -20
}

const EMPTY_RESULT: WashTradingResult = {
  uniqueWallets: 0,
  totalTxsSampled: 0,
  walletConcentration: 0,
  sameAmountRatio: 0,
  penalty: 0,
};

/**
 * Detect wash trading patterns on bonding curve transactions.
 *
 * Analyzes the 10 most recent bonding curve TXs (from bundle-detector cache)
 * to find:
 * 1. Wallet concentration: few wallets doing most TXs = coordinated
 * 2. Same-amount buys: identical SOL amounts = bot wash trading
 *
 * Speed: ~500ms (10 getParsedTransaction calls in parallel)
 * Cost: 10 RPC calls (only runs during observation window, net latency = 0)
 */
export async function checkWashTrading(
  connection: Connection,
  tokenMint: PublicKey,
): Promise<WashTradingResult> {
  try {
    // Get cached sigs from bundle-detector (0 extra RPC calls)
    let sigs = getCachedBondingCurveSigs(tokenMint.toBase58());

    // Fallback: fetch sigs if cache missed (expired or bundle check was skipped)
    if (!sigs) {
      const [bondingCurve] = PublicKey.findProgramAddressSync(
        [Buffer.from('bonding-curve'), tokenMint.toBuffer()],
        PUMPFUN_PROGRAM,
      );
      // v9k: Route through analysis RPC pool
      sigs = await withAnalysisRetry(
        (conn) => conn.getSignaturesForAddress(bondingCurve, { limit: 100 }),
        connection,
      );
    }

    if (!sigs || sigs.length < 5) {
      // Too few TXs to analyze wash trading patterns
      return EMPTY_RESULT;
    }

    // v9k: Reduced from 20→5 parallel TX fetches (saves 15 RPC calls per pool)
    // 5 TXs is enough to detect wash patterns (concentration + same-amount)
    const recentSigs = sigs.slice(0, 5);

    // Fetch parsed transactions in parallel via analysis RPC pool
    const txPromises = recentSigs.map(sig =>
      withAnalysisRetry(
        (conn) => conn.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 }),
        connection,
      ).catch(() => null),
    );

    const txs = await Promise.all(txPromises);

    // Extract signers and SOL transfer amounts
    const signerCounts = new Map<string, number>();
    const solAmounts: number[] = [];

    for (const tx of txs) {
      if (!tx?.transaction?.message) continue;

      // Signer = first account key that signed
      const accountKeys = tx.transaction.message.accountKeys;
      const signer = accountKeys.find(k => k.signer)?.pubkey?.toBase58();
      if (!signer) continue;

      signerCounts.set(signer, (signerCounts.get(signer) ?? 0) + 1);

      // Extract SOL amount from pre/postBalances delta of the signer
      const signerIndex = accountKeys.findIndex(k => k.pubkey?.toBase58() === signer);
      if (signerIndex >= 0 && tx.meta) {
        const preBal = tx.meta.preBalances[signerIndex];
        const postBal = tx.meta.postBalances[signerIndex];
        const delta = Math.abs(preBal - postBal);
        if (delta > 100_000) { // > 0.0001 SOL (ignore dust/fee-only TXs)
          solAmounts.push(delta);
        }
      }
    }

    const totalSampled = signerCounts.size > 0 ? Array.from(signerCounts.values()).reduce((a, b) => a + b, 0) : 0;

    if (totalSampled < 3) {
      return EMPTY_RESULT;
    }

    // Metric 1: Wallet concentration (top wallet's TX share)
    const uniqueWallets = signerCounts.size;
    const topWalletTxs = Math.max(...signerCounts.values());
    const walletConcentration = (topWalletTxs / totalSampled) * 100;

    // Metric 2: Same-amount ratio (group amounts within ±5%)
    let sameAmountRatio = 0;
    if (solAmounts.length >= 3) {
      // Group amounts within ±5% tolerance
      const amountGroups = new Map<number, number>();
      for (const amt of solAmounts) {
        let matched = false;
        for (const [groupAmt, count] of amountGroups) {
          if (Math.abs(amt - groupAmt) / groupAmt <= 0.05) {
            amountGroups.set(groupAmt, count + 1);
            matched = true;
            break;
          }
        }
        if (!matched) {
          amountGroups.set(amt, 1);
        }
      }

      // Largest group of same-amount buys
      const largestGroup = Math.max(...amountGroups.values());
      sameAmountRatio = (largestGroup / solAmounts.length) * 100;
    }

    // Calculate penalty (v8r: lowered thresholds from 70/50 → 50/30)
    // Old thresholds produced penalty=0 for ALL tokens (too high)
    let penalty = 0;
    if (walletConcentration >= 50) {
      penalty -= 10; // 50%+ TXs from same wallet = coordinated
    } else if (walletConcentration >= 40) {
      penalty -= 5;  // 40-49% = mild concentration signal
    }
    if (sameAmountRatio >= 30) {
      penalty -= 10; // 30%+ buys with identical amounts = bot wash trading
    }
    // Cap at -20
    penalty = Math.max(penalty, -20);

    const result: WashTradingResult = {
      uniqueWallets,
      totalTxsSampled: totalSampled,
      walletConcentration: Math.round(walletConcentration * 10) / 10,
      sameAmountRatio: Math.round(sameAmountRatio * 10) / 10,
      penalty,
    };

    logger.info(
      `[wash] ${tokenMint.toBase58().slice(0, 8)}...: wallets=${uniqueWallets}/${totalSampled} concentration=${result.walletConcentration}% sameAmount=${result.sameAmountRatio}% penalty=${penalty}`,
    );

    return result;
  } catch (err) {
    logger.debug(`[wash] Check failed for ${tokenMint.toBase58().slice(0, 8)}...: ${String(err)}`);
    return EMPTY_RESULT;
  }
}
