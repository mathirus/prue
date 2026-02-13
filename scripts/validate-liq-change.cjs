const db = require('better-sqlite3')('data/bot.db');

// VALIDATION: Raise minimum liquidity scoring
// Current: $15K=5pts, $20K=10pts, $25K+=15pts (full)
// Proposed: $15K=5pts, $20K=5pts, $25K=10pts, $30K+=15pts (full)
// Effect: $20-30K tokens lose 5pts, making them 75 max (below min_score=80)

console.log('=== VALIDATION: Liquidity Threshold Change ===');
console.log('Current:  <$15K=0pts, $15-20K=5pts, $20-25K=10pts, $25K+=15pts');
console.log('Proposed: <$15K=0pts, $15-20K=5pts, $20-25K=5pts, $25-30K=10pts, $30K+=15pts');
console.log('Effect: $20-30K tokens lose 5pts → score drops below 80 → BLOCKED\n');

// ALL TIME analysis
console.log('=== ALL-TIME DATA ===');
const allBrackets = db.prepare(`
  SELECT
    CASE WHEN liquidity_usd < 15000 THEN '<$15K'
         WHEN liquidity_usd < 20000 THEN '$15-20K'
         WHEN liquidity_usd < 25000 THEN '$20-25K'
         WHEN liquidity_usd < 30000 THEN '$25-30K'
         WHEN liquidity_usd < 50000 THEN '$30-50K'
         ELSE '>$50K' END as bracket,
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
console.log('Bracket   | N    | Wins | Rugs | Win%  | Rug%  | PnL        | Avg PnL');
allBrackets.forEach(r => console.log(`${r.bracket.padEnd(10)}| ${String(r.n).padStart(4)} | ${String(r.wins).padStart(4)} | ${String(r.rugs).padStart(4)} | ${String(r.win_pct).padStart(5)}% | ${String(r.rug_pct).padStart(5)}% | ${String(r.pnl).padStart(10)} | ${r.avg_pnl}`));

// Simulation: what would happen
console.log('\n=== SIMULATION: Block $20-30K bracket ===');
const blocked = db.prepare(`
  SELECT COUNT(*) as n,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN exit_reason IN ('rug_pull','pool_drained','max_retries','max_retries_429') THEN 1 ELSE 0 END) as rugs,
    ROUND(SUM(pnl_sol), 6) as pnl,
    ROUND(AVG(pnl_sol), 6) as avg_pnl
  FROM positions
  WHERE status IN ('closed','stopped') AND liquidity_usd >= 20000 AND liquidity_usd < 30000
`).get();
const kept = db.prepare(`
  SELECT COUNT(*) as n,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN exit_reason IN ('rug_pull','pool_drained','max_retries','max_retries_429') THEN 1 ELSE 0 END) as rugs,
    ROUND(SUM(pnl_sol), 6) as pnl,
    ROUND(AVG(pnl_sol), 6) as avg_pnl
  FROM positions
  WHERE status IN ('closed','stopped') AND (liquidity_usd < 20000 OR liquidity_usd >= 30000)
`).get();

console.log(`BLOCKED ($20-30K): ${blocked.n} trades, ${blocked.wins} wins, ${blocked.rugs} rugs, ${blocked.pnl} SOL`);
console.log(`KEPT (rest):       ${kept.n} trades, ${kept.wins} wins, ${kept.rugs} rugs, ${kept.pnl} SOL`);
console.log(`NET SAVINGS:       ${(-blocked.pnl).toFixed(6)} SOL (PnL of blocked trades, negated)`);
console.log(`WINNERS LOST:      ${blocked.wins} trades worth ~${(blocked.wins * 0.001).toFixed(3)} SOL avg`);

// List the specific winners we'd lose
console.log('\n=== WINNERS LOST (all-time, $20-30K bracket) ===');
const lostWinners = db.prepare(`
  SELECT substr(token_mint,1,8) as tok, ROUND(pnl_sol,6) as pnl, ROUND(pnl_pct,1) as pct,
    ROUND(liquidity_usd, 0) as liq, exit_reason, holder_count,
    datetime(opened_at/1000, 'unixepoch', 'localtime') as opened
  FROM positions
  WHERE status IN ('closed','stopped') AND pnl_sol > 0 AND liquidity_usd >= 20000 AND liquidity_usd < 30000
  ORDER BY pnl_sol DESC
`).all();
let totalLostPnl = 0;
lostWinners.forEach(r => {
  totalLostPnl += r.pnl;
  console.log(`  ${r.opened} | ${r.tok} | liq=$${r.liq} | h=${r.holder_count} | ${r.pnl} SOL (${r.pct}%) | ${r.exit_reason}`);
});
console.log(`Total winners PnL lost: ${totalLostPnl.toFixed(6)} SOL`);

// Feb 8-9 only (more relevant, after v8g+ improvements)
console.log('\n=== VALIDATION: Feb 8-9 only (v8g+ data with exit_reason) ===');
const feb89Start = new Date('2026-02-08T00:00:00').getTime();
const blockedRecent = db.prepare(`
  SELECT COUNT(*) as n,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN exit_reason IN ('rug_pull','pool_drained','max_retries','max_retries_429') THEN 1 ELSE 0 END) as rugs,
    ROUND(SUM(pnl_sol), 6) as pnl
  FROM positions
  WHERE status IN ('closed','stopped') AND liquidity_usd >= 20000 AND liquidity_usd < 30000 AND opened_at > ?
`).get(feb89Start);
const keptRecent = db.prepare(`
  SELECT COUNT(*) as n,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN exit_reason IN ('rug_pull','pool_drained','max_retries','max_retries_429') THEN 1 ELSE 0 END) as rugs,
    ROUND(SUM(pnl_sol), 6) as pnl
  FROM positions
  WHERE status IN ('closed','stopped') AND (liquidity_usd < 20000 OR liquidity_usd >= 30000) AND opened_at > ?
`).get(feb89Start);

console.log(`Feb 8-9 BLOCKED ($20-30K): ${blockedRecent.n} trades, ${blockedRecent.wins} wins, ${blockedRecent.rugs} rugs, ${blockedRecent.pnl} SOL`);
console.log(`Feb 8-9 KEPT (rest):       ${keptRecent.n} trades, ${keptRecent.wins} wins, ${keptRecent.rugs} rugs, ${keptRecent.pnl} SOL`);
console.log(`Feb 8-9 NET SAVINGS:       ${(-blockedRecent.pnl).toFixed(6)} SOL`);

// What about the 2-holder rug pattern?
console.log('\n=== 2-HOLDER RUG PATTERN ===');
const holderRugs = db.prepare(`
  SELECT holder_count,
    COUNT(*) as n,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN exit_reason IN ('rug_pull','pool_drained') THEN 1 ELSE 0 END) as rugs,
    ROUND(SUM(pnl_sol), 6) as pnl,
    ROUND(AVG(liquidity_usd), 0) as avg_liq
  FROM positions
  WHERE status IN ('closed','stopped') AND holder_count IS NOT NULL AND opened_at > ?
  GROUP BY holder_count ORDER BY n DESC
  LIMIT 10
`).all(feb89Start);
console.log('Holders | N   | Wins | Rugs | PnL        | Avg Liq');
holderRugs.forEach(r => console.log(`  ${String(r.holder_count).padStart(5)}   | ${String(r.n).padStart(3)} | ${String(r.wins).padStart(4)} | ${String(r.rugs).padStart(4)} | ${String(r.pnl).padStart(10)} | $${r.avg_liq}`));

db.close();
