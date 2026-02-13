const db = require('better-sqlite3')('data/bot.db');

const trades = db.prepare(`
  SELECT token_mint, sol_invested, sol_returned, pnl_sol, pnl_pct, status, exit_reason,
    peak_multiplier, time_to_peak_ms, sell_attempts, sell_successes, tp_levels_hit,
    opened_at, closed_at, entry_latency_ms, bot_version,
    post_sell_max_multiplier, post_sell_dex_change_24h, post_sell_dex_volume_24h, post_sell_dex_fdv
  FROM positions
  WHERE bot_version IN ('v8o','v8p')
  ORDER BY opened_at ASC
`).all();

console.log('=== v8o+v8p EXIT ANALYSIS (9 trades) ===\n');

let totalLeftOnTable = 0;

trades.forEach((t, i) => {
  const dur = t.closed_at ? ((t.closed_at - t.opened_at) / 1000).toFixed(0) : '?';
  const peak = t.peak_multiplier ? t.peak_multiplier.toFixed(3) : '?';
  const exitMult = 1 + t.pnl_pct / 100;
  const tpk = t.time_to_peak_ms ? (t.time_to_peak_ms / 1000).toFixed(0) + 's' : '?';

  // How much we left on the table
  const peakVal = t.peak_multiplier || exitMult;
  const leftPct = ((peakVal - exitMult) / exitMult * 100).toFixed(1);
  const leftSol = t.sol_invested * (peakVal - exitMult);
  totalLeftOnTable += Math.max(0, leftSol);

  console.log(`${i+1}. ${t.token_mint.slice(0,8)}`);
  console.log(`   PnL: +${t.pnl_pct.toFixed(1)}% (+${t.pnl_sol.toFixed(4)} SOL)`);
  console.log(`   Exit: ${exitMult.toFixed(2)}x | Peak: ${peak}x | Left on table: ${leftPct}%`);
  console.log(`   Duration: ${dur}s | Time to peak: ${tpk} | Exit reason: ${t.exit_reason || '?'}`);
  console.log(`   TP hits: ${t.tp_levels_hit || '[]'} | Sells: ${t.sell_attempts}/${t.sell_successes}`);

  if (t.post_sell_max_multiplier) {
    console.log(`   POST-SELL: max=${t.post_sell_max_multiplier.toFixed(2)}x | dex24h=${t.post_sell_dex_change_24h ? t.post_sell_dex_change_24h.toFixed(0)+'%' : '?'} | vol=${t.post_sell_dex_volume_24h ? '$'+Math.round(t.post_sell_dex_volume_24h) : '?'}`);
  }
  console.log();
});

console.log('=== RESUMEN ===');
console.log(`Total trades: ${trades.length}`);
console.log(`Avg PnL: +${(trades.reduce((s,t) => s+t.pnl_pct, 0) / trades.length).toFixed(1)}%`);
console.log(`Avg peak multiplier: ${(trades.filter(t=>t.peak_multiplier).reduce((s,t) => s+t.peak_multiplier, 0) / trades.filter(t=>t.peak_multiplier).length).toFixed(3)}x`);
console.log(`Total left on table: ${totalLeftOnTable.toFixed(4)} SOL`);

// Exit reason breakdown
const reasons = {};
trades.forEach(t => { const r = t.exit_reason || 'unknown'; reasons[r] = (reasons[r]||0) + 1; });
console.log(`\nExit reasons:`, reasons);

// TP levels hit analysis
const tpCounts = { 0: 0, 1: 0, 2: 0, 3: 0 };
trades.forEach(t => {
  try {
    const tp = JSON.parse(t.tp_levels_hit || '[]');
    tpCounts[tp.length] = (tpCounts[tp.length] || 0) + 1;
  } catch { tpCounts[0]++; }
});
console.log('TP levels reached:', tpCounts);

// Current TP config for reference
console.log('\n=== CURRENT TP CONFIG ===');
console.log('TP1: 50% @ 1.3x');
console.log('TP2: 25% @ 2.0x');
console.log('TP3: 25% @ 4.0x');
console.log('Trailing: 25% base, 20% after TP1');
console.log('Timeout: 12min base');

db.close();
