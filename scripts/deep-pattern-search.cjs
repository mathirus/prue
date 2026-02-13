const Database = require('better-sqlite3');
const db = new Database('data/bot.db');

// Pattern search: what combinations of features predict rugs vs winners?

// 1. RugCheck dangers count vs outcome
console.log('=== RUGCHECK DANGER COUNT vs OUTCOME ===');
const rcDangers = db.prepare(`
  SELECT
    CASE WHEN dp_rugcheck_score > 70 THEN 'RC_clean'
         WHEN dp_rugcheck_score > 30 THEN 'RC_medium'
         WHEN dp_rugcheck_score >= 0 THEN 'RC_risky'
         ELSE 'RC_unknown' END as rc_bracket,
    COUNT(*) as n,
    SUM(CASE WHEN p.pnl_pct > 5 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN p.pnl_pct <= -80 THEN 1 ELSE 0 END) as rugs,
    ROUND(AVG(p.pnl_pct),1) as avg_pnl,
    ROUND(SUM(p.pnl_sol),6) as total_sol
  FROM positions p
  JOIN detected_pools dp ON p.token_mint = dp.base_mint
  WHERE p.status IN ('closed','stopped') AND dp.dp_rugcheck_score IS NOT NULL
  GROUP BY rc_bracket ORDER BY rc_bracket
`).all();
rcDangers.forEach(r => console.log(r));

// 2. Bundle detection: no dp_bundle_txcount column, skip
console.log('\n=== BUNDLED LAUNCH: column not in dp_, skipped ===');

// 3. Time of day: when are rugs more common?
console.log('\n=== TIME OF DAY vs OUTCOME ===');
const timeOfDay = db.prepare(`
  SELECT
    CASE WHEN (opened_at/1000 % 86400)/3600 < 6 THEN '00-05 UTC'
         WHEN (opened_at/1000 % 86400)/3600 < 12 THEN '06-11 UTC'
         WHEN (opened_at/1000 % 86400)/3600 < 18 THEN '12-17 UTC'
         ELSE '18-23 UTC' END as period,
    COUNT(*) as n,
    SUM(CASE WHEN pnl_pct > 5 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN pnl_pct <= -80 THEN 1 ELSE 0 END) as rugs,
    ROUND(AVG(pnl_pct),1) as avg_pnl,
    ROUND(SUM(pnl_sol),6) as total_sol
  FROM positions
  WHERE status IN ('closed','stopped')
  GROUP BY period ORDER BY period
`).all();
timeOfDay.forEach(r => console.log(r));

// 4. Trade duration: quick exits vs slow
console.log('\n=== TRADE DURATION vs OUTCOME ===');
const duration = db.prepare(`
  SELECT
    CASE WHEN (closed_at - opened_at) < 60000 THEN '<1min'
         WHEN (closed_at - opened_at) < 180000 THEN '1-3min'
         WHEN (closed_at - opened_at) < 300000 THEN '3-5min'
         WHEN (closed_at - opened_at) < 600000 THEN '5-10min'
         ELSE '>10min' END as dur_bracket,
    COUNT(*) as n,
    SUM(CASE WHEN pnl_pct > 5 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN pnl_pct <= -80 THEN 1 ELSE 0 END) as rugs,
    ROUND(AVG(pnl_pct),1) as avg_pnl,
    ROUND(SUM(pnl_sol),6) as total_sol
  FROM positions
  WHERE status IN ('closed','stopped') AND closed_at IS NOT NULL
  GROUP BY dur_bracket ORDER BY dur_bracket
`).all();
duration.forEach(r => console.log(r));

