import { PublicKey, type Connection } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { botEmitter } from './event-emitter.js';
import { generateId, shortenAddress } from '../utils/helpers.js';
import { RAYDIUM_AMM_V4, WSOL_MINT, SYSTEM_PROGRAM, SYSVAR_RENT } from '../constants.js';
import { shouldSkipPoolParsing } from '../utils/analysis-rpc.js';
import type { DetectedPool } from '../types.js';
import type { WebSocketManager } from '../core/websocket-manager.js';

/**
 * Detects new Raydium AMM V4 pools by subscribing to program logs
 * and looking for the "initialize2" instruction.
 *
 * When a new pool is created on Raydium AMM V4, the initialize2 instruction
 * is called. We parse the log to extract pool info.
 */
export class PoolDetector {
  private isRunning = false;
  private processedSignatures = new Set<string>();

  constructor(
    private readonly getConnection: () => Connection,
    private readonly wsManager: WebSocketManager,
  ) {}

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    logger.info('[pool-detector] Starting Raydium AMM V4 pool detection...');

    await this.wsManager.subscribe(
      'raydium-amm-v4',
      RAYDIUM_AMM_V4,
      (logs, ctx) => {
        if (logs.err) return;
        this.processLogs(logs.signature, logs.logs, ctx.slot);
      },
    );

