import { Connection } from '@solana/web3.js';
import { logger } from './logger.js';
import { withAnalysisRetry } from './analysis-rpc.js';

/**
 * v11a: Pre-caches recent blockhash to avoid fetching it per TX.
 * Each getLatestBlockhash() takes 100-300ms via RPC. With cache, TX construction is instant.
 * Refresh every 1000ms (was 400ms — saves ~4M credits/mo, blockhash valid ~60s).
 */

interface CachedBlockhash {
  blockhash: string;
  lastValidBlockHeight: number;
  fetchedAt: number;
}

let cache: CachedBlockhash | null = null;
let refreshInterval: ReturnType<typeof setInterval> | null = null;
let connection: Connection | null = null;
let consecutiveFailures = 0;

const REFRESH_MS = 1_000; // v11a: was 400ms. Saves ~4M credits/mo. Blockhash valid ~60s.
const MAX_AGE_MS = 5_000; // Fetch fresh if cache older than 5s

async function refresh(): Promise<void> {
  if (!connection) return;
  try {
    // v9k: ALWAYS use analysis RPC pool for blockhash refresh.
    // Before: called Helius primary every 400ms (2.5 calls/sec constant drain).
    // After: distributed across Helius2/Alchemy/ExtrNode, Helius primary only as last resort.
    const result = await withAnalysisRetry(
      (conn) => conn.getLatestBlockhash('confirmed'),
      connection,
    );
    cache = {
      blockhash: result.blockhash,
      lastValidBlockHeight: result.lastValidBlockHeight,
      fetchedAt: Date.now(),
    };
    consecutiveFailures = 0;
  } catch {
    consecutiveFailures++;
    // Keep old cache — blockhash is valid for ~60s
  }
}

/**
 * Start the blockhash pre-cache. Call once at bot startup.
 */
export function startBlockhashCache(conn: Connection): void {
  connection = conn;
  // Fetch initial blockhash immediately
  refresh().then(() => {
    if (cache) {
      logger.info(`[blockhash-cache] Started (refresh every ${REFRESH_MS}ms)`);
    }
  });
  refreshInterval = setInterval(refresh, REFRESH_MS);
}

/**
 * Stop the blockhash pre-cache. Call on shutdown.
 */
export function stopBlockhashCache(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
  cache = null;
  connection = null;
}

/**
 * Get a cached blockhash (0ms if cache is fresh).
 * Falls back to a synchronous RPC call if cache is stale or empty.
 */
export async function getCachedBlockhash(
  conn: Connection,
): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  if (cache && (Date.now() - cache.fetchedAt) < MAX_AGE_MS) {
    return { blockhash: cache.blockhash, lastValidBlockHeight: cache.lastValidBlockHeight };
  }
  // v9h: Cache stale — try analysis RPCs first (primary is likely 429'd)
  try {
    const result = await withAnalysisRetry(
      (c) => c.getLatestBlockhash('confirmed'),
      conn,
    );
    cache = {
      blockhash: result.blockhash,
      lastValidBlockHeight: result.lastValidBlockHeight,
      fetchedAt: Date.now(),
    };
    return { blockhash: result.blockhash, lastValidBlockHeight: result.lastValidBlockHeight };
  } catch {
    // All RPCs failed — use stale cache if available (blockhash valid ~60s)
    if (cache) {
      logger.warn(`[blockhash-cache] All RPCs failed, using stale cache (age=${Date.now() - cache.fetchedAt}ms)`);
      return { blockhash: cache.blockhash, lastValidBlockHeight: cache.lastValidBlockHeight };
    }
    throw new Error('No blockhash available (all RPCs failed and no cache)');
  }
}
