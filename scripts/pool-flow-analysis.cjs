const db = require('better-sqlite3')('data/bot.db');

// How many pools reach different liquidity levels? (last 24h)
console.log('=== POOL FLOW ANALYSIS (last 24h) ===');
const cutoff = Date.now() - 24 * 3600000;

const total = db.prepare(`SELECT COUNT(*) as n FROM detected_pools WHERE detected_at > ?`).get(cutoff);
console.log(`Total pools detected: ${total.n}`);

const liqDist = db.prepare(`
  SELECT
    CASE WHEN dp_liquidity_usd IS NULL THEN 'no_data'
         WHEN dp_liquidity_usd < 5000 THEN '<$5K'
         WHEN dp_liquidity_usd < 10000 THEN '$5-10K'
         WHEN dp_liquidity_usd < 15000 THEN '$10-15K'
         WHEN dp_liquidity_usd < 20000 THEN '$15-20K'
         WHEN dp_liquidity_usd < 25000 THEN '$20-25K'
         WHEN dp_liquidity_usd < 30000 THEN '$25-30K'
         WHEN dp_liquidity_usd < 50000 THEN '$30-50K'
         WHEN dp_liquidity_usd < 75000 THEN '$50-75K'
         ELSE '>$75K' END as bracket,
    COUNT(*) as n,
    SUM(CASE WHEN security_passed = 1 THEN 1 ELSE 0 END) as passed,
    ROUND(100.0 * COUNT(*) / ${total.n}, 1) as pct_of_total
  FROM detected_pools WHERE detected_at > ?
  GROUP BY bracket ORDER BY MIN(COALESCE(dp_liquidity_usd, -1))
`).all(cutoff);
console.log('\nBracket    | Pools | Passed | % of Total');
liqDist.forEach(r => console.log(`${r.bracket.padEnd(11)}| ${String(r.n).padStart(5)} | ${String(r.passed).padStart(6)} | ${r.pct_of_total}%`));

// Score distribution of $30K+ pools
console.log('\n=== $30K+ POOLS: Score Distribution (last 24h) ===');
const highLiqScores = db.prepare(`
  SELECT security_score as score, security_passed as passed,
    ROUND(dp_liquidity_usd,0) as liq, dp_holder_count as holders,
    dp_graduation_time_s as grad,
    substr(base_mint,1,8) as tok,
    datetime(detected_at/1000, 'unixepoch', 'localtime') as ts
  FROM detected_pools
  WHERE detected_at > ? AND dp_liquidity_usd >= 30000
  ORDER BY detected_at DESC LIMIT 20
`).all(cutoff);
console.log(`$30K+ pools: ${highLiqScores.length}`);
highLiqScores.forEach(r => {
  const gradStr = r.grad != null && r.grad >= 0 ? `${Math.round(r.grad/60)}min` : 'N/A';
  console.log(`  ${r.ts} | ${r.tok} | score=${r.score} ${r.passed?'PASS':'REJECT'} | liq=$${r.liq} | h=${r.holders} | grad=${gradStr}`);
});

// Conversion rate: how many pools become trades
const trades24 = db.prepare(`SELECT COUNT(*) as n FROM positions WHERE opened_at > ?`).get(cutoff);
const pools24 = db.prepare(`SELECT COUNT(*) as n FROM detected_pools WHERE detected_at > ?`).get(cutoff);
console.log(`\n=== CONVERSION RATE ===`);
console.log(`Pools detected (24h): ${pools24.n}`);
console.log(`Trades opened (24h): ${trades24.n}`);
console.log(`Conversion: ${(100 * trades24.n / pools24.n).toFixed(2)}%`);

// Average time between trades
const recentTrades = db.prepare(`
  SELECT opened_at FROM positions WHERE opened_at > ? ORDER BY opened_at DESC
`).all(cutoff);
if (recentTrades.length > 1) {
  const gaps = [];
  for (let i = 0; i < recentTrades.length - 1; i++) {
    gaps.push(recentTrades[i].opened_at - recentTrades[i+1].opened_at);
  }
  const avgGapMin = (gaps.reduce((a,b) => a+b, 0) / gaps.length) / 60000;
  const minGapMin = Math.min(...gaps) / 60000;
  const maxGapMin = Math.max(...gaps) / 60000;
  console.log(`\nAvg time between trades: ${avgGapMin.toFixed(1)} min`);
  console.log(`Min gap: ${minGapMin.toFixed(1)} min, Max gap: ${maxGapMin.toFixed(1)} min`);
}

// Estimate: with $30K+ filter, expected trades per day
const pools30k = db.prepare(`
  SELECT COUNT(*) as n FROM detected_pools WHERE detected_at > ? AND dp_liquidity_usd >= 30000 AND security_passed = 1
`).get(cutoff);
console.log(`\n$30K+ pools that passed security (24h): ${pools30k.n}`);
console.log(`Expected: ~${pools30k.n} trades/day with v8n (was ~${trades24.n}/day with old filter)`);

db.close();
