const db = require('better-sqlite3')('data/bot.db');

const cutoff6h = Date.now() - 6 * 3600000;
const cutoff12h = Date.now() - 12 * 3600000;

// 1. Hourly breakdown with details
console.log('=== LAST 12h HOURLY BREAKDOWN ===');
const hourly = db.prepare(`
  SELECT strftime('%H', opened_at/1000, 'unixepoch', 'localtime') as hr,
    COUNT(*) as n,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN exit_reason IN ('rug_pull','pool_drained') THEN 1 ELSE 0 END) as rugs,
    SUM(CASE WHEN exit_reason = 'timeout' THEN 1 ELSE 0 END) as timeouts,
    SUM(CASE WHEN exit_reason = 'trailing_stop' THEN 1 ELSE 0 END) as trailing,
    ROUND(SUM(pnl_sol), 6) as pnl,
    ROUND(AVG(pnl_sol), 6) as avg_pnl,
    ROUND(AVG(security_score), 1) as avg_score,
    ROUND(AVG(liquidity_usd), 0) as avg_liq
  FROM positions
  WHERE status IN ('closed','stopped') AND opened_at > ?
  GROUP BY hr ORDER BY hr
`).all(cutoff12h);
console.log('Hour | Trades | Wins | Rugs | TO | TS | PnL | Avg PnL | Avg Score | Avg Liq');
hourly.forEach(r => {
  const winPct = r.n > 0 ? Math.round(100 * r.wins / r.n) : 0;
  console.log(`  ${r.hr}  |   ${r.n}    |  ${r.wins}   |  ${r.rugs}   | ${r.timeouts || 0}  | ${r.trailing || 0}  | ${r.pnl} | ${r.avg_pnl} | ${r.avg_score} | $${r.avg_liq}`);
});

// 2. Every trade in last 6h with full details
console.log('\n=== EVERY TRADE (last 6h) ===');
const trades = db.prepare(`
  SELECT substr(p.token_mint,1,8) as tok,
    ROUND(p.pnl_sol, 6) as pnl, ROUND(p.pnl_pct, 1) as pct,
    p.exit_reason, p.security_score as score,
    ROUND(p.liquidity_usd, 0) as liq,
    p.holder_count as holders,
    ROUND(p.peak_multiplier, 3) as peak,
    ROUND((p.closed_at - p.opened_at)/1000.0, 0) as hold_sec,
    p.sell_attempts, p.sell_successes,
    datetime(p.opened_at/1000, 'unixepoch', 'localtime') as opened,
    dp.dp_graduation_time_s as grad_time,
    dp.dp_bundle_penalty as bundle_pen,
    dp.dp_insiders_count as insiders
  FROM positions p
  LEFT JOIN detected_pools dp ON p.pool_address = dp.pool_address
  WHERE p.status IN ('closed','stopped') AND p.opened_at > ?
  ORDER BY p.opened_at DESC
`).all(cutoff6h);
console.log(`Total: ${trades.length} trades`);
trades.forEach(r => {
  const gradStr = r.grad_time != null && r.grad_time >= 0 ? `${Math.round(r.grad_time/60)}min` : 'N/A';
  console.log(`  ${r.opened} | ${r.tok} | score=${r.score} | liq=$${r.liq} | h=${r.holders} | grad=${gradStr} | peak=${r.peak}x | hold=${r.hold_sec}s | ${r.exit_reason} | ${r.pnl} SOL (${r.pct}%)`);
});

// 3. Winners vs Losers comparison
console.log('\n=== WINNERS vs LOSERS (last 6h) ===');
const comparison = db.prepare(`
  SELECT
    CASE WHEN pnl_sol > 0 THEN 'WIN' ELSE 'LOSS' END as outcome,
    COUNT(*) as n,
    ROUND(AVG(pnl_sol), 6) as avg_pnl,
    ROUND(AVG(peak_multiplier), 3) as avg_peak,
    ROUND(AVG((closed_at - opened_at)/1000.0), 0) as avg_hold_sec,
    ROUND(AVG(liquidity_usd), 0) as avg_liq,
    ROUND(AVG(security_score), 1) as avg_score,
    GROUP_CONCAT(DISTINCT exit_reason) as reasons
  FROM positions
  WHERE status IN ('closed','stopped') AND opened_at > ?
  GROUP BY outcome
`).all(cutoff6h);
comparison.forEach(r => console.log(`${r.outcome}: ${r.n} trades, avg PnL=${r.avg_pnl}, avg peak=${r.avg_peak}x, avg hold=${r.avg_hold_sec}s, avg liq=$${r.avg_liq}, avg score=${r.avg_score}, reasons: ${r.reasons}`));

