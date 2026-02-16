import { getDb } from '../data/database.js';
import { logger } from '../utils/logger.js';

export interface CreatorHistory {
  totalTokens: number;
  rugs: number;
  winners: number;
  losers: number;
  avgPnlPct: number;
  isRepeatRugger: boolean; // true if creator has 2+ rugs
}

// v11y: Network rug history from pool_outcome data (zero RPC, pure SQLite)
export interface NetworkRugResult {
  creatorPriorRugs: number;
  funderPriorRugs: number;
  funderHop2PriorRugs: number;
  penalty: number;
  reason: string | null;
  shouldBlock: boolean;
}

export class CreatorTracker {
  /**
   * Record a new (creator, token) pair when a pool is detected.
   * Called at detection time (before buy decision).
   */
  recordCreator(creatorWallet: string, tokenMint: string, poolAddress?: string): void {
    try {
      const db = getDb();
      db.prepare(`
        INSERT OR IGNORE INTO token_creators (creator_wallet, token_mint, pool_address)
        VALUES (?, ?, ?)
      `).run(creatorWallet, tokenMint, poolAddress ?? null);
    } catch (err) {
      logger.debug(`[creator-tracker] Failed to record creator: ${err}`);
    }
  }

  /**
   * Check creator's history. Returns stats on their past tokens.
   * This is the main anti-rug check: if creator has 2+ rugs, skip buying.
   * Query is <1ms on indexed SQLite table.
   */
  getCreatorHistory(creatorWallet: string): CreatorHistory {
    try {
      const db = getDb();
      const row = db.prepare(`
        SELECT
          COUNT(*) as total_tokens,
          SUM(CASE WHEN outcome = 'rug' THEN 1 ELSE 0 END) as rugs,
          SUM(CASE WHEN outcome = 'winner' THEN 1 ELSE 0 END) as winners,
          SUM(CASE WHEN outcome = 'loser' THEN 1 ELSE 0 END) as losers,
          AVG(CASE WHEN pnl_pct IS NOT NULL THEN pnl_pct ELSE NULL END) as avg_pnl_pct
        FROM token_creators
        WHERE creator_wallet = ?
      `).get(creatorWallet) as { total_tokens: number; rugs: number; winners: number; losers: number; avg_pnl_pct: number | null } | undefined;

      if (!row || row.total_tokens === 0) {
        return { totalTokens: 0, rugs: 0, winners: 0, losers: 0, avgPnlPct: 0, isRepeatRugger: false };
      }

      return {
        totalTokens: row.total_tokens,
        rugs: row.rugs,
        winners: row.winners,
        losers: row.losers,
        avgPnlPct: row.avg_pnl_pct ?? 0,
        isRepeatRugger: row.rugs >= 2,
      };
    } catch (err) {
      logger.debug(`[creator-tracker] Failed to get history: ${err}`);
      return { totalTokens: 0, rugs: 0, winners: 0, losers: 0, avgPnlPct: 0, isRepeatRugger: false };
    }
  }

  /**
   * Update a token's outcome after a position closes.
   * Called from position-manager when position is closed/stopped.
   */
  updateOutcome(tokenMint: string, pnlPct: number): void {
    try {
      const db = getDb();
      let outcome: string;
      if (pnlPct <= -90) {
        outcome = 'rug';       // -90% or worse = rug pull
      } else if (pnlPct < -5) {
        outcome = 'loser';
      } else if (pnlPct > 5) {
        outcome = 'winner';
      } else {
        outcome = 'breakeven';
      }

      const result = db.prepare(`
        UPDATE token_creators SET outcome = ?, pnl_pct = ?
        WHERE token_mint = ?
      `).run(outcome, pnlPct, tokenMint);

      if (result.changes > 0) {
        logger.debug(`[creator-tracker] Updated ${tokenMint.slice(0, 8)}... outcome=${outcome} (${pnlPct.toFixed(1)}%)`);
      }
    } catch (err) {
      logger.debug(`[creator-tracker] Failed to update outcome: ${err}`);
    }
  }

  /**
   * Check if a creator is "trusted" (has history of winners).
   * Used to potentially give bonus points in scoring.
   */
  isGoodCreator(creatorWallet: string): boolean {
    const history = this.getCreatorHistory(creatorWallet);
    return history.winners >= 2 && history.rugs === 0;
  }

  /**
   * Get top repeat ruggers for reporting.
   */
  /**
   * Save deep profile data (funding source, wallet age, etc.) for a creator.
   * Called after getCreatorDeepProfile() completes.
   */
  updateDeepProfile(creatorWallet: string, profile: {
    fundingSource: string | null;
    fundingSourceHop2: string | null;
    walletAgeSeconds: number;
    txCount: number;
    solBalance: number;
    reputationScore: number;
  }): void {
    try {
      const db = getDb();
      db.prepare(`
        UPDATE token_creators
        SET funding_source = ?, funding_source_hop2 = ?,
            wallet_age_seconds = ?, tx_count = ?,
            sol_balance_lamports = ?, reputation_score = ?
        WHERE creator_wallet = ?
      `).run(
        profile.fundingSource,
        profile.fundingSourceHop2,
        profile.walletAgeSeconds,
        profile.txCount,
        Math.round(profile.solBalance * 1e9),
        profile.reputationScore,
        creatorWallet,
      );
    } catch (err) {
      logger.debug(`[creator-tracker] Failed to update deep profile: ${err}`);
    }
  }

