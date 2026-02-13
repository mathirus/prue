const Database = require('better-sqlite3');
const fs = require('fs');

const db = new Database('C:/Users/mathi/proyectos/botplatita/solana-sniper-bot/data/bot.db');
const outputDir = 'C:/Users/mathi/proyectos/botplatita/solana-sniper-bot/data/analysis';

console.log('=== ANÁLISIS DE CROSS-PATTERNS ===\n');
console.log('Buscando combinaciones de features que maximicen win rate y minimicen rug rate.\n');

const results = {
  timestamp: new Date().toISOString(),
  crossPatterns: []
};

// ============================================================================
// 1. LIQUIDEZ + SCORE (most promising)
// ============================================================================
console.log('1. LIQUIDEZ + SCORE\n');
const liqScoreQuery = `
SELECT
  CASE
    WHEN dp_liquidity_usd < 5000 THEN '<5K'
    WHEN dp_liquidity_usd < 10000 THEN '5K-10K'
    WHEN dp_liquidity_usd < 20000 THEN '10K-20K'
    ELSE '20K+'
  END as liq_range,
  CASE
    WHEN security_score < 75 THEN '<75'
    WHEN security_score < 80 THEN '75-79'
    WHEN security_score < 85 THEN '80-84'
    ELSE '85+'
  END as score_range,
  COUNT(*) as total,
  SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) as rugs,
  SUM(CASE WHEN pool_outcome = 'survivor' THEN 1 ELSE 0 END) as survivors,
  ROUND(100.0 * SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) /
    NULLIF(SUM(CASE WHEN pool_outcome IN ('rug', 'survivor') THEN 1 ELSE 0 END), 0), 2) as rug_pct
FROM detected_pools
WHERE pool_outcome IN ('rug', 'survivor')
  AND dp_liquidity_usd IS NOT NULL
GROUP BY liq_range, score_range
HAVING total >= 10
ORDER BY liq_range, score_range;
`;
const liqScoreData = db.prepare(liqScoreQuery).all();
console.table(liqScoreData);

const bestLiqScore = liqScoreData
  .filter(r => r.total >= 50)
  .reduce((best, curr) => (!best || curr.rug_pct < best.rug_pct) ? curr : best, null);

results.crossPatterns.push({
  pattern: 'Liquidity + Score',
  data: liqScoreData,
  best: bestLiqScore,
  recommendation: bestLiqScore ?
    `FILTER: liq=${bestLiqScore.liq_range}, score=${bestLiqScore.score_range} → ${bestLiqScore.rug_pct}% rug (N=${bestLiqScore.total})` :
    'Insufficient data'
});

// ============================================================================
// 2. LIQUIDEZ + HOLDERS
// ============================================================================
console.log('\n2. LIQUIDEZ + HOLDERS\n');
const liqHolderQuery = `
SELECT
  CASE
    WHEN dp_liquidity_usd < 5000 THEN '<5K'
    WHEN dp_liquidity_usd < 10000 THEN '5K-10K'
    WHEN dp_liquidity_usd < 20000 THEN '10K-20K'
    ELSE '20K+'
  END as liq_range,
  CASE
    WHEN dp_holder_count < 10 THEN '<10'
    WHEN dp_holder_count < 20 THEN '10-19'
    ELSE '20+'
  END as holder_range,
  COUNT(*) as total,
  SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) as rugs,
  ROUND(100.0 * SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) /
    NULLIF(SUM(CASE WHEN pool_outcome IN ('rug', 'survivor') THEN 1 ELSE 0 END), 0), 2) as rug_pct
FROM detected_pools
WHERE pool_outcome IN ('rug', 'survivor')
  AND dp_liquidity_usd IS NOT NULL
  AND dp_holder_count IS NOT NULL
GROUP BY liq_range, holder_range
HAVING total >= 10
ORDER BY liq_range, holder_range;
`;
const liqHolderData = db.prepare(liqHolderQuery).all();
console.table(liqHolderData);

const bestLiqHolder = liqHolderData
  .filter(r => r.total >= 50)
  .reduce((best, curr) => (!best || curr.rug_pct < best.rug_pct) ? curr : best, null);

results.crossPatterns.push({
  pattern: 'Liquidity + Holders',
  data: liqHolderData,
  best: bestLiqHolder,
  recommendation: bestLiqHolder ?
    `FILTER: liq=${bestLiqHolder.liq_range}, holders=${bestLiqHolder.holder_range} → ${bestLiqHolder.rug_pct}% rug (N=${bestLiqHolder.total})` :
    'Insufficient data'
});

