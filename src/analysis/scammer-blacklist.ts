import { getDb } from '../data/database.js';
import { logger } from '../utils/logger.js';
import type { CreatorTracker } from './creator-tracker.js';

export class ScammerBlacklist {
  private blacklistedWallets = new Set<string>();

  constructor() {
    this.loadFromDb();
  }

  /** Load blacklist from SQLite into memory for O(1) lookups */
  private loadFromDb(): void {
    try {
      const db = getDb();
      const rows = db.prepare('SELECT wallet FROM scammer_blacklist').all() as Array<{ wallet: string }>;
      for (const row of rows) {
        this.blacklistedWallets.add(row.wallet);
      }
      if (rows.length > 0) {
        logger.info(`[blacklist] Loaded ${rows.length} blacklisted wallets`);
      }
    } catch (err) {
      logger.debug(`[blacklist] Failed to load from DB: ${err}`);
    }
  }

  /** O(1) check if a wallet is blacklisted */
  isBlacklisted(wallet: string): boolean {
    return this.blacklistedWallets.has(wallet);
  }

  /** Add a wallet to the blacklist */
  addToBlacklist(wallet: string, reason: string): void {
    if (this.blacklistedWallets.has(wallet)) return;

    try {
      const db = getDb();
      db.prepare(`
        INSERT OR IGNORE INTO scammer_blacklist (wallet, reason, linked_rug_count)
        VALUES (?, ?, 0)
      `).run(wallet, reason);
      this.blacklistedWallets.add(wallet);
      logger.warn(`[blacklist] Added ${wallet.slice(0, 8)}... reason: ${reason}`);
    } catch (err) {
      logger.debug(`[blacklist] Failed to add wallet: ${err}`);
    }
  }

  /**
   * Check if a funding source should be auto-promoted to blacklist.
   * Auto-blacklists if the funder has 3+ creators that rugged.
   */
  checkAndAutoPromote(fundingSource: string, creatorTracker: CreatorTracker): boolean {
    if (this.blacklistedWallets.has(fundingSource)) return true;

    try {
      const creators = creatorTracker.getCreatorsByFundingSource(fundingSource);
      if (creators.length < 2) return false;

      // Count how many of those creators have rug outcomes
      let rugCount = 0;
      for (const creator of creators) {
        const history = creatorTracker.getCreatorHistory(creator);
        if (history.rugs > 0) rugCount++;
      }

      if (rugCount >= 2) {
        this.addToBlacklist(fundingSource, `auto_promote: ${rugCount} rug creators funded`);

        // Update linked_rug_count
        const db = getDb();
        db.prepare('UPDATE scammer_blacklist SET linked_rug_count = ? WHERE wallet = ?')
          .run(rugCount, fundingSource);

        return true;
      }

      return false;
    } catch (err) {
      logger.debug(`[blacklist] Auto-promote check failed: ${err}`);
      return false;
    }
  }

  /**
   * v11y: Auto-promote wallets to blacklist based on pool_outcome rug data.
   * If a creator or funder has 3+ rugs in detected_pools, blacklist them.
   */
  promoteFromPoolOutcome(wallet: string, rugCount: number, role: 'creator' | 'funder'): void {
    if (rugCount < 3 || this.blacklistedWallets.has(wallet)) return;

    const reason = `pool_outcome_${role}: ${rugCount} rugs`;
    this.addToBlacklist(wallet, reason);

    try {
      const db = getDb();
      db.prepare('UPDATE scammer_blacklist SET linked_rug_count = ? WHERE wallet = ?')
        .run(rugCount, wallet);
    } catch (err) {
      logger.debug(`[blacklist] Failed to update rug count after pool_outcome promote: ${err}`);
    }
  }

  /** Get total count of blacklisted wallets */
  get size(): number {
    return this.blacklistedWallets.size;
  }
}
