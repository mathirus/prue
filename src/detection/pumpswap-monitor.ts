import { PublicKey, type Connection } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { botEmitter } from './event-emitter.js';
import { generateId, shortenAddress } from '../utils/helpers.js';
import { PUMPSWAP_AMM, WSOL_MINT, SYSTEM_PROGRAM } from '../constants.js';
import { withAnalysisRetry, shouldSkipPoolParsing } from '../utils/analysis-rpc.js';
import type { DetectedPool } from '../types.js';
import type { WebSocketManager } from '../core/websocket-manager.js';

/**
 * Monitors PumpSwap for new pool creations directly (not via pump.fun migration).
 * PumpSwap is pump.fun's own AMM that replaces Raydium for graduated tokens.
 */
export class PumpSwapMonitor {
  private isRunning = false;
  private processedSignatures = new Map<string, number>(); // sig → timestamp
  private emittedPoolAddresses = new Set<string>(); // Extra dedup layer by pool address
  // Extra dedup: track last N signatures with timestamps for diagnosis
  private recentSignatures = new Map<string, number>();
  // v9f: Time-based cleanup instead of size-based (PumpSwap processes hundreds of swaps/sec)
  private static readonly DEDUP_RETENTION_MS = 30 * 60 * 1000; // 30 minutes
  // v9m: Silent dedup counter — replaces per-event warn with periodic summary
  private dedupCount = 0;
  private lastDedupLog = Date.now();
  // v9x: Semaphore — max 2 concurrent fetchPoolDetails to prevent self-DDoS on RPCs
  private activeFetches = 0;
  private static readonly MAX_CONCURRENT_FETCHES = 2;
  private fetchQueue: Array<{ signature: string; slot: number; resolve: () => void }> = [];

  constructor(
    private readonly connection: Connection,
    private readonly wsManager: WebSocketManager,
  ) {}

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    logger.info('[pumpswap] Starting PumpSwap pool detection...');

    await this.wsManager.subscribe(
      'pumpswap-pools',
      PUMPSWAP_AMM,
      (logs, ctx) => {
        if (logs.err) return;
        // ULTRA-DEDUP: Check at the very first point of entry
        const sig = String(logs.signature); // Force string coercion
        const now = Date.now();
        if (this.recentSignatures.has(sig)) {
          // v9m: Silent counter instead of per-event warn (3815 warnings in v9l)
          this.dedupCount++;
          if (now - this.lastDedupLog > 60_000 && this.dedupCount > 0) {
            logger.info(`[pumpswap] DEDUP: ${this.dedupCount} duplicates filtered in last 60s`);
            this.dedupCount = 0;
            this.lastDedupLog = now;
          }
          return;
        }
        this.recentSignatures.set(sig, now);
        // v9f: Time-based cleanup (remove entries older than 30 min) every 2000 entries
        if (this.recentSignatures.size > 2000) {
          const cutoff = now - PumpSwapMonitor.DEDUP_RETENTION_MS;
          for (const [s, ts] of this.recentSignatures) {
            if (ts < cutoff) this.recentSignatures.delete(s);
          }
        }
        this.processLogs(sig, logs.logs, ctx.slot);
      },
    );

