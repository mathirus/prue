import { Connection, type ConnectionConfig } from '@solana/web3.js';
import { createRequire } from 'node:module';
import AgentKeepAlive from 'agentkeepalive';
import { logger } from '../utils/logger.js';
import { RateLimiter } from '../utils/rate-limiter.js';

// v11j: node-fetch v2 (CJS, transitive dep of @solana/web3.js) supports the `agent` option
// that built-in globalThis.fetch silently ignores. Without this, our custom httpAgent has no effect.
const _require = createRequire(import.meta.url);
const nodeFetch: (url: string | URL, init?: Record<string, unknown>) => Promise<Response> = _require('node-fetch');

interface RpcEndpoint {
  url: string;
  connection: Connection;
  agent: InstanceType<typeof AgentKeepAlive.HttpsAgent>;
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

    // v11j: Base config saved for connection recreation. httpAgent and fetch are per-endpoint.
    this.baseConnConfig = {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 30_000,
      wsEndpoint: this.wsUrl,
      disableRetryOnRateLimit: true, // Prevent @solana/web3.js from auto-retrying 429s (causes cascade)
    };

    for (const url of urls) {
      const agent = this.createAgent();
      this.endpoints.push({
        url,
        connection: this.createConnection(url, agent),
        agent,
        healthy: true,
        latencyMs: 0,
        failCount: 0,
        lastCheck: 0,
        lastConnectionReset: 0,
      });
    }
  }

  // v11j: Layer 1 — Custom HTTP agent with aggressive timeouts
  // DEFAULT agentkeepalive: timeout=38s, freeSocketTimeout=19s → death spiral on sustained outage
  // OUR agent: timeout=10s (kills active sockets fast), socketActiveTTL=60s (force-recycle)
  private createAgent(): InstanceType<typeof AgentKeepAlive.HttpsAgent> {
    return new AgentKeepAlive.HttpsAgent({
      keepAlive: true,
      maxSockets: 25,
      maxFreeSockets: 5,
      freeSocketTimeout: 15_000,   // Kill idle sockets after 15s (default 19s)
      timeout: 10_000,             // Kill ACTIVE sockets after 10s no response (default 38s!) — KEY FIX
      socketActiveTTL: 60_000,     // Force-recycle sockets every 60s even if healthy
    });
  }

  // v11j: Layer 3 — Custom fetch with AbortController timeout (8s absolute per request)
  // Uses node-fetch instead of globalThis.fetch because built-in fetch ignores the `agent` option.
  // This ensures Layer 1 (custom httpAgent) actually works.
  private createFetchWithAgent(agent: InstanceType<typeof AgentKeepAlive.HttpsAgent>) {
    const FETCH_TIMEOUT_MS = 8_000;
    return async (url: string | URL, init?: Record<string, unknown>): Promise<Response> => {
      const controller = new AbortController();
      const start = Date.now();
      const timer = setTimeout(() => {
        const elapsed = Date.now() - start;
        const agentStatus = agent.getCurrentStatus();
        logger.warn(
          `[rpc] FETCH TIMEOUT (${elapsed}ms): ${String(url).substring(0, 60)}... | ` +
          `sockets: create=${agentStatus.createSocketCount} active=${Object.keys(agentStatus.sockets).length} ` +
          `free=${Object.keys(agentStatus.freeSockets).length} total=${agentStatus.requestCount} ` +
          `timeout=${agentStatus.timeoutSocketCount}`,
        );
        controller.abort();
      }, FETCH_TIMEOUT_MS);
      try {
        return await nodeFetch(url, {
          ...init,
          agent,          // Layer 1: custom agent with aggressive socket timeouts
          signal: controller.signal,  // Layer 3: 8s absolute timeout per request
        });
      } finally {
        clearTimeout(timer);
      }
    };
  }

  // Create a Connection with our custom agent + fetch wrapper
  private createConnection(url: string, agent: InstanceType<typeof AgentKeepAlive.HttpsAgent>): Connection {
    return new Connection(url, {
      ...this.baseConnConfig,
      httpAgent: false,  // v11j: Disable default agentkeepalive (we manage via custom fetch)
      fetch: this.createFetchWithAgent(agent) as unknown as ConnectionConfig['fetch'],
    });
  }

  // v11j: Register callback for connection reset events
  // Consumers can update their cached Connection references when reset happens
  onConnectionReset(callback: () => void): void {
    this.connectionResetCallbacks.push(callback);
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
        } catch (err) {
          ep.failCount++;
          ep.latencyMs = -1;
          const hostname = new URL(ep.url).hostname;
          const elapsed = Date.now() - start;
          const errMsg = err instanceof Error ? err.message : String(err);
          const agentStatus = ep.agent.getCurrentStatus();
          if (ep.failCount >= 2) {
            logger.error(
              `[rpc] Endpoint fail: ${hostname} (${ep.failCount} consecutive, ${elapsed}ms) — ${errMsg} | ` +
              `sockets: created=${agentStatus.createSocketCount} active=${Object.keys(agentStatus.sockets).length} ` +
              `free=${Object.keys(agentStatus.freeSockets).length} total=${agentStatus.requestCount} ` +
              `timeout=${agentStatus.timeoutSocketCount} close=${agentStatus.closeSocketCount}`,
            );
          }
          if (ep.failCount >= 3) {
            ep.healthy = false;
          }
        }
        ep.lastCheck = Date.now();

        // v11j: Layer 2 — Connection reset at 3+ consecutive fails with 30s cooldown
        // Lowered from 5 to 3: at 5 fails the agent socket pool is already saturated and
        // all pending requests (pool parsing, blockhash, etc.) pile up. Reset ASAP.
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

  // v11j: Layer 2 — Destroy old agent + connection, create fresh ones
  private resetEndpointConnection(ep: RpcEndpoint): void {
    const hostname = new URL(ep.url).hostname;
    const agentStatus = ep.agent.getCurrentStatus();
    logger.warn(
      `[rpc] CONNECTION RESET: ${hostname} — ${ep.failCount} consecutive fails | ` +
      `sockets: created=${agentStatus.createSocketCount} active=${Object.keys(agentStatus.sockets).length} ` +
      `free=${Object.keys(agentStatus.freeSockets).length} total=${agentStatus.requestCount} ` +
      `timeout=${agentStatus.timeoutSocketCount} close=${agentStatus.closeSocketCount} | ` +
      `destroying agent, creating fresh Connection`,
    );

    // Destroy old agent — closes ALL sockets immediately (no waiting for GC)
    try { ep.agent.destroy(); } catch { /* ignore */ }

    // Create new agent + connection
    const newAgent = this.createAgent();
    ep.agent = newAgent;
    ep.connection = this.createConnection(ep.url, newAgent);
    ep.lastConnectionReset = Date.now();
    ep.failCount = 0;
    ep.healthy = false; // Start pessimistic, next health check will verify

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