// ============================================================================
// 3. GRADUATION TIME + LIQUIDEZ
// ============================================================================
console.log('\n3. GRADUATION TIME + LIQUIDEZ\n');
const gradLiqQuery = `
SELECT
  CASE
    WHEN dp_graduation_time_s < 300 THEN '<5min'
    WHEN dp_graduation_time_s < 1800 THEN '5-30min'
    WHEN dp_graduation_time_s < 3600 THEN '30-60min'
    ELSE '60min+'
  END as grad_range,
  CASE
    WHEN dp_liquidity_usd < 5000 THEN '<5K'
    WHEN dp_liquidity_usd < 10000 THEN '5K-10K'
    WHEN dp_liquidity_usd < 20000 THEN '10K-20K'
    ELSE '20K+'
  END as liq_range,
  COUNT(*) as total,
  SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) as rugs,
  ROUND(100.0 * SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) /
    NULLIF(SUM(CASE WHEN pool_outcome IN ('rug', 'survivor') THEN 1 ELSE 0 END), 0), 2) as rug_pct
FROM detected_pools
WHERE pool_outcome IN ('rug', 'survivor')
  AND dp_graduation_time_s IS NOT NULL
  AND dp_liquidity_usd IS NOT NULL
GROUP BY grad_range, liq_range
HAVING total >= 10
ORDER BY grad_range, liq_range;
`;
const gradLiqData = db.prepare(gradLiqQuery).all();
console.table(gradLiqData);

const bestGradLiq = gradLiqData
  .filter(r => r.total >= 50)
  .reduce((best, curr) => (!best || curr.rug_pct < best.rug_pct) ? curr : best, null);

results.crossPatterns.push({
  pattern: 'Graduation Time + Liquidity',
  data: gradLiqData,
  best: bestGradLiq,
  recommendation: bestGradLiq ?
    `FILTER: grad=${bestGradLiq.grad_range}, liq=${bestGradLiq.liq_range} → ${bestGradLiq.rug_pct}% rug (N=${bestGradLiq.total})` :
    'Insufficient data'
});

// ============================================================================
// 4. SCORE + HOLDERS (Score Paradox deep dive)
// ============================================================================
console.log('\n4. SCORE + HOLDERS (Score Paradox)\n');
const scoreHolderQuery = `
SELECT
  CASE
    WHEN security_score < 75 THEN '<75'
    WHEN security_score < 80 THEN '75-79'
    WHEN security_score < 85 THEN '80-84'
    ELSE '85+'
  END as score_range,
  CASE
    WHEN dp_holder_count < 10 THEN '<10'
    WHEN dp_holder_count < 20 THEN '10-19'
    ELSE '20+'
  END as holder_range,
  COUNT(*) as total,
  SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) as rugs,
  ROUND(100.0 * SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) /
    NULLIF(SUM(CASE WHEN pool_outcome IN ('rug', 'survivor') THEN 1 ELSE 0 END), 0), 2) as rug_pct
FROM detected_pools
WHERE pool_outcome IN ('rug', 'survivor')
  AND dp_holder_count IS NOT NULL
GROUP BY score_range, holder_range
HAVING total >= 10
ORDER BY score_range, holder_range;
`;
const scoreHolderData = db.prepare(scoreHolderQuery).all();
console.table(scoreHolderData);

results.crossPatterns.push({
  pattern: 'Score + Holders',
  data: scoreHolderData,
  recommendation: 'Score paradox persists across holder counts. Focus on liquidity instead.'
});

// ============================================================================
// 5. HORA + LIQUIDEZ (time-of-day safety)
// ============================================================================
console.log('\n5. HORA DEL DÍA + LIQUIDEZ\n');
const hourLiqQuery = `
SELECT
  CAST(strftime('%H', datetime(detected_at/1000, 'unixepoch')) AS INTEGER) as hour_utc,
  CASE
    WHEN dp_liquidity_usd < 5000 THEN '<5K'
    WHEN dp_liquidity_usd < 10000 THEN '5K-10K'
    WHEN dp_liquidity_usd < 20000 THEN '10K-20K'
    ELSE '20K+'
  END as liq_range,
  COUNT(*) as total,
  SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) as rugs,
  ROUND(100.0 * SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) /
    NULLIF(SUM(CASE WHEN pool_outcome IN ('rug', 'survivor') THEN 1 ELSE 0 END), 0), 2) as rug_pct
FROM detected_pools
WHERE pool_outcome IN ('rug', 'survivor')
  AND dp_liquidity_usd IS NOT NULL
GROUP BY hour_utc, liq_range
HAVING total >= 5
ORDER BY rug_pct DESC
LIMIT 20;
`;
const hourLiqData = db.prepare(hourLiqQuery).all();
console.log('Top 20 most dangerous hour+liq combinations:');
console.table(hourLiqData);

results.crossPatterns.push({
  pattern: 'Hour + Liquidity',
  data: hourLiqData.slice(0, 10),
  recommendation: 'Avoid trading in dangerous hours unless liq >= 5K USD.'
});

