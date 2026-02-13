import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { WSOL_MINT } from '../constants.js';

export interface WalletAnalysis {
  address: string;
  totalTrades: number;
  buyTrades: number;
  sellTrades: number;
  estimatedPnl: number;
  uniqueTokens: number;
  avgHoldTime: number;
  recentActivity: boolean;
}

/**
 * Analyzes a wallet's historical trading performance.
 * Helps identify profitable wallets to copy.
 */
export async function analyzeWallet(
  connection: Connection,
  address: PublicKey,
  maxSignatures = 100,
): Promise<WalletAnalysis> {
  try {
    // Get recent transaction signatures
    const signatures = await connection.getSignaturesForAddress(address, {
      limit: maxSignatures,
    });

    if (signatures.length === 0) {
      return {
        address: address.toBase58(),
        totalTrades: 0,
        buyTrades: 0,
        sellTrades: 0,
        estimatedPnl: 0,
        uniqueTokens: 0,
        avgHoldTime: 0,
        recentActivity: false,
      };
    }

    let buyTrades = 0;
    let sellTrades = 0;
    const tokenMints = new Set<string>();
    let totalSolOut = 0;
    let totalSolIn = 0;

    // Analyze a sample of transactions
    const sampleSize = Math.min(20, signatures.length);
    const sampled = signatures.slice(0, sampleSize);

    for (const sig of sampled) {
      try {
        const tx = await connection.getParsedTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
        });

        if (!tx?.meta) continue;

        const accountKeys = tx.transaction.message.accountKeys;
        const walletIndex = accountKeys.findIndex(
          (key: { pubkey?: { toBase58(): string }; toBase58?(): string }) => {
            const addr = key.pubkey ? key.pubkey.toBase58() : key.toBase58?.() ?? String(key);
            return addr === address.toBase58();
          },
        );

        if (walletIndex === -1) continue;

        const preSol = tx.meta.preBalances[walletIndex] ?? 0;
        const postSol = tx.meta.postBalances[walletIndex] ?? 0;
        const solChange = (postSol - preSol) / 1e9;

        // Check token balances
        const postTokens = tx.meta.postTokenBalances ?? [];
        for (const tb of postTokens) {
          if (tb.owner === address.toBase58() && tb.mint !== WSOL_MINT.toBase58()) {
            tokenMints.add(tb.mint);
          }
        }

        if (solChange < -0.001) {
          buyTrades++;
          totalSolOut += Math.abs(solChange);
        } else if (solChange > 0.001) {
          sellTrades++;
          totalSolIn += solChange;
        }
      } catch {
        continue;
      }
    }

    // Scale estimates based on sample
    const scaleFactor = signatures.length / sampleSize;
    const estimatedPnl = totalSolIn - totalSolOut;
    const recentActivity =
      signatures[0]?.blockTime
        ? Date.now() / 1000 - signatures[0].blockTime < 86400 // Active in last 24h
        : false;

    return {
      address: address.toBase58(),
      totalTrades: Math.round((buyTrades + sellTrades) * scaleFactor),
      buyTrades: Math.round(buyTrades * scaleFactor),
      sellTrades: Math.round(sellTrades * scaleFactor),
      estimatedPnl,
      uniqueTokens: tokenMints.size,
      avgHoldTime: 0, // Would need more sophisticated analysis
      recentActivity,
    };
  } catch (err) {
    logger.error(`[wallet-analyzer] Failed to analyze ${address.toBase58()}`, {
      error: String(err),
    });
    return {
      address: address.toBase58(),
      totalTrades: 0,
      buyTrades: 0,
      sellTrades: 0,
      estimatedPnl: 0,
      uniqueTokens: 0,
      avgHoldTime: 0,
      recentActivity: false,
    };
  }
}
