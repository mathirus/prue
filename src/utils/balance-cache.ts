import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from './logger.js';

/**
 * v11a: Simplified for Helius paid tier.
 * - Uses primaryConnection directly (no withAnalysisRetry rotation needed)
 * - Interval: 15s (was 30s — paid tier can handle it, fresher balance data)
 * v11j: Changed to accept getter function instead of Connection reference.
 * After RPC connection reset, the getter returns the fresh Connection automatically.
 * Free-tier version backed up in _backup-free-tier/balance-cache.ts.bak
 */

let cachedBalanceLamports: number | null = null;
let lastUpdate = 0;
let updateInterval: ReturnType<typeof setInterval> | null = null;

export function getCachedBalanceLamports(): number | null {
  return cachedBalanceLamports;
}

export function getCachedBalanceSol(): number | null {
  return cachedBalanceLamports !== null ? cachedBalanceLamports / 1e9 : null;
}

export function setCachedBalanceLamports(lamports: number): void {
  cachedBalanceLamports = lamports;
  lastUpdate = Date.now();
}

export function startBalanceUpdater(
  walletPubkey: PublicKey,
  getConnection: () => Connection,
  intervalMs: number = 15_000,
): void {
  const update = async () => {
    try {
      const conn = getConnection();
      const lamports = await Promise.race([
        conn.getBalance(walletPubkey),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('balance timeout')), 5_000),
        ),
      ]);
      cachedBalanceLamports = lamports;
      lastUpdate = Date.now();
    } catch {
      // Keep stale cache, don't crash
    }
  };

  update(); // Initial fetch
  updateInterval = setInterval(update, intervalMs);
  logger.info(`[balance-cache] Started background balance updater (every ${intervalMs / 1000}s)`);
}

export function stopBalanceUpdater(): void {
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
  }
}
