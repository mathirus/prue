import { type Connection, type ConfirmedSignatureInfo, PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { withAnalysisRetry } from '../utils/analysis-rpc.js';
import { PUMPFUN_PROGRAM } from '../constants.js';

// Module-level cache for bonding curve signatures (shared with wash-trading-detector)
// TTL 60s — survives analysis + observation window + buy
const bondingCurveSigsCache = new Map<string, { sigs: ConfirmedSignatureInfo[]; timestamp: number }>();
const SIGS_CACHE_TTL_MS = 60_000;

/** Get cached bonding curve signatures for a token mint (used by wash-trading-detector) */
export function getCachedBondingCurveSigs(tokenMint: string): ConfirmedSignatureInfo[] | null {
  const entry = bondingCurveSigsCache.get(tokenMint);
  if (entry && (Date.now() - entry.timestamp) < SIGS_CACHE_TTL_MS) {
    return entry.sigs;
  }
  bondingCurveSigsCache.delete(tokenMint);
  return null;
}

export interface BundleCheckResult {
  txCount: number;              // Total TXs on bonding curve before graduation
  sameSlotCount: number;        // TXs in the creation slot (bundled buys)
  isBundled: boolean;           // High confidence bundled launch
  penalty: number;              // Score penalty to apply (0 to -15)
  graduationTimeSeconds: number; // Time from token creation to graduation (-1 if unknown)
  // v8q: Early activity metrics (data collection, no scoring impact)
  earlyTxCount: number;         // TXs in the first 60s of the token's life
  txVelocity: number;           // TXs per minute during bonding curve
  uniqueSlots: number;          // Distinct slots across all TXs (temporal diversity)
  // v11n: Coefficient of Variation of inter-TX time gaps
  // Low CV (<0.3) = evenly-spaced bot TXs (coordinated), High CV (>0.5) = organic/random
  // -1 if insufficient data (<3 TXs with blockTime)
  timingClusterCV: number;
}

/**
 * v11n: Compute Coefficient of Variation of inter-transaction time gaps.
 * CV = stddev(gaps) / mean(gaps). Low CV = evenly spaced (bot), high CV = random (organic).
 * Returns -1 if insufficient data (<3 TXs with blockTime → <2 gaps).
 */
function computeTimingCV(sigs: ConfirmedSignatureInfo[]): number {
  // Extract blockTimes, filter nulls, sort ascending (oldest first)
  const times = sigs
    .filter(s => s.blockTime != null)
    .map(s => s.blockTime!)
    .sort((a, b) => a - b);
  if (times.length < 3) return -1; // Need at least 2 gaps

  // Calculate inter-TX gaps in seconds
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) {
    gaps.push(times[i] - times[i - 1]);
  }
  if (gaps.length < 2) return -1;

  const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  if (mean === 0) return 0; // All same-second → CV=0 (perfectly coordinated)

  const variance = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length;
  return Math.sqrt(variance) / mean;
}

/**
 * Detects bundled launches by counting transactions on the pump.fun bonding curve.
 *
 * Logic: A legitimate token that graduates needs ~85 SOL from hundreds of organic buyers.
 * A bundled launch has <20 TXs (creator + insiders buy the entire curve in few large TXs).
 *
 * Also checks for same-slot concentration: if 5+ buys happen in the same slot, it's
 * a coordinated launch (Jito bundles or same-block sniping).
 *
 * Speed: ~200-500ms (single RPC call to getSignaturesForAddress)
 */
