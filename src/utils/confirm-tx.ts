import { Connection } from '@solana/web3.js';
import { logger } from './logger.js';

// v11g: Rebroadcast config for re-sending TX during confirmation polling
interface RebroadcastConfig {
  rawTransaction: Uint8Array;
  intervalMs?: number; // Default 2000ms
}

/**
 * v11a: Sell-resilient polling with backup RPC rotation.
 * v11g: Optional rebroadcast — re-sends TX to all RPCs every N seconds during polling.
 * - Primary: Helius paid (fast, reliable)
 * - Backup: Free RPCs for redundancy when Helius has infrastructure blips
 * - Rotates to backup after 2 consecutive failures on current endpoint
 * Free-tier version backed up in _backup-free-tier/confirm-tx.ts.bak
 */
export async function pollConfirmation(
  signature: string,
  primaryConnection: Connection,
  maxWaitMs: number = 8_000,
  pollIntervalMs: number = 1_000,
  backupConnections: Connection[] = [],
  rebroadcastConfig?: RebroadcastConfig,
): Promise<{ confirmed: boolean; slot?: number; error?: string }> {
  const start = Date.now();
  const allConnections = [primaryConnection, ...backupConnections];
  let connIndex = 0;
  let consecutiveFails = 0;
  const rbInterval = rebroadcastConfig?.intervalMs ?? 2_000;
  let lastRebroadcast = start;

  const poll = async (): Promise<{ confirmed: boolean; slot?: number; error?: string }> => {
    while (Date.now() - start < maxWaitMs) {
      const conn = allConnections[connIndex % allConnections.length];
      try {
        const result = await Promise.race([
          conn.getSignatureStatuses([signature]),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('poll-timeout')), 2_000),
          ),
        ]);

        const status = result?.value?.[0];
        if (status) {
          if (status.err) {
            return { confirmed: false, error: `TX failed on-chain: ${JSON.stringify(status.err)}` };
          }
          if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
            const connLabel = connIndex % allConnections.length === 0 ? 'primary' : `backup-${connIndex % allConnections.length}`;
            logger.info(`[confirm] TX confirmed via ${connLabel} in ${Date.now() - start}ms (${status.confirmationStatus})`);
            return { confirmed: true, slot: status.slot };
          }
        }
        consecutiveFails = 0;
      } catch {
        consecutiveFails++;
        // v11a: Rotate to backup after 2 consecutive failures on current endpoint
        if (consecutiveFails >= 2 && allConnections.length > 1) {
          connIndex++;
          logger.debug(`[confirm] Rotating to connection #${connIndex % allConnections.length} after ${consecutiveFails} fails`);
          consecutiveFails = 0;
        }
      }

      // v11g: Rebroadcast TX to all RPCs periodically during confirmation
      if (rebroadcastConfig && (Date.now() - lastRebroadcast) >= rbInterval) {
        lastRebroadcast = Date.now();
        for (const c of allConnections) {
          c.sendRawTransaction(rebroadcastConfig.rawTransaction, { skipPreflight: true, maxRetries: 0 })
            .catch(() => {}); // fire-and-forget
        }
        logger.debug(`[confirm] Rebroadcast to ${allConnections.length} RPCs`);
      }

      const remaining = maxWaitMs - (Date.now() - start);
      if (remaining <= 0) break;
      await new Promise(r => setTimeout(r, Math.min(pollIntervalMs, remaining)));
    }

    return { confirmed: false, error: `Polling timeout (${maxWaitMs}ms)` };
  };

  // Absolute hard timeout
  return Promise.race([
    poll(),
    new Promise<{ confirmed: boolean; error: string }>((resolve) =>
      setTimeout(() => resolve({ confirmed: false, error: `Polling hard timeout (${maxWaitMs}ms)` }), maxWaitMs + 500),
    ),
  ]);
}