// 5. Score vs freeze authority (for PumpSwap)
console.log('\n=== FREEZE AUTH + MINT AUTH vs OUTCOME ===');
const authCombo = db.prepare(`
  SELECT
    CASE WHEN dp_freeze_auth_revoked = 1 AND dp_mint_auth_revoked = 1 THEN 'both_revoked'
         WHEN dp_mint_auth_revoked = 1 THEN 'mint_only'
         WHEN dp_freeze_auth_revoked = 1 THEN 'freeze_only'
         ELSE 'neither' END as auth,
    COUNT(*) as n,
    SUM(CASE WHEN p.pnl_pct > 5 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN p.pnl_pct <= -80 THEN 1 ELSE 0 END) as rugs,
    ROUND(AVG(p.pnl_pct),1) as avg_pnl,
    ROUND(SUM(p.pnl_sol),6) as total_sol
  FROM positions p
  JOIN detected_pools dp ON p.token_mint = dp.base_mint
  WHERE p.status IN ('closed','stopped')
  GROUP BY auth ORDER BY auth
`).all();
authCombo.forEach(r => console.log(r));

// 6. Creator reputation (v8+ data)
console.log('\n=== CREATOR REPUTATION vs OUTCOME ===');
const repScore = db.prepare(`
  SELECT
    CASE WHEN tc.reputation_score > 0 THEN 'positive'
         WHEN tc.reputation_score = 0 THEN 'neutral'
         WHEN tc.reputation_score < 0 THEN 'negative'
         ELSE 'no_data' END as rep,
    COUNT(*) as n,
    SUM(CASE WHEN p.pnl_pct > 5 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN p.pnl_pct <= -80 THEN 1 ELSE 0 END) as rugs,
    ROUND(AVG(p.pnl_pct),1) as avg_pnl,
    ROUND(SUM(p.pnl_sol),6) as total_sol
  FROM positions p
  LEFT JOIN token_creators tc ON p.token_mint = tc.token_mint
  WHERE p.status IN ('closed','stopped')
  GROUP BY rep ORDER BY rep
`).all();
repScore.forEach(r => console.log(r));

// 7. Combination: freeze=✗ + liq $10-15K = disaster?
console.log('\n=== DANGEROUS COMBOS ===');
const combos = db.prepare(`
  SELECT
    CASE WHEN dp_freeze_auth_revoked = 0 AND dp.dp_liquidity_usd < 15000 THEN 'freeze+lowliq'
         WHEN dp_freeze_auth_revoked = 0 THEN 'freeze_only'
         WHEN dp.dp_liquidity_usd < 15000 THEN 'lowliq_only'
         ELSE 'neither_risk' END as combo,
    COUNT(*) as n,
    SUM(CASE WHEN p.pnl_pct > 5 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN p.pnl_pct <= -80 THEN 1 ELSE 0 END) as rugs,
    ROUND(AVG(p.pnl_pct),1) as avg_pnl,
    ROUND(SUM(p.pnl_sol),6) as total_sol
  FROM positions p
  JOIN detected_pools dp ON p.token_mint = dp.base_mint
  WHERE p.status IN ('closed','stopped')
    AND dp.dp_liquidity_usd IS NOT NULL
  GROUP BY combo ORDER BY combo
`).all();
combos.forEach(r => console.log(r));

// 8. V8 specific: early price action (how fast do winners pump vs rugs?)
console.log('\n=== v8+ TRADES: PEAK PRICE vs OUTCOME ===');
const v8Peak = db.prepare(`
  SELECT
    CASE WHEN peak_pct >= 100 THEN 'peak>=2x'
         WHEN peak_pct >= 50 THEN 'peak 1.5-2x'
         WHEN peak_pct >= 25 THEN 'peak 1.25-1.5x'
         WHEN peak_pct >= 0 THEN 'peak 1-1.25x'
         ELSE 'never_green' END as peak,
    COUNT(*) as n,
    SUM(CASE WHEN pnl_pct > 5 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN pnl_pct <= -80 THEN 1 ELSE 0 END) as rugs,
    ROUND(AVG(pnl_pct),1) as avg_pnl,
    ROUND(SUM(pnl_sol),6) as total_sol
  FROM positions
  WHERE status IN ('closed','stopped') AND peak_pct IS NOT NULL
  GROUP BY peak ORDER BY peak
`).all();
v8Peak.forEach(r => console.log(r));

db.close();
