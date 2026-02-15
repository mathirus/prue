import { Connection, type ConnectionConfig } from '@solana/web3.js';
import { fetch as undiciFetch } from 'undici';
import { logger } from '../utils/logger.js';
import { RateLimiter } from '../utils/rate-limiter.js';
import { isSellPriorityActive } from '../utils/analysis-rpc.js';

// v11k fix: On Node.js 18, globalThis.fetch uses an INTERNAL undici copy with unlimited connections.
// setGlobalDispatcher() from the npm undici package does NOT affect globalThis.fetch on Node 18.
// So we import fetch directly from the npm undici package, which IS affected by setGlobalDispatcher().
// This gives us the connection limit of 50 set in index.ts.

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
  private inflight = 0; // diagnostic: concurrent requests in-flight
  private cacheWarmPending = false; // v11k: pending guard — max 1 getSlot in-flight
  private diagnosticInterval?: ReturnType<typeof setInterval>;
  private eventLoopInterval?: ReturnType<typeof setInterval>;

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

  // v11k fix: Use undiciFetch (npm package) NOT globalThis.fetch.
  // On Node 18, globalThis.fetch uses internal undici with unlimited connections.
  // npm undici's fetch respects setGlobalDispatcher({connections: 50}) from index.ts.
  private createFetchWithTimeout() {
    const FETCH_TIMEOUT_MS = 9_000;
    const self = this;
    return async (url: string | URL, init?: Record<string, unknown>): Promise<Response> => {
      // Extract RPC method from body for diagnostics
      let method = '?';
      try {
        const body = (init as Record<string, unknown>)?.body;
        if (typeof body === 'string') {
          const parsed = JSON.parse(body);
          method = parsed.method || '?';
        }
      } catch { /* ignore */ }

      self.inflight++;
      const controller = new AbortController();
      const start = Date.now();
      const timer = setTimeout(() => {
        const elapsed = Date.now() - start;
        logger.warn(`[rpc] FETCH TIMEOUT (${elapsed}ms) method=${method} inflight=${self.inflight}`);
        controller.abort();
      }, FETCH_TIMEOUT_MS);
      try {
        const response = await undiciFetch(String(url), {
          ...init as RequestInit,
          signal: controller.signal,
        });
        return response as unknown as Response;
      } finally {
        self.inflight--;
        clearTimeout(timer);
      }
    };
  }

  // v11k: Connection with undici fetch + timeout wrapper
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

  // v11k: Backpressure — lets background tasks check if RPC pool is saturated
  get inflightCount(): number {
    return this.inflight;
  }

  get isUnderPressure(): boolean {
    return this.inflight > 15;
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
    this.startDiagnostics();
    this.startEventLoopMonitor();
  }

  stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    this.stopCacheWarming();
    if (this.diagnosticInterval) {
      clearInterval(this.diagnosticInterval);
      this.diagnosticInterval = undefined;
    }
    if (this.eventLoopInterval) {
      clearInterval(this.eventLoopInterval);
      this.eventLoopInterval = undefined;
    }
  }

  // v11g: Cache warming — keep connections alive + Gatekeeper regional cache hot
  // v11k: Skips during sell priority to free Helius bandwidth for sell RPC calls
  // v11k: Pending guard + backpressure — max 1 getSlot in-flight, skip if pool saturated
  private startCacheWarming(): void {
    if (this.cacheWarmingInterval) return;
    this.cacheWarmingInterval = setInterval(() => {
      if (isSellPriorityActive()) return; // v11k: Don't waste Helius bandwidth during sell
      if (this.cacheWarmPending) {
        logger.debug('[rpc] cache warm skipped (previous pending)');
        return;
      }
      if (this.isUnderPressure) {
        logger.warn(`[rpc] cache warm skipped (RPC backpressure, inflight=${this.inflight})`);
        return;
      }
      this.cacheWarmPending = true;
      this.endpoints[0].connection.getSlot('processed').catch(() => {}).finally(() => {
        this.cacheWarmPending = false;
      });
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
    // v11k: Skip health checks during sell priority — free Helius bandwidth for sell
    if (isSellPriorityActive()) {
      logger.debug('[rpc] Health check skipped (sell priority active)');
      return;
    }
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
              setTimeout(() => reject(new Error('health check timeout')), 9_000),
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

  // v11k: Simplified reset — create fresh Connection (undici pool handles socket lifecycle)
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

  // v11k: Periodic inflight stats — detect backpressure buildup early
  private startDiagnostics(): void {
    this.diagnosticInterval = setInterval(() => {
      if (this.inflight > 5) {
        logger.warn(`[rpc] BACKPRESSURE: ${this.inflight} requests in-flight`);
      } else {
        logger.debug(`[rpc] inflight=${this.inflight}`);
      }
    }, 30_000);
    this.diagnosticInterval.unref();
  }

  // v11k: Event loop lag monitor — early warning of thread starvation
  private startEventLoopMonitor(): void {
    let lastTick = Date.now();
    this.eventLoopInterval = setInterval(() => {
      const now = Date.now();
      const lag = now - lastTick - 2_000; // expected interval is 2000ms
      if (lag > 500) {
        logger.warn(`[perf] Event loop lag: ${lag}ms`);
      }
      lastTick = now;
    }, 2_000);
    this.eventLoopInterval.unref();
  }

  getStatus(): Array<{ url: string; healthy: boolean; latencyMs: number }> {
    return this.endpoints.map((e) => ({
      url: e.url.replace(/api-key=[\w-]+/, 'api-key=***'),
      healthy: e.healthy,
      latencyMs: e.latencyMs,
    }));
  }
}
