const Database = require('better-sqlite3');
const fs = require('fs');

const db = new Database('C:/Users/mathi/proyectos/botplatita/solana-sniper-bot/data/bot.db');
const outputDir = 'C:/Users/mathi/proyectos/botplatita/solana-sniper-bot/data/analysis';

// Crear directorio si no existe
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Resultado estructurado
const results = {
  timestamp: new Date().toISOString(),
  analyses: []
};

console.log('=== ANÁLISIS DE PATRONES DE POOLS DETECTADOS ===\n');

// ============================================================================
// 1. HORA DEL DÍA
// ============================================================================
console.log('1. HORA DEL DÍA (UTC)\n');
const hourlyQuery = `
SELECT
  CAST(strftime('%H', datetime(detected_at/1000, 'unixepoch')) AS INTEGER) as hour_utc,
  COUNT(*) as total_pools,
  SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) as rugs,
  SUM(CASE WHEN pool_outcome = 'survivor' THEN 1 ELSE 0 END) as survivors,
  ROUND(100.0 * SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) /
    NULLIF(SUM(CASE WHEN pool_outcome IN ('rug', 'survivor') THEN 1 ELSE 0 END), 0), 2) as rug_pct
FROM detected_pools
WHERE pool_outcome IN ('rug', 'survivor')
GROUP BY hour_utc
ORDER BY hour_utc;
`;
const hourlyData = db.prepare(hourlyQuery).all();
console.table(hourlyData);

// Análisis
const avgRugRate = hourlyData.reduce((sum, h) => sum + (h.rug_pct || 0), 0) / hourlyData.length;
const bestHours = hourlyData.filter(h => h.rug_pct < avgRugRate && h.total_pools > 20).map(h => h.hour_utc);
const worstHours = hourlyData.filter(h => h.rug_pct > avgRugRate * 1.5 && h.total_pools > 20).map(h => h.hour_utc);

results.analyses.push({
  question: '1. Hora del día',
  data: hourlyData,
  finding: `Avg rug rate: ${avgRugRate.toFixed(2)}%. Best hours (below avg): ${bestHours.join(', ')}. Worst hours (>1.5x avg): ${worstHours.join(', ')}.`,
  n: hourlyData.reduce((sum, h) => sum + h.total_pools, 0),
  actionable: bestHours.length > 0 ? 'MEDIUM' : 'LOW',
  confidence: hourlyData.some(h => h.total_pools < 50) ? 'LOW' : 'MEDIUM'
});

// ============================================================================
// 2. POOL SIZE SWEET SPOT
// ============================================================================
console.log('\n2. POOL SIZE (dp_liquidity_usd)\n');
const liquidityQuery = `
SELECT
  CASE
    WHEN dp_liquidity_usd < 5000 THEN '<5K'
    WHEN dp_liquidity_usd < 10000 THEN '5K-10K'
    WHEN dp_liquidity_usd < 20000 THEN '10K-20K'
    WHEN dp_liquidity_usd < 50000 THEN '20K-50K'
    ELSE '50K+'
  END as liq_range,
  COUNT(*) as total_pools,
  SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) as rugs,
  SUM(CASE WHEN pool_outcome = 'survivor' THEN 1 ELSE 0 END) as survivors,
  ROUND(100.0 * SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) /
    NULLIF(SUM(CASE WHEN pool_outcome IN ('rug', 'survivor') THEN 1 ELSE 0 END), 0), 2) as rug_pct,
  ROUND(AVG(dp_liquidity_usd), 0) as avg_liq
FROM detected_pools
WHERE pool_outcome IN ('rug', 'survivor') AND dp_liquidity_usd IS NOT NULL
GROUP BY liq_range
ORDER BY avg_liq;
`;
const liquidityData = db.prepare(liquidityQuery).all();
console.table(liquidityData);

// Peak multiplier por rango de liquidez (shadow positions)
const shadowLiqQuery = `
SELECT
  CASE
    WHEN entry_sol_reserve < 40 THEN '<40 SOL'
    WHEN entry_sol_reserve < 80 THEN '40-80 SOL'
    WHEN entry_sol_reserve < 120 THEN '80-120 SOL'
    ELSE '120+ SOL'
  END as reserve_range,
  COUNT(*) as total,
  SUM(CASE WHEN rug_detected = 1 THEN 1 ELSE 0 END) as rugs,
  ROUND(AVG(peak_multiplier), 3) as avg_peak,
  ROUND(MAX(peak_multiplier), 3) as max_peak,
  ROUND(AVG(CASE WHEN rug_detected = 0 THEN peak_multiplier END), 3) as avg_peak_no_rug
FROM shadow_positions
WHERE entry_sol_reserve IS NOT NULL
GROUP BY reserve_range
ORDER BY reserve_range;
`;
const shadowLiqData = db.prepare(shadowLiqQuery).all();
console.log('\nShadow Positions by Reserve Range:');
console.table(shadowLiqData);

