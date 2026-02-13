const db = require('better-sqlite3')('data/bot.db');

// All trades with exit_reason (v8g+) - the useful data
console.log('=== PENALTY IMPACT ANALYSIS ===');
console.log('Goal: find which penalties correlate with rugs vs wins\n');

// 1. Graduation timing vs outcomes (from detected_pools + positions)
console.log('--- GRADUATION TIMING vs OUTCOMES ---');
const gradTrades = db.prepare(`
  SELECT
    CASE
      WHEN dp.dp_graduation_time_s IS NULL OR dp.dp_graduation_time_s < 0 THEN 'unknown'
      WHEN dp.dp_graduation_time_s < 60 THEN '<1min'
      WHEN dp.dp_graduation_time_s < 300 THEN '1-5min'
      WHEN dp.dp_graduation_time_s < 2700 THEN '5-45min'
      ELSE '>45min'
    END as grad_bracket,
    COUNT(*) as n,
    SUM(CASE WHEN p.pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN p.exit_reason IN ('rug_pull','pool_drained','max_retries','max_retries_429') THEN 1 ELSE 0 END) as rugs,
    ROUND(SUM(p.pnl_sol), 6) as pnl,
    ROUND(AVG(p.pnl_sol), 6) as avg_pnl
  FROM positions p
  JOIN detected_pools dp ON p.pool_address = dp.pool_address
  WHERE p.status IN ('closed','stopped') AND p.exit_reason IS NOT NULL
  GROUP BY grad_bracket ORDER BY grad_bracket
`).all();

gradTrades.forEach(r => {
  const winPct = r.n > 0 ? Math.round(100 * r.wins / r.n) : 0;
  const rugPct = r.n > 0 ? Math.round(100 * r.rugs / r.n) : 0;
  console.log(`  ${r.grad_bracket.padEnd(10)}: N=${r.n}, wins=${r.wins}(${winPct}%), rugs=${r.rugs}(${rugPct}%), pnl=${r.pnl} SOL, avg=${r.avg_pnl}`);
});

// 2. Holder count vs outcomes for PumpSwap
console.log('\n--- HOLDER COUNT vs OUTCOMES (all trades with exit_reason) ---');
const holderTrades = db.prepare(`
  SELECT
    CASE
      WHEN holder_count IS NULL OR holder_count < 0 THEN 'unknown'
      WHEN holder_count <= 2 THEN '1-2'
      WHEN holder_count <= 5 THEN '3-5'
      WHEN holder_count <= 10 THEN '6-10'
      WHEN holder_count <= 20 THEN '11-20'
      ELSE '20+'
    END as h_bracket,
    COUNT(*) as n,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN exit_reason IN ('rug_pull','pool_drained','max_retries','max_retries_429') THEN 1 ELSE 0 END) as rugs,
    ROUND(SUM(pnl_sol), 6) as pnl,
    ROUND(AVG(pnl_sol), 6) as avg_pnl,
    ROUND(AVG(liquidity_usd), 0) as avg_liq
  FROM positions
  WHERE status IN ('closed','stopped') AND exit_reason IS NOT NULL
  GROUP BY h_bracket ORDER BY h_bracket
`).all();

holderTrades.forEach(r => {
  const winPct = r.n > 0 ? Math.round(100 * r.wins / r.n) : 0;
  const rugPct = r.n > 0 ? Math.round(100 * r.rugs / r.n) : 0;
  console.log(`  ${r.h_bracket.padEnd(10)}: N=${r.n}, wins=${r.wins}(${winPct}%), rugs=${r.rugs}(${rugPct}%), pnl=${r.pnl} SOL, avg=${r.avg_pnl}, avg_liq=$${r.avg_liq}`);
});

// 3. RugCheck score vs outcomes
console.log('\n--- RUGCHECK SCORE vs OUTCOMES ---');
const rcTrades = db.prepare(`
  SELECT
    CASE
      WHEN ta.rugcheck_score IS NULL THEN 'null'
      WHEN ta.rugcheck_score < 50 THEN '<50'
      WHEN ta.rugcheck_score < 70 THEN '50-69'
      WHEN ta.rugcheck_score <= 100 THEN '70-100'
      ELSE '>100'
    END as rc_bracket,
    COUNT(*) as n,
    SUM(CASE WHEN p.pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN p.exit_reason IN ('rug_pull','pool_drained','max_retries','max_retries_429') THEN 1 ELSE 0 END) as rugs,
    ROUND(SUM(p.pnl_sol), 6) as pnl
  FROM positions p
  LEFT JOIN token_analysis ta ON p.token_mint = ta.token_mint
  WHERE p.status IN ('closed','stopped') AND p.exit_reason IS NOT NULL
  GROUP BY rc_bracket ORDER BY rc_bracket
`).all();

