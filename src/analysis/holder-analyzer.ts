import { type Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { withAnalysisRetry } from '../utils/analysis-rpc.js';

export interface HolderAnalysis {
  topHolderPct: number;
  top5HoldersPct: number;
  top10HoldersPct: number;
  holderCount: number;
  holders: Array<{
    address: string;
    pct: number;
    amount: string;
  }>;
  // v11n: Herfindahl-Hirschman Index of non-pool holders (skip holders[0] = pool vault)
  // HHI > 0.25 = highly concentrated (DOJ antitrust threshold), > 0.5 = extreme
  // 0 extra RPC calls — computed from existing holders data
  holderHHI: number;
}

/**
 * v11n: Calculate Herfindahl-Hirschman Index for non-pool holders.
 * Skips holders[0] (pool vault, typically 80-97% of supply) and computes
 * HHI on the remaining holders' relative shares.
 * HHI = sum((share_i / total_non_pool)^2)
 * Range: 0 (perfectly distributed) to 1 (single holder has everything)
 * Thresholds: >0.25 = highly concentrated, >0.5 = extreme concentration
 */
export function computeNonPoolHHI(holders: Array<{ pct: number }>): number {
  if (holders.length <= 1) return 0; // Only pool vault or empty
  const nonPool = holders.slice(1); // Skip pool vault (holders[0])
  const totalNonPoolPct = nonPool.reduce((sum, h) => sum + h.pct, 0);
  if (totalNonPoolPct <= 0) return 0;
  // Normalize shares relative to non-pool total, then compute HHI
  return nonPool.reduce((sum, h) => {
    const share = h.pct / totalNonPoolPct;
    return sum + share * share;
  }, 0);
}

/**
 * Analyzes holder concentration using getTokenLargestAccounts.
 * High concentration = higher dump risk.
 * v8s: Uses free RPC rotation (Ankr/dRPC/Solana public) to avoid Helius 429s.
 */
export async function analyzeHolders(
  connection: Connection,
  mintAddress: PublicKey,
): Promise<HolderAnalysis> {
  try {
    // v8s: Try free RPCs first, fall back to Helius (primary) if all fail
    const largestAccounts = await withAnalysisRetry(
      (conn) => conn.getTokenLargestAccounts(mintAddress),
      connection,
    );

    if (!largestAccounts.value.length) {
      return {
        topHolderPct: 100,
        top5HoldersPct: 100,
        top10HoldersPct: 100,
        holderCount: 0,
        holders: [],
        holderHHI: 0,
      };
    }

    // Calculate total supply from all accounts
    const totalFromAccounts = largestAccounts.value.reduce(
      (sum, acc) => sum + Number(acc.uiAmount ?? 0),
      0,
    );

    if (totalFromAccounts === 0) {
      return {
        topHolderPct: 0,
        top5HoldersPct: 0,
        top10HoldersPct: 0,
        holderCount: largestAccounts.value.length,
        holders: [],
        holderHHI: 0,
      };
    }

    const holders = largestAccounts.value
      .filter((acc) => (acc.uiAmount ?? 0) > 0)
      .map((acc) => ({
        address: acc.address.toBase58(),
        pct: ((acc.uiAmount ?? 0) / totalFromAccounts) * 100,
        amount: acc.amount,
      }))
      .sort((a, b) => b.pct - a.pct);

    const topHolderPct = holders[0]?.pct ?? 0;
    const top5HoldersPct = holders.slice(0, 5).reduce((sum, h) => sum + h.pct, 0);
    const top10HoldersPct = holders.slice(0, 10).reduce((sum, h) => sum + h.pct, 0);

    return {
      topHolderPct,
      top5HoldersPct,
      top10HoldersPct,
      holderCount: holders.length,
      holders: holders.slice(0, 20), // Top 20
      holderHHI: computeNonPoolHHI(holders),
    };
  } catch (err) {
    const errStr = String(err);
    // Token-2022 tokens fail getTokenLargestAccounts - try Helius DAS fallback
    if (errStr.includes('not a Token mint') || errStr.includes('TokenInvalidAccountOwner')) {
      logger.debug(`[holders] Token-2022 detected for ${mintAddress.toBase58().slice(0, 8)}..., trying Helius DAS fallback...`);

      const rpcUrl = (connection as any)._rpcEndpoint as string | undefined;
      if (rpcUrl && rpcUrl.includes('helius')) {
        try {
          const dasResult = await fetchHeliusDasHolders(rpcUrl, mintAddress);
          if (dasResult) {
            logger.info(`[holders] DAS returned ${dasResult.holderCount} holders, top: ${dasResult.topHolderPct.toFixed(1)}%`);
            return dasResult;
          }
        } catch (dasErr) {
          logger.debug(`[holders] Helius DAS fallback failed: ${String(dasErr)}`);
        }
      }

      // Neutral fallback if DAS unavailable or fails
      return {
        topHolderPct: 30,
        top5HoldersPct: 70,
        top10HoldersPct: 85,
        holderCount: -1, // -1 signals "unknown"
        holders: [],
        holderHHI: 0,
      };
    }
    logger.error(`[holders] Analysis failed for ${mintAddress.toBase58()}`, {
      error: errStr,
    });
    return {
      topHolderPct: 100,
      top5HoldersPct: 100,
      top10HoldersPct: 100,
      holderCount: 0,
      holders: [],
      holderHHI: 0,
    };
  }
}

interface DasTokenAccount {
  owner: string;
  amount: number;
}

/**
 * Fetches token holders via Helius DAS getTokenAccounts API.
 * Works with both Token and Token-2022 programs.
 */
async function fetchHeliusDasHolders(
  rpcUrl: string,
  mintAddress: PublicKey,
): Promise<HolderAnalysis | null> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'holders',
      method: 'getTokenAccounts',
      params: {
        mint: mintAddress.toBase58(),
        limit: 20,
      },
    }),
    signal: AbortSignal.timeout(3_000),
  });

  const json = (await response.json()) as {
    result?: { token_accounts?: DasTokenAccount[] };
  };
  const accounts = json.result?.token_accounts;
  if (!accounts || accounts.length === 0) return null;

  const totalAmount = accounts.reduce((sum, acc) => sum + (acc.amount || 0), 0);
  if (totalAmount === 0) return null;

  const holders = accounts
    .filter((acc) => acc.amount > 0)
    .map((acc) => ({
      address: acc.owner,
      pct: (acc.amount / totalAmount) * 100,
      amount: String(acc.amount),
    }))
    .sort((a, b) => b.pct - a.pct);

  return {
    topHolderPct: holders[0]?.pct ?? 0,
    top5HoldersPct: holders.slice(0, 5).reduce((sum, h) => sum + h.pct, 0),
    top10HoldersPct: holders.slice(0, 10).reduce((sum, h) => sum + h.pct, 0),
    holderCount: holders.length,
    holders: holders.slice(0, 20),
    holderHHI: computeNonPoolHHI(holders),
  };
}
