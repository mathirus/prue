import { Connection } from '@solana/web3.js';
import { logger } from './logger.js';
import { withAnalysisRetry, isSellPriorityActive } from './analysis-rpc.js';

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
let getConnection: (() => Connection) | null = null;
let consecutiveFailures = 0;
let refreshPending = false; // v11k: pending guard — max 1 getLatestBlockhash in-flight
let shouldSkipFn: (() => boolean) | undefined; // v11k: backpressure callback

const REFRESH_MS = 1_000; // v11a: was 400ms. Saves ~4M credits/mo. Blockhash valid ~60s.
const MAX_AGE_MS = 5_000; // Fetch fresh if cache older than 5s

async function refresh(): Promise<void> {
  if (!getConnection) return;
  // v11k: Pending guard — skip if previous refresh still in-flight
  if (refreshPending) {
    logger.debug('[blockhash-cache] skipped (previous pending)');
    return;
  }
  // v11k: Backpressure — skip if RPC pool is saturated
  if (shouldSkipFn?.()) {
    logger.warn('[blockhash-cache] skipped (RPC backpressure)');
    return;
  }
  // v11k: Skip refresh during sell priority — free Helius bandwidth for sell RPC calls
  if (isSellPriorityActive() && cache && (Date.now() - cache.fetchedAt) < 30_000) {
    return; // Use existing cache (blockhash valid ~60s, 30s is safe)
  }
  refreshPending = true;
  try {
    // v11j: Call getter each time to get fresh Connection after RPC reset.
    // Before: stored Connection reference → zombie requests after agent.destroy()
    const conn = getConnection();
    const result = await withAnalysisRetry(
      (c) => c.getLatestBlockhash('confirmed'),
      conn,
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
  } finally {
    refreshPending = false;
  }
}

/**
 * Start the blockhash pre-cache. Call once at bot startup.
 * v11j: Accepts getter function instead of Connection reference.
 * After RPC connection reset, the getter returns the fresh Connection automatically.
 */
export function startBlockhashCache(connGetter: () => Connection, shouldSkip?: () => boolean): void {
  getConnection = connGetter;
  shouldSkipFn = shouldSkip;
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
  getConnection = null;
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
