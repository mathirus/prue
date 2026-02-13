const db = require('better-sqlite3')('data/bot.db');
const now = Date.now();

// How many pools detected per hour (last 24h)
console.log('=== POOLS DETECTADOS POR HORA (ultimas 24h) ===\n');
const hourly = db.prepare(`
  SELECT
    strftime('%H', datetime(detected_at/1000, 'unixepoch', 'localtime')) as hour,
    COUNT(*) as pools,
    SUM(CASE WHEN security_passed = 1 THEN 1 ELSE 0 END) as passed
  FROM detected_pools
  WHERE detected_at > ?
  GROUP BY hour
  ORDER BY hour
`).all(now - 24 * 60 * 60 * 1000);

let totalPools = 0, totalPassed = 0;
hourly.forEach(h => {
  totalPools += h.pools;
  totalPassed += h.passed;
  const bar = '█'.repeat(Math.round(h.pools / 5));
  console.log(`  ${h.hour}:00 | ${String(h.pools).padStart(4)} pools | ${h.passed} passed ${bar}`);
});
console.log(`\n  TOTAL: ${totalPools} pools | ${totalPassed} passed | ${(totalPassed/totalPools*100).toFixed(2)}% pass rate`);
console.log(`  Avg: ${(totalPools / hourly.length).toFixed(0)} pools/hr | ${(totalPassed / hourly.length).toFixed(1)} trades/hr`);

// v8o+v8p specific: trades per hour
console.log('\n=== v8o+v8p TRADES POR HORA ===\n');
const v8trades = db.prepare(`
  SELECT opened_at, token_mint, pnl_pct, bot_version
  FROM positions
  WHERE bot_version IN ('v8o', 'v8p')
  ORDER BY opened_at ASC
`).all();

if (v8trades.length >= 2) {
  const firstTrade = v8trades[0].opened_at;
  const lastTrade = v8trades[v8trades.length - 1].opened_at;
  const totalHours = (lastTrade - firstTrade) / (1000 * 60 * 60);
  console.log(`  ${v8trades.length} trades en ${totalHours.toFixed(1)} horas`);
  console.log(`  = ${(v8trades.length / totalHours).toFixed(2)} trades/hora`);

  // Time between trades
  const gaps = [];
  for (let i = 1; i < v8trades.length; i++) {
    gaps.push((v8trades[i].opened_at - v8trades[i-1].opened_at) / 60000);
  }
  const avgGap = gaps.reduce((a,b) => a+b, 0) / gaps.length;
  const minGap = Math.min(...gaps);
  const maxGap = Math.max(...gaps);
  console.log(`  Intervalo promedio: ${avgGap.toFixed(0)} min`);
  console.log(`  Min: ${minGap.toFixed(0)} min | Max: ${maxGap.toFixed(0)} min`);
}

// Compare with old version
console.log('\n=== OLD VERSION TRADES POR HORA ===\n');
const oldTrades = db.prepare(`
  SELECT opened_at FROM positions
  WHERE bot_version IS NULL AND opened_at > ?
  ORDER BY opened_at ASC
`).all(now - 24 * 60 * 60 * 1000);

if (oldTrades.length >= 2) {
  const first = oldTrades[0].opened_at;
  const last = oldTrades[oldTrades.length - 1].opened_at;
  const hours = (last - first) / (1000 * 60 * 60);
  console.log(`  ${oldTrades.length} trades en ${hours.toFixed(1)} horas`);
  console.log(`  = ${(oldTrades.length / hours).toFixed(2)} trades/hora`);
}

// What's the bottleneck? Show rejection reasons
console.log('\n=== POR QUE NO PASAN (v8o+v8p top reasons) ===\n');
const reasons = db.prepare(`
  SELECT dp_rejection_stage, COUNT(*) as n
  FROM detected_pools
  WHERE bot_version IN ('v8o', 'v8p') AND security_passed = 0
  GROUP BY dp_rejection_stage
  ORDER BY n DESC
  LIMIT 10
`).all();
reasons.forEach(r => console.log(`  ${(r.dp_rejection_stage || 'score<80').padEnd(20)} | ${r.n} pools`));

// What score do they get?
console.log('\n=== SCORE DE RECHAZADOS (que tan lejos quedan) ===\n');
const scores = db.prepare(`
  SELECT
    CASE
      WHEN security_score >= 75 THEN '75-79 (casi pasan)'
      WHEN security_score >= 65 THEN '65-74'
      WHEN security_score >= 50 THEN '50-64'
      ELSE '<50'
    END as bracket,
    COUNT(*) as n
  FROM detected_pools
  WHERE bot_version IN ('v8o', 'v8p') AND security_passed = 0
  GROUP BY bracket
  ORDER BY MIN(security_score) DESC
`).all();
scores.forEach(r => console.log(`  ${r.bracket.padEnd(25)} | ${r.n} pools`));

// Liquidity distribution of what we see
console.log('\n=== LIQUIDEZ DE POOLS DETECTADOS (v8o+v8p) ===\n');
const liqDist = db.prepare(`
  SELECT
    CASE
      WHEN dp_liquidity_usd >= 30000 THEN '$30K+'
      WHEN dp_liquidity_usd >= 15000 THEN '$15-30K'
      WHEN dp_liquidity_usd >= 5000 THEN '$5-15K'
      WHEN dp_liquidity_usd > 0 THEN '<$5K'
      ELSE 'sin dato'
    END as bracket,
    COUNT(*) as n,
    SUM(CASE WHEN security_passed = 1 THEN 1 ELSE 0 END) as passed
  FROM detected_pools
  WHERE bot_version IN ('v8o', 'v8p')
  GROUP BY bracket
  ORDER BY MIN(COALESCE(dp_liquidity_usd, 0)) DESC
`).all();
liqDist.forEach(r => console.log(`  ${r.bracket.padEnd(12)} | ${r.n} pools | ${r.passed} passed`));

db.close();
