import RedisModule from 'ioredis';
import { logger } from '../utils/logger.js';

// ioredis default export is both a namespace and constructor
const Redis = RedisModule as unknown as new (url: string, opts?: Record<string, unknown>) => RedisInstance;

interface RedisInstance {
  on(event: string, cb: (...args: unknown[]) => void): void;
  connect(): Promise<void>;
  quit(): Promise<string>;
  get(key: string): Promise<string | null>;
  setex(key: string, ttl: number, value: string): Promise<string>;
  del(key: string): Promise<number>;
}

let redis: RedisInstance | null = null;

export function getRedis(url = 'redis://localhost:6379'): RedisInstance {
  if (!redis) {
    redis = new Redis(url, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => {
        if (times > 5) {
          logger.warn('[redis] Max retries reached, giving up');
          return null;
        }
        return Math.min(times * 200, 2000);
      },
      lazyConnect: true,
    });

    redis.on('error', (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug(`[redis] Connection error: ${msg}`);
    });

    redis.on('connect', () => {
      logger.info('[redis] Connected');
    });
  }
  return redis;
}

export async function connectRedis(url: string): Promise<boolean> {
  try {
    const client = getRedis(url);
    await client.connect();
    return true;
  } catch {
    logger.warn('[redis] Failed to connect, running without cache');
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}

/**
 * Simple cache wrapper that works with or without Redis.
 */
export class Cache {
  private memoryCache = new Map<string, { value: string; expiresAt: number }>();
  private redisAvailable = false;

  constructor(private readonly redisUrl?: string) {}

  async init(): Promise<void> {
    if (this.redisUrl) {
      this.redisAvailable = await connectRedis(this.redisUrl);
    }
  }

  async get(key: string): Promise<string | null> {
    if (this.redisAvailable) {
      try {
        return await getRedis().get(key);
      } catch {
        // Fallback to memory
      }
    }

    const entry = this.memoryCache.get(key);
    if (entry && entry.expiresAt > Date.now()) {
      return entry.value;
    }
    this.memoryCache.delete(key);
    return null;
  }

  async set(key: string, value: string, ttlSeconds = 60): Promise<void> {
    if (this.redisAvailable) {
      try {
        await getRedis().setex(key, ttlSeconds, value);
        return;
      } catch {
        // Fallback
      }
    }

    this.memoryCache.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async del(key: string): Promise<void> {
    if (this.redisAvailable) {
      try {
        await getRedis().del(key);
      } catch {
        // Fallback
      }
    }
    this.memoryCache.delete(key);
  }

  async close(): Promise<void> {
    await closeRedis();
    this.memoryCache.clear();
  }
}
