import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type Connection,
} from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { JITO_TIP_ACCOUNTS } from '../constants.js';
import { getCachedBlockhash } from '../utils/blockhash-cache.js';

export interface TransactionOptions {
  computeUnitLimit: number;
  priorityFeeMicrolamports: number;
  jitoTipLamports?: number;
  feePayer: PublicKey;
}

/**
 * Builds optimized transactions with compute budget, priority fees,
 * and optional Jito tips.
 */
export class TransactionBuilder {
  constructor(private readonly connection: Connection) {}

  /**
   * Wraps instructions with compute budget + priority fee + optional Jito tip.
   */
  async buildTransaction(
    instructions: TransactionInstruction[],
    options: TransactionOptions,
  ): Promise<Transaction> {
    const tx = new Transaction();

    // Compute budget: set limit
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: options.computeUnitLimit,
      }),
    );

    // Compute budget: set priority fee
    tx.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: options.priorityFeeMicrolamports,
      }),
    );

    // Add main instructions
    for (const ix of instructions) {
      tx.add(ix);
    }

    // Optional Jito tip
    if (options.jitoTipLamports && options.jitoTipLamports > 0) {
      const tipAccount = this.getRandomTipAccount();
      tx.add(
        SystemProgram.transfer({
          fromPubkey: options.feePayer,
          toPubkey: tipAccount,
          lamports: options.jitoTipLamports,
        }),
      );
      logger.debug(`[tx-builder] Jito tip: ${options.jitoTipLamports} lamports -> ${tipAccount.toBase58().slice(0, 8)}...`);
    }

    // v8s: Set recent blockhash from pre-cache (0ms vs 100-300ms)
    const { blockhash } = await getCachedBlockhash(this.connection);
    tx.recentBlockhash = blockhash;
    tx.feePayer = options.feePayer;

    return tx;
  }

  /**
   * Gets a random Jito tip account for distributing tips.
   */
  private getRandomTipAccount(): PublicKey {
    const index = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
    return JITO_TIP_ACCOUNTS[index];
  }

  /**
   * Estimates the priority fee based on recent fees.
   */
  async estimatePriorityFee(writableAccounts: PublicKey[]): Promise<number> {
    try {
      const fees = await this.connection.getRecentPrioritizationFees({
        lockedWritableAccounts: writableAccounts,
      });

      if (fees.length === 0) return 50_000; // default

      // Use 75th percentile
      const sorted = fees
        .map((f) => f.prioritizationFee)
        .sort((a, b) => a - b);
      const p75Index = Math.floor(sorted.length * 0.75);
      return sorted[p75Index] || 50_000;
    } catch {
      return 50_000;
    }
  }
}
