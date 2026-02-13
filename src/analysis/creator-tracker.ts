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
