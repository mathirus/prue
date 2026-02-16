import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { JUPITER_API_BASE, WSOL_MINT } from '../constants.js';

// v8u: Added solReserveLamports for ML data tracking (only available for PumpSwap pools)
type PriceCallback = (mint: string, price: number, solReserveLamports?: number) => void;
type RugPullCallback = (mint: string, reserveDropPct: number) => void;
type AuthorityCallback = (mint: string, authorityType: 'mint' | 'freeze') => void;

interface MonitoredToken {
  mint: PublicKey;
  lastPrice: number;
  poolAddress?: PublicKey;
  source?: string;
  jupiterFailCount: number;
  // Cache vault addresses to avoid re-parsing pool data each poll
  cachedVaults?: {
    baseVault: PublicKey;
    quoteVault: PublicKey;
    isReversed: boolean;
  };
  // Anti-rug: track initial SOL reserves to detect liquidity drain
  initialSolReserve?: number;
  lastSolReserve?: number;
  // v8r: Track previous poll's SOL reserve for inter-poll drain detection
  previousSolReserve?: number;
  // v11m: Constant product K tracking — K = baseReserve * quoteReserve (BigInt for precision)
  // Normal swaps increase K (fees). K decrease = liquidity removal.
  initialK?: bigint;
  previousK?: bigint;
  // Stale price detection: count consecutive fetch failures
  consecutiveFailures: number;
  rugPullDetected?: boolean;
  // v8r: Authority monitoring
  pollCount: number;
  mintAddress?: PublicKey;
  initialMintAuthRevoked?: boolean;
  initialFreezeAuthRevoked?: boolean;
}

// PumpSwap pool layout offsets (same as pumpswap-swap.ts)
const POOL_BASE_VAULT_OFFSET = 139;
const POOL_QUOTE_VAULT_OFFSET = 171;
const POOL_BASE_MINT_OFFSET = 43;

/**
 * Polls token prices. PumpSwap tokens use pool reserves directly (accurate),
 * non-PumpSwap tokens use Jupiter quote API.
 *
 * v5e: Batches ALL PumpSwap vault queries into a single getMultipleAccountsInfo
 * call. With N positions, this is 1 RPC call instead of N, preventing 429 cascade.
 */
export class PriceMonitor {
  private monitoredTokens = new Map<string, MonitoredToken>();
  private interval?: ReturnType<typeof setInterval>;
  private callbacks: PriceCallback[] = [];
  private rugPullCallbacks: RugPullCallback[] = [];
  private authorityCallbacks: AuthorityCallback[] = [];
  private paused = false;
  private pollPending = false; // v11k: pending guard — max 1 pollPrices in-flight
  // Max consecutive failures before we stop returning stale prices
  private static readonly MAX_STALE_READS = 3;
  // v9f: Exponential backoff for 429s on vault caching
  private vaultCacheBackoffUntil = 0;
  private vaultCache429Count = 0;
  // Liquidity drain threshold: 15% drop = likely rug pull (was 30%)
  // Rationale: Rugs drain 100% instantly. By the time we detect 30%, pool is usually empty.
  // At 15%, there may still be enough SOL to salvage some of our position.
  // Also triggers PARTIAL emergency sell (50%) at this level - see position-manager.
  private static readonly RUG_PULL_RESERVE_DROP_PCT = 15;

  // Fast polling mode: when reserves drop >5%, poll 4x faster to catch rugs earlier
  private fastPollMode = false;
  private fastPollInterval?: ReturnType<typeof setInterval>;

  private readonly getConnection?: () => Connection;
  constructor(
    private readonly pollIntervalMs = 2000,
    getConn?: () => Connection,
  ) {
    this.getConnection = getConn;
  }

  private get connection(): Connection | undefined {
    return this.getConnection?.();
  }

  onPriceUpdate(callback: PriceCallback): void {
    this.callbacks.push(callback);
  }

  onRugPullDetected(callback: RugPullCallback): void {
    this.rugPullCallbacks.push(callback);
  }

  onAuthorityReenabled(callback: AuthorityCallback): void {
    this.authorityCallbacks.push(callback);
  }

