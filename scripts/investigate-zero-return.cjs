const Database = require('better-sqlite3');
const db = new Database('data/bot.db');

// Zero-return trades - what are they?
console.log('=== ZERO-RETURN TRADES: BREAKDOWN ===');
const zeroByInvested = db.prepare(`
  SELECT
    CASE WHEN sol_invested >= 0.01 THEN '>=0.01 (pre-v8)'
         WHEN sol_invested >= 0.003 THEN '0.003 (v8e+)'
         WHEN sol_invested >= 0.001 THEN '0.001 (v8c/d)'
         ELSE '<0.001' END as size,
    COUNT(*) as n,
    ROUND(SUM(sol_invested),4) as lost_sol,
    status
  FROM positions
  WHERE status IN ('closed','stopped') AND sol_returned = 0 AND sol_invested > 0
  GROUP BY size, status ORDER BY size
`).all();
zeroByInvested.forEach(r => console.log(r));

// Last 30 zero-return trades
console.log('\n=== LAST 30 ZERO-RETURN TRADES ===');
const lastZero = db.prepare(`
  SELECT token_mint, sol_invested, security_score, status,
    datetime(opened_at/1000, 'unixepoch') as opened,
    ROUND((closed_at - opened_at)/1000.0, 0) as duration_sec
  FROM positions
  WHERE status IN ('closed','stopped') AND sol_returned = 0 AND sol_invested > 0
  ORDER BY opened_at DESC LIMIT 30
`).all();
lastZero.forEach(t => console.log(
  (t.token_mint||'').slice(0,8), 'inv:', t.sol_invested, 'score:', t.security_score,
  'dur:', t.duration_sec+'s', 'status:', t.status, t.opened
));

// Recent v8 zero-return specifically
console.log('\n=== V8 ZERO-RETURN (since Feb 8 noon) ===');
const v8Start = new Date('2026-02-08T12:00:00').getTime();
const v8Zero = db.prepare(`
  SELECT token_mint, sol_invested, security_score, pnl_pct,
    datetime(opened_at/1000, 'unixepoch') as opened,
    ROUND((closed_at - opened_at)/1000.0, 0) as duration_sec
  FROM positions
  WHERE opened_at > ? AND status IN ('closed','stopped') AND sol_returned = 0
  ORDER BY opened_at
`).all(v8Start);
console.log('Count:', v8Zero.length);
v8Zero.forEach(t => console.log(
  (t.token_mint||'').slice(0,8), 'inv:', t.sol_invested, 'score:', t.security_score,
  'pnl:', t.pnl_pct+'%', 'dur:', t.duration_sec+'s', t.opened
));

// Holder count 8-14 deeper analysis
console.log('\n=== HOLDER 8-14 BRACKET: INDIVIDUAL TRADES ===');
const holder814 = db.prepare(`
  SELECT p.token_mint, p.pnl_pct, p.pnl_sol, p.security_score, dp.dp_holder_count,
    dp.dp_liquidity_usd, dp.dp_top_holder_pct,
    CASE WHEN p.pnl_pct <= -80 THEN 'RUG'
         WHEN p.pnl_pct > 5 THEN 'WIN'
         ELSE 'LOSS' END as outcome
  FROM positions p
  JOIN detected_pools dp ON p.token_mint = dp.base_mint
  WHERE p.status IN ('closed','stopped')
    AND dp.dp_holder_count >= 8 AND dp.dp_holder_count <= 14
  ORDER BY p.pnl_pct
`).all();
console.log('Total:', holder814.length);
const rug814 = holder814.filter(t => t.outcome === 'RUG');
const win814 = holder814.filter(t => t.outcome === 'WIN');
console.log('Rugs:', rug814.length, 'Wins:', win814.length, 'Losses:', holder814.length - rug814.length - win814.length);

// Rug tokens in 8-14 bracket - what else characterizes them?
console.log('\nRugs in 8-14:');
rug814.forEach(t => console.log(
  (t.token_mint||'').slice(0,8), 'score:', t.security_score,
  'holders:', t.dp_holder_count, 'top:', Math.round(t.dp_top_holder_pct||0)+'%',
  'liq:', Math.round(t.dp_liquidity_usd||0)
));

