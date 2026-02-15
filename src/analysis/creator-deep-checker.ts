import { type Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { withAnalysisRetry } from '../utils/analysis-rpc.js';
import { ScammerBlacklist } from './scammer-blacklist.js';
import { CreatorTracker } from './creator-tracker.js';

export interface CreatorDeepProfile {
  // From existing creator-checker.ts
  walletAgeSeconds: number;
  txCount: number;
  isNewWallet: boolean;

  // Funding source (2 hops)
  fundingSource: string | null;
  fundingSourceHop2: string | null;
  fundingNetworkSize: number;
  isKnownScammerNetwork: boolean;

  // Balance
  solBalance: number;
  isLowBalance: boolean;

  // v11m: Serial deployer detection
  recentTxCount24h: number;

  // Score for TokenScorer
  reputationScore: number;
  reputationReason: string;
}

/**
 * Trace who funded a wallet by looking at its oldest transaction.
 * Finds the account with the largest SOL decrease (excluding fees) = funder.
 */
async function traceFundingSource(
  connection: Connection,
  walletAddress: string,
  sigs: Array<{ signature: string; blockTime?: number | null }>,
): Promise<string | null> {
  if (sigs.length === 0) return null;

  try {
    // Get the oldest transaction (last in the array)
    const oldestSig = sigs[sigs.length - 1].signature;
    // v9k: Route through analysis RPC pool
    const tx = await withAnalysisRetry(
      (conn) => conn.getParsedTransaction(oldestSig, { maxSupportedTransactionVersion: 0 }),
      connection,
    );

    if (!tx?.meta || !tx.transaction.message.accountKeys) return null;

    const accountKeys = tx.transaction.message.accountKeys.map(k =>
      typeof k === 'string' ? k : k.pubkey.toBase58(),
    );
    const preBalances = tx.meta.preBalances;
    const postBalances = tx.meta.postBalances;

    // Find the account that lost the most SOL (funder)
    let maxDrop = 0;
    let funderIndex = -1;

    for (let i = 0; i < accountKeys.length; i++) {
      if (accountKeys[i] === walletAddress) continue; // Skip the wallet itself
      const drop = preBalances[i] - postBalances[i];
      if (drop > maxDrop) {
        maxDrop = drop;
        funderIndex = i;
      }
    }

    if (funderIndex >= 0 && maxDrop > 10000) {
      // At least 0.00001 SOL transferred
      return accountKeys[funderIndex];
    }

    return null;
  } catch (err) {
    logger.debug(`[creator-deep] traceFundingSource failed: ${String(err).slice(0, 100)}`);
    return null;
  }
}

/**
 * v11m: Serial deployer detection — check if creator has deployed many tokens recently.
 * Uses the creator's TX signatures (already fetched) to count recent activity.
 * Serial deployers launching 5+ tokens/day are almost always scammers.
 * Returns the count of transactions in the last 24h.
 */
function countRecentActivity(
  sigs: Array<{ signature: string; blockTime?: number | null }>,
  lookbackSeconds: number = 86400,
): number {
  const cutoff = Math.floor(Date.now() / 1000) - lookbackSeconds;
  return sigs.filter(s => s.blockTime && s.blockTime > cutoff).length;
}

/**
 * Compute reputation score based on creator profile.
 * Range: -20 to +10
 */
function computeReputationScore(
  profile: Omit<CreatorDeepProfile, 'reputationScore' | 'reputationReason'>,
  creatorTracker: CreatorTracker,
): { score: number; reason: string } {
  // Penalty: Known scammer network
  if (profile.isKnownScammerNetwork) {
    return { score: -20, reason: 'scammer_network' };
  }

  // v11m: Serial deployer penalty — creator has many recent TXs (likely deploying multiple tokens)
  // Data: scammers deploy 10+ tokens/day. With sig limit=10, if all 10 are in last 24h,
  // the wallet is hyper-active. 8+ recent TXs = heavy penalty, 6+ = moderate
  if (profile.recentTxCount24h >= 8) {
    return { score: -15, reason: `serial_deployer_${profile.recentTxCount24h}tx_24h` };
  }
  if (profile.recentTxCount24h >= 6) {
    return { score: -10, reason: `active_deployer_${profile.recentTxCount24h}tx_24h` };
  }

  // Penalty: Funder has 2+ creators that rugged
  if (profile.fundingNetworkSize >= 2) {
    return { score: -15, reason: `funder_${profile.fundingNetworkSize}_creators` };
  }

  // v11l: Check if funder is also a token creator with rug history
  if (profile.fundingSource) {
    const funderHistory = creatorTracker.getCreatorHistory(profile.fundingSource);
    if (funderHistory.rugs >= 1) {
      return { score: -15, reason: `funder_rugged_${funderHistory.rugs}x` };
    }
  }

  // Penalty: New wallet + low balance (throwaway deployer)
  if (profile.isNewWallet && profile.isLowBalance) {
    return { score: -10, reason: 'new_wallet_low_balance' };
  }

  // v11b→v11g: Creator < 5min — penalty deferred to slow phase (not applied at fast stage).
  // Data (N=4,733): 65% of ALL creators are <5min. 92% of winners AND 93% of losers are <5min.
  // v11g: Increased from -3 to -7 (user request). Most rugs come from young wallets.
  if (profile.walletAgeSeconds < 300) {
    return { score: -7, reason: 'young_wallet_under_5min' };
  }

  // Penalty: Very new with few txs
  if (profile.walletAgeSeconds < 86400 && profile.txCount < 3) {
    return { score: -5, reason: 'young_inactive_wallet' };
  }

  // Bonus: Mature wallet with history
  if (profile.walletAgeSeconds > 30 * 86400 && profile.txCount >= 10) {
    return { score: 5, reason: 'mature_wallet' };
  }

  return { score: 0, reason: 'neutral' };
}

// v9x: In-memory cache for creator profiles (10 min TTL)
// Same creator deploying multiple pools = no need to re-check 4-5 RPCs
const creatorProfileCache = new Map<string, { profile: CreatorDeepProfile; timestamp: number }>();
const CREATOR_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Get a comprehensive deep profile of a token creator.
 * Runs 3-5 RPC calls but is designed to run in parallel with scoring.
 * Fails gracefully - returns neutral profile on any error.
 * v9x: Cached by creator address with 10min TTL.
 */
export async function getCreatorDeepProfile(
  connection: Connection,
  creatorAddress: string,
  blacklist: ScammerBlacklist,
  creatorTracker: CreatorTracker,
): Promise<CreatorDeepProfile> {
  // v9x: Check cache first — saves 4-5 RPCs for repeat creators
  const cached = creatorProfileCache.get(creatorAddress);
  if (cached && (Date.now() - cached.timestamp) < CREATOR_CACHE_TTL_MS) {
    logger.info(`[creator-deep] Cache hit for ${creatorAddress.slice(0, 8)}... rep=${cached.profile.reputationScore}(${cached.profile.reputationReason})`);
    return cached.profile;
  }
  const neutral: CreatorDeepProfile = {
    walletAgeSeconds: -1,
    txCount: -1,
    isNewWallet: false,
    fundingSource: null,
    fundingSourceHop2: null,
    fundingNetworkSize: 0,
    isKnownScammerNetwork: false,
    solBalance: 0,
    isLowBalance: false,
    recentTxCount24h: 0,
    reputationScore: 0,
    reputationReason: 'error_fallback',
  };

  try {
    const pubkey = new PublicKey(creatorAddress);

    // Step 1: Get signatures + balance in parallel (v9k: via analysis RPC pool)
    const [sigs, balanceLamports] = await Promise.all([
      withAnalysisRetry((conn) => conn.getSignaturesForAddress(pubkey, { limit: 10 }), connection),
      withAnalysisRetry((conn) => conn.getBalance(pubkey), connection),
    ]);

    if (sigs.length === 0) {
      return {
        ...neutral,
        txCount: 0,
        walletAgeSeconds: 0,
        isNewWallet: true,
        solBalance: 0,
        isLowBalance: true,
        recentTxCount24h: 0,
        reputationScore: -10,
        reputationReason: 'brand_new_wallet',
      };
    }

    const now = Math.floor(Date.now() / 1000);
    const oldest = sigs[sigs.length - 1];
    const walletAgeSeconds = oldest.blockTime ? now - oldest.blockTime : 0;
    const txCount = sigs.length;
    const solBalance = balanceLamports / 1e9;
    const isNewWallet = walletAgeSeconds < 3600;
    const isLowBalance = solBalance < 0.1;

    // Step 2: Trace funding source (hop 1)
    const fundingSource = await traceFundingSource(connection, creatorAddress, sigs);

    // Step 3: Check if funder is blacklisted + get network size
    let fundingSourceHop2: string | null = null;
    let fundingNetworkSize = 0;
    let isKnownScammerNetwork = false;

    if (fundingSource) {
      // Check blacklist
      isKnownScammerNetwork = blacklist.isBlacklisted(fundingSource);

      // Get network size (how many creators share this funder)
      const networkCreators = creatorTracker.getCreatorsByFundingSource(fundingSource);
      fundingNetworkSize = networkCreators.length;

      // Auto-promote to blacklist if 2+ rug creators from same funder
      if (fundingNetworkSize >= 2) {
        blacklist.checkAndAutoPromote(fundingSource, creatorTracker);
      }

      // Step 4: Trace hop 2 (funder's funder) - only if not already blacklisted
      if (!isKnownScammerNetwork) {
        try {
          const funderPubkey = new PublicKey(fundingSource);
          const funderSigs = await withAnalysisRetry(
            (conn) => conn.getSignaturesForAddress(funderPubkey, { limit: 10 }),
            connection,
          );
          fundingSourceHop2 = await traceFundingSource(connection, fundingSource, funderSigs);

          // Check hop2 against blacklist too
          if (fundingSourceHop2 && blacklist.isBlacklisted(fundingSourceHop2)) {
            isKnownScammerNetwork = true;
          }

          // Check if hop2 funds many creators
          if (fundingSourceHop2 && !isKnownScammerNetwork) {
            const hop2Creators = creatorTracker.getCreatorsByFundingSource(fundingSourceHop2);
            if (hop2Creators.length >= 2) {
              blacklist.checkAndAutoPromote(fundingSourceHop2, creatorTracker);
              isKnownScammerNetwork = true;
            }
          }
        } catch {
          // Hop 2 failure is non-critical
        }
      }

      // v11i Step 5: Trace hop 3 — catches Hard Disperse obfuscation (1 extra RPC call)
      // Scammers use 3-4 intermediate wallets to hide funding source from 2-hop tracing
      if (!isKnownScammerNetwork && fundingSourceHop2) {
        try {
          const hop2Pubkey = new PublicKey(fundingSourceHop2);
          const hop2Sigs = await withAnalysisRetry(
            (conn) => conn.getSignaturesForAddress(hop2Pubkey, { limit: 10 }),
            connection,
          );
          const fundingSourceHop3 = await traceFundingSource(connection, fundingSourceHop2, hop2Sigs);

          if (fundingSourceHop3) {
            if (blacklist.isBlacklisted(fundingSourceHop3)) {
              isKnownScammerNetwork = true;
            } else {
              const hop3Creators = creatorTracker.getCreatorsByFundingSource(fundingSourceHop3);
              if (hop3Creators.length >= 2) {
                blacklist.checkAndAutoPromote(fundingSourceHop3, creatorTracker);
                isKnownScammerNetwork = true;
              }
            }
          }
        } catch {
          // Hop 3 failure is non-critical
        }
      }
    }

    // v11m: Count recent activity for serial deployer detection (zero-cost — uses existing sigs)
    const recentTxCount24h = countRecentActivity(sigs);

    const partialProfile = {
      walletAgeSeconds,
      txCount,
      isNewWallet,
      fundingSource,
      fundingSourceHop2,
      fundingNetworkSize,
      isKnownScammerNetwork,
      solBalance,
      isLowBalance,
      recentTxCount24h,
    };

    const { score, reason } = computeReputationScore(partialProfile, creatorTracker);

    const profile: CreatorDeepProfile = {
      ...partialProfile,
      reputationScore: score,
      reputationReason: reason,
    };

    const ageStr = walletAgeSeconds > 86400
      ? `${(walletAgeSeconds / 86400).toFixed(1)}d`
      : walletAgeSeconds > 3600
        ? `${(walletAgeSeconds / 3600).toFixed(1)}h`
        : `${walletAgeSeconds}s`;

    logger.info(
      `[creator-deep] ${creatorAddress.slice(0, 8)}... age=${ageStr} txs=${txCount}${txCount >= 10 ? '+' : ''} recent24h=${recentTxCount24h} bal=${solBalance.toFixed(3)} funder=${fundingSource?.slice(0, 8) ?? 'N/A'} network=${fundingNetworkSize} rep=${score}(${reason})`,
    );

    // v9x: Cache successful profiles
    creatorProfileCache.set(creatorAddress, { profile, timestamp: Date.now() });
    // Cleanup old entries when cache grows
    if (creatorProfileCache.size > 200) {
      const cutoff = Date.now() - CREATOR_CACHE_TTL_MS;
      for (const [addr, entry] of creatorProfileCache) {
        if (entry.timestamp < cutoff) creatorProfileCache.delete(addr);
      }
    }

    return profile;
  } catch (err) {
    logger.debug(`[creator-deep] Profile failed for ${creatorAddress.slice(0, 8)}...: ${String(err).slice(0, 100)}`);
    return neutral;
  }
}
