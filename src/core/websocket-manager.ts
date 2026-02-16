import { Connection, type Logs, PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/helpers.js';

export type LogCallback = (logs: Logs, context: { slot: number }) => void;

// v11g: Callback for external notifications (Telegram alerts)
export type WsAlertCallback = (message: string) => void;

interface Subscription {
  id: string;
  programId: PublicKey;
  callback: LogCallback;
  wsSubId?: number;
  lastActivityTs: number; // v11g: Per-subscription activity tracking
}

export class WebSocketManager {
  private subscriptions = new Map<string, Subscription>();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 20;
  private isConnected = false;
  private heartbeatInterval?: ReturnType<typeof setInterval>;
  private alertCallback?: WsAlertCallback;
  // v11g: Per-subscription stale detection (was global — Raydium callbacks masked dead PumpSwap)
  // 90s without callbacks on a SPECIFIC subscription = stale for that subscription
  private static readonly STALE_TIMEOUT_MS = 90 * 1000;
  // v11k DIAGNOSTIC: WS message rate counter per subscription
  private wsMsgCounts = new Map<string, number>();
  private wsMsgInterval?: ReturnType<typeof setInterval>;

  private readonly getConnection: () => Connection;
  constructor(
    private connection: Connection,
    private readonly wsUrl: string,
    getConn?: () => Connection,
  ) {
    // v11j: Optional getter for fresh Connection (used by heartbeat getSlot)
    this.getConnection = getConn || (() => this.connection);
  }

  // v11g: Register alert callback (for Telegram notifications)
  onAlert(callback: WsAlertCallback): void {
    this.alertCallback = callback;
  }

  // v11h: Only send critical alerts to Telegram (max attempts, full death)
  // Routine stale/reconnect just logs — no Telegram spam
  private sendAlert(message: string, critical: boolean = false): void {
    logger.warn(`[ws] ALERT: ${message}`);
    if (critical && this.alertCallback) {
      try { this.alertCallback(message); } catch { /* ignore */ }
    }
  }

  async subscribe(
    id: string,
    programId: PublicKey,
    callback: LogCallback,
  ): Promise<void> {
    const sub: Subscription = { id, programId, callback, lastActivityTs: Date.now() };
    this.subscriptions.set(id, sub);

    await this.attachSubscription(sub);
    logger.info(`[ws] Subscribed to ${id} (${programId.toBase58().slice(0, 8)}...)`);
  }

  async unsubscribe(id: string): Promise<void> {
    const sub = this.subscriptions.get(id);
    if (!sub) return;

    if (sub.wsSubId !== undefined) {
      try {
        await this.connection.removeOnLogsListener(sub.wsSubId);
      } catch (err) {
        logger.warn(`[ws] Error removing listener ${id}`, { error: String(err) });
      }
    }

    this.subscriptions.delete(id);
    logger.info(`[ws] Unsubscribed from ${id}`);
  }

  startHeartbeat(intervalMs = 30_000): void {
    // v11k DIAGNOSTIC: Log WS message rate
    // v11u: 10s → 60s, info → debug (was 10% of all logs with zero actionability)
    this.wsMsgInterval = setInterval(() => {
      const parts: string[] = [];
      for (const [id, count] of this.wsMsgCounts) {
        parts.push(`${id}=${count}`);
      }
      if (parts.length > 0) {
        const total = [...this.wsMsgCounts.values()].reduce((a, b) => a + b, 0);
        logger.debug(`[ws] MSG RATE (60s): ${parts.join(', ')} | total=${total} (${(total / 60).toFixed(0)}/s)`);
      }
      this.wsMsgCounts.clear();
    }, 60_000);

    this.heartbeatInterval = setInterval(async () => {
      const now = Date.now();

      // v11g: Check EACH subscription individually for staleness
      // Bug fix: Before, a single global lastActivityTs meant Raydium callbacks
      // masked a dead PumpSwap subscription for 30+ minutes
      const staleSubs: Subscription[] = [];
      let anyAlive = false;

      for (const sub of this.subscriptions.values()) {
        const staleDuration = now - sub.lastActivityTs;
        if (staleDuration >= WebSocketManager.STALE_TIMEOUT_MS) {
          staleSubs.push(sub);
          logger.warn(`[ws] Subscription "${sub.id}" stale for ${Math.round(staleDuration / 1000)}s`);
        } else {
          anyAlive = true;
        }
      }

      // If no subscriptions are stale, everything is fine
      if (staleSubs.length === 0) return;

      // v11g: If some subs are stale but others alive, the WS connection itself
      // may be OK but individual onLogs listeners died. Force reconnect ALL.
      if (staleSubs.length > 0) {
        const staleNames = staleSubs.map(s => s.id).join(', ');
        const alertMsg = anyAlive
          ? `⚠️ WS parcialmente muerto: ${staleNames} sin actividad ${Math.round((now - staleSubs[0].lastActivityTs) / 1000)}s — reconnecting`
          : `🔴 WS completamente muerto: todas las subs sin actividad — reconnecting`;

        this.sendAlert(alertMsg);

        try {
          await this.getConnection().getSlot();
          // HTTP works, WS partially/fully dead → reconnect
          this.isConnected = false;
          await this.reconnectAll();
        } catch {
          // HTTP also dead → reconnect everything
          this.isConnected = false;
          logger.warn('[ws] Heartbeat failed AND WS stale, reconnecting...');
          await this.reconnectAll();
        }
      }
    }, intervalMs);
  }

  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    if (this.wsMsgInterval) {
      clearInterval(this.wsMsgInterval);
    }
  }

  private async attachSubscription(sub: Subscription): Promise<void> {
    try {
      sub.wsSubId = this.connection.onLogs(
        sub.programId,
        (logs, ctx) => {
          // v11g: Update per-subscription activity timestamp
          sub.lastActivityTs = Date.now();
          // v11k DIAGNOSTIC: count messages per subscription
          this.wsMsgCounts.set(sub.id, (this.wsMsgCounts.get(sub.id) ?? 0) + 1);
          if (!this.isConnected) {
            this.isConnected = true;
            this.reconnectAttempts = 0;
          }
          sub.callback(logs, ctx);
        },
        'confirmed',
      );
      this.isConnected = true;
    } catch (err) {
      logger.error(`[ws] Failed to attach subscription ${sub.id}`, { error: String(err) });
      throw err;
    }
  }

  private async reconnectAll(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.sendAlert('🔴 Max reconnect attempts (20) reached — bot needs manual restart!', true);
      logger.error('[ws] Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000);
    logger.info(`[ws] Reconnecting (attempt ${this.reconnectAttempts}) in ${delay}ms`);

    await sleep(delay);

    try {
      // v9m: Skip removeOnLogsListener on dead connections — @solana/web3.js prints
      // errors directly to stderr (not catchable), flooding output + causing OOM.
      // Just clear wsSubId; the old connection will be garbage collected.
      for (const sub of this.subscriptions.values()) {
        sub.wsSubId = undefined;
      }

      // Re-create connection
      this.connection = new Connection(this.connection.rpcEndpoint, {
        commitment: 'confirmed',
        wsEndpoint: this.wsUrl,
      });

      // Re-attach all subscriptions
      for (const sub of this.subscriptions.values()) {
        sub.lastActivityTs = Date.now(); // Reset stale timer
        await this.attachSubscription(sub);
      }

      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.sendAlert('✅ WS reconectado exitosamente');
      logger.info('[ws] Reconnected successfully');
    } catch (err) {
      this.sendAlert(`❌ WS reconnect falló (attempt ${this.reconnectAttempts}): ${String(err)}`, this.reconnectAttempts >= 5);
      logger.error('[ws] Reconnect failed', { error: String(err) });
    }
  }

  async shutdown(): Promise<void> {
    this.stopHeartbeat();
    for (const id of this.subscriptions.keys()) {
      await this.unsubscribe(id);
    }
  }
}
