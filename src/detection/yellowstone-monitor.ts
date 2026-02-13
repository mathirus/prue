import { PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { botEmitter } from './event-emitter.js';
import { generateId } from '../utils/helpers.js';
import { PUMPSWAP_AMM, WSOL_MINT } from '../constants.js';
import type { DetectedPool } from '../types.js';

// CreatePool discriminator: SHA256("global:create_pool") truncated to 8 bytes
// Computed via: Buffer.from(sha256("global:create_pool")).slice(0, 8)
// This must be verified against actual on-chain data after deployment
const CREATE_POOL_DISCRIMINATOR = Buffer.from([233, 146, 209, 142, 207, 104, 64, 188]);

function getNextMidnightUTC(): number {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return tomorrow.getTime();
}

/**
 * Yellowstone gRPC monitor for faster pool detection.
 * Uses QuickNode's free tier (50K responses/day).
 * Falls back gracefully to WebSocket monitors when limit is reached.
 */
export class YellowstoneMonitor {
  private client: unknown = null;
  private stream: unknown = null;
  private isRunning = false;
  private processedSignatures = new Set<string>();
  private dailyResponseCount = 0;
  private dailyResetAt: number;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private limitReached = false;

  constructor(private config: {
    endpoint: string;
    token: string;
    dailyResponseLimit: number;
  }) {
    this.dailyResetAt = getNextMidnightUTC();
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    if (!this.config.endpoint || !this.config.token) {
      logger.warn('[yellowstone] No endpoint/token configured, skipping gRPC monitor');
      return;
    }

    try {
      // Dynamic import to avoid breaking if package not installed
      // @ts-ignore - optional dependency, only needed when yellowstone.enabled=true
      const { default: Client, CommitmentLevel } = await import('@triton-one/yellowstone-grpc');

      this.client = new Client(this.config.endpoint, this.config.token, {});
      this.isRunning = true;

      logger.info('[yellowstone] Connecting to gRPC...');

      const stream = await (this.client as { subscribe(): Promise<unknown> }).subscribe();
      this.stream = stream;

      const s = stream as {
        on(event: string, handler: (...args: unknown[]) => void): void;
        write(data: unknown): void;
      };

      // Build subscribe request for PumpSwap transactions
      const request = {
        transactions: {
          pumpswap: {
            vote: false,
            failed: false,
            accountInclude: [PUMPSWAP_AMM.toBase58()],
            accountExclude: [],
            accountRequired: [],
          },
        },
        commitment: CommitmentLevel.CONFIRMED,
        accounts: {},
        slots: {},
        blocks: {},
        blocksMeta: {},
        entry: {},
        transactionsStatus: {},
        accountsDataSlice: [],
        ping: undefined,
      };

      s.on('data', (data: unknown) => {
        this.onMessage(data);
      });

      s.on('error', (err: unknown) => {
        logger.error(`[yellowstone] Stream error: ${String(err).slice(0, 200)}`);
        if (this.isRunning) this.scheduleReconnect();
      });

      s.on('end', () => {
        logger.warn('[yellowstone] Stream ended');
        if (this.isRunning) this.scheduleReconnect();
      });

      // Send subscribe request
      s.write(request);

      this.reconnectAttempts = 0;
      logger.info('[yellowstone] gRPC connected, listening for PumpSwap CreatePool events');
    } catch (err) {
      const msg = String(err);
      if (msg.includes('Cannot find module') || msg.includes('MODULE_NOT_FOUND')) {
        logger.warn('[yellowstone] @triton-one/yellowstone-grpc not installed. Run: npm install @triton-one/yellowstone-grpc');
      } else {
        logger.error(`[yellowstone] Failed to start: ${msg.slice(0, 200)}`);
      }
      this.isRunning = false;
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    try {
      if (this.stream && typeof (this.stream as { end(): void }).end === 'function') {
        (this.stream as { end(): void }).end();
      }
    } catch { /* ignore */ }
    this.stream = null;
    this.client = null;
    logger.info('[yellowstone] Stopped');
  }

  private onMessage(data: unknown): void {
    // Rate limiting check
    this.dailyResponseCount++;
    this.checkDailyLimit();
    if (this.limitReached) return;

    try {
      const msg = data as {
        transaction?: {
          transaction?: {
            transaction?: {
              message?: {
                accountKeys?: Uint8Array[];
                instructions?: Array<{
                  programIdIndex: number;
                  accounts: Uint8Array | number[];
                  data: Uint8Array;
                }>;
              };
            };
            signature?: Uint8Array;
          };
          slot?: string | number;
        };
      };

      if (!msg.transaction?.transaction?.transaction?.message) return;

      const txMsg = msg.transaction.transaction.transaction.message;
      const signature = msg.transaction.transaction.signature;
      const slot = Number(msg.transaction.slot ?? 0);

      if (!signature || !txMsg.accountKeys || !txMsg.instructions) return;

      // Convert signature to hex string for dedup (fast, unique enough)
      const sigStr = Buffer.from(signature).toString('hex').slice(0, 32);

      if (this.processedSignatures.has(sigStr)) return;
      this.processedSignatures.add(sigStr);

      // Cleanup old signatures
      if (this.processedSignatures.size > 2000) {
        const arr = Array.from(this.processedSignatures);
        this.processedSignatures = new Set(arr.slice(-1000));
      }

      // Find CreatePool instruction
      const pumpswapIndex = txMsg.accountKeys.findIndex((key) => {
        try {
          return new PublicKey(key).equals(PUMPSWAP_AMM);
        } catch { return false; }
      });

      if (pumpswapIndex < 0) return;

      for (const ix of txMsg.instructions) {
        if (ix.programIdIndex !== pumpswapIndex) continue;
        if (!this.isCreatePool(ix.data)) continue;

        // Parse CreatePool accounts
        // Layout: [0] pool, [1] poolAuthority, [2] creator, [3] baseMint, [4] quoteMint, ...
        const accountIndices = Array.from(ix.accounts);
        if (accountIndices.length < 7) continue;

        try {
          const poolKey = new PublicKey(txMsg.accountKeys[accountIndices[0]]);
          const baseMintKey = new PublicKey(txMsg.accountKeys[accountIndices[3]]);
          const quoteMintKey = new PublicKey(txMsg.accountKeys[accountIndices[4]]);

          // Determine token mint (non-WSOL)
          let tokenMint: PublicKey;
          if (baseMintKey.equals(WSOL_MINT)) {
            tokenMint = quoteMintKey;
          } else if (quoteMintKey.equals(WSOL_MINT)) {
            tokenMint = baseMintKey;
          } else {
            tokenMint = quoteMintKey;
          }

          // Reconstruct signature as base58 for logging
          const bs58Sig = this.uint8ArrayToBase58(signature);

          const pool: DetectedPool = {
            id: generateId(),
            source: 'pumpswap',
            poolAddress: poolKey,
            baseMint: tokenMint,
            quoteMint: WSOL_MINT,
            baseDecimals: 6,
            quoteDecimals: 9,
            detectedAt: Date.now(),
            slot,
            txSignature: bs58Sig,
          };

          logger.info(`[yellowstone] CreatePool detected via gRPC: ${tokenMint.toBase58().slice(0, 8)}... slot=${slot}`);
          botEmitter.emit('newPool', pool);
          return; // Only process first CreatePool per TX
        } catch (err) {
          logger.debug(`[yellowstone] Failed to parse CreatePool accounts: ${err}`);
        }
      }
    } catch (err) {
      logger.debug(`[yellowstone] Message processing error: ${String(err).slice(0, 200)}`);
    }
  }

  private isCreatePool(instructionData: Uint8Array): boolean {
    if (!instructionData || instructionData.length < 8) return false;
    const disc = Buffer.from(instructionData.slice(0, 8));
    return disc.equals(CREATE_POOL_DISCRIMINATOR);
  }

  private checkDailyLimit(): void {
    const now = Date.now();
    if (now > this.dailyResetAt) {
      logger.info(`[yellowstone] Daily reset: ${this.dailyResponseCount} responses yesterday`);
      this.dailyResponseCount = 0;
      this.dailyResetAt = getNextMidnightUTC();
      this.limitReached = false;
    }

    if (this.dailyResponseCount >= this.config.dailyResponseLimit * 0.90 && !this.limitReached) {
      logger.warn(`[yellowstone] 90% daily limit reached (${this.dailyResponseCount}/${this.config.dailyResponseLimit})`);
    }

    if (this.dailyResponseCount >= this.config.dailyResponseLimit * 0.95) {
      if (!this.limitReached) {
        logger.error(`[yellowstone] 95% daily limit - stopping gRPC. WebSocket fallback active.`);
        this.limitReached = true;
        this.stop();
      }
    }
  }

  private scheduleReconnect(): void {
    if (!this.isRunning) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error(`[yellowstone] Max reconnect attempts (${this.maxReconnectAttempts}) reached. Giving up.`);
      this.isRunning = false;
      return;
    }

    this.reconnectAttempts++;
    const delayMs = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60000);
    logger.info(`[yellowstone] Reconnecting in ${delayMs / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    setTimeout(() => {
      if (this.isRunning) {
        this.stream = null;
        this.start().catch((err) => {
          logger.error(`[yellowstone] Reconnect failed: ${String(err).slice(0, 100)}`);
        });
      }
    }, delayMs);
  }

  /** Convert Uint8Array to base58 string (simple implementation) */
  private uint8ArrayToBase58(bytes: Uint8Array): string {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let num = BigInt('0x' + Buffer.from(bytes).toString('hex'));
    const chars: string[] = [];
    while (num > 0n) {
      chars.unshift(ALPHABET[Number(num % 58n)]);
      num = num / 58n;
    }
    // Add leading '1's for leading zero bytes
    for (const byte of bytes) {
      if (byte === 0) chars.unshift('1');
      else break;
    }
    return chars.join('') || '1';
  }
}
