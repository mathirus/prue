import { getDb } from './database.js';
import type { BotAnalytics } from '../types.js';

export type { BotAnalytics };

export interface DailyPnl {
  date: string;
  pnlSol: number;
  trades: number;
  wins: number;
}

/** Get analytics for a specific time window (in hours). */
export function getAnalyticsForHours(hours: number): BotAnalytics & { rugCount: number } {
  const db = getDb();
  const since = Date.now() - hours * 60 * 60 * 1000;

  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_trades,
      SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as winning_trades,
      SUM(CASE WHEN pnl_sol < 0 THEN 1 ELSE 0 END) as losing_trades,
      SUM(CASE WHEN pnl_pct <= -80 THEN 1 ELSE 0 END) as rug_count,
      SUM(pnl_sol) as total_pnl_sol,
      SUM(sol_invested) as total_volume_sol,
      AVG(CASE WHEN pnl_sol > 0 THEN pnl_sol END) as avg_win,
      AVG(CASE WHEN pnl_sol < 0 THEN pnl_sol END) as avg_loss,
      MAX(pnl_sol) as largest_win,
      MIN(pnl_sol) as largest_loss,
      SUM(CASE WHEN pnl_sol > 0 THEN pnl_sol ELSE 0 END) as gross_profit,
      SUM(CASE WHEN pnl_sol < 0 THEN ABS(pnl_sol) ELSE 0 END) as gross_loss
    FROM positions
    WHERE opened_at >= ? AND status IN ('closed', 'stopped')
  `).get(since) as Record<string, number | null>;

  const openCount = db.prepare(`
    SELECT COUNT(*) as count FROM positions WHERE status IN ('open', 'partial_close')
  `).get() as { count: number };

  const totalTrades = (stats.total_trades as number) ?? 0;
  const winningTrades = (stats.winning_trades as number) ?? 0;
  const losingTrades = (stats.losing_trades as number) ?? 0;
  const rugCount = (stats.rug_count as number) ?? 0;
  const grossProfit = (stats.gross_profit as number) ?? 0;
  const grossLoss = (stats.gross_loss as number) ?? 0;

  return {
    totalTrades,
    winningTrades,
    losingTrades,
    rugCount,
    winRate: totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0,
    totalPnlSol: (stats.total_pnl_sol as number) ?? 0,
    totalVolumeSol: (stats.total_volume_sol as number) ?? 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    averageWin: (stats.avg_win as number) ?? 0,
    averageLoss: (stats.avg_loss as number) ?? 0,
    largestWin: (stats.largest_win as number) ?? 0,
    largestLoss: (stats.largest_loss as number) ?? 0,
    openPositions: openCount.count,
  };
}

export function getAnalytics(days = 30): BotAnalytics {
  const db = getDb();
  const since = Date.now() - days * 24 * 60 * 60 * 1000;

  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_trades,
      SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as winning_trades,
      SUM(CASE WHEN pnl_sol < 0 THEN 1 ELSE 0 END) as losing_trades,
      SUM(pnl_sol) as total_pnl_sol,
      SUM(sol_invested) as total_volume_sol,
      AVG(CASE WHEN pnl_sol > 0 THEN pnl_sol END) as avg_win,
      AVG(CASE WHEN pnl_sol < 0 THEN pnl_sol END) as avg_loss,
      MAX(pnl_sol) as largest_win,
      MIN(pnl_sol) as largest_loss,
      SUM(CASE WHEN pnl_sol > 0 THEN pnl_sol ELSE 0 END) as gross_profit,
      SUM(CASE WHEN pnl_sol < 0 THEN ABS(pnl_sol) ELSE 0 END) as gross_loss
    FROM positions
    WHERE opened_at >= ? AND status IN ('closed', 'stopped')
  `).get(since) as Record<string, number | null>;

  const openCount = db.prepare(`
    SELECT COUNT(*) as count FROM positions WHERE status IN ('open', 'partial_close')
  `).get() as { count: number };

  const totalTrades = (stats.total_trades as number) ?? 0;
  const winningTrades = (stats.winning_trades as number) ?? 0;
  const losingTrades = (stats.losing_trades as number) ?? 0;
  const grossProfit = (stats.gross_profit as number) ?? 0;
  const grossLoss = (stats.gross_loss as number) ?? 0;

  return {
    totalTrades,
    winningTrades,
    losingTrades,
    winRate: totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0,
    totalPnlSol: (stats.total_pnl_sol as number) ?? 0,
    totalVolumeSol: (stats.total_volume_sol as number) ?? 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    averageWin: (stats.avg_win as number) ?? 0,
    averageLoss: (stats.avg_loss as number) ?? 0,
    largestWin: (stats.largest_win as number) ?? 0,
    largestLoss: (stats.largest_loss as number) ?? 0,
    openPositions: openCount.count,
  };
}

export function getDailyPnl(days = 30): DailyPnl[] {
  const db = getDb();
  const since = Date.now() - days * 24 * 60 * 60 * 1000;

  const rows = db.prepare(`
    SELECT
      date(opened_at / 1000, 'unixepoch') as date,
      SUM(pnl_sol) as pnl_sol,
      COUNT(*) as trades,
      SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins
    FROM positions
    WHERE opened_at >= ? AND status IN ('closed', 'stopped')
    GROUP BY date(opened_at / 1000, 'unixepoch')
    ORDER BY date DESC
  `).all(since) as Array<{ date: string; pnl_sol: number; trades: number; wins: number }>;

  return rows.map((r) => ({
    date: r.date,
    pnlSol: r.pnl_sol,
    trades: r.trades,
    wins: r.wins,
  }));
}