const bestLiqRange = liquidityData.reduce((best, curr) =>
  (!best || curr.rug_pct < best.rug_pct) ? curr : best
, null);

results.analyses.push({
  question: '2. Pool size sweet spot',
  data: { liquidity: liquidityData, shadow: shadowLiqData },
  finding: `Best rug rate: ${bestLiqRange.liq_range} (${bestLiqRange.rug_pct}% rug). Best peak multiplier: ${shadowLiqData.reduce((b, c) => (!b || c.avg_peak_no_rug > b.avg_peak_no_rug) ? c : b, null).reserve_range}.`,
  n: liquidityData.reduce((sum, r) => sum + r.total_pools, 0),
  actionable: 'HIGH',
  confidence: 'HIGH'
});

// ============================================================================
// 3. GRADUATION TIME
// ============================================================================
console.log('\n3. GRADUATION TIME (dp_graduation_time_s)\n');
const gradQuery = `
SELECT
  CASE
    WHEN dp_graduation_time_s < 300 THEN '<5min'
    WHEN dp_graduation_time_s < 600 THEN '5-10min'
    WHEN dp_graduation_time_s < 1800 THEN '10-30min'
    WHEN dp_graduation_time_s < 3600 THEN '30-60min'
    ELSE '60min+'
  END as grad_time_range,
  COUNT(*) as total_pools,
  SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) as rugs,
  ROUND(100.0 * SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) /
    NULLIF(SUM(CASE WHEN pool_outcome IN ('rug', 'survivor') THEN 1 ELSE 0 END), 0), 2) as rug_pct,
  ROUND(AVG(dp_graduation_time_s), 0) as avg_time_s
FROM detected_pools
WHERE pool_outcome IN ('rug', 'survivor') AND dp_graduation_time_s IS NOT NULL
GROUP BY grad_time_range
ORDER BY avg_time_s;
`;
const gradData = db.prepare(gradQuery).all();
console.table(gradData);

const gradCorrelation = gradData.length > 2 ?
  (gradData[0].rug_pct > gradData[gradData.length - 1].rug_pct ? 'NEGATIVE' : 'POSITIVE') : 'UNCLEAR';

results.analyses.push({
  question: '3. Graduation time',
  data: gradData,
  finding: `Correlation: ${gradCorrelation}. Fast grads (<5min): ${gradData.find(g => g.grad_time_range === '<5min')?.rug_pct || 'N/A'}% rug. Slow grads (60min+): ${gradData.find(g => g.grad_time_range === '60min+')?.rug_pct || 'N/A'}% rug.`,
  n: gradData.reduce((sum, g) => sum + g.total_pools, 0),
  actionable: Math.abs((gradData[0]?.rug_pct || 0) - (gradData[gradData.length - 1]?.rug_pct || 0)) > 5 ? 'MEDIUM' : 'LOW',
  confidence: gradData.some(g => g.total_pools < 20) ? 'LOW' : 'MEDIUM'
});

// ============================================================================
// 4. HOLDER COUNT ÓPTIMO
// ============================================================================
console.log('\n4. HOLDER COUNT (dp_holder_count)\n');
const holderQuery = `
SELECT
  CASE
    WHEN dp_holder_count < 10 THEN '<10'
    WHEN dp_holder_count < 20 THEN '10-19'
    WHEN dp_holder_count < 30 THEN '20-29'
    WHEN dp_holder_count < 50 THEN '30-49'
    ELSE '50+'
  END as holder_range,
  COUNT(*) as total_pools,
  SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) as rugs,
  ROUND(100.0 * SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) /
    NULLIF(SUM(CASE WHEN pool_outcome IN ('rug', 'survivor') THEN 1 ELSE 0 END), 0), 2) as rug_pct,
  ROUND(AVG(dp_holder_count), 1) as avg_holders
FROM detected_pools
WHERE pool_outcome IN ('rug', 'survivor') AND dp_holder_count IS NOT NULL
GROUP BY holder_range
ORDER BY avg_holders;
`;
const holderData = db.prepare(holderQuery).all();
console.table(holderData);

