const db = require('better-sqlite3')('data/bot.db');
const now = Date.now();

// Compare what v8o+v8p accepts vs what old version accepted
console.log('=== QUE CAMBIO ENTRE OLD Y v8o+v8p? ===\n');

// 1. Score distribution of what we BOUGHT
console.log('--- Score de tokens COMPRADOS ---');
const bought = db.prepare(`
  SELECT bot_version, security_score, COUNT(*) as n,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN exit_reason = 'rug_pull' THEN 1 ELSE 0 END) as rugs,
    ROUND(AVG(pnl_pct), 1) as avg_pnl
  FROM positions
  GROUP BY bot_version, security_score
  ORDER BY bot_version, security_score DESC
`).all();
bought.forEach(r => {
  const v = r.bot_version || 'old';
  console.log(`  ${v.padEnd(4)} | score=${r.security_score} | ${r.n} trades | ${r.wins}W/${r.rugs}R | avg=${r.avg_pnl}%`);
});

// 2. Liquidity of what we bought
console.log('\n--- Liquidez de tokens COMPRADOS ---');
const liqBought = db.prepare(`
  SELECT
    CASE WHEN bot_version IN ('v8o','v8p') THEN 'v8o+v8p' ELSE 'old' END as ver,
    COUNT(*) as n,
    ROUND(AVG(liquidity_usd)) as avg_liq,
    ROUND(MIN(liquidity_usd)) as min_liq,
    ROUND(MAX(liquidity_usd)) as max_liq
  FROM positions
  WHERE liquidity_usd IS NOT NULL
  GROUP BY ver
`).all();
liqBought.forEach(r => console.log(`  ${r.ver}: ${r.n} trades | avg=$${r.avg_liq} | min=$${r.min_liq} | max=$${r.max_liq}`));

// 3. The key filters that changed: $30K min liq, RugCheck PumpSwap filter, graduation penalty
console.log('\n--- v8o+v8p: tokens que PASARON (detalle) ---');
const v8Passed = db.prepare(`
  SELECT ta.token_mint, ta.score, ta.liquidity_usd, ta.holder_count, ta.top_holder_pct,
    ta.rugcheck_score, ta.lp_burned, ta.ml_prediction, ta.ml_confidence,
    p.pnl_pct, p.exit_reason, p.peak_multiplier, dp.dp_graduation_time_s
  FROM token_analysis ta
  JOIN positions p ON ta.token_mint = p.token_mint AND p.bot_version IN ('v8o','v8p')
  LEFT JOIN detected_pools dp ON dp.base_mint = ta.token_mint
  WHERE ta.passed = 1
  ORDER BY ta.created_at DESC
`).all();
v8Passed.forEach((t, i) => {
  console.log(`  ${i+1}. ${t.token_mint.slice(0,8)} | score=${t.score} | liq=$${Math.round(t.liquidity_usd||0)} | holders=${t.holder_count} | top=${t.top_holder_pct?.toFixed(1)}% | rc=${t.rugcheck_score} | grad=${t.dp_graduation_time_s||'?'}s | pnl=${t.pnl_pct?.toFixed(1)}% | ml=${t.ml_prediction}`);
});

// 4. What the OLD version bought that RUGGED
console.log('\n--- OLD: tokens que fueron RUG (que hubiera filtrado v8o+v8p?) ---');
const oldRugs = db.prepare(`
  SELECT p.token_mint, p.security_score, p.pnl_pct, p.liquidity_usd, p.holder_count,
    dp.dp_liquidity_usd, dp.dp_holder_count, dp.dp_graduation_time_s, dp.dp_insiders_count
  FROM positions p
  LEFT JOIN detected_pools dp ON dp.base_mint = p.token_mint
  WHERE p.exit_reason = 'rug_pull' AND (p.bot_version IS NULL OR p.bot_version = '')
  ORDER BY p.opened_at DESC
`).all();
oldRugs.forEach((t, i) => {
  const liq = t.dp_liquidity_usd || t.liquidity_usd || 0;
  console.log(`  ${i+1}. ${t.token_mint.slice(0,8)} | score=${t.security_score} | liq=$${Math.round(liq)} | holders=${t.dp_holder_count||t.holder_count||'?'} | grad=${t.dp_graduation_time_s||'?'}s | insiders=${t.dp_insiders_count||'?'} | pnl=${t.pnl_pct?.toFixed(1)}%`);
});

// 5. Rejection funnel: how many tokens rejected and WHY in v8o+v8p
console.log('\n--- v8o+v8p REJECTION FUNNEL ---');
const rejections = db.prepare(`
  SELECT dp_rejection_stage, COUNT(*) as n
  FROM detected_pools
  WHERE bot_version IN ('v8o','v8p') AND dp_rejection_stage IS NOT NULL
  GROUP BY dp_rejection_stage
  ORDER BY n DESC
`).all();
rejections.forEach(r => console.log(`  ${r.dp_rejection_stage}: ${r.n} rejected`));

// 6. Pass rate comparison
console.log('\n--- PASS RATE ---');
const passRate = db.prepare(`
  SELECT
    CASE WHEN bot_version IN ('v8o','v8p') THEN 'v8o+v8p' ELSE 'old' END as ver,
    COUNT(*) as total,
    SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) as passed,
    ROUND(100.0 * SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) / COUNT(*), 2) as pct
  FROM token_analysis
  GROUP BY ver
`).all();
passRate.forEach(r => console.log(`  ${r.ver}: ${r.passed}/${r.total} passed (${r.pct}%)`));

// 7. The $30K liquidity filter - how many rugs had liq < $30K?
console.log('\n--- RUGS POR LIQUIDEZ (old version) ---');
const rugsByLiq = db.prepare(`
  SELECT
    CASE
      WHEN COALESCE(dp.dp_liquidity_usd, p.liquidity_usd, 0) < 15000 THEN '<$15K'
      WHEN COALESCE(dp.dp_liquidity_usd, p.liquidity_usd, 0) < 30000 THEN '$15-30K'
      WHEN COALESCE(dp.dp_liquidity_usd, p.liquidity_usd, 0) < 50000 THEN '$30-50K'
      ELSE '$50K+'
    END as liq_bracket,
    COUNT(*) as n
  FROM positions p
  LEFT JOIN detected_pools dp ON dp.base_mint = p.token_mint
  WHERE p.exit_reason = 'rug_pull'
  GROUP BY liq_bracket
`).all();
rugsByLiq.forEach(r => console.log(`  ${r.liq_bracket}: ${r.n} rugs`));

db.close();
