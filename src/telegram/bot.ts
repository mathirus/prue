import { Telegraf } from 'telegraf';
import { logger } from '../utils/logger.js';
import { registerCommands } from './commands.js';
import { NotificationService } from './notifications.js';
import type { BotConfig } from '../types.js';
import type { Wallet } from '../core/wallet.js';
import type { RpcManager } from '../core/rpc-manager.js';
import type { PositionManager } from '../position/position-manager.js';
import type { TokenScorer } from '../analysis/token-scorer.js';

export interface TelegramBotDeps {
  config: BotConfig;
  wallet: Wallet;
  rpcManager: RpcManager;
  positionManager: PositionManager;
  scorer: TokenScorer;
}

export class TelegramBot {
  private bot: Telegraf;
  private notifications: NotificationService;
  public paused = { value: false };

  constructor(private readonly deps: TelegramBotDeps) {
    this.bot = new Telegraf(deps.config.telegram.botToken);

    this.notifications = new NotificationService(
      this.bot,
      deps.config.telegram.chatId,
      deps.config,
    );
  }

  async start(): Promise<void> {
    // Register commands
    registerCommands(this.bot, {
      ...this.deps,
      paused: this.paused,
    });

    // Start notification listeners
    this.notifications.start();

    // Handle polling errors (like 409) gracefully
    this.bot.catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[telegram] Bot error: ${message}`);
    });

    // Launch bot with retry logic (network errors like ECONNRESET are transient)
    await this.launchWithRetry(3);
  }

  private async launchWithRetry(maxRetries: number): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const launchPromise = this.bot.launch({ dropPendingUpdates: true });
        const timeout = new Promise<void>((resolve) => setTimeout(resolve, 10000));
        await Promise.race([launchPromise, timeout]);
        logger.info('[telegram] Bot started');

        this.notifications.sendMessage(
          `🐍 <b>ViperSnipe Online</b>\n\nDry run: ${this.deps.config.risk.dryRun ? 'Yes' : 'No'}`,
        ).catch(e => logger.warn(`[telegram] Failed to send startup message: ${e}`));
        return; // Success
      } catch (err) {
        logger.error(`[telegram] Failed to start bot (attempt ${attempt}/${maxRetries}): ${err}`);
        if (attempt < maxRetries) {
          const delay = attempt * 5000; // 5s, 10s, 15s
          logger.info(`[telegram] Retrying in ${delay / 1000}s...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    logger.error(`[telegram] All ${maxRetries} attempts failed. Running without Telegram.`);
  }

  async stop(): Promise<void> {
    this.bot.stop('SIGTERM');
    logger.info('[telegram] Bot stopped');
  }

  get notificationService(): NotificationService {
    return this.notifications;
  }

  get isPaused(): boolean {
    return this.paused.value;
  }
}
