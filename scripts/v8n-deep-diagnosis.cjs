const db = require('better-sqlite3')('data/bot.db');

// 1. What columns does token_analysis have?
const cols = db.prepare("PRAGMA table_info(token_analysis)").all();
console.log('=== token_analysis COLUMNS ===');
cols.forEach(c => console.log('  ' + c.name + ' (' + c.type + ')'));

// 2. For $30K+ v8n pools, what are the individual scoring components?
console.log('\n=== $30K+ v8n TOKENS: SCORING BREAKDOWN ===');
const highLiq = db.prepare(`
  SELECT substr(dp.base_mint,1,12) as tok, ROUND(dp.dp_liquidity_usd,0) as liq,
    dp.dp_holder_count as h, dp.security_score as score,
    dp.rejection_reasons as rej, dp.dp_graduation_time_s as grad,
    ta.freeze_authority_revoked, ta.mint_authority_revoked, ta.honeypot_safe,
    ta.lp_burned, ta.rugcheck_score, ta.top_holder_pct
  FROM detected_pools dp
  LEFT JOIN token_analysis ta ON dp.base_mint = ta.token_mint
  WHERE dp.bot_version = 'v8n' AND dp.dp_liquidity_usd >= 30000
  ORDER BY dp.detected_at DESC
`).all();

if (highLiq.length === 0) {
  console.log('  (no $30K+ pools in v8n!)');
} else {
  highLiq.forEach(r => {
    const g = r.grad !== null && r.grad >= 0 ? Math.round(r.grad/60)+'min' : 'N/A';
    console.log('  ' + r.tok + ' | liq=$' + r.liq + ' | h=' + r.h + ' | score=' + r.score);
    console.log('    freeze=' + r.freeze_authority_revoked + ' mint=' + r.mint_authority_revoked + ' hp=' + r.honeypot_safe + ' lp=' + r.lp_burned);
    console.log('    rc_score=' + r.rugcheck_score + ' top_h=' + r.top_holder_pct + '% grad=' + g);
    console.log('    rej=' + r.rej);
    console.log('');
  });
}

// 3. What about $25K-30K? These were blocked by v8n change
console.log('\n=== $25-30K v8n TOKENS ===');
const midLiq = db.prepare(`
  SELECT substr(dp.base_mint,1,12) as tok, ROUND(dp.dp_liquidity_usd,0) as liq,
    dp.dp_holder_count as h, dp.security_score as score,
    dp.rejection_reasons as rej
  FROM detected_pools dp
  WHERE dp.bot_version = 'v8n' AND dp.dp_liquidity_usd >= 25000 AND dp.dp_liquidity_usd < 30000
  ORDER BY dp.detected_at DESC
`).all();
if (midLiq.length === 0) console.log('  (none)');
midLiq.forEach(r => console.log('  ' + r.tok + ' | liq=$' + r.liq + ' | h=' + r.h + ' | score=' + r.score + ' | ' + r.rej));

// 4. Comparison: how many passed per version?
console.log('\n=== PASS RATE BY VERSION ===');
const versions = db.prepare(`
  SELECT COALESCE(bot_version, 'pre-v8n') as ver,
    COUNT(*) as total,
    SUM(CASE WHEN security_passed = 1 THEN 1 ELSE 0 END) as passed,
    ROUND(100.0 * SUM(CASE WHEN security_passed = 1 THEN 1 ELSE 0 END) / COUNT(*), 2) as pass_pct
  FROM detected_pools
  GROUP BY ver ORDER BY ver
`).all();
versions.forEach(r => {
  console.log('  ' + r.ver.padEnd(8) + ': ' + r.total + ' pools, ' + r.passed + ' passed (' + r.pass_pct + '%)');
});

// 5. Recent passes (last 24h, any version) - what made it through?
console.log('\n=== RECENT PASSES (last 24h, any version) ===');
const recentPasses = db.prepare(`
  SELECT substr(base_mint,1,12) as tok, security_score as score,
    ROUND(dp_liquidity_usd,0) as liq, dp_holder_count as h,
    COALESCE(bot_version,'old') as ver,
    datetime(detected_at/1000, 'unixepoch', 'localtime') as dt
  FROM detected_pools
  WHERE security_passed = 1 AND detected_at > ?
  ORDER BY detected_at DESC LIMIT 20
`).all(Date.now() - 24 * 3600000);

if (recentPasses.length === 0) console.log('  (NONE in 24h!)');
recentPasses.forEach(r => {
  console.log('  ' + r.dt + ' | ' + r.ver + ' | ' + r.tok + ' | score=' + r.score + ' | liq=$' + r.liq + ' | h=' + r.h);
});

// 6. Last 20 TRADES (any version) - when was the last one?
console.log('\n=== LAST 10 TRADES (any version) ===');
const lastTrades = db.prepare(`
  SELECT substr(token_mint,1,8) as tok, ROUND(pnl_sol,6) as pnl,
    security_score as score, ROUND(liquidity_usd,0) as liq, holder_count as h,
    exit_reason, COALESCE(bot_version,'old') as ver,
    datetime(opened_at/1000, 'unixepoch', 'localtime') as opened
  FROM positions WHERE status IN ('closed','stopped')
  ORDER BY opened_at DESC LIMIT 10
`).all();
lastTrades.forEach(r => {
  console.log('  ' + r.opened + ' | ' + r.ver + ' | ' + r.tok + ' | score=' + r.score + ' | liq=$' + r.liq + ' | h=' + r.h + ' | ' + r.exit_reason + ' | ' + r.pnl + ' SOL');
});

db.close();
