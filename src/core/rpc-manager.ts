import { Connection, type ConnectionConfig } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { RateLimiter } from '../utils/rate-limiter.js';

interface RpcEndpoint {
  url: string;
  connection: Connection;
  healthy: boolean;
  latencyMs: number;
  failCount: number;
  lastCheck: number;
}

export class RpcManager {
  private endpoints: RpcEndpoint[] = [];
  private currentIndex = 0;
  private rateLimiter: RateLimiter;
  private healthCheckInterval?: ReturnType<typeof setInterval>;
  private cacheWarmingInterval?: ReturnType<typeof setInterval>;

  constructor(
    urls: string[],
    private readonly wsUrl?: string,
    rateLimit = 50, // v11a: Helius paid tier: 50 req/s (was 10 free)
  ) {
    this.rateLimiter = new RateLimiter(rateLimit, rateLimit);

    const connConfig: ConnectionConfig = {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 30_000,
      wsEndpoint: this.wsUrl,
      disableRetryOnRateLimit: true, // Prevent @solana/web3.js from auto-retrying 429s (causes cascade)
    };

    for (const url of urls) {
      this.endpoints.push({
        url,
        connection: new Connection(url, connConfig),
        healthy: true,
        latencyMs: 0,
        failCount: 0,
        lastCheck: 0,
      });
    }
  }

  get connection(): Connection {
    const healthy = this.endpoints.filter((e) => e.healthy);
    if (healthy.length === 0) {
      logger.warn('[rpc] No healthy endpoints, using first');
      return this.endpoints[0].connection;
    }
    // Round-robin among healthy
    this.currentIndex = (this.currentIndex + 1) % healthy.length;
    return healthy[this.currentIndex].connection;
  }

  /** Primary connection (first endpoint) for WebSocket subscriptions */
  get primaryConnection(): Connection {
    return this.endpoints[0].connection;
  }

  get wsConnection(): Connection {
    if (this.wsUrl) {
      return this.endpoints[0].connection;
    }
    return this.primaryConnection;
  }

  async acquireRate(count = 1): Promise<void> {
    await this.rateLimiter.acquire(count);
  }

  startHealthChecks(intervalMs = 30_000): void {
    this.healthCheckInterval = setInterval(() => this.checkHealth(), intervalMs);
    this.checkHealth();
    // v11g: Start cache warming alongside health checks
    this.startCacheWarming();
  }

  stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    this.stopCacheWarming();
  }

  // v11g: Cache warming — keep TCP connections alive + Gatekeeper regional cache hot
  // Helius docs recommend getHealth/getSlot every 1s for connection reuse (35ms → 0.5ms)
  // Cost: 1 credit/s = 86,400 credits/day = 0.86% of 10M monthly budget
  private startCacheWarming(): void {
    if (this.cacheWarmingInterval) return; // already running
    this.cacheWarmingInterval = setInterval(() => {
      this.endpoints[0].connection.getSlot('processed').catch(() => {});
    }, 1_000);
    logger.info('[rpc] Cache warming started (getSlot every 1s)');
  }

  private stopCacheWarming(): void {
    if (this.cacheWarmingInterval) {
      clearInterval(this.cacheWarmingInterval);
      this.cacheWarmingInterval = undefined;
      logger.info('[rpc] Cache warming stopped');
    }
  }

  // v10a: Prevent overlapping health checks — if getSlot hangs 30s+, next interval
  // fires while previous still running, creating cascading hangs
  private isChecking = false;

  private async checkHealth(): Promise<void> {
    // v10a: Skip if previous check still running
    if (this.isChecking) {
      logger.debug('[rpc] Health check skipped (previous still running)');
      return;
    }
    this.isChecking = true;

    try {
      for (const ep of this.endpoints) {
        const start = Date.now();
        try {
          // v10a: 5s timeout on health check getSlot — prevents indefinite hangs
          // Without this, getSlot on Helius during load can hang 30-60s
          await Promise.race([
            ep.connection.getSlot(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('health check timeout')), 5_000),
            ),
          ]);
          ep.latencyMs = Date.now() - start;
          ep.healthy = true;
          ep.failCount = 0;
        } catch {
          ep.failCount++;
          ep.latencyMs = -1;
          if (ep.failCount >= 3) {
            ep.healthy = false;
            logger.error(`[rpc] Endpoint unhealthy: ${new URL(ep.url).hostname} (${ep.failCount} consecutive fails)`);
          }
        }
        ep.lastCheck = Date.now();

        // v10a: Auto-recover — if unhealthy for 90s+, reset failCount to give it another chance
        // Was >5 (150s+) which was too slow — Helius recovers in ~60s typically
        if (!ep.healthy && ep.failCount > 3) {
          ep.failCount = 2; // Next success → healthy
          logger.info(`[rpc] Auto-recover: reset ${new URL(ep.url).hostname} failCount for retry`);
        }
      }

      const healthyCount = this.endpoints.filter((e) => e.healthy).length;
      logger.debug(`[rpc] Health check: ${healthyCount}/${this.endpoints.length} healthy`);
    } finally {
      this.isChecking = false;
    }
  }

  getStatus(): Array<{ url: string; healthy: boolean; latencyMs: number }> {
    return this.endpoints.map((e) => ({
      url: e.url.replace(/api-key=[\w-]+/, 'api-key=***'),
      healthy: e.healthy,
      latencyMs: e.latencyMs,
    }));
  }
}