// 4. Rug analysis - what are rugs doing differently?
console.log('\n=== RUG DETAILS (last 6h) ===');
const rugs = db.prepare(`
  SELECT substr(p.token_mint,1,12) as tok,
    ROUND(p.pnl_sol, 6) as pnl,
    p.security_score as score,
    ROUND(p.liquidity_usd, 0) as liq,
    p.holder_count as holders,
    ROUND(p.peak_multiplier, 3) as peak,
    ROUND((p.closed_at - p.opened_at)/1000.0, 0) as hold_sec,
    dp.dp_graduation_time_s as grad_time,
    datetime(p.opened_at/1000, 'unixepoch', 'localtime') as opened
  FROM positions p
  LEFT JOIN detected_pools dp ON p.pool_address = dp.pool_address
  WHERE p.status IN ('closed','stopped')
    AND p.exit_reason IN ('rug_pull','pool_drained','max_retries','max_retries_429')
    AND p.opened_at > ?
  ORDER BY p.opened_at DESC
`).all(cutoff6h);
rugs.forEach(r => {
  const gradStr = r.grad_time != null && r.grad_time >= 0 ? `${Math.round(r.grad_time/60)}min` : 'N/A';
  console.log(`  ${r.opened} | ${r.tok} | score=${r.score} | liq=$${r.liq} | h=${r.holders} | grad=${gradStr} | peak=${r.peak}x | hold=${r.hold_sec}s`);
});

// 5. Liquidity distribution of trades
console.log('\n=== LIQUIDITY BRACKETS (last 6h) ===');
const liqBrackets = db.prepare(`
  SELECT
    CASE WHEN liquidity_usd < 20000 THEN '<$20K'
         WHEN liquidity_usd < 30000 THEN '$20-30K'
         WHEN liquidity_usd < 50000 THEN '$30-50K'
         WHEN liquidity_usd < 75000 THEN '$50-75K'
         ELSE '>$75K' END as bracket,
    COUNT(*) as n,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN exit_reason IN ('rug_pull','pool_drained') THEN 1 ELSE 0 END) as rugs,
    ROUND(SUM(pnl_sol), 6) as pnl,
    ROUND(AVG(pnl_sol), 6) as avg_pnl
  FROM positions
  WHERE status IN ('closed','stopped') AND opened_at > ?
  GROUP BY bracket ORDER BY MIN(liquidity_usd)
`).all(cutoff6h);
liqBrackets.forEach(r => console.log(`  ${r.bracket}: ${r.n} trades, ${r.wins} wins, ${r.rugs} rugs, ${r.pnl} SOL (avg ${r.avg_pnl})`));

// 6. Comparison: profitable period (last 12-6h ago) vs unprofitable (last 6h)
console.log('\n=== PERIOD COMPARISON ===');
const period1 = db.prepare(`
  SELECT COUNT(*) as n, SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN exit_reason IN ('rug_pull','pool_drained') THEN 1 ELSE 0 END) as rugs,
    ROUND(SUM(pnl_sol), 6) as pnl, ROUND(AVG(pnl_sol), 6) as avg
  FROM positions WHERE status IN ('closed','stopped') AND opened_at BETWEEN ? AND ?
`).get(cutoff12h, cutoff6h);
const period2 = db.prepare(`
  SELECT COUNT(*) as n, SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN exit_reason IN ('rug_pull','pool_drained') THEN 1 ELSE 0 END) as rugs,
    ROUND(SUM(pnl_sol), 6) as pnl, ROUND(AVG(pnl_sol), 6) as avg
  FROM positions WHERE status IN ('closed','stopped') AND opened_at > ?
`).get(cutoff6h);
console.log(`6-12h ago: ${period1.n} trades, ${period1.wins} wins (${period1.n>0?Math.round(100*period1.wins/period1.n):0}%), ${period1.rugs} rugs, ${period1.pnl} SOL`);
console.log(`Last 6h:   ${period2.n} trades, ${period2.wins} wins (${period2.n>0?Math.round(100*period2.wins/period2.n):0}%), ${period2.rugs} rugs, ${period2.pnl} SOL`);

// 7. Exit reason effectiveness
console.log('\n=== EXIT REASON PnL (last 6h) ===');
const exitReasons = db.prepare(`
  SELECT exit_reason, COUNT(*) as n,
    ROUND(SUM(pnl_sol),6) as pnl, ROUND(AVG(pnl_sol),6) as avg,
    ROUND(AVG(peak_multiplier),3) as avg_peak
  FROM positions WHERE status IN ('closed','stopped') AND opened_at > ?
  GROUP BY exit_reason ORDER BY pnl
`).all(cutoff6h);
exitReasons.forEach(r => console.log(`  ${r.exit_reason || 'null'}: ${r.n} trades, ${r.pnl} SOL (avg ${r.avg}), avg peak=${r.avg_peak}x`));

db.close();
