const db = require('better-sqlite3')('data/bot.db');

// Recent pools - last 2 hours
const recent = db.prepare(`
  SELECT substr(base_mint,1,8) as tok, security_score as score, security_passed as pass,
    ROUND(dp_liquidity_usd,0) as liq, dp_holder_count as h, dp_graduation_time_s as grad,
    rejection_reasons as rej, bot_version as ver,
    datetime(detected_at/1000, 'unixepoch', 'localtime') as dt
  FROM detected_pools
  WHERE detected_at > ?
  ORDER BY detected_at DESC LIMIT 40
`).all(Date.now() - 2 * 3600000);

console.log('=== LAST 2 HOURS POOLS (' + recent.length + ') ===');
recent.forEach(r => {
  const g = r.grad !== null && r.grad >= 0 ? Math.round(r.grad/60)+'min' : 'N/A';
  console.log(r.dt + ' | ' + r.tok + ' | ' + (r.ver||'pre-v8n') + ' | score=' + r.score + (r.pass?' PASS':' REJ') + ' | liq=$' + r.liq + ' | h=' + r.h + ' | grad=' + g + ' | ' + (r.rej||''));
});

// Total v8n stats
const total = db.prepare('SELECT COUNT(*) as n FROM detected_pools WHERE bot_version = ?').get('v8n');
const passed = db.prepare('SELECT COUNT(*) as n FROM detected_pools WHERE bot_version = ? AND security_passed = 1').get('v8n');
const positions = db.prepare('SELECT COUNT(*) as n FROM positions WHERE bot_version = ?').get('v8n');
console.log('\nv8n totals: ' + total.n + ' pools, ' + passed.n + ' passed, ' + positions.n + ' positions');

// Rejection breakdown
console.log('\n=== v8n REJECTION BREAKDOWN ===');
const rejBreakdown = db.prepare(`
  SELECT rejection_reasons as rej, COUNT(*) as n,
    ROUND(AVG(dp_liquidity_usd),0) as avg_liq,
    ROUND(AVG(security_score),0) as avg_score
  FROM detected_pools WHERE bot_version = 'v8n' AND security_passed = 0
  GROUP BY rejection_reasons ORDER BY n DESC
`).all();
rejBreakdown.forEach(r => {
  console.log('  ' + String(r.n).padStart(3) + 'x | avg_score=' + r.avg_score + ' | avg_liq=$' + r.avg_liq + ' | ' + r.rej);
});

// High-liq $25K+ tokens: what exactly is blocking them?
console.log('\n=== HIGH-LIQ ($25K+) v8n: RugCheck details ===');
const highLiq = db.prepare(`
  SELECT substr(dp.base_mint,1,8) as tok, ROUND(dp.dp_liquidity_usd,0) as liq,
    dp.dp_holder_count as h, dp.security_score as score,
    dp.rejection_reasons as rej,
    ta.rugcheck_score, ta.rugcheck_risks
  FROM detected_pools dp
  LEFT JOIN token_analysis ta ON dp.base_mint = ta.token_mint
  WHERE dp.bot_version = 'v8n' AND dp.dp_liquidity_usd >= 25000
  ORDER BY dp.detected_at DESC LIMIT 15
`).all();
highLiq.forEach(r => {
  console.log('  ' + r.tok + ' | liq=$' + r.liq + ' | h=' + r.h + ' | score=' + r.score + ' | rej=' + (r.rej||'') + ' | rc_score=' + r.rugcheck_score + ' | risks=' + (r.rugcheck_risks ? r.rugcheck_risks.substring(0,80) : 'null'));
});

// Score distribution for all v8n pools
console.log('\n=== v8n SCORE DISTRIBUTION ===');
const scoreDist = db.prepare(`
  SELECT
    CASE
      WHEN security_score < 40 THEN '<40'
      WHEN security_score < 60 THEN '40-59'
      WHEN security_score < 70 THEN '60-69'
      WHEN security_score < 80 THEN '70-79'
      ELSE '80+'
    END as bracket,
    COUNT(*) as n,
    SUM(CASE WHEN security_passed = 1 THEN 1 ELSE 0 END) as passed
  FROM detected_pools WHERE bot_version = 'v8n'
  GROUP BY bracket ORDER BY bracket
`).all();
scoreDist.forEach(r => {
  console.log('  ' + r.bracket.padEnd(6) + ': ' + r.n + ' pools, ' + r.passed + ' passed');
});

// Check if bot is running (lock file)
const fs = require('fs');
try {
  const lock = fs.readFileSync('.bot.lock', 'utf8').trim();
  console.log('\nBot lock file PID: ' + lock);
} catch { console.log('\nNo .bot.lock found - bot may not be running'); }

db.close();
