import type { Telegraf } from 'telegraf';
import { logger } from '../utils/logger.js';
import { botEmitter } from '../detection/event-emitter.js';
import { formatDetection, formatBuy, formatSell, formatTradeClosed, formatError } from './formatters.js';
import { detectionKeyboard, positionKeyboard } from './inline-keyboards.js';
import { getSolPriceUsd } from '../utils/helpers.js';
import type { BotConfig, DetectedPool, Position, SecurityResult, TradeResult } from '../types.js';

export class NotificationService {
  constructor(
    private readonly bot: Telegraf,
    private readonly chatId: string,
    private readonly config: BotConfig,
  ) {}

  start(): void {
    // Only notify when a trade is FULLY closed (not partial sells)
    // User preference: single notification per trade with final result
    if (this.config.telegram.notifySell || this.config.telegram.notifyStopLoss) {
      botEmitter.on('positionClosed', (position: Position) => {
        this.sendTradeClosed(position);
      });
    }

    if (this.config.telegram.notifyError) {
      botEmitter.on('error', (error: Error, context: string) => {
        this.sendError(error, context);
      });
    }

    logger.info('[notifications] Service started (trade-close only mode)');
  }

  async sendDetection(pool: DetectedPool, security?: SecurityResult): Promise<void> {
    try {
      const message = formatDetection(pool, security);
      const keyboard = detectionKeyboard(pool.baseMint.toBase58());
      await this.bot.telegram.sendMessage(this.chatId, message, {
        parse_mode: 'HTML',
        ...keyboard,
      });
    } catch (err) {
      logger.error('[notifications] Failed to send detection', { error: String(err) });
    }
  }

  async sendBuy(pool: DetectedPool, result: TradeResult): Promise<void> {
    try {
      const solPrice = await getSolPriceUsd();
      const message = formatBuy(pool, result, solPrice);
      await this.bot.telegram.sendMessage(this.chatId, message, {
        parse_mode: 'HTML',
      });
    } catch (err) {
      logger.error('[notifications] Failed to send buy notification', { error: String(err) });
    }
  }

  async sendTakeProfit(position: Position, level: number): Promise<void> {
    try {
      const tpResult: TradeResult = {
        success: true,
        inputAmount: position.tokenAmount,
        outputAmount: position.solReturned * 1e9,
        pricePerToken: position.currentPrice,
        fee: 0,
        timestamp: Date.now(),
      };
      const solPrice = await getSolPriceUsd();
      const message = formatSell(position, tpResult, `Take Profit Level ${level + 1}`, solPrice);
      const keyboard = positionKeyboard(position.id, position.tokenMint.toBase58());
      await this.bot.telegram.sendMessage(this.chatId, message, {
        parse_mode: 'HTML',
        ...keyboard,
      });
    } catch (err) {
      logger.error('[notifications] Failed to send TP notification', { error: String(err) });
    }
  }

  async sendStopLoss(position: Position): Promise<void> {
    try {
      const slResult: TradeResult = {
        success: true,
        inputAmount: position.tokenAmount,
        outputAmount: position.solReturned * 1e9,
        pricePerToken: position.currentPrice,
        fee: 0,
        timestamp: Date.now(),
      };
      const solPrice = await getSolPriceUsd();
      const message = formatSell(position, slResult, 'Stop Loss', solPrice);
      await this.bot.telegram.sendMessage(this.chatId, message, {
        parse_mode: 'HTML',
      });
    } catch (err) {
      logger.error('[notifications] Failed to send SL notification', { error: String(err) });
    }
  }

  async sendTradeClosed(position: Position): Promise<void> {
    try {
      const solPrice = await getSolPriceUsd();
      const message = formatTradeClosed(position, solPrice);
      await this.bot.telegram.sendMessage(this.chatId, message, {
        parse_mode: 'HTML',
      });
    } catch (err) {
      logger.error('[notifications] Failed to send trade closed notification', { error: String(err) });
    }
  }

  async sendError(error: Error, context: string): Promise<void> {
    try {
      const message = formatError(error.message, context);
      await this.bot.telegram.sendMessage(this.chatId, message, {
        parse_mode: 'HTML',
      });
    } catch (err) {
      logger.error('[notifications] Failed to send error notification', { error: String(err) });
    }
  }

  async sendMessage(text: string): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(this.chatId, text, {
        parse_mode: 'HTML',
      });
    } catch (err) {
      logger.error('[notifications] Failed to send message', { error: String(err) });
    }
  }
}