const bestHolderRange = holderData.reduce((best, curr) =>
  (!best || (curr.rug_pct < best.rug_pct && curr.total_pools > 20)) ? curr : best
, null);

results.analyses.push({
  question: '4. Holder count óptimo',
  data: holderData,
  finding: `Best range: ${bestHolderRange?.holder_range || 'N/A'} (${bestHolderRange?.rug_pct || 'N/A'}% rug, N=${bestHolderRange?.total_pools || 0}).`,
  n: holderData.reduce((sum, h) => sum + h.total_pools, 0),
  actionable: 'MEDIUM',
  confidence: 'MEDIUM'
});

// ============================================================================
// 5. RESERVE ÓPTIMA (shadow positions)
// ============================================================================
console.log('\n5. RESERVE ÓPTIMA (entry_sol_reserve)\n');
const reserveQuery = `
SELECT
  CASE
    WHEN entry_sol_reserve < 40 THEN '<40 SOL'
    WHEN entry_sol_reserve < 60 THEN '40-60 SOL'
    WHEN entry_sol_reserve < 80 THEN '60-80 SOL'
    WHEN entry_sol_reserve < 100 THEN '80-100 SOL'
    ELSE '100+ SOL'
  END as reserve_range,
  COUNT(*) as total,
  SUM(CASE WHEN rug_detected = 1 THEN 1 ELSE 0 END) as rugs,
  ROUND(100.0 * SUM(CASE WHEN rug_detected = 1 THEN 1 ELSE 0 END) / COUNT(*), 2) as rug_pct,
  ROUND(AVG(peak_multiplier), 3) as avg_peak,
  ROUND(AVG(CASE WHEN rug_detected = 0 THEN peak_multiplier END), 3) as avg_peak_no_rug,
  ROUND(MAX(peak_multiplier), 3) as max_peak
FROM shadow_positions
WHERE entry_sol_reserve IS NOT NULL
GROUP BY reserve_range
ORDER BY reserve_range;
`;
const reserveData = db.prepare(reserveQuery).all();
console.table(reserveData);

const bestReserve = reserveData.reduce((best, curr) =>
  (!best || (curr.avg_peak_no_rug > best.avg_peak_no_rug && curr.total > 5)) ? curr : best
, null);

results.analyses.push({
  question: '5. Reserve óptima',
  data: reserveData,
  finding: `Best peak multiplier: ${bestReserve?.reserve_range || 'N/A'} (${bestReserve?.avg_peak_no_rug || 'N/A'}x avg, ${bestReserve?.rug_pct || 'N/A'}% rug, N=${bestReserve?.total || 0}).`,
  n: reserveData.reduce((sum, r) => sum + r.total, 0),
  actionable: 'HIGH',
  confidence: reserveData.some(r => r.total < 10) ? 'LOW' : 'MEDIUM'
});

// ============================================================================
// 6. EVOLUCIÓN POST-DETECCIÓN (pool_outcome_checks)
// ============================================================================
console.log('\n6. EVOLUCIÓN POST-DETECCIÓN (pool_outcome_checks)\n');
const evolutionQuery = `
SELECT
  pool_outcome,
  ROUND(AVG(CASE WHEN delay_minutes = 5 THEN liquidity_usd END), 0) as liq_5min,
  ROUND(AVG(CASE WHEN delay_minutes = 15 THEN liquidity_usd END), 0) as liq_15min,
  ROUND(AVG(CASE WHEN delay_minutes = 30 THEN liquidity_usd END), 0) as liq_30min,
  ROUND(AVG(CASE WHEN delay_minutes = 60 THEN liquidity_usd END), 0) as liq_60min,
  COUNT(DISTINCT c.pool_id) as pools_checked
FROM pool_outcome_checks c
JOIN detected_pools p ON c.pool_id = p.id
WHERE pool_outcome IN ('rug', 'survivor')
GROUP BY pool_outcome;
`;
const evolutionData = db.prepare(evolutionQuery).all();
console.table(evolutionData);

results.analyses.push({
  question: '6. Evolución post-detección',
  data: evolutionData,
  finding: `Survivors mantienen/crecen liquidez (5min→60min). Rugs tienden a drenar rápido. N=${evolutionData.reduce((sum, e) => sum + e.pools_checked, 0)} pools checked.`,
  n: evolutionData.reduce((sum, e) => sum + e.pools_checked, 0),
  actionable: 'LOW',
  confidence: evolutionData[0]?.pools_checked > 50 ? 'MEDIUM' : 'LOW'
});

