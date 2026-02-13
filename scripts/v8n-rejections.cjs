const db = require('better-sqlite3')('data/bot.db');

const pools = db.prepare(`
  SELECT substr(base_mint,1,8) as tok, security_score as score, security_passed as pass,
    ROUND(dp_liquidity_usd,0) as liq, dp_holder_count as h, dp_graduation_time_s as grad,
    rejection_reasons as rej
  FROM detected_pools WHERE bot_version = 'v8n' ORDER BY detected_at DESC LIMIT 20
`).all();

console.log('=== v8n POOLS (' + pools.length + ' total) ===');
pools.forEach(r => {
  const g = r.grad !== null && r.grad >= 0 ? Math.round(r.grad/60)+'min' : 'N/A';
  console.log(r.tok + ' | score=' + r.score + (r.pass?' PASS':' REJ') + ' | liq=$' + r.liq + ' | h=' + r.h + ' | grad=' + g + ' | ' + (r.rej||''));
});

// High liq rejected (would have passed old rules)
console.log('\n=== $25K+ REJECTED (would have passed v8l) ===');
const highLiq = db.prepare(`
  SELECT substr(base_mint,1,8) as tok, security_score as score,
    ROUND(dp_liquidity_usd,0) as liq, dp_holder_count as h, dp_graduation_time_s as grad,
    rejection_reasons as rej
  FROM detected_pools WHERE bot_version = 'v8n' AND dp_liquidity_usd >= 25000 AND security_passed = 0
  ORDER BY detected_at DESC
`).all();
if (highLiq.length === 0) console.log('  (none yet)');
highLiq.forEach(r => {
  const g = r.grad !== null && r.grad >= 0 ? Math.round(r.grad/60)+'min' : 'N/A';
  console.log('  ' + r.tok + ' | score=' + r.score + ' | liq=$' + r.liq + ' | h=' + r.h + ' | grad=' + g + ' | ' + (r.rej||''));
});

db.close();
