import { type Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { WSOL_MINT } from '../constants.js';
import { withAnalysisRetry } from '../utils/analysis-rpc.js';

export interface LiquidityResult {
  liquiditySol: number;
  liquidityUsd: number;
  poolSolBalance: number;
  poolTokenBalance: number;
}

/**
 * Checks liquidity of a pool by examining SOL reserves.
 * v8t: Uses analysis RPC pool to avoid 429s on Helius primary.
 */
export async function checkLiquidity(
  connection: Connection,
  poolAddress: PublicKey,
  quoteMint: PublicKey = WSOL_MINT,
): Promise<LiquidityResult> {
  try {
    // v8t: Use analysis RPC rotation to avoid 429s on primary Helius
    const { poolSolBalance, poolTokenBalance } = await withAnalysisRetry(async (conn) => {
      const tokenAccounts = await conn.getParsedTokenAccountsByOwner(poolAddress, {
        programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      });

      let solBal = 0;
      let tokenBal = 0;

      for (const { account } of tokenAccounts.value) {
        const parsed = account.data.parsed;
        const mint = parsed.info.mint;
        const amount = parsed.info.tokenAmount.uiAmount ?? 0;

        if (mint === quoteMint.toBase58()) {
          solBal = amount;
        } else {
          tokenBal = amount;
        }
      }

      const nativeBalance = await conn.getBalance(poolAddress);
      const nativeSol = nativeBalance / LAMPORTS_PER_SOL;

      return { poolSolBalance: solBal + nativeSol, poolTokenBalance: tokenBal };
    }, connection);

    // Estimate USD (rough SOL price fetch)
    const solPriceUsd = await getSolPrice();
    const liquidityUsd = poolSolBalance * solPriceUsd;

    return {
      liquiditySol: poolSolBalance,
      liquidityUsd,
      poolSolBalance,
      poolTokenBalance,
    };
  } catch (err) {
    logger.error(`[liquidity] Check failed for ${poolAddress.toBase58()}`, {
      error: String(err),
    });
    return {
      liquiditySol: 0,
      liquidityUsd: 0,
      poolSolBalance: 0,
      poolTokenBalance: 0,
    };
  }
}

let cachedSolPrice = 0;
let priceLastFetched = 0;
const PRICE_CACHE_MS = 60_000;

async function getSolPrice(): Promise<number> {
  if (cachedSolPrice > 0 && Date.now() - priceLastFetched < PRICE_CACHE_MS) {
    return cachedSolPrice;
  }

  try {
    const response = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      { signal: AbortSignal.timeout(5_000) },
    );

    if (response.ok) {
      const data = (await response.json()) as { solana: { usd: number } };
      cachedSolPrice = data.solana.usd;
      priceLastFetched = Date.now();
      return cachedSolPrice;
    }
  } catch {
    // Fallback price
  }

  return cachedSolPrice || 150; // Fallback
}