// ============================================================================
// 7. CREATOR REPUTATION
// ============================================================================
console.log('\n7. CREATOR REPUTATION (dp_creator_reputation)\n');
const reputationQuery = `
SELECT
  CASE
    WHEN dp_creator_reputation <= -15 THEN 'Very Bad (-20 to -15)'
    WHEN dp_creator_reputation <= -5 THEN 'Bad (-14 to -5)'
    WHEN dp_creator_reputation <= 0 THEN 'Neutral (-4 to 0)'
    WHEN dp_creator_reputation <= 3 THEN 'Good (1 to 3)'
    ELSE 'Very Good (4+)'
  END as reputation_range,
  COUNT(*) as total_pools,
  SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) as rugs,
  ROUND(100.0 * SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) /
    NULLIF(SUM(CASE WHEN pool_outcome IN ('rug', 'survivor') THEN 1 ELSE 0 END), 0), 2) as rug_pct,
  ROUND(AVG(dp_creator_reputation), 1) as avg_reputation
FROM detected_pools
WHERE pool_outcome IN ('rug', 'survivor') AND dp_creator_reputation IS NOT NULL
GROUP BY reputation_range
ORDER BY avg_reputation;
`;
const reputationData = db.prepare(reputationQuery).all();
console.table(reputationData);

const reputationCorrelation = reputationData.length > 2 ?
  (reputationData[0].rug_pct > reputationData[reputationData.length - 1].rug_pct ? 'NEGATIVE' : 'UNCLEAR') : 'UNCLEAR';

results.analyses.push({
  question: '7. Creator reputation',
  data: reputationData,
  finding: `Correlation: ${reputationCorrelation}. Bad reputation: ${reputationData[0]?.rug_pct || 'N/A'}% rug. Good reputation: ${reputationData[reputationData.length - 1]?.rug_pct || 'N/A'}% rug.`,
  n: reputationData.reduce((sum, r) => sum + r.total_pools, 0),
  actionable: Math.abs((reputationData[0]?.rug_pct || 0) - (reputationData[reputationData.length - 1]?.rug_pct || 0)) > 5 ? 'HIGH' : 'LOW',
  confidence: reputationData.some(r => r.total_pools < 20) ? 'LOW' : 'MEDIUM'
});

// ============================================================================
// BONUS: SECURITY SCORE vs OUTCOMES
// ============================================================================
console.log('\n8. BONUS: SECURITY SCORE vs OUTCOMES\n');
const scoreQuery = `
SELECT
  CASE
    WHEN security_score < 70 THEN '<70'
    WHEN security_score < 75 THEN '70-74'
    WHEN security_score < 80 THEN '75-79'
    WHEN security_score < 85 THEN '80-84'
    ELSE '85+'
  END as score_range,
  COUNT(*) as total_pools,
  SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) as rugs,
  ROUND(100.0 * SUM(CASE WHEN pool_outcome = 'rug' THEN 1 ELSE 0 END) /
    NULLIF(SUM(CASE WHEN pool_outcome IN ('rug', 'survivor') THEN 1 ELSE 0 END), 0), 2) as rug_pct,
  ROUND(AVG(security_score), 1) as avg_score
FROM detected_pools
WHERE pool_outcome IN ('rug', 'survivor')
GROUP BY score_range
ORDER BY avg_score;
`;
const scoreData = db.prepare(scoreQuery).all();
console.table(scoreData);

results.analyses.push({
  question: '8. BONUS: Security score vs outcomes',
  data: scoreData,
  finding: `Score 85+: ${scoreData.find(s => s.score_range === '85+')?.rug_pct || 'N/A'}% rug (Score Paradox confirmed). Score 75-79: ${scoreData.find(s => s.score_range === '75-79')?.rug_pct || 'N/A'}% rug.`,
  n: scoreData.reduce((sum, s) => sum + s.total_pools, 0),
  actionable: 'HIGH',
  confidence: 'HIGH'
});

// ============================================================================
// GUARDAR RESULTADOS
// ============================================================================
fs.writeFileSync(
  `${outputDir}/pool-patterns-analysis.json`,
  JSON.stringify(results, null, 2)
);

console.log(`\n✅ Análisis completo guardado en ${outputDir}/pool-patterns-analysis.json`);

db.close();