// Liquidity $10-15K deeper
console.log('\n=== LIQUIDITY $10-15K: OUTCOMES ===');
const liq1015 = db.prepare(`
  SELECT p.token_mint, p.pnl_pct, p.security_score, dp.dp_liquidity_usd,
    dp.dp_holder_count, dp.dp_top_holder_pct,
    CASE WHEN p.pnl_pct <= -80 THEN 'RUG'
         WHEN p.pnl_pct > 5 THEN 'WIN'
         ELSE 'LOSS' END as outcome
  FROM positions p
  JOIN detected_pools dp ON p.token_mint = dp.base_mint
  WHERE p.status IN ('closed','stopped')
    AND dp.dp_liquidity_usd >= 10000 AND dp.dp_liquidity_usd < 15000
  ORDER BY p.pnl_pct
`).all();
const rugLiq = liq1015.filter(t => t.outcome === 'RUG');
const winLiq = liq1015.filter(t => t.outcome === 'WIN');
console.log('Total:', liq1015.length, 'Rugs:', rugLiq.length, 'Wins:', winLiq.length);
console.log('\nRugs in $10-15K:');
rugLiq.forEach(t => console.log(
  (t.token_mint||'').slice(0,8), 'score:', t.security_score,
  'holders:', t.dp_holder_count, 'top:', Math.round(t.dp_top_holder_pct||0)+'%',
  'liq:', Math.round(t.dp_liquidity_usd||0)
));

// What would happen if we REQUIRED liquidity >= $15K?
console.log('\n=== WHAT-IF: REQUIRE $15K+ LIQUIDITY ===');
const whatIfLiq = db.prepare(`
  SELECT
    CASE WHEN dp_liquidity_usd >= 15000 THEN 'pass ($15K+)' ELSE 'blocked (<$15K)' END as group_name,
    COUNT(*) as n,
    SUM(CASE WHEN p.pnl_pct > 5 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN p.pnl_pct <= -80 THEN 1 ELSE 0 END) as rugs,
    ROUND(AVG(p.pnl_pct), 1) as avg_pnl,
    ROUND(SUM(p.pnl_sol), 6) as total_sol
  FROM positions p
  JOIN detected_pools dp ON p.token_mint = dp.base_mint
  WHERE p.status IN ('closed','stopped') AND dp.dp_liquidity_usd IS NOT NULL
  GROUP BY group_name
`).all();
whatIfLiq.forEach(r => console.log(r));

// What would happen if we penalize holders 8-14 by -10 pts?
console.log('\n=== WHAT-IF: PENALTY -10 FOR HOLDERS 8-14 ===');
const whatIfHolders = db.prepare(`
  SELECT
    p.security_score,
    p.security_score - 10 as adjusted_score,
    CASE WHEN p.security_score - 10 < 80 THEN 'would-be-blocked' ELSE 'still-passes' END as result,
    p.pnl_pct,
    CASE WHEN p.pnl_pct <= -80 THEN 'RUG'
         WHEN p.pnl_pct > 5 THEN 'WIN'
         ELSE 'LOSS' END as outcome
  FROM positions p
  JOIN detected_pools dp ON p.token_mint = dp.base_mint
  WHERE p.status IN ('closed','stopped')
    AND dp.dp_holder_count >= 8 AND dp.dp_holder_count <= 14
    AND p.security_score >= 80
  ORDER BY result, outcome
`).all();
const blocked = whatIfHolders.filter(r => r.result === 'would-be-blocked');
const blockedRugs = blocked.filter(r => r.outcome === 'RUG');
const blockedWins = blocked.filter(r => r.outcome === 'WIN');
console.log(`Would block ${blocked.length} trades: ${blockedRugs.length} rugs, ${blockedWins.length} wins, ${blocked.length - blockedRugs.length - blockedWins.length} losses`);
const savedSol = blockedRugs.length * 0.003; // approximate
const lostSol = blockedWins.length * 0.001; // approximate win
console.log(`Approx saved: ${savedSol.toFixed(4)} SOL, lost: ${lostSol.toFixed(4)} SOL, net: ${(savedSol - lostSol).toFixed(4)} SOL`);

db.close();
