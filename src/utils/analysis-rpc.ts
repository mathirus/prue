import { Connection } from '@solana/web3.js';
import { logger } from './logger.js';

/**
 * v11a: Simplified for Helius paid tier (50 req/s, 10M credits/mo).
 * Free-tier rotation/queue/concurrency logic backed up in _backup-free-tier/analysis-rpc.ts.bak
 *
 * Previous architecture (v8s-v10g):
 * - Pool of 4 free-tier endpoints (Helius2, Alchemy, ExtrNode, Chainstack)
 * - Round-robin rotation with retry on 429/503/timeout
 * - Global concurrency limiter (MAX_CONCURRENT_RPC=4)
 * - Sell-priority mode (pauses non-sell RPC calls)
 *
 * With Helius Developer ($49/mo, 50 req/s), all of that is unnecessary.
 * withAnalysisRetry is kept as a timeout wrapper for API compatibility (20+ call sites).
 */

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms),
    ),
  ]);
}

/**
 * v11a: Simplified — just a timeout wrapper around primaryConnection.
 * Signature kept identical for backward compat with 20+ call sites.
 */
export async function withAnalysisRetry<T>(
  fn: (connection: Connection) => Promise<T>,
  primaryConnection: Connection,
  perCallTimeoutMs: number = 8_000, // v11a fix: was 5s, sell path timed out during RPC blip
  _isSellPath: boolean = false, // kept for API compat, ignored
): Promise<T> {
  return withTimeout(fn(primaryConnection), perCallTimeoutMs);
}

// v11e: Re-enabled sell priority — even with paid tier, pool detection RPC calls
// compete with sell calls during bursts (140+ sells/15s → everything times out).
// When selling, pool detection fetches are paused to free RPC bandwidth for sells.
let _sellModeActive = false;

// v11f: At-capacity flag — when max_concurrent positions are open, skip pool parsing
// entirely. getParsedTransaction is the heaviest RPC call and wastes bandwidth when
// we can't buy anything. WebSocket detection still works (free), only parsing is skipped.
let _atCapacity = false;

export function enterSellPriority(): void {
  _sellModeActive = true;
  logger.info('[rpc] SELL PRIORITY ON — pausing non-essential RPC calls');
}

export function exitSellPriority(): void {
  _sellModeActive = false;
  logger.info('[rpc] SELL PRIORITY OFF — resuming normal operations');
}

/** Check if sell mode is active (used by pool detection to pause fetches) */
export function isSellPriorityActive(): boolean {
  return _sellModeActive;
}

/** v11f: Set whether bot is at max concurrent positions */
export function setAtCapacity(atCapacity: boolean): void {
  if (_atCapacity !== atCapacity) {
    _atCapacity = atCapacity;
    logger.info(`[rpc] Pool parsing ${atCapacity ? 'PAUSED (at capacity)' : 'RESUMED (capacity available)'}`);
  }
}

/** v11f: Should pool parsing be skipped? True if selling OR at max capacity */
export function shouldSkipPoolParsing(): boolean {
  return _sellModeActive || _atCapacity;
}

/**
 * v11a: Returns empty array. Previously returned pool of free-tier connections.
 * Call sites (confirm-tx, pumpswap-swap sendMultiEndpoint) updated to not depend on this.
 */
export function getAnalysisConnections(): Connection[] { return []; }

// v11a: Kept for any code that calls getAnalysisConnection() (singular)
export function getAnalysisConnection(): Connection {
  throw new Error('v11a: getAnalysisConnection() removed. Use primaryConnection directly.');
}
