const db = require('better-sqlite3')('data/bot.db');
const now = Date.now();

console.log('=== FULL STATUS (last 12h) ===\n');

// All trades last 12h
const trades = db.prepare(`
  SELECT substr(token_mint, 1, 8) as tok, status,
    ROUND(pnl_sol, 6) as pnl, ROUND(pnl_pct, 1) as pct,
    exit_reason, bot_version as ver,
    ROUND((? - opened_at) / 60000.0) as mins_ago,
    ROUND((closed_at - opened_at) / 1000.0) as dur_s,
    sell_attempts, sell_successes
  FROM positions
  WHERE opened_at > ?
  ORDER BY opened_at ASC
`).all(now, now - 12 * 60 * 60 * 1000);

let totalPnl = 0, wins = 0, losses = 0;
trades.forEach((t, i) => {
  totalPnl += t.pnl || 0;
  if (t.status === 'open' || t.status === 'partial_close') {
    // still active
  } else if (t.pnl > 0) wins++;
  else losses++;
  const dur = t.dur_s ? `${t.dur_s}s` : 'active';
  console.log(`  ${String(i + 1).padStart(2)}. ${t.tok} | ${t.status.padEnd(13)} | ${String(t.pnl).padStart(10)} SOL (${String(t.pct).padStart(5)}%) | exit=${(t.exit_reason || '-').padEnd(12)} | dur=${dur.padEnd(8)} | ${t.ver || 'old'} | ${Math.abs(t.mins_ago)}m ago`);
});

const active = trades.filter(t => t.status === 'open' || t.status === 'partial_close');
console.log(`\nClosed: ${wins} wins, ${losses} losses (${trades.length - active.length} total)`);
console.log(`Active: ${active.length}`);
console.log(`PnL (closed): ${(totalPnl - active.reduce((s, t) => s + (t.pnl || 0), 0)).toFixed(6)} SOL`);
console.log(`PnL (incl active): ${totalPnl.toFixed(6)} SOL`);

// Check recent errors/failures
const recentFails = db.prepare(`
  SELECT COUNT(*) as n FROM token_analysis
  WHERE created_at > ? AND buy_attempted = 1 AND buy_succeeded = 0
`).get(now - 4 * 60 * 60 * 1000);
console.log(`\nBuy attempts failed (last 4h): ${recentFails.n}`);

// Balance trajectory from positions
const balTrajectory = db.prepare(`
  SELECT bot_version as ver,
    COUNT(*) as n,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN pnl_sol <= 0 THEN 1 ELSE 0 END) as losses,
    ROUND(SUM(pnl_sol), 6) as pnl,
    ROUND(AVG(pnl_sol), 6) as avg
  FROM positions
  WHERE status IN ('closed', 'stopped') AND opened_at > ?
  GROUP BY bot_version
  ORDER BY MIN(opened_at) ASC
`).all(now - 12 * 60 * 60 * 1000);
console.log('\nPnL by version (last 12h):');
balTrajectory.forEach(v => {
  console.log(`  ${v.ver || 'old'}: ${v.n} trades, ${v.wins}W/${v.losses}L, PnL=${v.pnl} SOL, avg=${v.avg}`);
});

// Recent sell failures (pool drains)
const sellFails = db.prepare(`
  SELECT substr(token_mint, 1, 8) as tok, exit_reason,
    ROUND(pnl_sol, 6) as pnl, sell_attempts, sell_successes,
    ROUND((? - closed_at) / 60000.0) as mins_ago_closed
  FROM positions
  WHERE opened_at > ? AND exit_reason IN ('timeout', 'sell_failed', 'stop_loss')
  ORDER BY closed_at DESC LIMIT 10
`).all(now, now - 12 * 60 * 60 * 1000);
console.log('\nRecent exits with issues:');
sellFails.forEach(s => {
  console.log(`  ${s.tok} | exit=${s.exit_reason} | pnl=${s.pnl} SOL | sells=${s.sell_attempts}/${s.sell_successes} | ${Math.abs(s.mins_ago_closed)}m ago`);
});

// Fee estimation (buy failures × ~0.00036 SOL)
const failCount = db.prepare(`
  SELECT COUNT(*) as n FROM detected_pools dp
  WHERE dp.detected_at > ? AND dp.bot_version IS NOT NULL
  AND EXISTS (SELECT 1 FROM token_analysis ta WHERE ta.pool_address = dp.pool_address AND ta.buy_attempted = 1 AND ta.buy_succeeded = 0)
`).get(now - 12 * 60 * 60 * 1000);
console.log(`\nBuy failures that cost fees: ~${failCount.n}`);
console.log(`Estimated fee waste: ~${(failCount.n * 0.00036).toFixed(5)} SOL`);

// All-time stats
const allTime = db.prepare(`
  SELECT COUNT(*) as total,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    ROUND(SUM(pnl_sol), 6) as pnl
  FROM positions WHERE status IN ('closed', 'stopped')
`).get();
console.log(`\nAll-time: ${allTime.total} trades, ${allTime.wins} wins, PnL: ${allTime.pnl} SOL`);

db.close();