  /**
   * Find all creators that share the same funding source.
   * Used to detect scammer networks (same wallet funding multiple token creators).
   */
  getCreatorsByFundingSource(fundingSource: string): string[] {
    try {
      const db = getDb();
      const rows = db.prepare(`
        SELECT DISTINCT creator_wallet FROM token_creators
        WHERE funding_source = ?
      `).all(fundingSource) as Array<{ creator_wallet: string }>;
      return rows.map(r => r.creator_wallet);
    } catch (err) {
      logger.debug(`[creator-tracker] Failed to get creators by funding source: ${err}`);
      return [];
    }
  }

  /**
   * v11y: Check network rug history using pool_outcome data.
   * Looks up if this creator, funder, or funder_hop2 has prior rugs in detected_pools.
   * Zero RPC calls — pure SQLite JOINs. <1ms.
   */
  getNetworkRugHistory(
    creatorWallet: string,
    fundingSource: string | null,
    fundingSourceHop2: string | null,
  ): NetworkRugResult {
    const result: NetworkRugResult = {
      creatorPriorRugs: 0,
      funderPriorRugs: 0,
      funderHop2PriorRugs: 0,
      penalty: 0,
      reason: null,
      shouldBlock: false,
    };

    try {
      const db = getDb();

      // 1. Creator prior rugs: other tokens by same creator with pool_outcome='rug'
      const creatorRow = db.prepare(`
        SELECT COUNT(*) as cnt FROM token_creators tc
        JOIN detected_pools dp ON tc.token_mint = dp.base_mint
        WHERE tc.creator_wallet = ? AND dp.pool_outcome = 'rug'
      `).get(creatorWallet) as { cnt: number } | undefined;
      result.creatorPriorRugs = creatorRow?.cnt ?? 0;

      // 2. Funder prior rugs: other creators funded by same funder with pool_outcome='rug'
      if (fundingSource) {
        const funderRow = db.prepare(`
          SELECT COUNT(DISTINCT tc.creator_wallet) as cnt FROM token_creators tc
          JOIN detected_pools dp ON tc.token_mint = dp.base_mint
          WHERE tc.funding_source = ? AND dp.pool_outcome = 'rug'
            AND tc.creator_wallet != ?
        `).get(fundingSource, creatorWallet) as { cnt: number } | undefined;
        result.funderPriorRugs = funderRow?.cnt ?? 0;
      }

      // 3. Funder hop2 prior rugs: same as above but for 2nd-hop funder
      if (fundingSourceHop2) {
        const hop2Row = db.prepare(`
          SELECT COUNT(DISTINCT tc.creator_wallet) as cnt FROM token_creators tc
          JOIN detected_pools dp ON tc.token_mint = dp.base_mint
          WHERE tc.funding_source_hop2 = ? AND dp.pool_outcome = 'rug'
            AND tc.creator_wallet != ?
        `).get(fundingSourceHop2, creatorWallet) as { cnt: number } | undefined;
        result.funderHop2PriorRugs = hop2Row?.cnt ?? 0;
      }

      // Compute penalty and block decision
      if (result.creatorPriorRugs >= 2) {
        result.penalty = -25;
        result.reason = `creator ${creatorWallet.slice(0, 8)} has ${result.creatorPriorRugs} prior rugs (pool_outcome)`;
        result.shouldBlock = true;
      } else if (result.funderPriorRugs >= 3) {
        result.penalty = -25;
        result.reason = `funder ${fundingSource!.slice(0, 8)} funded ${result.funderPriorRugs} creators with rugs`;
        result.shouldBlock = true;
      } else {
        // Accumulate softer penalties
        if (result.creatorPriorRugs === 1) {
          result.penalty -= 10;
          result.reason = `creator has 1 prior rug (pool_outcome)`;
        }
        if (result.funderPriorRugs >= 1) {
          result.penalty -= 10;
          const funderReason = `funder has ${result.funderPriorRugs} rug-creators`;
          result.reason = result.reason ? `${result.reason}, ${funderReason}` : funderReason;
        }
        if (result.funderHop2PriorRugs >= 3) {
          result.penalty -= 15;
          const hop2Reason = `funder_hop2 has ${result.funderHop2PriorRugs} rug-creators`;
          result.reason = result.reason ? `${result.reason}, ${hop2Reason}` : hop2Reason;
        }
        // Block if accumulated penalty is severe enough
        if (result.penalty <= -25) {
          result.shouldBlock = true;
        }
      }
    } catch (err) {
      logger.debug(`[creator-tracker] Network rug history check failed: ${err}`);
    }

    return result;
  }

  getTopRuggers(limit = 10): Array<{ creator_wallet: string; rug_count: number; total_tokens: number }> {
    try {
      const db = getDb();
      return db.prepare(`
        SELECT creator_wallet,
               SUM(CASE WHEN outcome = 'rug' THEN 1 ELSE 0 END) as rug_count,
               COUNT(*) as total_tokens
        FROM token_creators
        GROUP BY creator_wallet
        HAVING rug_count >= 2
        ORDER BY rug_count DESC
        LIMIT ?
      `).all(limit) as Array<{ creator_wallet: string; rug_count: number; total_tokens: number }>;
    } catch {
      return [];
    }
  }
}
