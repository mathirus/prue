import { PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { JUPITER_API_BASE, WSOL_MINT } from '../constants.js';

export interface HoneypotResult {
  isHoneypot: boolean;
  honeypotVerified: boolean;
  buyQuoteOk: boolean;
  sellQuoteOk: boolean;
  buyPriceImpact: number;
  sellPriceImpact: number;
  error?: string;
}

/**
 * Detects honeypot tokens by simulating buy AND sell via Jupiter quotes.
 * A honeypot typically allows buying but blocks selling.
 */
export async function checkHoneypot(
  mintAddress: PublicKey,
  testAmountLamports = 100_000_000, // 0.1 SOL
): Promise<HoneypotResult> {
  const result: HoneypotResult = {
    isHoneypot: false,
    honeypotVerified: false,
    buyQuoteOk: false,
    sellQuoteOk: false,
    buyPriceImpact: 0,
    sellPriceImpact: 0,
  };

  try {
    // Step 1: Try to get a BUY quote (SOL -> Token)
    const buyQuote = await getJupiterQuote(
      WSOL_MINT.toBase58(),
      mintAddress.toBase58(),
      testAmountLamports,
    );

    if (buyQuote) {
      result.buyQuoteOk = true;
      result.buyPriceImpact = buyQuote.priceImpactPct;

      // Step 2: Try to get a SELL quote (Token -> SOL) using the output from buy
      const tokenAmount = parseInt(buyQuote.outAmount);
      if (tokenAmount > 0) {
        const sellQuote = await getJupiterQuote(
          mintAddress.toBase58(),
          WSOL_MINT.toBase58(),
          tokenAmount,
        );

        if (sellQuote) {
          result.sellQuoteOk = true;
          result.sellPriceImpact = sellQuote.priceImpactPct;
          result.honeypotVerified = true; // Both buy and sell routes exist
        } else {
          // Can buy but can't sell = honeypot
          result.isHoneypot = true;
          result.honeypotVerified = true; // Verified: can buy, can't sell
        }
      }
    } else {
      // Can't get a buy quote - could be no liquidity OR token too new for Jupiter
      // For newly migrated tokens, Jupiter won't have routes yet
      // Don't mark as honeypot, just note the issue
      result.isHoneypot = false; // Give benefit of doubt to new tokens
      result.error = 'No Jupiter route yet (token may be too new)';
      logger.debug(`[honeypot] No Jupiter route for ${mintAddress.toBase58().slice(0, 8)}... (likely too new)`);
    }

    // High sell price impact (>50%) is a soft honeypot indicator
    if (result.sellPriceImpact > 50) {
      result.isHoneypot = true;
      result.error = `Extreme sell price impact: ${result.sellPriceImpact}%`;
    }
  } catch (err) {
    logger.error(`[honeypot] Check failed for ${mintAddress.toBase58()}`, {
      error: String(err),
    });
    result.isHoneypot = true;
    result.error = String(err);
  }

  return result;
}

interface JupiterQuoteResponse {
  outAmount: string;
  priceImpactPct: number;
  routePlan: unknown[];
}

async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
): Promise<JupiterQuoteResponse | null> {
  try {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amount.toString(),
      slippageBps: '500',
      onlyDirectRoutes: 'false',
    });

    const response = await fetch(`${JUPITER_API_BASE}/quote?${params}`, {
      signal: AbortSignal.timeout(3_000), // 3s timeout for faster analysis
    });

    if (!response.ok) return null;

    const data = (await response.json()) as JupiterQuoteResponse;
    return data.routePlan?.length > 0 ? data : null;
  } catch {
    return null;
  }
}