export async function checkBundledLaunch(
  connection: Connection,
  tokenMint: PublicKey,
  poolCreationBlockTime?: number, // v8m: from pumpswap-monitor (for graduation timing fallback)
): Promise<BundleCheckResult> {
  try {
    // Derive bonding curve PDA for this token
    const [bondingCurve] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), tokenMint.toBuffer()],
      PUMPFUN_PROGRAM,
    );

    // Get transaction signatures (newest first, limit 100)
    // Works even after account is closed - Solana maintains TX history
    // v9k: Route through analysis RPC pool
    const sigs = await withAnalysisRetry(
      (conn) => conn.getSignaturesForAddress(bondingCurve, { limit: 100 }),
      connection,
    );

    const txCount = sigs.length;

    if (txCount === 0) {
      // v8m: Bonding curve history pruned (happens ~93% of the time).
      // Fallback: use token mint signatures to estimate graduation time.
      // 1 extra RPC call, but bonding curve call was wasted anyway.
      let fallbackGradTime = -1;
      try {
        if (poolCreationBlockTime) {
          // Try getting oldest TX on the token mint (= token creation time)
          const mintSigs = await withAnalysisRetry(
            (conn) => conn.getSignaturesForAddress(tokenMint, { limit: 100 }),
            connection,
          );
          if (mintSigs.length > 0) {
            const oldestMintTx = mintSigs[mintSigs.length - 1];
            if (oldestMintTx.blockTime) {
              // If we got < 100 results, this IS the oldest TX (token creation)
              // If we got exactly 100, there are more TXs = organic (>100 bonding curve buys)
              if (mintSigs.length < 100) {
                fallbackGradTime = poolCreationBlockTime - oldestMintTx.blockTime;
              } else {
                // >100 TXs on mint = likely organic growth, give neutral
                fallbackGradTime = 9999; // >45min = neutral in scorer
              }
            }
          }
        }
      } catch (err) {
        logger.debug(`[bundle] Mint fallback failed: ${String(err).slice(0, 60)}`);
      }

      const gradStr = fallbackGradTime >= 0
        ? `${Math.floor(fallbackGradTime / 60)}m${fallbackGradTime % 60}s (mint-fallback)`
        : 'N/A';
      logger.debug(`[bundle] No bonding curve history for ${tokenMint.toBase58().slice(0, 8)}... gradTime=${gradStr}`);
      return { txCount: 0, sameSlotCount: 0, isBundled: false, penalty: 0, graduationTimeSeconds: fallbackGradTime, earlyTxCount: 0, txVelocity: 0, uniqueSlots: 0, timingClusterCV: -1 };
    }

    // Cache sigs for wash-trading-detector (0 extra RPC calls)
    bondingCurveSigsCache.set(tokenMint.toBase58(), { sigs, timestamp: Date.now() });

    // Check same-slot concentration in the earliest (creation) slot
    const oldestSlot = sigs[sigs.length - 1].slot;
    const sameSlotCount = sigs.filter(s => s.slot === oldestSlot).length;

    // Calculate graduation timing (non-falsifiable signal)
    // oldestBlockTime = when bonding curve was created, now = graduation detected
    const oldestBlockTime = sigs[sigs.length - 1]?.blockTime ?? null;
    const graduationTimeSeconds = oldestBlockTime
      ? Math.floor(Date.now() / 1000) - oldestBlockTime
      : -1;

    // Calculate penalty based on TX count
    let penalty = 0;
    let isBundled = false;

    if (txCount < 15) {
      // Almost certainly bundled - entire bonding curve bought in <15 TXs
      penalty = -15;
      isBundled = true;
    } else if (txCount < 50) {
      // Probably bundled or very fast graduation
      penalty = -10;
      isBundled = true;
    } else if (txCount < 100 && txCount !== 100) {
      // Possibly bundled - fewer organic buyers than expected
      penalty = -5;
    }

    // Same-slot penalty (additive with TX count penalty)
    if (sameSlotCount > 5) {
      penalty = Math.min(penalty, -10); // At least -10 for coordinated launch
      isBundled = true;
    }

    // v8q: Early activity metrics (data collection only)
    const uniqueSlots = new Set(sigs.map(s => s.slot)).size;
    let earlyTxCount = 0;
    let txVelocity = 0;
    if (oldestBlockTime) {
      const earlyThreshold = oldestBlockTime + 60; // first 60 seconds
      earlyTxCount = sigs.filter(s => s.blockTime && s.blockTime <= earlyThreshold).length;
      txVelocity = graduationTimeSeconds > 0
        ? Math.round((txCount / graduationTimeSeconds) * 60) // TXs per minute
        : txCount; // all in <1s = entire count
    }

    const gradStr = graduationTimeSeconds >= 0
      ? `${Math.floor(graduationTimeSeconds / 60)}m${graduationTimeSeconds % 60}s`
      : 'N/A';
    logger.info(
      `[bundle] ${tokenMint.toBase58().slice(0, 8)}...: txCount=${txCount} sameSlot=${sameSlotCount} gradTime=${gradStr} early60s=${earlyTxCount} vel=${txVelocity}tx/min slots=${uniqueSlots} penalty=${penalty}${isBundled ? ' BUNDLED' : ''}`,
    );

    // v11n: Timing cluster CV — computed from existing sigs (0 extra RPC)
    const timingClusterCV = computeTimingCV(sigs);
    if (timingClusterCV >= 0) {
      logger.debug(`[bundle] ${tokenMint.toBase58().slice(0, 8)}... timingCV=${timingClusterCV.toFixed(2)} (${timingClusterCV < 0.3 ? 'BOT' : timingClusterCV > 0.5 ? 'organic' : 'mixed'})`);
    }

    return { txCount, sameSlotCount, isBundled, penalty, graduationTimeSeconds, earlyTxCount, txVelocity, uniqueSlots, timingClusterCV };
  } catch (err) {
    logger.debug(`[bundle] Check failed for ${tokenMint.toBase58().slice(0, 8)}...: ${String(err)}`);
    return { txCount: -1, sameSlotCount: 0, isBundled: false, penalty: 0, graduationTimeSeconds: -1, earlyTxCount: 0, txVelocity: 0, uniqueSlots: 0, timingClusterCV: -1 };
  }
}
