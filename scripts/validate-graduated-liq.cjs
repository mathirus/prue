const Database = require('better-sqlite3');
const db = new Database('data/bot.db');

// Validate graduated liquidity scoring against TRADED positions
// Old: $11K+ = 15 pts
// New: $11-15K = 5pts, $15-25K = 10pts, $25K+ = 15pts
// Difference: -10 for $11-15K, -5 for $15-25K

console.log('=== IMPACT ON TRADED POSITIONS (v8+, 0.003 SOL) ===');
const v8Trades = db.prepare(`
  SELECT p.token_mint, p.security_score, dp.dp_liquidity_usd, p.pnl_pct, p.pnl_sol,
    CASE WHEN p.pnl_pct <= -80 THEN 'RUG'
         WHEN p.pnl_pct > 5 THEN 'WIN'
         ELSE 'LOSS' END as outcome,
    CASE WHEN dp.dp_liquidity_usd < 15000 THEN -10
         WHEN dp.dp_liquidity_usd < 25000 THEN -5
         ELSE 0 END as score_delta
  FROM positions p
  JOIN detected_pools dp ON p.token_mint = dp.base_mint
  WHERE p.status IN ('closed','stopped')
    AND p.sol_invested >= 0.002
    AND dp.dp_liquidity_usd >= 11000
`).all();

let newly_blocked = { RUG: 0, WIN: 0, LOSS: 0, sol: 0 };
let unaffected = { RUG: 0, WIN: 0, LOSS: 0, sol: 0 };

for (const t of v8Trades) {
  const new_score = t.security_score + t.score_delta;
  if (new_score < 80 && t.security_score >= 80) {
    newly_blocked[t.outcome]++;
    newly_blocked.sol += t.pnl_sol;
    console.log(`BLOCKED: ${(t.token_mint||'').slice(0,8)} score:${t.security_score}→${new_score} liq:$${Math.round(t.dp_liquidity_usd)} ${t.outcome} pnl:${t.pnl_pct?.toFixed(1)}%`);
  } else {
    unaffected[t.outcome]++;
    unaffected.sol += t.pnl_sol;
  }
}

console.log('\n--- SUMMARY ---');
console.log('Newly blocked:', JSON.stringify(newly_blocked));
console.log('Unaffected:', JSON.stringify(unaffected));
console.log('SOL saved by blocking:', (-newly_blocked.sol).toFixed(6));

// Also show: what happens to score 80-89 tokens at $11-15K liq
console.log('\n=== SCORE 80-89 + LIQ $11-15K (will drop to 70-79, BLOCKED) ===');
const dropZone = db.prepare(`
  SELECT p.token_mint, p.security_score, dp.dp_liquidity_usd, p.pnl_pct,
    dp.dp_holder_count,
    CASE WHEN p.pnl_pct <= -80 THEN 'RUG'
         WHEN p.pnl_pct > 5 THEN 'WIN'
         ELSE 'LOSS' END as outcome
  FROM positions p
  JOIN detected_pools dp ON p.token_mint = dp.base_mint
  WHERE p.status IN ('closed','stopped')
    AND p.security_score >= 80 AND p.security_score < 90
    AND dp.dp_liquidity_usd >= 11000 AND dp.dp_liquidity_usd < 15000
  ORDER BY p.pnl_pct
`).all();
console.log('Total in drop zone:', dropZone.length);
dropZone.forEach(t => console.log(
  (t.token_mint||'').slice(0,8), 'score:', t.security_score, '→', t.security_score - 10,
  'liq:', Math.round(t.dp_liquidity_usd), 'holders:', t.dp_holder_count,
  t.outcome, 'pnl:', t.pnl_pct?.toFixed(1)+'%'
));

db.close();
