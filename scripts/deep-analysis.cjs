const db = require('better-sqlite3')('data/bot.db');

// 1. Rug cluster analysis - last 24h rugs with details
console.log('=== RUG ANALYSIS (last 24h) ===');
const rugs = db.prepare(`
  SELECT p.id, substr(p.token_mint,1,12) as tok, p.exit_reason,
    ROUND(p.pnl_sol,6) as pnl, ROUND(p.pnl_pct,1) as pct,
    p.sell_attempts, p.sell_successes, ROUND(p.peak_multiplier,3) as peak_mult,
    p.security_score, p.liquidity_usd, p.holder_count,
    datetime(p.opened_at/1000, 'unixepoch', 'localtime') as opened,
    ROUND((p.closed_at - p.opened_at)/1000.0, 1) as hold_sec
  FROM positions p
  WHERE p.status IN ('closed','stopped')
    AND p.exit_reason IN ('rug_pull','pool_drained','max_retries','max_retries_429')
    AND p.opened_at > ?
  ORDER BY p.opened_at DESC
`).all(Date.now() - 24 * 3600000);
rugs.forEach(r => console.log(`${r.opened} | ${r.tok} | score=${r.security_score} | liq=$${r.liquidity_usd} | hold=${r.hold_sec}s | peak=${r.peak_mult}x | ${r.exit_reason} | sells=${r.sell_attempts}/${r.sell_successes}`));
console.log(`Total rugs: ${rugs.length}`);

// 2. Win rate by hour today
console.log('\n=== HOURLY BREAKDOWN (today) ===');
const hourly = db.prepare(`
  SELECT strftime('%H', opened_at/1000, 'unixepoch', 'localtime') as hr,
    COUNT(*) as n,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN exit_reason IN ('rug_pull','pool_drained') THEN 1 ELSE 0 END) as rugs,
    ROUND(SUM(pnl_sol), 6) as pnl
  FROM positions
  WHERE status IN ('closed','stopped') AND opened_at > ?
  GROUP BY hr ORDER BY hr
`).all(Date.now() - 24 * 3600000);
hourly.forEach(r => {
  const winPct = r.n > 0 ? Math.round(100 * r.wins / r.n) : 0;
  console.log(`Hour ${r.hr}: ${r.n} trades, ${r.wins} wins (${winPct}%), ${r.rugs} rugs, ${r.pnl} SOL`);
});

// 3. Score distribution of rugs vs winners
console.log('\n=== SCORE vs OUTCOME (last 24h) ===');
const scoreOutcome = db.prepare(`
  SELECT
    CASE WHEN security_score < 80 THEN '<80'
         WHEN security_score < 85 THEN '80-84'
         WHEN security_score < 90 THEN '85-89'
         ELSE '90+' END as score_band,
    COUNT(*) as n,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN exit_reason IN ('rug_pull','pool_drained') THEN 1 ELSE 0 END) as rugs,
    ROUND(SUM(pnl_sol), 6) as pnl,
    ROUND(AVG(pnl_sol), 6) as avg_pnl
  FROM positions
  WHERE status IN ('closed','stopped') AND opened_at > ?
  GROUP BY score_band ORDER BY score_band
`).all(Date.now() - 24 * 3600000);
scoreOutcome.forEach(r => console.log(`Score ${r.score_band}: ${r.n} trades, ${r.wins} wins, ${r.rugs} rugs, ${r.pnl} SOL (avg ${r.avg_pnl})`));

// 4. v8l specific data - graduation timing vs outcome
console.log('\n=== GRADUATION TIMING vs OUTCOME ===');
const gradData = db.prepare(`
  SELECT
    CASE WHEN dp.dp_graduation_time_s IS NULL THEN 'no_data'
         WHEN dp.dp_graduation_time_s < 300 THEN '<5min'
         WHEN dp.dp_graduation_time_s < 2700 THEN '5-45min'
         ELSE '>45min' END as grad_band,
    COUNT(*) as n,
    SUM(CASE WHEN p.pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN p.exit_reason IN ('rug_pull','pool_drained') THEN 1 ELSE 0 END) as rugs,
    ROUND(SUM(p.pnl_sol), 6) as pnl,
    ROUND(AVG(p.pnl_sol), 6) as avg_pnl
  FROM positions p
  LEFT JOIN detected_pools dp ON p.pool_address = dp.pool_address
  WHERE p.status IN ('closed','stopped') AND p.opened_at > ?
  GROUP BY grad_band ORDER BY grad_band
`).all(Date.now() - 48 * 3600000);
gradData.forEach(r => console.log(`Grad ${r.grad_band}: ${r.n} trades, ${r.wins} wins, ${r.rugs} rugs, ${r.pnl} SOL (avg ${r.avg_pnl})`));