  addToken(
    mint: PublicKey,
    poolAddress?: PublicKey,
    source?: string,
    initialSolReserve?: number,
    initialAuthorities?: { mintRevoked: boolean; freezeRevoked: boolean },
    // v11t: Pre-cached vault addresses from buy (saves 1 poll cycle = 1.5s for first price read)
    vaultCache?: { baseVault: PublicKey; quoteVault: PublicKey; isReversed: boolean },
  ): void {
    const key = mint.toBase58();
    if (!this.monitoredTokens.has(key)) {
      const token: MonitoredToken = {
        mint, lastPrice: 0, poolAddress, source, jupiterFailCount: 0,
        consecutiveFailures: 0, pollCount: 0,
        mintAddress: mint,
      };
      if (initialSolReserve && initialSolReserve > 0) {
        token.initialSolReserve = initialSolReserve;
        logger.debug(`[price] Set initial SOL reserve from buy: ${(initialSolReserve / 1e9).toFixed(4)} SOL`);
      }
      // v8r: Store initial authority state for re-enablement detection
      if (initialAuthorities) {
        token.initialMintAuthRevoked = initialAuthorities.mintRevoked;
        token.initialFreezeAuthRevoked = initialAuthorities.freezeRevoked;
      }
      // v11t: Pre-cache vault addresses from buy result (skip pool account fetch on first poll)
      if (vaultCache) {
        token.cachedVaults = vaultCache;
        logger.debug(`[price] Pre-cached vaults from buy (saves 1 poll cycle)`);
      }
      this.monitoredTokens.set(key, token);
      logger.debug(`[price] Monitoring ${key.slice(0, 8)}... (pool=${poolAddress?.toBase58().slice(0, 8) ?? 'none'}, source=${source ?? 'unknown'}, vaults=${vaultCache ? 'pre-cached' : 'pending'})`);
    }
  }

  removeToken(mint: PublicKey): void {
    this.monitoredTokens.delete(mint.toBase58());
  }