    logger.info('[pool-detector] Listening for new Raydium AMM V4 pools');
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    await this.wsManager.unsubscribe('raydium-amm-v4');
    logger.info('[pool-detector] Stopped');
  }

  private processLogs(signature: string, logs: string[], slot: number): void {
    // Early dedup: skip if we already processed this signature
    if (this.processedSignatures.has(signature)) return;
    this.processedSignatures.add(signature);

    // v11k: Lightweight cleanup — only when very large, and just clear entirely
    // At 45 msgs/s, reaches 5000 in ~2 min. Pool creations are rare (~1/min),
    // so clearing the whole set loses nothing meaningful.
    if (this.processedSignatures.size > 5000) {
      this.processedSignatures.clear();
    }

    // v11k: Use logs.some() instead of logs.join(' ') — avoids creating huge string on every callback (45 msgs/s)
    const hasInit = logs.some(
      (log) =>
        log.includes('initialize2') ||
        log.includes('InitializeInstruction2'),
    ) || logs.some(
      // Pool creation also involves initializing the LP mint
      (log) => log.includes('ray_log') && log.includes('InitializeMint'),
    );

    if (!hasInit) return;

    logger.info(`[pool-detector] Potential new Raydium pool! TX: ${signature.slice(0, 30)}...`);

    // We need to fetch the transaction to get full pool details
    this.fetchPoolDetails(signature, slot).catch((err) => {
      logger.error('[pool-detector] Error fetching pool details', { error: String(err) });
    });
  }

  private async fetchPoolDetails(signature: string, slot: number): Promise<void> {
    // v11f: Skip fetch during sell priority OR at max capacity — saves RPC for sells/monitoring
    if (shouldSkipPoolParsing()) {
      logger.debug(`[pool-detector] Skipping fetch (parsing paused): ${signature.slice(0, 16)}...`);
      return;
    }
    try {
      // Brief delay to ensure TX is indexed
      await new Promise((r) => setTimeout(r, 200));

      const fetchWithTimeout = (sig: string, timeoutMs = 10000) =>
        Promise.race([
          this.getConnection().getParsedTransaction(sig, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          }),
          new Promise<null>((_, reject) => setTimeout(() => reject(new Error('TX fetch timeout')), timeoutMs)),
        ]);

      let tx;
      try {
        tx = await fetchWithTimeout(signature);
      } catch (err) {
        const msg = String(err);
        if (msg.includes('429') || msg.includes('Too Many Requests')) {
          logger.warn(`[pool-detector] Rate limited, skipping TX: ${signature.slice(0, 20)}...`);
          return;
        }
        if (msg.includes('timeout')) {
          logger.warn(`[pool-detector] TX fetch timed out: ${signature.slice(0, 20)}...`);
        }
        // Fall through to retry
      }

      if (!tx?.meta || !tx.transaction) {
        // Retry once
        await new Promise((r) => setTimeout(r, 400));
        try {
          tx = await fetchWithTimeout(signature);
        } catch { /* ignore retry errors */ }
      }

      if (!tx?.meta || !tx.transaction) {
        logger.warn(`[pool-detector] Could not fetch TX: ${signature.slice(0, 20)}...`);
        return;
      }

      // Extract account keys from the transaction
      const accountKeys = tx.transaction.message.accountKeys.map((k) =>
        typeof k === 'object' && 'pubkey' in k ? k.pubkey : k,
      );

      // Find the Raydium AMM instruction
      const instructions = tx.transaction.message.instructions;
      const raydiumIx = instructions.find(
        (ix) => 'programId' in ix && ix.programId.equals(RAYDIUM_AMM_V4),
      );

      if (!raydiumIx || !('accounts' in raydiumIx)) {
        // Try inner instructions
        logger.info(`[pool-detector] No direct Raydium IX, checking inner instructions...`);
        return this.parseFromInnerInstructions(tx, signature, slot);
      }

      // Raydium AMM V4 initialize2 account layout:
      // [0] = tokenProgram, [1] = systemProgram, [2] = rent,
      // [3] = amm, [4] = ammAuthority, [5] = ammOpenOrders,
      // [6] = lpMint, [7] = coinMint, [8] = pcMint,
      // [9] = poolCoinToken, [10] = poolPcToken, ...
      const accounts = raydiumIx.accounts as PublicKey[];

      if (accounts.length < 11) {
        logger.warn('[pool-detector] Not enough accounts in Raydium IX');
        return;
      }

      const poolAddress = accounts[3]; // amm
      const lpMint = accounts[6];
      const baseMint = accounts[7]; // coinMint
      const quoteMint = accounts[8]; // pcMint

      // Validate that we have real PublicKeys, not System Program or Sysvars
      if (
        !poolAddress ||
        !baseMint ||
        !quoteMint ||
        baseMint.equals(SYSTEM_PROGRAM) ||
        quoteMint.equals(SYSTEM_PROGRAM) ||
        poolAddress.equals(SYSTEM_PROGRAM) ||
        poolAddress.equals(SYSVAR_RENT) ||
        poolAddress.toBase58().startsWith('Sysvar')
      ) {
        logger.debug(`[pool-detector] Invalid accounts - pool: ${poolAddress?.toBase58().slice(0,8) || 'null'}, base: ${baseMint?.toBase58().slice(0,8) || 'null'}`);
        return;
      }

      // Skip if not paired with SOL/WSOL
      if (!quoteMint.equals(WSOL_MINT) && !baseMint.equals(WSOL_MINT)) {
        logger.info(`[pool-detector] Skipping non-SOL pair: ${shortenAddress(baseMint)}/${shortenAddress(quoteMint)}`);
        return;
      }

      // Normalize: base = token, quote = SOL
      const isBaseSOL = baseMint.equals(WSOL_MINT);

      const pool: DetectedPool = {
        id: generateId(),
        source: 'raydium_amm_v4',
        poolAddress,
        baseMint: isBaseSOL ? quoteMint : baseMint,
        quoteMint: WSOL_MINT,
        baseDecimals: 0, // Will be resolved later
        quoteDecimals: 9,
        lpMint,
        detectedAt: Date.now(),
        slot,
        txSignature: signature,
      };

      logger.info(
        `[pool-detector] New pool: ${shortenAddress(pool.baseMint)}/SOL @ ${shortenAddress(pool.poolAddress)}`,
      );

      botEmitter.emit('newPool', pool);
    } catch (err) {
      logger.error('[pool-detector] Error parsing pool details', {
        error: String(err),
        signature,
      });
    }
  }

  private parseFromInnerInstructions(
    tx: Awaited<ReturnType<Connection['getParsedTransaction']>>,
    signature: string,
    slot: number,
  ): void {
    if (!tx?.meta?.innerInstructions) {
      logger.info(`[pool-detector] No inner instructions found in TX`);
      return;
    }

    for (const inner of tx.meta.innerInstructions) {
      for (const ix of inner.instructions) {
        if ('programId' in ix && ix.programId.equals(RAYDIUM_AMM_V4) && 'accounts' in ix) {
          const accounts = ix.accounts as PublicKey[];
          if (accounts.length >= 11) {
            const poolAddress = accounts[3];
            const baseMint = accounts[7];
            const quoteMint = accounts[8];

            // Validate that we have real PublicKeys, not System Program or Sysvars
            if (
              !poolAddress ||
              !baseMint ||
              !quoteMint ||
              baseMint.equals(SYSTEM_PROGRAM) ||
              quoteMint.equals(SYSTEM_PROGRAM) ||
              poolAddress.equals(SYSTEM_PROGRAM) ||
              poolAddress.equals(SYSVAR_RENT) ||
              poolAddress.toBase58().startsWith('Sysvar')
            ) {
              logger.debug('[pool-detector] Invalid accounts in inner instruction, skipping');
              continue;
            }

            // Skip if not paired with SOL/WSOL
            if (!quoteMint.equals(WSOL_MINT) && !baseMint.equals(WSOL_MINT)) {
              logger.debug('[pool-detector] Skipping non-SOL pair in inner instruction');
              continue;
            }

            // Normalize: base = token, quote = SOL
            const isBaseSOL = baseMint.equals(WSOL_MINT);

            const pool: DetectedPool = {
              id: generateId(),
              source: 'raydium_amm_v4',
              poolAddress,
              baseMint: isBaseSOL ? quoteMint : baseMint,
              quoteMint: WSOL_MINT,
              baseDecimals: 0,
              quoteDecimals: 9,
              detectedAt: Date.now(),
              slot,
              txSignature: signature,
            };

            logger.info(
              `[pool-detector] New pool (inner): ${shortenAddress(pool.baseMint)}/SOL @ ${shortenAddress(pool.poolAddress)}`,
            );

            botEmitter.emit('newPool', pool);
            return;
          }
        }
      }
    }
  }
}
