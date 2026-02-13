import { PublicKey } from '@solana/web3.js';
import type { Context, Telegraf } from 'telegraf';
import { logger } from '../utils/logger.js';
import { formatPositionsList, formatStats, formatBalance, formatMultiPeriodStats } from './formatters.js';
import { mainMenuKeyboard, positionKeyboard } from './inline-keyboards.js';
import { getAnalytics, getAnalyticsForHours } from '../data/analytics.js';
import { TradeLogger } from '../data/trade-logger.js';
import { isValidPublicKey, shortenAddress } from '../utils/helpers.js';
import type { BotConfig } from '../types.js';
import type { Wallet } from '../core/wallet.js';
import type { RpcManager } from '../core/rpc-manager.js';
import type { PositionManager } from '../position/position-manager.js';
import type { TokenScorer } from '../analysis/token-scorer.js';

interface BotDeps {
  config: BotConfig;
  wallet: Wallet;
  rpcManager: RpcManager;
  positionManager: PositionManager;
  scorer: TokenScorer;
  paused: { value: boolean };
}

export function registerCommands(bot: Telegraf, deps: BotDeps): void {
  const { config, wallet, rpcManager, positionManager, scorer } = deps;
  const tradeLogger = new TradeLogger();
  const adminIds = new Set(config.telegram.adminIds);

  // Auth middleware
  function isAdmin(ctx: Context): boolean {
    const userId = ctx.from?.id;
    if (!userId) return false;
    if (adminIds.size === 0) return true; // No admins = everyone allowed
    return adminIds.has(userId);
  }

  function requireAdmin(ctx: Context): boolean {
    if (!isAdmin(ctx)) {
      ctx.reply('⛔ Unauthorized');
      return false;
    }
    return true;
  }

  // Log ALL incoming messages for debugging
  bot.use((ctx, next) => {
    const text = 'text' in (ctx.message ?? {}) ? (ctx.message as { text: string }).text : '(no text)';
    logger.info(`[telegram] Received message from user ${ctx.from?.id}: ${text.slice(0, 50)}`);
    return next();
  });

  // /start
  bot.command('start', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    await ctx.reply(
      `🐍 <b>ViperSnipe Bot</b>\n\nSolana memecoin sniper & copy trader.\n\nUse the menu below or type /help for commands.`,
      { parse_mode: 'HTML', ...mainMenuKeyboard() },
    );
  });

  // /help
  bot.command('help', async (ctx) => {
    await ctx.reply(
      [
        '<b>Commands:</b>',
        '/status - Bot status',
        '/balance - Wallet balance',
        '/positions - Open positions',
        '/history - Recent trades',
        '/stats - Trading statistics',
        '/buy &lt;mint&gt; &lt;sol&gt; - Buy token',
        '/sell &lt;posId&gt; &lt;pct&gt; - Sell position',
        '/close_all - Close all positions',
        '/score &lt;mint&gt; - Security analysis',
        '/pause - Pause bot',
        '/resume - Resume bot',
        '/wallets - Tracked wallets',
        '/track &lt;address&gt; &lt;label&gt; - Track wallet',
        '/untrack &lt;address&gt; - Stop tracking',
      ].join('\n'),
      { parse_mode: 'HTML' },
    );
  });

  // /status
  bot.command('status', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const balance = await wallet.getBalance(rpcManager.connection);
    const openPositions = positionManager.openCount;
    const rpcStatus = rpcManager.getStatus();
    const healthy = rpcStatus.filter((r) => r.healthy).length;

    await ctx.reply(
      [
        `<b>Bot Status</b>`,
        ``,
        `State: ${deps.paused.value ? '⏸ Paused' : '▶️ Running'}`,
        `Dry Run: ${config.risk.dryRun ? 'Yes' : 'No'}`,
        `Balance: ${balance.toFixed(4)} SOL`,
        `Open Positions: ${openPositions}/${config.risk.maxConcurrent}`,
        `RPC: ${healthy}/${rpcStatus.length} healthy`,
      ].join('\n'),
      { parse_mode: 'HTML' },
    );
  });

  // /balance
  bot.command('balance', async (ctx) => {
    logger.info(`[telegram] /balance command received from user ${ctx.from?.id}`);
    if (!requireAdmin(ctx)) return;
    try {
      const balance = await wallet.getBalance(rpcManager.connection);
      const history = tradeLogger.getBalanceHistory(20) as Array<{
        balance_sol: number; event: string; token_mint?: string; pnl_sol?: number; created_at: number;
      }>;
      // Get session PnL breakdown from DB
      const { getDb } = await import('../data/database.js');
      const db = getDb();
      const now = Date.now();
      const h1Ago = now - 3600_000;
      const h6Ago = now - 6 * 3600_000;
      const h24Ago = now - 24 * 3600_000;
      const sessionStats = {
        h1: db.prepare(`SELECT COALESCE(SUM(pnl_sol),0) as pnl, COUNT(*) as n, SUM(CASE WHEN pnl_sol>0 THEN 1 ELSE 0 END) as w, SUM(CASE WHEN exit_reason='rug_pull' THEN 1 ELSE 0 END) as r FROM positions WHERE opened_at>?`).get(h1Ago) as { pnl: number; n: number; w: number; r: number },
        h6: db.prepare(`SELECT COALESCE(SUM(pnl_sol),0) as pnl, COUNT(*) as n, SUM(CASE WHEN pnl_sol>0 THEN 1 ELSE 0 END) as w, SUM(CASE WHEN exit_reason='rug_pull' THEN 1 ELSE 0 END) as r FROM positions WHERE opened_at>?`).get(h6Ago) as { pnl: number; n: number; w: number; r: number },
        h24: db.prepare(`SELECT COALESCE(SUM(pnl_sol),0) as pnl, COUNT(*) as n, SUM(CASE WHEN pnl_sol>0 THEN 1 ELSE 0 END) as w, SUM(CASE WHEN exit_reason='rug_pull' THEN 1 ELSE 0 END) as r FROM positions WHERE opened_at>?`).get(h24Ago) as { pnl: number; n: number; w: number; r: number },
        allTime: db.prepare(`SELECT COALESCE(SUM(pnl_sol),0) as pnl, COUNT(*) as n, SUM(CASE WHEN pnl_sol>0 THEN 1 ELSE 0 END) as w FROM positions`).get() as { pnl: number; n: number; w: number },
        byVersion: db.prepare(`SELECT bot_version as v, COALESCE(SUM(pnl_sol),0) as pnl, COUNT(*) as n, SUM(CASE WHEN pnl_sol>0 THEN 1 ELSE 0 END) as w FROM positions WHERE opened_at>? GROUP BY bot_version ORDER BY MIN(opened_at)`).all(h24Ago) as Array<{ v: string; pnl: number; n: number; w: number }>,
        openPnl: db.prepare(`SELECT COALESCE(SUM(pnl_sol),0) as pnl, COUNT(*) as n FROM positions WHERE status NOT IN ('stopped','closed')`).get() as { pnl: number; n: number },
      };
      await ctx.reply(formatBalance(balance, wallet.publicKey.toBase58(), history, sessionStats), {
        parse_mode: 'HTML',
      });
    } catch (err) {
      logger.error(`[telegram] /balance error: ${err}`);
      await ctx.reply(`Error: ${String(err).slice(0, 200)}`);
    }
  });

  // /positions
  bot.command('positions', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const positions = positionManager.getOpenPositions();
    await ctx.reply(formatPositionsList(positions), { parse_mode: 'HTML' });
  });

  // /history
  bot.command('history', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const trades = tradeLogger.getRecentTrades(10);
    if (trades.length === 0) {
      await ctx.reply('📭 No trades yet');
      return;
    }
    const lines = trades.map((t, i) => {
      const type = t.type === 'buy' ? '💰' : '💸';
      const mint = shortenAddress(String(t.base_mint || t.input_mint));
      const amount = Number(t.input_amount).toFixed(4);
      return `${i + 1}. ${type} ${mint} | ${amount} SOL | ${t.status}`;
    });
    await ctx.reply(`<b>Recent Trades</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
  });

  // /stats - show 1h, 6h, 24h breakdown
  bot.command('stats', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const h1 = getAnalyticsForHours(1);
    const h6 = getAnalyticsForHours(6);
    const h24 = getAnalyticsForHours(24);
    await ctx.reply(formatMultiPeriodStats(h1, h6, h24), { parse_mode: 'HTML' });
  });

  // /buy <mint> [sol_amount]
  bot.command('buy', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 1) {
      await ctx.reply('Usage: /buy <token_mint> [sol_amount]');
      return;
    }
    const [mintStr, amountStr] = args;
    if (!isValidPublicKey(mintStr)) {
      await ctx.reply('❌ Invalid token address');
      return;
    }
    await ctx.reply(`⏳ Manual buy for ${shortenAddress(mintStr)} queued...`);
    // Actual buy execution would be triggered through the main pipeline
  });

  // /sell <positionId> <pct>
  bot.command('sell', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 2) {
      await ctx.reply('Usage: /sell <position_id> <percentage>');
      return;
    }
    await ctx.reply(`⏳ Sell order queued...`);
  });

  // /close_all
  bot.command('close_all', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const count = positionManager.openCount;
    if (count === 0) {
      await ctx.reply('No open positions to close');
      return;
    }
    await ctx.reply(`⏳ Closing ${count} positions...`);
    await positionManager.closeAll();
    await ctx.reply(`✅ All positions closed`);
  });

  // /score <mint>
  bot.command('score', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 1 || !isValidPublicKey(args[0])) {
      await ctx.reply('Usage: /score <token_mint>');
      return;
    }
    await ctx.reply(`⏳ Analyzing ${shortenAddress(args[0])}...`);
    // Analysis would be triggered through the scorer
  });

  // /pause
  bot.command('pause', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    deps.paused.value = true;
    await ctx.reply('⏸ Bot paused. Detection continues but no trades will execute.');
  });

  // /resume
  bot.command('resume', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    deps.paused.value = false;
    await ctx.reply('▶️ Bot resumed.');
  });

  // /wallets
  bot.command('wallets', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const { getDb } = await import('../data/database.js');
    const db = getDb();
    const wallets = db.prepare('SELECT * FROM wallet_targets ORDER BY added_at DESC').all() as Array<Record<string, unknown>>;
    if (wallets.length === 0) {
      await ctx.reply('📭 No tracked wallets. Use /track <address> <label>');
      return;
    }
    const lines = wallets.map((w) => {
      const status = w.enabled ? '🟢' : '🔴';
      return `${status} <code>${shortenAddress(String(w.address))}</code> - ${w.label}`;
    });
    await ctx.reply(`<b>Tracked Wallets (${wallets.length})</b>\n\n${lines.join('\n')}`, {
      parse_mode: 'HTML',
    });
  });

  // /track <address> <label>
  bot.command('track', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 2 || !isValidPublicKey(args[0])) {
      await ctx.reply('Usage: /track <wallet_address> <label>');
      return;
    }
    const [address, ...labelParts] = args;
    const label = labelParts.join(' ');
    const { getDb } = await import('../data/database.js');
    const db = getDb();
    db.prepare(
      'INSERT OR REPLACE INTO wallet_targets (address, label) VALUES (?, ?)',
    ).run(address, label);
    await ctx.reply(`✅ Tracking ${shortenAddress(address)} as "${label}"`);
  });

  // /untrack <address>
  bot.command('untrack', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 1 || !isValidPublicKey(args[0])) {
      await ctx.reply('Usage: /untrack <wallet_address>');
      return;
    }
    const { getDb } = await import('../data/database.js');
    const db = getDb();
    db.prepare('DELETE FROM wallet_targets WHERE address = ?').run(args[0]);
    await ctx.reply(`✅ Untracked ${shortenAddress(args[0])}`);
  });

  // Inline keyboard callbacks
  bot.on('callback_query', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const data = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
    if (!data) return;

    if (data === 'positions') {
      const positions = positionManager.getOpenPositions();
      await ctx.editMessageText(formatPositionsList(positions), { parse_mode: 'HTML' });
    } else if (data === 'balance') {
      const balance = await wallet.getBalance(rpcManager.connection);
      const history = tradeLogger.getBalanceHistory(20) as Array<{
        balance_sol: number; event: string; token_mint?: string; pnl_sol?: number; created_at: number;
      }>;
      await ctx.editMessageText(formatBalance(balance, wallet.publicKey.toBase58(), history), {
        parse_mode: 'HTML',
      });
    } else if (data === 'stats') {
      const analytics = getAnalytics(30);
      await ctx.editMessageText(formatStats(analytics), { parse_mode: 'HTML' });
    } else if (data === 'pause') {
      deps.paused.value = true;
      await ctx.answerCbQuery('Bot paused');
    } else if (data === 'resume') {
      deps.paused.value = false;
      await ctx.answerCbQuery('Bot resumed');
    } else if (data === 'cancel') {
      await ctx.answerCbQuery('Cancelled');
      await ctx.deleteMessage();
    }

    await ctx.answerCbQuery();
  });

  logger.info('[telegram] Commands registered');
}
