import {
  Connection,
  PublicKey,
  VersionedTransaction,
  type TransactionSignature,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { logger } from '../utils/logger.js';
import { JUPITER_API_BASE, WSOL_MINT } from '../constants.js';
import type { Wallet } from '../core/wallet.js';
import type { TradeOrder, TradeResult } from '../types.js';
import { pollConfirmation } from '../utils/confirm-tx.js';

// Jito endpoints for bundle submission
const JITO_TX_ENDPOINTS = [
  'https://mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true',
  'https://ny.mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true',
  'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true',
  'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true',
  'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true',
];

// v11g: Helius Sender URL (staked connections, SWQOS-only)
let _jupSenderUrl: string | null | undefined;
function getJupSenderUrl(): string | null {
  if (_jupSenderUrl === undefined) {
    let key = process.env.HELIUS_API_KEY;
    if (!key) {
      const rpcUrl = process.env.RPC_URL || '';
      const match = rpcUrl.match(/api-key=([a-f0-9-]+)/i);
      if (match) key = match[1];
    }
    _jupSenderUrl = key ? `https://sender.helius-rpc.com/fast?api-key=${key}&swqos_only=true` : null;
    if (_jupSenderUrl) logger.info(`[jupiter] Helius Sender endpoint configured`);
  }
  return _jupSenderUrl;
}

interface JupiterQuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: unknown[];
  otherAmountThreshold: string;
}

interface JupiterSwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
}

export class JupiterSwap {
  private static readonly MAX_RETRIES = 3;
  private static readonly RETRY_DELAY_MS = 500;

  constructor(
    private readonly connection: Connection,
    private readonly wallet: Wallet,
  ) {}

