import { PublicKey, type Connection } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { botEmitter } from './event-emitter.js';
import { generateId, shortenAddress } from '../utils/helpers.js';
import {
  PUMPFUN_PROGRAM,
  PUMPFUN_MIGRATION_AUTHORITY,
  RAYDIUM_AMM_V4,
  PUMPSWAP_PROGRAM,
  PUMPSWAP_AMM,
  WSOL_MINT,
  SYSTEM_PROGRAM,
  SYSVAR_RENT,
  EXCLUDED_MINTS,
} from '../constants.js';
import { PumpSwapSwap } from '../execution/pumpswap-swap.js';
import type { DetectedPool } from '../types.js';
import type { WebSocketManager } from '../core/websocket-manager.js';

/**
 * Monitors pump.fun for token migrations (graduations).
 * When a token graduates from the bonding curve, it migrates to
 * either Raydium or PumpSwap. We detect both.
 */
export class PumpFunMonitor {
  private isRunning = false;
  private processedSignatures = new Set<string>();

  constructor(
    private readonly connection: Connection,
    private readonly wsManager: WebSocketManager,
  ) {}

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    logger.info('[pumpfun] Starting pump.fun migration monitor...');

    // Subscribe to pump.fun program logs
    await this.wsManager.subscribe(
      'pumpfun-migrations',
      PUMPFUN_PROGRAM,
      (logs, ctx) => {
        if (logs.err) return;
        this.processLogs(logs.signature, logs.logs, ctx.slot);
      },
    );