  start(): void {
    if (this.interval) return;

    this.interval = setInterval(() => {
      this.pollPrices().catch((err) => {
        logger.error('[price] Poll error', { error: String(err) });
      });
    }, this.pollIntervalMs);

    logger.info(`[price] Started monitoring (${this.pollIntervalMs}ms interval, PumpSwap batch: ${this.connection ? 'ON' : 'OFF'})`);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  /** Pause polling (e.g. during sell operations to avoid RPC contention) */
  pause(): void {
    this.paused = true;
  }

  /** Resume polling after sell completes */
  resume(): void {
    this.paused = false;
  }

  /**
   * v11q: Fetch reserves for a single pool immediately (1 RPC call).
   * Used by conditional grace: when sell burst happens during grace period,
   * fetch reserves on-demand instead of waiting for next poll cycle.
   * Returns SOL reserve in lamports, or null on failure.
   */
  async fetchSinglePoolReserves(mint: string): Promise<number | null> {
    const token = this.monitoredTokens.get(mint);
    if (!token || !token.poolAddress || !this.connection) return null;

    try {
      // If vaults not cached yet, fetch pool account to get vault addresses
      if (!token.cachedVaults) {
        const poolInfo = await this.connection.getAccountInfo(token.poolAddress);
        if (!poolInfo || poolInfo.data.length < 203) return null;
        const baseMint = new PublicKey(poolInfo.data.slice(POOL_BASE_MINT_OFFSET, POOL_BASE_MINT_OFFSET + 32));
        token.cachedVaults = {
          baseVault: new PublicKey(poolInfo.data.slice(POOL_BASE_VAULT_OFFSET, POOL_BASE_VAULT_OFFSET + 32)),
          quoteVault: new PublicKey(poolInfo.data.slice(POOL_QUOTE_VAULT_OFFSET, POOL_QUOTE_VAULT_OFFSET + 32)),
          isReversed: baseMint.equals(WSOL_MINT),
        };
      }

      const solVault = token.cachedVaults.isReversed
        ? token.cachedVaults.baseVault
        : token.cachedVaults.quoteVault;

      const vaultInfo = await this.connection.getAccountInfo(solVault);
      if (!vaultInfo) return null;

      const solReserve = Number(vaultInfo.data.readBigUInt64LE(64));
      return solReserve > 0 ? solReserve : null;
    } catch (err) {
      logger.debug(`[price] fetchSinglePoolReserves failed for ${mint.slice(0, 8)}: ${err}`);
      return null;
    }
  }

  private async pollPrices(): Promise<void> {
    if (this.paused) return;
    // v11k: Pending guard — skip if previous poll still in-flight
    if (this.pollPending) {
      logger.debug('[price] pollPrices skipped (previous pending)');
      return;
    }
    const tokens = [...this.monitoredTokens.values()];
    if (tokens.length === 0) return;

    this.pollPending = true;
    try {
      // Separate PumpSwap (batch via reserves) from others (Jupiter API)
      const pumpswap: MonitoredToken[] = [];
      const others: MonitoredToken[] = [];

      for (const t of tokens) {
        if (this.connection && t.poolAddress && t.source === 'pumpswap' && !t.rugPullDetected) {
          pumpswap.push(t);
        } else if (!t.rugPullDetected) {
          others.push(t);
        }
      }

      // Batch ALL PumpSwap vault queries into 1-2 RPC calls (was N calls before)
      if (pumpswap.length > 0) {
        await this.batchFetchPumpSwapPrices(pumpswap);
      }

      // Non-PumpSwap tokens: use Jupiter sequentially
      for (const t of others) {
        const price = await this.fetchJupiterPrice(t.mint);
        if (price !== null) {
          t.consecutiveFailures = 0;
          this.emitPrice(t, price);
        } else {
          t.consecutiveFailures++;
          this.emitPrice(t, null);
        }
      }
    } finally {
      this.pollPending = false;
    }
  }

  /**
   * Batch fetch prices for all PumpSwap tokens in 1-2 RPC calls.
   * Step 1: Cache vault addresses for new tokens (1 call for all uncached)
   * Step 2: Fetch all vault balances (1 call for all tokens)
   */
  private async batchFetchPumpSwapPrices(tokens: MonitoredToken[]): Promise<void> {
    // Step 1: Cache vault addresses for tokens that don't have them yet
    const uncached = tokens.filter(t => !t.cachedVaults);
    if (uncached.length > 0) {
      // v9f: Skip if in backoff period from previous 429
      if (Date.now() < this.vaultCacheBackoffUntil) {
        for (const t of uncached) {
          t.consecutiveFailures++;
          this.emitPrice(t, null);
        }
      } else {
        try {
          const poolAddresses = uncached.map(t => t.poolAddress!);
          const poolInfos = await this.connection!.getMultipleAccountsInfo(poolAddresses);

          for (let i = 0; i < uncached.length; i++) {
            const poolInfo = poolInfos[i];
            if (!poolInfo || poolInfo.data.length < 203) continue;

            const poolData = poolInfo.data;
            const baseMint = new PublicKey(poolData.slice(POOL_BASE_MINT_OFFSET, POOL_BASE_MINT_OFFSET + 32));
            uncached[i].cachedVaults = {
              baseVault: new PublicKey(poolData.slice(POOL_BASE_VAULT_OFFSET, POOL_BASE_VAULT_OFFSET + 32)),
              quoteVault: new PublicKey(poolData.slice(POOL_QUOTE_VAULT_OFFSET, POOL_QUOTE_VAULT_OFFSET + 32)),
              isReversed: baseMint.equals(WSOL_MINT),
            };
          }
          this.vaultCache429Count = 0; // Reset on success
        } catch (err) {
          const errStr = String(err);
          if (errStr.includes('429') || errStr.includes('Too Many Requests')) {
            this.vaultCache429Count++;
            // Exponential backoff: 5s, 10s, 20s, 30s max
            const backoffMs = Math.min(5000 * Math.pow(2, this.vaultCache429Count - 1), 30000);
            this.vaultCacheBackoffUntil = Date.now() + backoffMs;
            logger.warn(`[price] RPC 429 during vault caching, backoff ${(backoffMs / 1000).toFixed(0)}s (attempt #${this.vaultCache429Count})`);
          } else {
            logger.debug(`[price] Failed to batch-cache vault addresses: ${errStr}`);
          }
          // Uncached tokens fail this cycle
          for (const t of uncached) {
            t.consecutiveFailures++;
            this.emitPrice(t, null);
          }
        }
      }
    }

    // Step 2: Batch fetch ALL vault balances in 1 RPC call
    const cached = tokens.filter(t => t.cachedVaults);
    if (cached.length === 0) return;

    const vaultAddresses: PublicKey[] = [];
    for (const t of cached) {
      vaultAddresses.push(t.cachedVaults!.baseVault, t.cachedVaults!.quoteVault);
    }

    try {
      const vaultInfos = await this.connection!.getMultipleAccountsInfo(vaultAddresses);

      for (let i = 0; i < cached.length; i++) {
        const token = cached[i];
        const baseInfo = vaultInfos[i * 2];
        const quoteInfo = vaultInfos[i * 2 + 1];

        if (!baseInfo || !quoteInfo) {
          token.consecutiveFailures++;
          this.emitPrice(token, null);
          continue;
        }

        const baseReserve = Number(baseInfo.data.readBigUInt64LE(64));
        const quoteReserve = Number(quoteInfo.data.readBigUInt64LE(64));

        if (baseReserve === 0 || quoteReserve === 0) {
          token.consecutiveFailures++;
          this.emitPrice(token, null);
          continue;
        }

        const { isReversed } = token.cachedVaults!;
        const solReserve = isReversed ? baseReserve : quoteReserve;
        const tokenReserve = isReversed ? quoteReserve : baseReserve;

        // Guard: near-zero reserves produce absurd prices (e.g. 9.9B x spikes in DB)
        // Minimum 1000 lamports (~0.000001 SOL) on each side
        if (tokenReserve < 1000 || solReserve < 1000) {
          token.consecutiveFailures++;
          this.emitPrice(token, null);
          continue;
        }

        // Anti-rug: track SOL reserves for drain detection
        this.checkReserveDrain(token, solReserve);

        // v11m: Track constant product K = base * quote (BigInt to avoid overflow)
        // Normal swaps: K stays same or increases (fees). K decrease = liquidity removal.
        this.checkKDrain(token, baseInfo.data.readBigUInt64LE(64), quoteInfo.data.readBigUInt64LE(64));

        // v8r: Periodic authority check (~every 30s = 20 polls at 1.5s)
        token.pollCount++;
        if (token.pollCount % 20 === 0 && token.mintAddress && this.connection) {
          this.checkAuthorityReenabled(token).catch(() => {});
        }

        const pricePerUnit = (solReserve / 1e9) / tokenReserve;

        // Guard: cap price spikes - no legit token moves 50x in a single poll (1.5s)
        if (token.lastPrice > 0) {
          const priceChange = pricePerUnit / token.lastPrice;
          if (priceChange > 50 || priceChange < 0.02) {
            const key = token.mint.toBase58();
            logger.warn(`[price] Suspicious price change ${priceChange.toFixed(1)}x for ${key.slice(0, 8)} - ignoring`);
            continue;
          }
        }

        token.consecutiveFailures = 0;
        this.emitPrice(token, pricePerUnit, solReserve);
      }
    } catch (err) {
      const errStr = String(err);
      if (errStr.includes('429') || errStr.includes('Too Many Requests')) {
        this.vaultCache429Count++;
        const backoffMs = Math.min(5000 * Math.pow(2, this.vaultCache429Count - 1), 30000);
        this.vaultCacheBackoffUntil = Date.now() + backoffMs;
        logger.warn(`[price] RPC 429 during batch vault fetch, backoff ${(backoffMs / 1000).toFixed(0)}s`);
      } else {
        logger.debug(`[price] Batch vault fetch failed: ${errStr}`);
      }
      // All tokens fail this cycle
      for (const token of cached) {
        token.consecutiveFailures++;
        this.emitPrice(token, null);
      }
    }
  }

  /** Emit price to callbacks, or handle stale/failed prices */
  private emitPrice(token: MonitoredToken, price: number | null, solReserveLamports?: number): void {
    const key = token.mint.toBase58();

    if (price !== null) {
      token.lastPrice = price;
      for (const cb of this.callbacks) {
        cb(key, price, solReserveLamports);
      }
      return;
    }

    // Price fetch failed
    if (token.consecutiveFailures >= PriceMonitor.MAX_STALE_READS) {
      if (token.consecutiveFailures === PriceMonitor.MAX_STALE_READS) {
        logger.warn(`[price] ${key.slice(0, 8)}... ${token.consecutiveFailures} consecutive failures - stale price`);
      }
      // Fire 0 so timeout checks still run
      for (const cb of this.callbacks) {
        cb(key, 0);
      }
      return;
    }

    // Under MAX_STALE_READS: use lastPrice if available
    if (token.lastPrice > 0) {
      for (const cb of this.callbacks) {
        cb(key, token.lastPrice);
      }
    }
  }

  // v11m: K drop threshold — 3% decrease in constant product = liquidity removal
  // Normal trading only INCREASES K (swap fees), so any decrease is suspicious.
  // 3% threshold avoids false positives from rounding/precision.
  private static readonly K_DROP_PCT = 3;

  /**
   * v11m: Track constant product K = baseReserve * quoteReserve.
   * In AMM: swaps keep K constant (or increase via fees). K decrease = liquidity removed.
   * More precise than SOL-only reserve tracking because it catches removals where
   * both reserves change proportionally (single-side tracking misses these).
   */
  private checkKDrain(token: MonitoredToken, baseReserveBig: bigint, quoteReserveBig: bigint): void {
    if (token.rugPullDetected) return;
    const currentK = baseReserveBig * quoteReserveBig;
    if (currentK === 0n) return;

    if (token.initialK === undefined) {
      token.initialK = currentK;
      token.previousK = currentK;
      return;
    }

    // Check K drop from initial
    if (token.initialK > 0n) {
      // Use integer math: dropPct = (initial - current) * 100 / initial
      const dropBps = (token.initialK - currentK) * 10000n / token.initialK;
      const dropPct = Number(dropBps) / 100;

      if (dropPct >= PriceMonitor.K_DROP_PCT) {
        const key = token.mint.toBase58();
        logger.warn(
          `[price] 🚨 K-DROP: ${key.slice(0, 8)}... constant product dropped ${dropPct.toFixed(1)}% — liquidity removed`,
        );
        // Trigger rug detection via same callbacks as reserve drain
        token.rugPullDetected = true;
        for (const cb of this.rugPullCallbacks) {
          cb(key, dropPct);
        }
        this.deactivateFastPoll();
      }
    }

    token.previousK = currentK;
  }

  /** Track SOL reserves and detect rug pull (>15% drain or >50% inter-poll drop) */
  private checkReserveDrain(token: MonitoredToken, solReserve: number): void {
    // v8r: Inter-poll drain detection (catches instant 100% rugs 1-2 polls faster)
    // If reserves dropped >50% since LAST poll, it's an instant rug
    if (token.previousSolReserve !== undefined && token.previousSolReserve > 1_000_000 && !token.rugPullDetected) {
      const interPollDropPct = ((token.previousSolReserve - solReserve) / token.previousSolReserve) * 100;
      if (interPollDropPct >= 50) {
        token.rugPullDetected = true;
        const key = token.mint.toBase58();
        logger.warn(
          `[price] 🚨 INSTANT RUG: ${key.slice(0, 8)}... SOL reserves dropped ${interPollDropPct.toFixed(0)}% in ONE poll (${(token.previousSolReserve / 1e9).toFixed(4)} → ${(solReserve / 1e9).toFixed(4)} SOL)`,
        );
        for (const cb of this.rugPullCallbacks) {
          cb(key, interPollDropPct);
        }
        this.deactivateFastPoll();
        token.previousSolReserve = solReserve;
        return;
      }
      // Also catch complete drain (reserves go to 0)
      if (solReserve === 0 && token.previousSolReserve > 1_000_000) {
        token.rugPullDetected = true;
        const key = token.mint.toBase58();
        logger.warn(
          `[price] 🚨 COMPLETE DRAIN: ${key.slice(0, 8)}... SOL reserves went to 0 (was ${(token.previousSolReserve / 1e9).toFixed(4)} SOL)`,
        );
        for (const cb of this.rugPullCallbacks) {
          cb(key, 100);
        }
        this.deactivateFastPoll();
        token.previousSolReserve = solReserve;
        return;
      }
    }
    token.previousSolReserve = solReserve;

    // Original logic: track vs initial reserves
    token.lastSolReserve = solReserve;
    if (token.initialSolReserve === undefined) {
      token.initialSolReserve = solReserve;
    } else if (token.initialSolReserve > 0 && !token.rugPullDetected) {
      const reserveDropPct = ((token.initialSolReserve - solReserve) / token.initialSolReserve) * 100;

      // Activate fast polling when reserves start dropping (>5%)
      // This polls 4x faster to catch the full rug pull sooner
      if (reserveDropPct >= 5 && !this.fastPollMode) {
        this.activateFastPoll();
      }

      if (reserveDropPct >= PriceMonitor.RUG_PULL_RESERVE_DROP_PCT) {
        token.rugPullDetected = true;
        const key = token.mint.toBase58();
        logger.warn(
          `[price] 🚨 RUG PULL DETECTED: ${key.slice(0, 8)}... SOL reserves dropped ${reserveDropPct.toFixed(0)}% (${(token.initialSolReserve / 1e9).toFixed(4)} → ${(solReserve / 1e9).toFixed(4)} SOL)`,
        );
        for (const cb of this.rugPullCallbacks) {
          cb(key, reserveDropPct);
        }
        // Deactivate fast poll after detection (will sell immediately)
        this.deactivateFastPoll();
      }
    }
  }

  /** Switch to fast polling (500ms) when reserves start dropping */
  private activateFastPoll(): void {
    if (this.fastPollMode) return;
    this.fastPollMode = true;
    logger.info('[price] ⚡ FAST POLL activated (500ms) - reserves dropping');

    // Add extra fast polls between normal ones
    this.fastPollInterval = setInterval(() => {
      this.pollPrices().catch((err) => {
        logger.debug(`[price] Fast poll error: ${String(err)}`);
      });
    }, 500);

    // Auto-deactivate after 30s (if no rug detected, it was just normal trading)
    setTimeout(() => this.deactivateFastPoll(), 30_000);
  }

  /** Return to normal polling */
  private deactivateFastPoll(): void {
    if (!this.fastPollMode) return;
    this.fastPollMode = false;
    if (this.fastPollInterval) {
      clearInterval(this.fastPollInterval);
      this.fastPollInterval = undefined;
    }
    logger.debug('[price] Fast poll deactivated, back to normal');
  }

  /**
   * v8r: Check if mint or freeze authority was re-enabled after purchase.
   * Parses raw mint account bytes: mintAuthorityOption at offset 0-3, freezeAuthorityOption at offset 46-49.
   * COption<Pubkey> format: 4-byte option (0=None, 1=Some) + 32-byte pubkey
   * Cost: 1 RPC call per check (~every 30s per position)
   */
  private async checkAuthorityReenabled(token: MonitoredToken): Promise<void> {
    if (!this.connection || !token.mintAddress) return;

    try {
      const mintInfo = await this.connection.getAccountInfo(token.mintAddress);
      if (!mintInfo || mintInfo.data.length < 82) return;

      const data = mintInfo.data;
      // Mint account layout: mintAuthorityOption (u32) at offset 0, freezeAuthorityOption (u32) at offset 46
      const mintAuthOption = data.readUInt32LE(0);   // 0=None(revoked), 1=Some(active)
      const freezeAuthOption = data.readUInt32LE(46); // 0=None(revoked), 1=Some(active)

      const mintAuthActive = mintAuthOption === 1;
      const freezeAuthActive = freezeAuthOption === 1;

      // Detect re-enablement: was revoked at buy time, now active
      if (token.initialMintAuthRevoked === true && mintAuthActive) {
        const key = token.mint.toBase58();
        logger.warn(`[price] 🚨 MINT AUTHORITY RE-ENABLED: ${key.slice(0, 8)}... (was revoked at buy time!)`);
        for (const cb of this.authorityCallbacks) {
          cb(key, 'mint');
        }
      }
      if (token.initialFreezeAuthRevoked === true && freezeAuthActive) {
        const key = token.mint.toBase58();
        logger.warn(`[price] 🚨 FREEZE AUTHORITY RE-ENABLED: ${key.slice(0, 8)}... (was revoked at buy time!)`);
        for (const cb of this.authorityCallbacks) {
          cb(key, 'freeze');
        }
      }
    } catch {
      // Non-fatal — authority check is best-effort
    }
  }

  private async fetchJupiterPrice(mint: PublicKey): Promise<number | null> {
    try {
      const testAmount = 100_000_000;
      const params = new URLSearchParams({
        inputMint: mint.toBase58(),
        outputMint: WSOL_MINT.toBase58(),
        amount: testAmount.toString(),
        slippageBps: '500',
      });

      const response = await fetch(`${JUPITER_API_BASE}/quote?${params}`, {
        signal: AbortSignal.timeout(5_000),
      });

      if (!response.ok) return null;

      const data = (await response.json()) as { outAmount?: string; routePlan?: unknown[] };
      if (!data.outAmount || !data.routePlan?.length) return null;

      const priceInLamports = parseInt(data.outAmount);
      return priceInLamports / 1e9 / testAmount;
    } catch {
      return null;
    }
  }

  getPrice(mint: PublicKey): number {
    return this.monitoredTokens.get(mint.toBase58())?.lastPrice ?? 0;
  }
}
