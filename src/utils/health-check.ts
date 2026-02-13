import { type Connection } from '@solana/web3.js';
import { logger } from './logger.js';

export interface HealthStatus {
  healthy: boolean;
  uptime: number;
  rpcLatency: number;
  memoryUsageMb: number;
  errors: string[];
}

const startTime = Date.now();

export async function checkHealth(connection: Connection): Promise<HealthStatus> {
  const errors: string[] = [];
  let rpcLatency = -1;

  // Check RPC
  try {
    const start = Date.now();
    await connection.getSlot();
    rpcLatency = Date.now() - start;
  } catch (err) {
    errors.push(`RPC unreachable: ${err}`);
  }

  // Check memory
  const mem = process.memoryUsage();
  const memoryUsageMb = Math.round(mem.heapUsed / 1024 / 1024);

  if (memoryUsageMb > 450) {
    errors.push(`High memory: ${memoryUsageMb}MB`);
  }

  const healthy = errors.length === 0 && rpcLatency >= 0 && rpcLatency < 5000;

  if (!healthy) {
    logger.warn('[health] Unhealthy', { errors, rpcLatency, memoryUsageMb });
  }

  return {
    healthy,
    uptime: Date.now() - startTime,
    rpcLatency,
    memoryUsageMb,
    errors,
  };
}

export function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