    logger.info('[pumpfun] Listening for pump.fun migrations');
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    await this.wsManager.unsubscribe('pumpfun-migrations');
    logger.info('[pumpfun] Stopped');
  }

  private processLogs(signature: string, logs: string[], slot: number): void {
    // Early dedup: skip if we already processed this signature
    if (this.processedSignatures.has(signature)) return;
    this.processedSignatures.add(signature);

    // Cleanup old signatures every 1000 entries
    if (this.processedSignatures.size > 1000) {
      const arr = Array.from(this.processedSignatures);
      this.processedSignatures = new Set(arr.slice(-500));
    }

    // Migration logs typically contain references to migration or withdraw
    const isMigration = logs.some(
      (log) =>
        log.includes('Program log: Instruction: Withdraw') ||
        log.includes('migrate') ||
        log.includes('Migration'),
    );

    if (!isMigration) return;

    // Check if this is a Raydium or PumpSwap migration
    const isRaydium = logs.some((log) => log.includes(RAYDIUM_AMM_V4.toBase58()));
    const isPumpSwap = logs.some(
      (log) => log.includes(PUMPSWAP_PROGRAM.toBase58()) || log.includes(PUMPSWAP_AMM.toBase58()),
    );

    if (!isRaydium && !isPumpSwap) return;

    // v9f: Skip PumpSwap migrations — PumpSwapMonitor already handles these.
    // Emitting from both monitors causes duplicate shadow positions.
    if (isPumpSwap) {
      logger.debug(`[pumpfun] PumpSwap migration detected, skipping (handled by PumpSwapMonitor): ${signature.slice(0, 16)}`);
      return;
    }

    const target = 'Raydium';
    logger.info(`[pumpfun] Migration detected -> ${target}! TX: ${signature}`);

    this.fetchMigrationDetails(signature, slot, isPumpSwap).catch((err) => {
      logger.error('[pumpfun] Error fetching migration details', { error: String(err) });
    });
  }

  private async fetchMigrationDetails(
    signature: string,
    slot: number,
    isPumpSwap: boolean,
  ): Promise<void> {
    try {
      // Brief delay to ensure TX is indexed, then retry once if not found
      await new Promise((r) => setTimeout(r, 100));

      const fetchWithTimeout = (sig: string, timeoutMs = 5000) =>
        Promise.race([
          this.connection.getParsedTransaction(sig, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          }),
          new Promise<null>((_, reject) => setTimeout(() => reject(new Error('TX fetch timeout')), timeoutMs)),
        ]);

      let tx;
      try {
        tx = await fetchWithTimeout(signature);
      } catch {
        // timeout or error, will retry below
      }

      if (!tx?.meta || !tx.transaction) {
        // Retry once after a short delay
        await new Promise((r) => setTimeout(r, 300));
        try {
          tx = await fetchWithTimeout(signature);
        } catch { /* ignore */ }
      }

      if (!tx?.meta || !tx.transaction) {
        logger.warn(`[pumpfun] Could not fetch TX: ${signature}`);
        return;
      }

      // Extract token mints from pre/post token balances
      const preBalances = tx.meta.preTokenBalances ?? [];
      const postBalances = tx.meta.postTokenBalances ?? [];

      // Find pump.fun tokens (exclude known stablecoins, SOL variants, etc.)
      const candidateMints: string[] = [];

      for (const bal of [...preBalances, ...postBalances]) {
        if (bal.mint && !EXCLUDED_MINTS.includes(bal.mint)) {
          candidateMints.push(bal.mint);
        }
      }

      if (candidateMints.length === 0) {
        logger.warn('[pumpfun] No valid token mint found in migration TX');
        return;
      }

      // Prefer tokens ending in "pump" (pump.fun token naming convention)
      // pump.fun tokens have addresses ending in "pump"
      let tokenMintStr = candidateMints.find(m => m.endsWith('pump'));

      // If no "pump" token found, use the first non-excluded mint
      if (!tokenMintStr) {
        // Filter out any that look like LP tokens (usually have specific patterns)
        tokenMintStr = candidateMints[0];
        logger.debug(`[pumpfun] No 'pump' suffix found, using first candidate: ${tokenMintStr.slice(0, 8)}...`);
      }

      const tokenMint = new PublicKey(tokenMintStr);

      // Final validation
      if (tokenMint.equals(SYSTEM_PROGRAM)) {
        logger.warn('[pumpfun] Invalid token mint (System Program), skipping');
        return;
      }

      // Find the pool address from inner instructions
      let poolAddress: PublicKey | undefined;

      if (tx.meta.innerInstructions) {
        const targetProgram = isPumpSwap ? PUMPSWAP_PROGRAM : RAYDIUM_AMM_V4;
        for (const inner of tx.meta.innerInstructions) {
          for (const ix of inner.instructions) {
            if ('programId' in ix && ix.programId.equals(targetProgram) && 'accounts' in ix) {
              const accounts = ix.accounts as PublicKey[];
              if (isPumpSwap && accounts.length >= 1) {
                poolAddress = accounts[0]; // Pool account is first in PumpSwap
              } else if (!isPumpSwap) {
                // Only match initialize2 (18 accounts, accounts[2]=SysvarRent) -> pool at accounts[3]
                // Note: migration router also calls Raydium with 8 accounts for intermediate swaps
                // (e.g. SOL→USDT routing), but those pools are NOT for the new token.
                // Only initialize2 creates the actual pool for the migrating token.
                if (accounts.length >= 15 && accounts[2] && accounts[2].equals(SYSVAR_RENT)) {
                  poolAddress = accounts[3];
                  logger.debug(`[pumpfun] Found initialize2 IX (${accounts.length} accts), pool=${poolAddress.toBase58().slice(0,8)}...`);
                }
              }
              if (poolAddress) break;
            }
          }
          if (poolAddress) break;
        }
      }

      // If pool address not found, we can't do Raydium direct swap.
      // Since March 2025, most pump.fun tokens migrate to PumpSwap, not Raydium.
      // The migration router may reference Raydium for intermediate swaps,
      // but the actual token pool is on PumpSwap AMM.
      const hasValidRaydiumPool = !!poolAddress && !poolAddress.equals(tokenMint);

      // If no Raydium pool found but migration detected → it's a PumpSwap token
      const effectiveSource = isPumpSwap
        ? 'pumpswap'
        : hasValidRaydiumPool
          ? 'raydium_amm_v4'
          : 'pumpswap'; // Default to pumpswap for unresolved migrations

      // v9f: Skip ALL PumpSwap-destined pools — PumpSwapMonitor handles them.
      // This prevents duplicate shadow positions from two monitors detecting the same TX.
      if (effectiveSource === 'pumpswap') {
        logger.debug(`[pumpfun] PumpSwap pool skipped (handled by PumpSwapMonitor): ${tokenMintStr.slice(0, 8)}`);
        return;
      }

      const pool: DetectedPool = {
        id: generateId(),
        source: effectiveSource,
        poolAddress: poolAddress ?? tokenMint,
        baseMint: tokenMint,
        quoteMint: WSOL_MINT,
        baseDecimals: 6, // pump.fun tokens are 6 decimals
        quoteDecimals: 9,
        detectedAt: Date.now(),
        slot,
        txSignature: signature,
      };

      logger.info(
        `[pumpfun] Migration: ${shortenAddress(pool.baseMint)}/SOL -> Raydium`,
      );

      botEmitter.emit('migration', pool);
      botEmitter.emit('newPool', pool);
    } catch (err) {
      logger.error('[pumpfun] Error parsing migration', {
        error: String(err),
        signature,
      });
    }
  }
}
