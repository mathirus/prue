import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';

const ALLENHARK_URL = 'https://allenhark.com/blacklist.jsonl';
const LOCAL_FALLBACK = join(process.cwd(), 'data', 'allenhark-blacklist.jsonl');
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const FETCH_TIMEOUT_MS = 15_000;

/**
 * External scammer blacklist from AllenHark (4,178+ wallets).
 * In-memory Set for O(1) lookups. Refreshes every 6h.
 * Graceful degradation: if fetch fails, keeps existing Set.
 */
export class AllenHarkBlacklist {
  private wallets = new Set<string>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private lastLoadedAt = 0;

  /** Load initial data and schedule periodic refresh */
  async init(): Promise<void> {
    await this.loadFromUrl();
    // v10d: If URL fetch failed, try local fallback file
    if (this.wallets.size === 0) {
      this.loadFromLocalFile();
    }
    this.refreshTimer = setInterval(() => {
      this.loadFromUrl().catch((err) => {
        logger.debug(`[allenhark] Scheduled refresh failed: ${err}`);
      });
    }, REFRESH_INTERVAL_MS);
  }

  /** v10d: Load from local JSONL file as fallback */
  private loadFromLocalFile(): void {
    try {
      const text = readFileSync(LOCAL_FALLBACK, 'utf-8');
      const parsed = this.parseJsonl(text);
      if (parsed.size > 0) {
        this.wallets = parsed;
        this.lastLoadedAt = Date.now();
        logger.info(`[allenhark] Loaded ${parsed.size} wallets from local fallback`);
      }
    } catch {
      logger.debug(`[allenhark] No local fallback at ${LOCAL_FALLBACK}`);
    }
  }

  /** Parse JSONL text into a Set of wallet addresses */
  private parseJsonl(text: string): Set<string> {
    const wallets = new Set<string>();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        const wallet = obj.addr || obj.wallet || obj.address || obj.pubkey;
        if (wallet && typeof wallet === 'string' && wallet.length >= 32) {
          wallets.add(wallet);
        }
      } catch {
        if (trimmed.length >= 32 && trimmed.length <= 44 && !trimmed.includes('{')) {
          wallets.add(trimmed);
        }
      }
    }
    return wallets;
  }

  /** Fetch JSONL from AllenHark and populate Set */
  async loadFromUrl(): Promise<void> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const res = await fetch(ALLENHARK_URL, { signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) {
        logger.warn(`[allenhark] HTTP ${res.status} from ${ALLENHARK_URL}`);
        return;
      }

      const text = await res.text();
      const newWallets = this.parseJsonl(text);

      if (newWallets.size > 0) {
        this.wallets = newWallets;
        this.lastLoadedAt = Date.now();
        logger.info(`[allenhark] Loaded ${newWallets.size} blacklisted wallets from URL`);
      } else {
        logger.warn(`[allenhark] Parsed 0 wallets from response (${text.length} bytes), keeping existing ${this.wallets.size}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('abort')) {
        logger.warn(`[allenhark] Fetch timed out (${FETCH_TIMEOUT_MS / 1000}s), keeping existing ${this.wallets.size} wallets`);
      } else {
        logger.warn(`[allenhark] Fetch failed: ${msg.slice(0, 100)}, keeping existing ${this.wallets.size} wallets`);
      }
    }
  }

  /** O(1) check if a wallet is blacklisted */
  isBlacklisted(wallet: string): boolean {
    return this.wallets.has(wallet);
  }

  get size(): number {
    return this.wallets.size;
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}
