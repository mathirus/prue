const db = require('better-sqlite3')('data/bot.db');

const trades = db.prepare("SELECT id, token_mint, opened_at, closed_at, sol_invested, sol_returned, pnl_sol, pnl_pct, exit_reason, peak_multiplier, entry_latency_ms, sell_attempts, sell_successes, bot_version FROM positions WHERE bot_version = 'v10c' ORDER BY opened_at").all();

console.log('=== v10c TRADES ===');
trades.forEach(t => {
  const opened = new Date(t.opened_at).toLocaleString();
  const closed = t.closed_at ? new Date(t.closed_at).toLocaleString() : 'OPEN';
  console.log(`\n${t.token_mint?.slice(0,8)}... | ${t.bot_version}`);
  console.log(`  Opened: ${opened} | Closed: ${closed}`);
  console.log(`  Invested: ${t.sol_invested} | Returned: ${t.sol_returned} | PnL: ${t.pnl_sol} (${t.pnl_pct}%)`);
  console.log(`  Peak: ${t.peak_multiplier}x | Latency: ${t.entry_latency_ms}ms | Exit: ${t.exit_reason}`);
  console.log(`  Sells: ${t.sell_successes}/${t.sell_attempts}`);
});

const total_pnl = trades.reduce((s, t) => s + (t.pnl_sol || 0), 0);
console.log(`\n=== SUMMARY ===`);
console.log(`Total trades: ${trades.length}`);
console.log(`Total PnL: ${total_pnl.toFixed(6)} SOL`);
console.log(`Wins: ${trades.filter(t => t.pnl_sol > 0).length}`);
console.log(`Losses: ${trades.filter(t => t.pnl_sol <= 0).length}`);

db.close();