// 5. Insiders vs outcome
console.log('\n=== INSIDERS vs OUTCOME ===');
const insidersData = db.prepare(`
  SELECT
    CASE WHEN dp.dp_insiders_count IS NULL THEN 'no_data'
         WHEN dp.dp_insiders_count = 0 THEN '0 insiders'
         WHEN dp.dp_insiders_count <= 2 THEN '1-2 insiders'
         ELSE '3+ insiders' END as ins_band,
    COUNT(*) as n,
    SUM(CASE WHEN p.pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN p.exit_reason IN ('rug_pull','pool_drained') THEN 1 ELSE 0 END) as rugs,
    ROUND(SUM(p.pnl_sol), 6) as pnl
  FROM positions p
  LEFT JOIN detected_pools dp ON p.pool_address = dp.pool_address
  WHERE p.status IN ('closed','stopped') AND p.opened_at > ?
  GROUP BY ins_band ORDER BY ins_band
`).all(Date.now() - 48 * 3600000);
insidersData.forEach(r => console.log(`${r.ins_band}: ${r.n} trades, ${r.wins} wins, ${r.rugs} rugs, ${r.pnl} SOL`));

// 6. Exit reasons summary
console.log('\n=== EXIT REASONS (last 24h) ===');
const exits = db.prepare(`
  SELECT exit_reason, COUNT(*) as n, ROUND(SUM(pnl_sol),6) as pnl, ROUND(AVG(pnl_sol),6) as avg
  FROM positions WHERE status IN ('closed','stopped') AND opened_at > ?
  GROUP BY exit_reason ORDER BY n DESC
`).all(Date.now() - 24 * 3600000);
exits.forEach(r => console.log(`${r.exit_reason || 'null'}: ${r.n} trades, ${r.pnl} SOL (avg ${r.avg})`));

// 7. Version comparison (v8k trades vs v8l trades)
console.log('\n=== VERSION COMPARISON ===');
// v8l started ~Feb 9 00:00, check if we can identify the transition
const v8lStart = db.prepare(`
  SELECT MIN(dp.detected_at) as first_v8l
  FROM detected_pools dp
  WHERE dp.dp_graduation_time_s IS NOT NULL
`).get();
console.log('v8l data collection started:', v8lStart.first_v8l ? new Date(v8lStart.first_v8l).toLocaleString() : 'unknown');

// 8. Rejected tokens analysis - what scores are being blocked?
console.log('\n=== REJECTED TOKENS (last 6h, score < 80) ===');
const rejected = db.prepare(`
  SELECT
    CASE WHEN ta.score < 40 THEN '<40'
         WHEN ta.score < 60 THEN '40-59'
         WHEN ta.score < 70 THEN '60-69'
         WHEN ta.score < 80 THEN '70-79'
         ELSE '80+' END as band,
    COUNT(*) as n
  FROM token_analysis ta
  WHERE ta.analyzed_at > ?
  GROUP BY band ORDER BY band
`).all(Date.now() - 6 * 3600000);
rejected.forEach(r => console.log(`Score ${r.band}: ${r.n} tokens`));

// 9. Wash trading data if available
console.log('\n=== WASH TRADING DETECTIONS (last 24h) ===');
try {
  const wash = db.prepare(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN ta.wash_unique_wallets IS NOT NULL THEN 1 ELSE 0 END) as has_wash
    FROM token_analysis ta WHERE ta.analyzed_at > ?
  `).get(Date.now() - 24 * 3600000);
  console.log(JSON.stringify(wash));
} catch(e) {
  console.log('No wash trading columns yet:', e.message.slice(0, 60));
}

db.close();