    logger.info('[pumpswap] Listening for new PumpSwap pools');
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    await this.wsManager.unsubscribe('pumpswap-pools');
    logger.info('[pumpswap] Stopped');
  }

  private processLogs(signature: string, logs: string[], slot: number): void {
    // Early dedup: skip if we already processed this signature
    if (this.processedSignatures.has(signature)) {
      // Only log for CreatePool (not every swap)
      const hasCreate = logs.some((l) => l.includes('CreatePool') || l.includes('create_pool'));
      if (hasCreate) {
        logger.warn(`[pumpswap] DEDUP-SIG: Duplicate CreatePool TX ${signature.slice(0, 16)}... (map size: ${this.processedSignatures.size})`);
      }
      return;
    }
    const now = Date.now();
    this.processedSignatures.set(signature, now);

    // v9f: Time-based cleanup (remove entries older than 30 min) every 2000 entries
    if (this.processedSignatures.size > 2000) {
      const cutoff = now - PumpSwapMonitor.DEDUP_RETENTION_MS;
      for (const [sig, ts] of this.processedSignatures) {
        if (ts < cutoff) this.processedSignatures.delete(sig);
      }
    }

    // Look for pool creation events in PumpSwap
    const isPoolCreate = logs.some(
      (log) =>
        log.includes('Program log: Instruction: CreatePool') ||
        log.includes('CreatePool') ||
        log.includes('create_pool'),
    );

    if (!isPoolCreate) return;

    logger.info(`[pumpswap] New PumpSwap pool detected! TX: ${signature}`);

    this.enqueueFetch(signature, slot);
  }

  // v9x: Semaphore-controlled fetch queue — max 2 concurrent to prevent self-DDoS
  // v11e: Pause fetches during sell priority — sell RPC calls take precedence
  // v11f: Also pause when at max capacity — can't buy, don't waste RPC on parsing
  private enqueueFetch(signature: string, slot: number): void {
    if (shouldSkipPoolParsing()) {
      // Drop — no need to queue, we can't buy anyway (at capacity) or selling
      logger.debug(`[pumpswap] Skipping fetch (${this.activeFetches} active, parsing paused): ${signature.slice(0, 16)}...`);
      return;
    }
    if (this.activeFetches < PumpSwapMonitor.MAX_CONCURRENT_FETCHES) {
      this.activeFetches++;
      this.fetchPoolDetails(signature, slot).catch((err) => {
        logger.error('[pumpswap] Error fetching pool details', { error: String(err) });
      }).finally(() => {
        this.activeFetches--;
        this.drainQueue();
      });
    } else {
      // Queue it — will execute when a slot opens
      this.fetchQueue.push({ signature, slot, resolve: () => {} });
      if (this.fetchQueue.length > 10) {
        // Drop oldest if queue grows too large (stale pools not worth fetching)
        const dropped = this.fetchQueue.shift();
        if (dropped) logger.debug(`[pumpswap] Dropped queued fetch (queue full): ${dropped.signature.slice(0, 16)}...`);
      }
    }
  }

  private drainQueue(): void {
    // v11f: Don't drain queue during sell priority or at capacity
    if (shouldSkipPoolParsing()) return;
    while (this.fetchQueue.length > 0 && this.activeFetches < PumpSwapMonitor.MAX_CONCURRENT_FETCHES) {
      const next = this.fetchQueue.shift();
      if (!next) break;
      this.activeFetches++;
      this.fetchPoolDetails(next.signature, next.slot).catch((err) => {
        logger.error('[pumpswap] Error fetching pool details', { error: String(err) });
      }).finally(() => {
        this.activeFetches--;
        this.drainQueue();
      });
    }
  }

  private async fetchPoolDetails(signature: string, slot: number): Promise<void> {
    try {
      const parseStart = Date.now(); // v11g: track parse duration
      await new Promise((r) => setTimeout(r, 100));

      // v10a: Global 10s timeout on entire pool parsing — prevents 60s+ hangs
      // Pool #16 (GKAX) took 60s cycling through RPCs, token was dead by then
      let globalTimer: ReturnType<typeof setTimeout>;
      const tx = await Promise.race([
        withAnalysisRetry(
          (conn) => conn.getParsedTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          }),
          this.connection,
          15_000, // v11g: 15s (was 10s). Argentina→USA latency: 500ms base + Helius load. User requested increase
          false, // v10c: Respect concurrency limiter — isSellPath=true caused self-DDoS when multiple pools arrived
        ).then(result => {
          clearTimeout(globalTimer);
          return result;
        }),
        new Promise<null>((resolve) => {
          globalTimer = setTimeout(() => {
            logger.warn(`[pumpswap] Pool parsing global timeout (20s) for ${signature.slice(0, 16)}...`);
            resolve(null);
          }, 20_000);
        }),
      ]);

      if (!tx?.meta || !tx.transaction) {
        logger.warn(`[pumpswap] Could not fetch TX: ${signature}`);
        return;
      }

      // Find the CreatePool instruction from PumpSwap AMM
      // Actual CreatePool accounts layout (verified from on-chain TX):
      // [0] pool, [1] poolAuthority, [2] creator(wallet), [3] baseMint, [4] quoteMint,
      // [5] lpMint, [6] poolBaseVault, [7] poolQuoteVault, ...
      let poolAddress: PublicKey | undefined;
      let baseMintFromIx: PublicKey | undefined;
      let quoteMintFromIx: PublicKey | undefined;

      const findCreatePoolAccounts = (accounts: PublicKey[]) => {
        if (accounts.length >= 7) {
          poolAddress = accounts[0];
          baseMintFromIx = accounts[3];
          quoteMintFromIx = accounts[4];
        }
      };

      // Check top-level instructions
      const instructions = tx.transaction.message.instructions;
      for (const ix of instructions) {
        if ('programId' in ix && ix.programId.equals(PUMPSWAP_AMM) && 'accounts' in ix) {
          findCreatePoolAccounts(ix.accounts as PublicKey[]);
          break;
        }
      }

      // If not found at top level, check inner instructions
      if (!poolAddress && tx.meta.innerInstructions) {
        for (const inner of tx.meta.innerInstructions) {
          for (const ix of inner.instructions) {
            if ('programId' in ix && ix.programId.equals(PUMPSWAP_AMM) && 'accounts' in ix) {
              findCreatePoolAccounts(ix.accounts as PublicKey[]);
              break;
            }
          }
          if (poolAddress) break;
        }
      }

      // Determine token mint: in PumpSwap pools, baseMint=WSOL and quoteMint=TOKEN
      let tokenMint: PublicKey;
      if (baseMintFromIx && quoteMintFromIx) {
        // Pick the non-WSOL mint as the token
        if (baseMintFromIx.equals(WSOL_MINT)) {
          tokenMint = quoteMintFromIx;
        } else if (quoteMintFromIx.equals(WSOL_MINT)) {
          tokenMint = baseMintFromIx;
        } else {
          // Neither is WSOL - rare case, take quoteMint
          tokenMint = quoteMintFromIx;
        }
      } else {
        // Fallback: extract from postTokenBalances (old logic)
        const postBalances = tx.meta.postTokenBalances ?? [];
        const wsolStr = WSOL_MINT.toBase58();
        const sysStr = SYSTEM_PROGRAM.toBase58();
        let foundMint: string | undefined;
        for (const bal of postBalances) {
          if (bal.mint && bal.mint !== wsolStr && bal.mint !== sysStr) {
            foundMint = bal.mint;
            break;
          }
        }
        if (!foundMint) {
          logger.warn('[pumpswap] No token mint found in pool creation TX');
          return;
        }
        tokenMint = new PublicKey(foundMint);
      }

      if (tokenMint.equals(SYSTEM_PROGRAM)) {
        logger.warn('[pumpswap] Invalid token mint (System Program), skipping');
        return;
      }

      // v9s: Extract fee payer (deployer) for Tier 0 rate limiting — FREE, no extra RPC
      const feePayer = tx.transaction.message.accountKeys?.[0]?.pubkey?.toBase58() ?? undefined;

      const pool: DetectedPool = {
        id: generateId(),
        source: 'pumpswap',
        poolAddress: poolAddress ?? tokenMint,
        baseMint: tokenMint,
        quoteMint: WSOL_MINT,
        baseDecimals: 6,
        quoteDecimals: 9,
        detectedAt: Date.now(),
        slot,
        txSignature: signature,
        poolCreationBlockTime: tx.blockTime ?? undefined, // v8m: for graduation timing
        deployer: feePayer, // v9s: for Tier 0 rate limiting
      };

      // Extra dedup: skip if we already emitted this pool address
      const poolKey = pool.poolAddress.toBase58();
      if (this.emittedPoolAddresses.has(poolKey)) {
        logger.debug(`[pumpswap] DEDUP: Pool ${poolKey.slice(0, 8)}... already emitted`);
        return;
      }
      this.emittedPoolAddresses.add(poolKey);

      // Cleanup emittedPoolAddresses at 500 entries
      if (this.emittedPoolAddresses.size > 500) {
        const arr = Array.from(this.emittedPoolAddresses);
        this.emittedPoolAddresses = new Set(arr.slice(-250));
      }

      const parseDurationMs = Date.now() - parseStart;
      logger.info(
        `[pumpswap] New pool: ${shortenAddress(pool.baseMint)}/SOL @ ${shortenAddress(pool.poolAddress)} (parsed in ${parseDurationMs}ms)`,
      );

      botEmitter.emit('newPool', pool);
    } catch (err) {
      logger.error('[pumpswap] Error parsing pool details', {
        error: String(err),
        signature,
      });
    }
  }
}
