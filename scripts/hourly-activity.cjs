const db = require('better-sqlite3')('data/bot.db');

// Hourly pool + trade activity (last 24h)
console.log('=== HOURLY ACTIVITY (last 24h, local time) ===');
const hourly = db.prepare(`
  SELECT strftime('%H', detected_at/1000, 'unixepoch', 'localtime') as hr,
    COUNT(*) as pools,
    SUM(CASE WHEN security_passed = 1 THEN 1 ELSE 0 END) as passed,
    SUM(CASE WHEN dp_liquidity_usd >= 30000 THEN 1 ELSE 0 END) as big_liq,
    SUM(CASE WHEN dp_liquidity_usd >= 30000 AND security_passed = 1 THEN 1 ELSE 0 END) as big_passed
  FROM detected_pools WHERE detected_at > ?
  GROUP BY hr ORDER BY hr
`).all(Date.now() - 24 * 3600000);

console.log('Hour | Pools | Passed | $30K+ | $30K+Pass');
hourly.forEach(r => {
  console.log(`  ${r.hr}  | ${String(r.pools).padStart(5)} | ${String(r.passed).padStart(6)} | ${String(r.big_liq).padStart(5)} | ${String(r.big_passed).padStart(8)}`);
});

// Hourly trade outcomes
console.log('\n=== HOURLY TRADE OUTCOMES (last 24h, local time) ===');
const tradeHours = db.prepare(`
  SELECT strftime('%H', opened_at/1000, 'unixepoch', 'localtime') as hr,
    COUNT(*) as n,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN exit_reason IN ('rug_pull','pool_drained','max_retries','max_retries_429') THEN 1 ELSE 0 END) as rugs,
    ROUND(SUM(pnl_sol), 6) as pnl
  FROM positions WHERE status IN ('closed','stopped') AND opened_at > ?
  GROUP BY hr ORDER BY hr
`).all(Date.now() - 24 * 3600000);

console.log('Hour | Trades | Wins | Rugs | PnL');
tradeHours.forEach(r => {
  console.log(`  ${r.hr}  |   ${String(r.n).padStart(3)} | ${String(r.wins).padStart(4)} | ${String(r.rugs).padStart(4)} | ${r.pnl}`);
});

// Current hour (to know where we are)
const now = new Date();
console.log(`\nCurrent time: ${now.toLocaleTimeString()} (hour ${String(now.getHours()).padStart(2, '0')})`);

db.close();