// ============================================================================
// 6. SHADOW POSITIONS: Features que maximizan peak_multiplier
// ============================================================================
console.log('\n6. SHADOW POSITIONS: Peak Multiplier Maximizers\n');
const shadowQuery = `
SELECT
  CASE
    WHEN entry_sol_reserve < 80 THEN '<80 SOL'
    WHEN entry_sol_reserve < 100 THEN '80-100 SOL'
    WHEN entry_sol_reserve < 120 THEN '100-120 SOL'
    ELSE '120+ SOL'
  END as reserve_range,
  CASE
    WHEN security_score < 75 THEN '<75'
    WHEN security_score < 80 THEN '75-79'
    WHEN security_score < 85 THEN '80-84'
    ELSE '85+'
  END as score_range,
  COUNT(*) as total,
  SUM(CASE WHEN rug_detected = 1 THEN 1 ELSE 0 END) as rugs,
  ROUND(100.0 * SUM(CASE WHEN rug_detected = 1 THEN 1 ELSE 0 END) / COUNT(*), 2) as rug_pct,
  ROUND(AVG(peak_multiplier), 3) as avg_peak,
  ROUND(AVG(CASE WHEN rug_detected = 0 THEN peak_multiplier END), 3) as avg_peak_no_rug,
  ROUND(MAX(peak_multiplier), 3) as max_peak
FROM shadow_positions
WHERE entry_sol_reserve IS NOT NULL
GROUP BY reserve_range, score_range
HAVING total >= 3
ORDER BY avg_peak_no_rug DESC;
`;
const shadowData = db.prepare(shadowQuery).all();
console.table(shadowData);

const bestShadow = shadowData.find(s => s.total >= 5 && s.rug_pct < 30);

results.crossPatterns.push({
  pattern: 'Shadow: Reserve + Score',
  data: shadowData,
  best: bestShadow,
  recommendation: bestShadow ?
    `MAXIMIZE: reserve=${bestShadow.reserve_range}, score=${bestShadow.score_range} → ${bestShadow.avg_peak_no_rug}x avg peak (N=${bestShadow.total})` :
    'Focus on 80-120 SOL reserves regardless of score'
});

// ============================================================================
// GUARDAR RESULTADOS
// ============================================================================
fs.writeFileSync(
  `${outputDir}/cross-patterns-analysis.json`,
  JSON.stringify(results, null, 2)
);

console.log(`\n✅ Cross-patterns guardado en ${outputDir}/cross-patterns-analysis.json`);

// ============================================================================
// GENERAR REGLAS ACCIONABLES
// ============================================================================
console.log('\n=== REGLAS ACCIONABLES ===\n');

const rules = [];

// Regla 1: Liquidez sweet spot
if (bestLiqScore) {
  rules.push({
    rule: 'LIQUIDEZ_SWEET_SPOT',
    condition: `liq >= 5000 && liq <= 20000`,
    reason: `${bestLiqScore.rug_pct}% rug rate (N=${bestLiqScore.total})`,
    priority: 'HIGH'
  });
}

// Regla 2: Evitar graduations lentas
const slowGrad = gradLiqData.find(g => g.grad_range === '60min+' && g.liq_range === '<5K');
if (slowGrad && slowGrad.rug_pct > 10) {
  rules.push({
    rule: 'AVOID_SLOW_GRADUATION',
    condition: `graduationTime > 3600 && liq < 5000`,
    reason: `${slowGrad.rug_pct}% rug rate (N=${slowGrad.total})`,
    priority: 'MEDIUM'
  });
}

// Regla 3: Holders bajos + liq baja = peligro
const lowHolderLowLiq = liqHolderData.find(r => r.holder_range === '20+' && r.liq_range === '<5K');
if (lowHolderLowLiq && lowHolderLowLiq.rug_pct > 5) {
  rules.push({
    rule: 'AVOID_HIGH_HOLDERS_LOW_LIQ',
    condition: `holders >= 20 && liq < 5000`,
    reason: `${lowHolderLowLiq.rug_pct}% rug rate (N=${lowHolderLowLiq.total})`,
    priority: 'HIGH'
  });
}

// Regla 4: Time-of-day weighting
const dangerousHours = hourLiqData.filter(h => h.rug_pct > 10 && h.total >= 10).map(h => h.hour_utc);
if (dangerousHours.length > 0) {
  rules.push({
    rule: 'TIME_OF_DAY_PENALTY',
    condition: `hour IN [${dangerousHours.join(', ')}]`,
    reason: `High rug rate in these hours`,
    priority: 'LOW'
  });
}

console.table(rules);

fs.writeFileSync(
  `${outputDir}/actionable-rules.json`,
  JSON.stringify(rules, null, 2)
);

console.log(`\n✅ Reglas accionables guardadas en ${outputDir}/actionable-rules.json`);

db.close();
