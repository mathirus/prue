const db = require('better-sqlite3')('data/bot.db');

// All-time liquidity bracket analysis
console.log('=== ALL-TIME LIQUIDITY BRACKETS ===');
const liq = db.prepare(`
  SELECT
    CASE WHEN liquidity_usd < 20000 THEN '<$20K'
         WHEN liquidity_usd < 25000 THEN '$20-25K'
         WHEN liquidity_usd < 30000 THEN '$25-30K'
         WHEN liquidity_usd < 50000 THEN '$30-50K'
         WHEN liquidity_usd < 75000 THEN '$50-75K'
         ELSE '>$75K' END as bracket,
    COUNT(*) as n,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN exit_reason IN ('rug_pull','pool_drained','max_retries','max_retries_429') THEN 1 ELSE 0 END) as rugs,
    ROUND(SUM(pnl_sol), 6) as pnl,
    ROUND(AVG(pnl_sol), 6) as avg_pnl,
    ROUND(100.0 * SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) as win_pct,
    ROUND(100.0 * SUM(CASE WHEN exit_reason IN ('rug_pull','pool_drained','max_retries','max_retries_429') THEN 1 ELSE 0 END) / COUNT(*), 1) as rug_pct
  FROM positions
  WHERE status IN ('closed','stopped') AND liquidity_usd > 0
  GROUP BY bracket ORDER BY MIN(liquidity_usd)
`).all();
console.log('Bracket   | N   | Wins | Rugs | Win%  | Rug%  | PnL        | Avg PnL');
liq.forEach(r => console.log(`${r.bracket.padEnd(10)}| ${String(r.n).padStart(3)} | ${String(r.wins).padStart(4)} | ${String(r.rugs).padStart(4)} | ${String(r.win_pct).padStart(5)}% | ${String(r.rug_pct).padStart(5)}% | ${String(r.pnl).padStart(10)} | ${r.avg_pnl}`));

// Same but only last 48h (more relevant data)
console.log('\n=== LAST 48h LIQUIDITY BRACKETS ===');
const liq48 = db.prepare(`
  SELECT
    CASE WHEN liquidity_usd < 20000 THEN '<$20K'
         WHEN liquidity_usd < 25000 THEN '$20-25K'
         WHEN liquidity_usd < 30000 THEN '$25-30K'
         WHEN liquidity_usd < 50000 THEN '$30-50K'
         WHEN liquidity_usd < 75000 THEN '$50-75K'
         ELSE '>$75K' END as bracket,
    COUNT(*) as n,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN exit_reason IN ('rug_pull','pool_drained','max_retries','max_retries_429') THEN 1 ELSE 0 END) as rugs,
    ROUND(SUM(pnl_sol), 6) as pnl,
    ROUND(AVG(pnl_sol), 6) as avg_pnl,
    ROUND(100.0 * SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) as win_pct,
    ROUND(100.0 * SUM(CASE WHEN exit_reason IN ('rug_pull','pool_drained','max_retries','max_retries_429') THEN 1 ELSE 0 END) / COUNT(*), 1) as rug_pct
  FROM positions
  WHERE status IN ('closed','stopped') AND liquidity_usd > 0 AND opened_at > ?
  GROUP BY bracket ORDER BY MIN(liquidity_usd)
`).all(Date.now() - 48 * 3600000);
console.log('Bracket   | N   | Wins | Rugs | Win%  | Rug%  | PnL        | Avg PnL');
liq48.forEach(r => console.log(`${r.bracket.padEnd(10)}| ${String(r.n).padStart(3)} | ${String(r.wins).padStart(4)} | ${String(r.rugs).padStart(4)} | ${String(r.win_pct).padStart(5)}% | ${String(r.rug_pct).padStart(5)}% | ${String(r.pnl).padStart(10)} | ${r.avg_pnl}`));

// Simulate: what if we required $30K+ instead of $25K+?
console.log('\n=== SIMULATION: Require $30K+ liquidity (last 48h) ===');
const sim30k = db.prepare(`
  SELECT
    CASE WHEN liquidity_usd >= 30000 THEN 'PASS (>=30K)' ELSE 'BLOCKED (<30K)' END as category,
    COUNT(*) as n,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN exit_reason IN ('rug_pull','pool_drained','max_retries','max_retries_429') THEN 1 ELSE 0 END) as rugs,
    ROUND(SUM(pnl_sol), 6) as pnl,
    ROUND(AVG(pnl_sol), 6) as avg_pnl
  FROM positions
  WHERE status IN ('closed','stopped') AND liquidity_usd > 0 AND opened_at > ?
  GROUP BY category
`).all(Date.now() - 48 * 3600000);
sim30k.forEach(r => console.log(`${r.category}: ${r.n} trades, ${r.wins} wins, ${r.rugs} rugs, ${r.pnl} SOL (avg ${r.avg_pnl})`));

// What winners would we lose at $30K+?
console.log('\n=== WINNERS LOST at $30K+ threshold (last 48h) ===');
const lostWinners = db.prepare(`
  SELECT substr(token_mint,1,8) as tok, ROUND(pnl_sol,6) as pnl, ROUND(pnl_pct,1) as pct,
    ROUND(liquidity_usd, 0) as liq, exit_reason,
    datetime(opened_at/1000, 'unixepoch', 'localtime') as opened
  FROM positions
  WHERE status IN ('closed','stopped') AND pnl_sol > 0 AND liquidity_usd < 30000 AND liquidity_usd > 0
    AND opened_at > ?
  ORDER BY opened_at DESC
`).all(Date.now() - 48 * 3600000);
lostWinners.forEach(r => console.log(`  ${r.opened} | ${r.tok} | liq=$${r.liq} | ${r.pnl} SOL (${r.pct}%) | ${r.exit_reason}`));
console.log(`Total winners lost: ${lostWinners.length}, total PnL lost: ${lostWinners.reduce((s,r)=>s+r.pnl,0).toFixed(6)} SOL`);

db.close();