  async getQuote(
    inputMint: PublicKey,
    outputMint: PublicKey,
    amountIn: number,
    slippageBps: number,
  ): Promise<JupiterQuoteResponse | null> {
    const params = new URLSearchParams({
      inputMint: inputMint.toBase58(),
      outputMint: outputMint.toBase58(),
      amount: amountIn.toString(),
      slippageBps: slippageBps.toString(),
      onlyDirectRoutes: 'false',
      asLegacyTransaction: 'false',
    });

    // Retry logic with exponential backoff
    for (let attempt = 1; attempt <= JupiterSwap.MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(`${JUPITER_API_BASE}/quote?${params}`, {
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
          logger.warn(`[jupiter] Quote failed (attempt ${attempt}): HTTP ${response.status}`);
          if (attempt < JupiterSwap.MAX_RETRIES) {
            await this.delay(JupiterSwap.RETRY_DELAY_MS * attempt);
            continue;
          }
          return null;
        }

        return (await response.json()) as JupiterQuoteResponse;
      } catch (err) {
        logger.warn(`[jupiter] Quote error (attempt ${attempt}/${JupiterSwap.MAX_RETRIES}): ${String(err)}`);
        if (attempt < JupiterSwap.MAX_RETRIES) {
          await this.delay(JupiterSwap.RETRY_DELAY_MS * attempt);
          continue;
        }
        logger.error('[jupiter] Quote failed after all retries');
        return null;
      }
    }
    return null;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async executeSwap(order: TradeOrder): Promise<TradeResult> {
    const startTime = Date.now();

    try {
      // Step 1: Get quote
      const quote = await this.getQuote(
        order.inputMint,
        order.outputMint,
        order.amountIn,
        order.slippageBps,
      );

      if (!quote) {
        return {
          success: false,
          inputAmount: order.amountIn,
          outputAmount: 0,
          pricePerToken: 0,
          fee: 0,
          timestamp: Date.now(),
          error: 'Failed to get Jupiter quote',
        };
      }

      // Calculate slippage tolerance from quote
      const expectedOut = parseInt(quote.outAmount);
      const minOut = parseInt(quote.otherAmountThreshold);
      const slippagePct = ((expectedOut - minOut) / expectedOut * 100).toFixed(2);

      logger.info(
        `[jupiter] Quote: ${quote.inAmount} -> ${quote.outAmount} (impact: ${quote.priceImpactPct}%, slippage tolerance: ${slippagePct}%, min: ${minOut})`,
      );

      // Step 2: Get swap transaction
      // IMPORTANT: Do NOT use autoSlippage - it overrides our configured slippage (95%)
      // with a maximum of maxAutoSlippageBps, causing 6014 errors on volatile tokens
      const swapResponse = await fetch(`${JUPITER_API_BASE}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: this.wallet.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 'auto',
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!swapResponse.ok) {
        const errorText = await swapResponse.text();
        return {
          success: false,
          inputAmount: order.amountIn,
          outputAmount: 0,
          pricePerToken: 0,
          fee: 0,
          timestamp: Date.now(),
          error: `Swap API error: ${errorText}`,
        };
      }

      const swapData = (await swapResponse.json()) as JupiterSwapResponse;

      // Step 3: Deserialize and sign transaction
      const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
      transaction.sign([this.wallet.keypair]);

      // PROTECTION: Simulate before sending (FREE - catches errors without burning fees)
      const simResult = await this.connection.simulateTransaction(transaction);
      if (simResult.value.err) {
        const simError = JSON.stringify(simResult.value.err);
        logger.warn(`[jupiter] Simulation FAILED (saved fees): ${simError}`);
        return {
          success: false, inputAmount: order.amountIn, outputAmount: 0,
          pricePerToken: 0, fee: 0, timestamp: Date.now(),
          error: `Simulation failed: ${simError}`,
        };
      }

      // Step 4: Send transaction
      const signature = await this.sendAndConfirmTransaction(
        transaction,
        swapData.lastValidBlockHeight,
      );

      const outputAmount = parseInt(quote.outAmount);
      const inputAmount = parseInt(quote.inAmount);

      // Calculate price per token
      const isBuy = order.inputMint.equals(WSOL_MINT);
      const pricePerToken = isBuy
        ? (inputAmount / 1e9) / outputAmount   // SOL per base unit
        : (outputAmount / 1e9) / inputAmount;  // SOL per base unit

      return {
        success: true,
        txSignature: signature,
        inputAmount,
        outputAmount,
        pricePerToken,
        fee: 0,
        timestamp: Date.now(),
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : JSON.stringify(err);
      logger.error('[jupiter] Swap failed', { error: errorMsg });
      return {
        success: false,
        inputAmount: order.amountIn,
        outputAmount: 0,
        pricePerToken: 0,
        fee: 0,
        timestamp: Date.now(),
        error: errorMsg,
      };
    }
  }

  private async sendAndConfirmTransaction(
    transaction: VersionedTransaction,
    lastValidBlockHeight: number,
  ): Promise<TransactionSignature> {
    const rawTransaction = transaction.serialize();
    const base58Tx = bs58.encode(rawTransaction);
    // Extract blockhash from transaction for confirmation
    const blockhash = transaction.message.recentBlockhash;

    // Send to multiple endpoints simultaneously for maximum inclusion probability
    const sendPromises: Promise<string | null>[] = [];

    // 1. Send via primary RPC
    sendPromises.push(
      this.connection
        .sendRawTransaction(rawTransaction, { skipPreflight: true, maxRetries: 0 })
        .catch((e) => {
          logger.debug(`[jupiter] Primary RPC failed: ${e.message}`);
          return null;
        }),
    );

    // 2. Send via Jito endpoints (MEV protected)
    for (const jitoUrl of JITO_TX_ENDPOINTS) {
      sendPromises.push(
        fetch(jitoUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'sendTransaction',
            params: [base58Tx, { encoding: 'base58' }],
          }),
          signal: AbortSignal.timeout(3000),
        })
          .then(async (res) => {
            const data = (await res.json()) as { error?: { message: string }; result?: string };
            if (data.error) throw new Error(data.error.message);
            return data.result as string;
          })
          .catch((e) => {
            logger.debug(`[jupiter] Jito endpoint failed: ${e.message}`);
            return null;
          }),
      );
    }

    // 3. v11g: Send via Helius Sender (staked connections)
    const senderUrl = getJupSenderUrl();
    if (senderUrl) {
      const base64Tx = Buffer.from(rawTransaction).toString('base64');
      sendPromises.push(
        fetch(senderUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'sendTransaction',
            params: [base64Tx, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }],
          }),
          signal: AbortSignal.timeout(3000),
        })
          .then(async (res) => {
            const data = (await res.json()) as { error?: { message: string }; result?: string };
            if (data.error) throw new Error(data.error.message);
            logger.info(`[jupiter] Sender endpoint success`);
            return data.result as string;
          })
          .catch((e) => {
            logger.debug(`[jupiter] Sender endpoint failed: ${e.message}`);
            return null;
          }),
      );
    }

    // Wait for all sends to complete
    const results = await Promise.all(sendPromises);
    const successfulSigs = results.filter((r): r is string => r !== null);

    if (successfulSigs.length === 0) {
      throw new Error('All send endpoints failed');
    }

    const signature = successfulSigs[0];
    logger.info(`[jupiter] TX sent to ${successfulSigs.length} endpoints: ${signature}`);

    // v11k: 25s timeout (was 10s). During Solana congestion, TXs land in 15-25s.
    // 10s was too aggressive — caused false "sell failed" when TX actually landed.
    const pollResult = await pollConfirmation(signature, this.connection, 25_000, 1_000);
    if (!pollResult.confirmed) {
      throw new Error(`TX confirmation error: ${pollResult.error ?? 'Polling timeout (25s)'}`);
    }

    logger.info(`[jupiter] TX confirmed: ${signature}`);
    return signature;
  }
}