rcTrades.forEach(r => {
  const winPct = r.n > 0 ? Math.round(100 * r.wins / r.n) : 0;
  const rugPct = r.n > 0 ? Math.round(100 * r.rugs / r.n) : 0;
  console.log(`  ${r.rc_bracket.padEnd(10)}: N=${r.n}, wins=${r.wins}(${winPct}%), rugs=${r.rugs}(${rugPct}%), pnl=${r.pnl} SOL`);
});

// 4. Insiders vs outcomes (from detected_pools)
console.log('\n--- INSIDERS vs OUTCOMES ---');
const insiderTrades = db.prepare(`
  SELECT
    CASE
      WHEN dp.dp_insiders_count IS NULL THEN 'unknown'
      WHEN dp.dp_insiders_count = 0 THEN 'none'
      WHEN dp.dp_insiders_count <= 2 THEN '1-2'
      ELSE '3+'
    END as insiders,
    COUNT(*) as n,
    SUM(CASE WHEN p.pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN p.exit_reason IN ('rug_pull','pool_drained','max_retries','max_retries_429') THEN 1 ELSE 0 END) as rugs,
    ROUND(SUM(p.pnl_sol), 6) as pnl
  FROM positions p
  JOIN detected_pools dp ON p.pool_address = dp.pool_address
  WHERE p.status IN ('closed','stopped') AND p.exit_reason IS NOT NULL
  GROUP BY insiders ORDER BY insiders
`).all();

insiderTrades.forEach(r => {
  const winPct = r.n > 0 ? Math.round(100 * r.wins / r.n) : 0;
  const rugPct = r.n > 0 ? Math.round(100 * r.rugs / r.n) : 0;
  console.log(`  ${r.insiders.padEnd(10)}: N=${r.n}, wins=${r.wins}(${winPct}%), rugs=${r.rugs}(${rugPct}%), pnl=${r.pnl} SOL`);
});

// 5. What would pass with RELAXED penalties? Simulate
console.log('\n--- SIMULATION: What if we relaxed penalties? ---');
// Count $30K+ tokens in last 6h that would pass with different penalty configs
const recent30k = db.prepare(`
  SELECT dp.base_mint, dp.security_score, ROUND(dp.dp_liquidity_usd,0) as liq,
    dp.dp_holder_count as h, dp.dp_graduation_time_s as grad,
    dp.rejection_reasons as rej, dp.dp_insiders_count as ins
  FROM detected_pools dp
  WHERE dp.detected_at > ? AND dp.dp_liquidity_usd >= 30000
  ORDER BY dp.detected_at DESC
`).all(Date.now() - 6 * 3600000);

console.log(`  $30K+ pools in last 6h: ${recent30k.length}`);

// Simulate: current score + removed penalties
let wouldPass_noGradPenalty = 0;
let wouldPass_noRCHolderDanger = 0;
let wouldPass_both = 0;

recent30k.forEach(r => {
  // Current score already has all penalties baked in
  let adjustedScore = r.security_score;

  // Estimate what penalty was applied for graduation
  let gradPenalty = 0;
  if (r.grad > 0 && r.grad < 300) gradPenalty = -15;
  else if (r.grad >= 300 && r.grad < 2700) gradPenalty = 5; // it's a bonus

  // Without grad penalty
  const scoreNoGrad = adjustedScore - gradPenalty; // remove the penalty
  if (scoreNoGrad >= 80) wouldPass_noGradPenalty++;

  // Estimate RC holder dangers: if rej includes 'rugcheck', assume -10 from holder-related dangers
  let rcHolderPenalty = 0;
  if (r.rej && r.rej.includes('rugcheck')) rcHolderPenalty = 10; // estimate
  const scoreNoRCHolder = adjustedScore + rcHolderPenalty;
  if (scoreNoRCHolder >= 80) wouldPass_noRCHolderDanger++;

  // Both
  const scoreBoth = adjustedScore - gradPenalty + rcHolderPenalty;
  if (scoreBoth >= 80) wouldPass_both++;
});

console.log(`  Would pass removing graduation penalty: ${wouldPass_noGradPenalty}/${recent30k.length}`);
console.log(`  Would pass removing RC holder dangers: ${wouldPass_noRCHolderDanger}/${recent30k.length}`);
console.log(`  Would pass removing BOTH: ${wouldPass_both}/${recent30k.length}`);

db.close();
