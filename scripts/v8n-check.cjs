const db = require('better-sqlite3')('data/bot.db');

// v8n version tracking check
console.log('=== v8n VERSION TRACKING ===');
const versions = db.prepare(`
  SELECT bot_version, COUNT(*) as n FROM detected_pools
  WHERE bot_version IS NOT NULL
  GROUP BY bot_version ORDER BY n DESC
`).all();
versions.forEach(r => console.log(`  ${r.bot_version}: ${r.n} pools`));

// Recent v8n pools
console.log('\n=== RECENT v8n POOLS ===');
const recent = db.prepare(`
  SELECT substr(base_mint,1,8) as tok, security_score as score,
    security_passed as passed, bot_version as ver,
    dp_graduation_time_s as grad, ROUND(dp_liquidity_usd,0) as liq,
    dp_holder_count as holders, rejection_reasons,
    datetime(detected_at/1000, 'unixepoch', 'localtime') as ts
  FROM detected_pools WHERE bot_version = 'v8n'
  ORDER BY detected_at DESC LIMIT 15
`).all();
recent.forEach(r => {
  const gradStr = r.grad != null && r.grad >= 0 ? `${Math.round(r.grad/60)}min` : 'N/A';
  const passStr = r.passed ? 'PASS' : 'REJECT';
  console.log(`  ${r.ts} | ${r.tok} | score=${r.score} ${passStr} | liq=$${r.liq} | h=${r.holders} | grad=${gradStr}`);
  if (r.rejection_reasons) console.log(`    reasons: ${r.rejection_reasons}`);
});

// Check if any v8n tokens would have PASSED under old rules ($25K+)
console.log('\n=== v8n TOKENS THAT WOULD PASS UNDER v8l ($25K+ threshold) ===');
const wouldPass = db.prepare(`
  SELECT substr(base_mint,1,8) as tok, security_score as score,
    ROUND(dp_liquidity_usd,0) as liq, dp_holder_count as holders,
    dp_graduation_time_s as grad,
    datetime(detected_at/1000, 'unixepoch', 'localtime') as ts
  FROM detected_pools
  WHERE bot_version = 'v8n' AND dp_liquidity_usd >= 25000 AND dp_liquidity_usd < 30000
  ORDER BY detected_at DESC
`).all();
if (wouldPass.length === 0) {
  console.log('  (none yet - these tokens would have passed old threshold but blocked by v8n)');
} else {
  wouldPass.forEach(r => {
    const gradStr = r.grad != null && r.grad >= 0 ? `${Math.round(r.grad/60)}min` : 'N/A';
    console.log(`  ${r.ts} | ${r.tok} | old_score=~${r.score+10} new_score=${r.score} | liq=$${r.liq} | h=${r.holders} | grad=${gradStr}`);
  });
}

// v8n token_analysis check
console.log('\n=== v8n TOKEN ANALYSIS ===');
const analysis = db.prepare(`
  SELECT substr(token_mint,1,8) as tok, score, passed,
    ROUND(liquidity_usd,0) as liq, holder_count as holders,
    ml_prediction, ROUND(ml_confidence*100,0) as ml_conf,
    bot_version as ver
  FROM token_analysis WHERE bot_version = 'v8n'
  ORDER BY created_at DESC LIMIT 10
`).all();
analysis.forEach(r => {
  console.log(`  ${r.tok} | score=${r.score} ${r.passed?'PASS':'REJECT'} | liq=$${r.liq} | h=${r.holders} | ML=${r.ml_prediction} (${r.ml_conf}%) | v=${r.ver}`);
});

db.close();
