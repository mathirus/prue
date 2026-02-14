import { Connection, type ConnectionConfig } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { RateLimiter } from '../utils/rate-limiter.js';

// v11k: Replaced agentkeepalive + node-fetch with globalThis.fetch (undici).
// Root cause: agentkeepalive creates socket storms (69 sockets for 6 requests)
// during Helius blips, blocking the event loop and making the bot unable to sell.
// curl works fine (188ms) while node-fetch+agent times out at 9-12s.
// undici (built into Node.js 18+) manages its own connection pool robustly.
// No custom socket management = no socket pool poisoning.

interface RpcEndpoint {
  url: string;
  connection: Connection;
  healthy: boolean;
  latencyMs: number;
  failCount: number;
  lastCheck: number;
  lastConnectionReset: number;
}

export class RpcManager {
  private endpoints: RpcEndpoint[] = [];
  private currentIndex = 0;
  private rateLimiter: RateLimiter;
  private healthCheckInterval?: ReturnType<typeof setInterval>;
  private cacheWarmingInterval?: ReturnType<typeof setInterval>;
  private readonly baseConnConfig: Omit<ConnectionConfig, 'httpAgent' | 'fetch'>;
  private connectionResetCallbacks: Array<() => void> = [];
  private isChecking = false;

  constructor(
    urls: string[],
    private readonly wsUrl?: string,
    rateLimit = 50, // v11a: Helius paid tier: 50 req/s (was 10 free)
  ) {
    this.rateLimiter = new RateLimiter(rateLimit, rateLimit);

    this.baseConnConfig = {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 30_000,
      wsEndpoint: this.wsUrl,
      disableRetryOnRateLimit: true,
    };

    for (const url of urls) {
      this.endpoints.push({
        url,
        connection: this.createConnection(url),
        healthy: true,
        latencyMs: 0,
        failCount: 0,
        lastCheck: 0,
        lastConnectionReset: 0,
      });
    }
  }

  // v11k: Simple fetch wrapper with AbortController timeout.
  // globalThis.fetch (undici) manages its own connection pool with proper keep-alive.
  // No agentkeepalive = no socket storms = no event loop blocking.
  private createFetchWithTimeout() {
    const FETCH_TIMEOUT_MS = 9_000;
    return async (url: string | URL, init?: Record<string, unknown>): Promise<Response> => {
      const controller = new AbortController();
      const start = Date.now();
      const timer = setTimeout(() => {
        const elapsed = Date.now() - start;
        logger.warn(`[rpc] FETCH TIMEOUT (${elapsed}ms): ${String(url).substring(0, 60)}...`);
        controller.abort();
      }, FETCH_TIMEOUT_MS);
      try {
        const response = await globalThis.fetch(String(url), {
          ...init as RequestInit,
          signal: controller.signal,
        });
        return response;
      } finally {
        clearTimeout(timer);
      }
    };
  }

  // v11k: Connection with globalThis.fetch + timeout wrapper
  private createConnection(url: string): Connection {
    return new Connection(url, {
      ...this.baseConnConfig,
      httpAgent: false,
      fetch: this.createFetchWithTimeout() as unknown as ConnectionConfig['fetch'],
    });
  }

  // v11j: Register callback for connection reset events
  onConnectionReset(callback: () => void): void {
    this.connectionResetCallbacks.push(callback);
  }

  get connection(): Connection {
    const healthy = this.endpoints.filter((e) => e.healthy);
    if (healthy.length === 0) {
      logger.warn('[rpc] No healthy endpoints, using first');
      return this.endpoints[0].connection;
    }
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
    this.startCacheWarming();
  }

  stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    this.stopCacheWarming();
  }

  // v11g: Cache warming — keep connections alive + Gatekeeper regional cache hot
  private startCacheWarming(): void {
    if (this.cacheWarmingInterval) return;
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

  private async checkHealth(): Promise<void> {
    if (this.isChecking) {
      logger.debug('[rpc] Health check skipped (previous still running)');
      return;
    }
    this.isChecking = true;

    try {
      for (const ep of this.endpoints) {
        const start = Date.now();
        try {
          await Promise.race([
            ep.connection.getSlot(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('health check timeout')), 5_000),
            ),
          ]);
          ep.latencyMs = Date.now() - start;
          ep.healthy = true;
          ep.failCount = 0;
        } catch (err) {
          ep.failCount++;
          ep.latencyMs = -1;
          const hostname = new URL(ep.url).hostname;
          const elapsed = Date.now() - start;
          const errMsg = err instanceof Error ? err.message : String(err);
          if (ep.failCount >= 2) {
            logger.error(
              `[rpc] Endpoint fail: ${hostname} (${ep.failCount} consecutive, ${elapsed}ms) — ${errMsg}`,
            );
          }
          if (ep.failCount >= 3) {
            ep.healthy = false;
          }
        }
        ep.lastCheck = Date.now();

        // v11k: Connection reset at 3+ consecutive fails with 30s cooldown
        if (ep.failCount >= 3 && Date.now() - ep.lastConnectionReset >= 30_000) {
          this.resetEndpointConnection(ep);
        }
      }

      const healthyCount = this.endpoints.filter((e) => e.healthy).length;
      logger.debug(`[rpc] Health check: ${healthyCount}/${this.endpoints.length} healthy`);
    } finally {
      this.isChecking = false;
    }
  }

  // v11k: Simplified reset — just create fresh Connection (no agent to destroy)
  private resetEndpointConnection(ep: RpcEndpoint): void {
    const hostname = new URL(ep.url).hostname;
    logger.warn(
      `[rpc] CONNECTION RESET: ${hostname} — ${ep.failCount} consecutive fails | creating fresh Connection`,
    );

    ep.connection = this.createConnection(ep.url);
    ep.lastConnectionReset = Date.now();
    ep.failCount = 0;
    ep.healthy = true; // v11k: Start optimistic — undici connections are fresh and reliable

    // Notify consumers to update cached references
    for (const cb of this.connectionResetCallbacks) {
      try { cb(); } catch (err) { logger.error('[rpc] Connection reset callback error:', err); }
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
