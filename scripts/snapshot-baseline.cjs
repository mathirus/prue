/**
 * Capture baseline metrics from current trade data.
 * Saves to data/baseline-metrics.json as benchmark for comparing improvements.
 *
 * Usage: node scripts/snapshot-baseline.cjs
 */

const Database = require('better-sqlite3');
const { writeFileSync, mkdirSync } = require('fs');
const path = require('path');

const DB_PATH = path.resolve(process.cwd(), 'data', 'bot.db');
const OUTPUT_PATH = path.resolve(process.cwd(), 'data', 'baseline-metrics.json');

function main() {
  const db = new Database(DB_PATH, { readonly: true });

  const row = db.prepare(`
    SELECT
      COUNT(*) as total_trades,
      SUM(CASE WHEN pnl_pct <= -80 THEN 1 ELSE 0 END) as rugs,
      SUM(CASE WHEN pnl_pct > 5 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl_pct BETWEEN -80 AND -5 THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN pnl_pct BETWEEN -5 AND 5 THEN 1 ELSE 0 END) as breakeven,
      ROUND(AVG(pnl_pct), 2) as avg_pnl_pct,
      ROUND(SUM(pnl_sol), 6) as total_pnl_sol,
      ROUND(AVG(CASE WHEN pnl_pct > 5 THEN pnl_pct END), 2) as avg_win_pct,
      ROUND(AVG(CASE WHEN pnl_pct <= -80 THEN pnl_pct END), 2) as avg_rug_pct,
      ROUND(AVG(CASE WHEN pnl_pct BETWEEN -80 AND -5 THEN pnl_pct END), 2) as avg_loss_pct,
      ROUND(AVG(sol_invested), 6) as avg_position_size,
      MIN(opened_at) as first_trade_at,
      MAX(COALESCE(closed_at, opened_at)) as last_trade_at
    FROM positions
    WHERE status IN ('closed', 'stopped')
  `).get();

  if (!row || row.total_trades === 0) {
    console.error('No closed trades found in database.');
    process.exit(1);
  }

  const metrics = {
    snapshot_at: new Date().toISOString(),
    period: {
      from: new Date(row.first_trade_at).toISOString(),
      to: new Date(row.last_trade_at).toISOString(),
    },
    total_trades: row.total_trades,
    rugs: row.rugs,
    wins: row.wins,
    losses: row.losses,
    breakeven: row.breakeven,
    rug_rate_pct: Number(((row.rugs / row.total_trades) * 100).toFixed(1)),
    win_rate_pct: Number(((row.wins / row.total_trades) * 100).toFixed(1)),
    avg_pnl_pct: row.avg_pnl_pct,
    total_pnl_sol: row.total_pnl_sol,
    pnl_per_trade_sol: Number((row.total_pnl_sol / row.total_trades).toFixed(6)),
    avg_win_pct: row.avg_win_pct,
    avg_rug_pct: row.avg_rug_pct,
    avg_loss_pct: row.avg_loss_pct,
    avg_position_size: row.avg_position_size,
  };

  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(metrics, null, 2));

  console.log('=== BASELINE METRICS SNAPSHOT ===\n');
  console.log(`Period: ${metrics.period.from.slice(0, 10)} to ${metrics.period.to.slice(0, 10)}`);
  console.log(`Total trades:     ${metrics.total_trades}`);
  console.log(`Rugs:             ${metrics.rugs} (${metrics.rug_rate_pct}%)`);
  console.log(`Wins:             ${metrics.wins} (${metrics.win_rate_pct}%)`);
  console.log(`Losses:           ${metrics.losses}`);
  console.log(`Breakeven:        ${metrics.breakeven}`);
  console.log(`Avg PnL:          ${metrics.avg_pnl_pct}%`);
  console.log(`Total PnL:        ${metrics.total_pnl_sol} SOL`);
  console.log(`PnL/trade:        ${metrics.pnl_per_trade_sol} SOL`);
  console.log(`Avg win:          +${metrics.avg_win_pct}%`);
  console.log(`Avg rug:          ${metrics.avg_rug_pct}%`);
  console.log(`Avg position:     ${metrics.avg_position_size} SOL`);
  console.log(`\nSaved to: ${OUTPUT_PATH}`);

  db.close();
}

main();
