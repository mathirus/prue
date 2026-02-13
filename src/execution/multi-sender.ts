import {
  Connection,
  type TransactionSignature,
  VersionedTransaction,
  Transaction,
} from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { pollConfirmation } from '../utils/confirm-tx.js';

// v11a: Backup RPCs re-enabled for sell-path redundancy.
// Independent infrastructure from Helius — if Helius has a blip, these provide fallback.
const BACKUP_RPCS: string[] = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
];

/**
 * Sends a transaction to multiple RPC endpoints simultaneously.
 * Returns the first confirmed signature.
 *
 * Strategy: Send to all endpoints at once, use first successful response.
 * This maximizes inclusion probability without waiting.
 */
export class MultiSender {
  private allConnections: Connection[];

  constructor(private readonly connections: Connection[], includeBackups: boolean = false) {
    this.allConnections = [...connections];
    if (includeBackups) {
      BACKUP_RPCS.forEach(url => {
        this.allConnections.push(new Connection(url, 'confirmed'));
      });
    }
  }

  async sendAndConfirm(
    transaction: Transaction | VersionedTransaction,
    timeoutMs = 30_000,
  ): Promise<{ signature: TransactionSignature; slot?: number } | null> {
    const rawTx =
      transaction instanceof VersionedTransaction
        ? Buffer.from(transaction.serialize())
        : transaction.serialize();

    // Send to all connections simultaneously (including backups)
    const sendPromises = this.allConnections.map(async (conn, index) => {
      try {
        const signature = await conn.sendRawTransaction(rawTx, {
          skipPreflight: true,
          maxRetries: 2,
        });
        logger.debug(`[multi-send] Sent via endpoint #${index}: ${signature}`);
        return { connection: conn, signature };
      } catch (err) {
        logger.debug(`[multi-send] Failed on endpoint #${index}: ${err}`);
        return null;
      }
    });

    const results = await Promise.allSettled(sendPromises);
    const successful = results
      .filter((r) => r.status === 'fulfilled' && r.value !== null)
      .map((r) => (r as PromiseFulfilledResult<NonNullable<Awaited<(typeof sendPromises)[0]>>>).value);

    if (successful.length === 0) {
      logger.error('[multi-send] All endpoints failed to send');
      return null;
    }

    // Use the first successful signature
    const { connection: primaryConn, signature } = successful[0];

    // v9w: Confirm via polling (backup RPCs, not primary WS which may be 429'd)
    try {
      const pollResult = await pollConfirmation(signature, primaryConn, 15_000, 1_500);
      if (!pollResult.confirmed) {
        logger.error(`[multi-send] Confirmation failed: ${pollResult.error}`);
        return null;
      }

      logger.info(`[multi-send] TX confirmed: ${signature}`);
      return { signature, slot: pollResult.slot };
    } catch (err) {
      logger.error(`[multi-send] Confirmation failed: ${err}`);
      return null;
    }
  }
}
