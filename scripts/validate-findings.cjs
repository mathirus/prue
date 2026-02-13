const Database = require('better-sqlite3');
const db = new Database('data/bot.db');

// FINDING 1: top_holder_pct >= 90% passes with high score but loses
console.log('=== FINDING 1: TOP HOLDER >= 90% ===');
const topHolder90 = db.prepare(`
  SELECT
    CASE WHEN dp_top_holder_pct >= 90 THEN '>=90%'
         WHEN dp_top_holder_pct >= 50 THEN '50-89%'
         ELSE '<50%' END as bracket,
    COUNT(*) as n,
    SUM(CASE WHEN p.pnl_pct > 5 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN p.pnl_pct <= -80 THEN 1 ELSE 0 END) as rugs,
    ROUND(AVG(p.pnl_pct),1) as avg_pnl,
    ROUND(SUM(p.pnl_sol),6) as total_sol
  FROM positions p
  JOIN detected_pools dp ON p.token_mint = dp.base_mint
  WHERE p.status IN ('closed','stopped') AND dp.dp_top_holder_pct IS NOT NULL
  GROUP BY bracket ORDER BY bracket
`).all();
topHolder90.forEach(r => console.log(r));

// FINDING 2: holder_count > 15 = more rugs (wash trading?)
console.log('\n=== FINDING 2: HOLDER COUNT BRACKETS ===');
const holderBrackets = db.prepare(`
  SELECT
    CASE WHEN dp_holder_count >= 15 THEN '15+'
         WHEN dp_holder_count >= 8 THEN '8-14'
         WHEN dp_holder_count >= 3 THEN '3-7'
         ELSE '0-2' END as bracket,
    COUNT(*) as n,
    SUM(CASE WHEN p.pnl_pct > 5 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN p.pnl_pct <= -80 THEN 1 ELSE 0 END) as rugs,
    ROUND(AVG(p.pnl_pct),1) as avg_pnl,
    ROUND(SUM(p.pnl_sol),6) as total_sol
  FROM positions p
  JOIN detected_pools dp ON p.token_mint = dp.base_mint
  WHERE p.status IN ('closed','stopped') AND dp_holder_count IS NOT NULL AND dp_holder_count > 0
  GROUP BY bracket ORDER BY bracket
`).all();
holderBrackets.forEach(r => console.log(r));

// FINDING 3: Liquidity brackets vs PnL
console.log('\n=== FINDING 3: LIQUIDITY BRACKETS ===');
const liqBrackets = db.prepare(`
  SELECT
    CASE WHEN dp_liquidity_usd >= 25000 THEN '$25K+'
         WHEN dp_liquidity_usd >= 15000 THEN '$15-25K'
         WHEN dp_liquidity_usd >= 10000 THEN '$10-15K'
         ELSE '<$10K' END as bracket,
    COUNT(*) as n,
    SUM(CASE WHEN p.pnl_pct > 5 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN p.pnl_pct <= -80 THEN 1 ELSE 0 END) as rugs,
    ROUND(AVG(p.pnl_pct),1) as avg_pnl,
    ROUND(SUM(p.pnl_sol),6) as total_sol
  FROM positions p
  JOIN detected_pools dp ON p.token_mint = dp.base_mint
  WHERE p.status IN ('closed','stopped') AND dp_liquidity_usd IS NOT NULL
  GROUP BY bracket ORDER BY bracket
`).all();
liqBrackets.forEach(r => console.log(r));

// FINDING 4: Score 90+ with top_holder >= 90% - the problem combo
console.log('\n=== FINDING 4: SCORE 90+ WITH TOP HOLDER >= 90% ===');
const dangerCombo = db.prepare(`
  SELECT p.token_mint, p.security_score, dp.dp_top_holder_pct, dp.dp_holder_count,
    ROUND(p.pnl_pct,1) as pnl, ROUND(p.pnl_sol,6) as sol, dp.dp_liquidity_usd
  FROM positions p
  JOIN detected_pools dp ON p.token_mint = dp.base_mint
  WHERE p.status IN ('closed','stopped')
    AND p.security_score >= 85
    AND dp.dp_top_holder_pct >= 90
  ORDER BY p.pnl_pct
`).all();
console.log('Count:', dangerCombo.length);
dangerCombo.forEach(d => console.log(
  (d.token_mint||'').slice(0,8), 'score:', d.security_score,
  'top:', Math.round(d.dp_top_holder_pct)+'%', 'holders:', d.dp_holder_count,
  'pnl:', d.pnl+'%', d.sol+' SOL', 'liq:', Math.round(d.dp_liquidity_usd||0)
));

// FINDING 5: v8e only (0.003 SOL trades) - same analysis
console.log('\n=== FINDING 5: V8E ONLY - SCORE vs PnL ===');
const v8eSince = new Date('2026-02-08T12:00:00').getTime(); // broader window
const v8eByScore = db.prepare(`
  SELECT
    CASE WHEN security_score >= 85 THEN '85+' ELSE '80-84' END as bracket,
    COUNT(*) as n,
    SUM(CASE WHEN pnl_pct > 5 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN pnl_pct <= -80 THEN 1 ELSE 0 END) as rugs,
    ROUND(SUM(pnl_sol),6) as total_sol,
    ROUND(AVG(pnl_pct),1) as avg_pnl
  FROM positions
  WHERE opened_at > ? AND status IN ('closed','stopped') AND sol_invested >= 0.002
  GROUP BY bracket
`).all(v8eSince);
v8eByScore.forEach(r => console.log(r));

// FINDING 6: breakeven trades (sol_returned = 0)
console.log('\n=== FINDING 6: ZERO-RETURN TRADES ===');
const zeroReturn = db.prepare(`
  SELECT COUNT(*) as n, ROUND(SUM(sol_invested),4) as lost_sol
  FROM positions
  WHERE status IN ('closed','stopped') AND sol_returned = 0 AND sol_invested > 0
`).get();
console.log('Trades with 0 SOL returned:', zeroReturn);

db.close();
