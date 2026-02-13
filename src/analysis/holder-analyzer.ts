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
  };
}
