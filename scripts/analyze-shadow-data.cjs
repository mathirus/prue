#!/usr/bin/env node
/**
 * Shadow Data Analysis Script
 * Comprehensive analysis of v9a shadow mode data for ML pipeline design
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'bot.db');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'shadow-analysis.json');

const db = new Database(DB_PATH, { readonly: true });

const results = {
  generated_at: new Date().toISOString(),
  overview: {},
  feature_completeness: {},
  score_distribution: {},
  rug_rates_by_score: {},
  tp_hit_rates: {},
  peak_multiplier_dist: {},
  timing_analysis: {},
  detected_pools_features: {},
  price_log_stats: {},
  pool_outcome_checks: {},
  recommendations: []
};

console.log('='.repeat(80));
console.log('SHADOW DATA ANALYSIS - v9a ML Pipeline Design');
console.log('='.repeat(80));
console.log();

// 1. SHADOW POSITIONS OVERVIEW
console.log('1. SHADOW POSITIONS OVERVIEW');
console.log('-'.repeat(80));

const statusCount = db.prepare(`
  SELECT status, COUNT(*) as count
  FROM shadow_positions
  GROUP BY status
`).all();

console.log('\nStatus Distribution:');
statusCount.forEach(row => {
  console.log(`  ${row.status.padEnd(15)}: ${row.count}`);
});
results.overview.status_distribution = statusCount;

const totalPositions = statusCount.reduce((sum, row) => sum + row.count, 0);
results.overview.total_positions = totalPositions;

const exitReasons = db.prepare(`
  SELECT exit_reason, COUNT(*) as count
  FROM shadow_positions
  WHERE status = 'closed' AND exit_reason IS NOT NULL
  GROUP BY exit_reason
  ORDER BY count DESC
`).all();

console.log('\nExit Reasons (closed positions):');
exitReasons.forEach(row => {
  const pct = ((row.count / statusCount.find(s => s.status === 'closed')?.count || 1) * 100).toFixed(1);
  console.log(`  ${row.exit_reason.padEnd(25)}: ${row.count.toString().padStart(3)} (${pct}%)`);
});
results.overview.exit_reasons = exitReasons;

// Age of tracking positions
const trackingAge = db.prepare(`
  SELECT
    MIN((unixepoch('now') * 1000 - opened_at) / 1000 / 60) as min_age_min,
    MAX((unixepoch('now') * 1000 - opened_at) / 1000 / 60) as max_age_min,
    AVG((unixepoch('now') * 1000 - opened_at) / 1000 / 60) as avg_age_min
  FROM shadow_positions
  WHERE status = 'tracking'
`).get();

if (trackingAge && trackingAge.avg_age_min !== null) {
  console.log('\nTracking Positions Age:');
  console.log(`  Min: ${trackingAge.min_age_min.toFixed(1)} min`);
  console.log(`  Avg: ${trackingAge.avg_age_min.toFixed(1)} min`);
  console.log(`  Max: ${trackingAge.max_age_min.toFixed(1)} min`);
  results.overview.tracking_age = trackingAge;
}

console.log();

// 2. FEATURE COMPLETENESS
console.log('2. FEATURE COMPLETENESS ANALYSIS');
console.log('-'.repeat(80));

const columns = [
  'security_score', 'entry_price', 'entry_sol_reserve', 'current_price',
  'peak_price', 'min_price', 'peak_multiplier', 'time_to_peak_ms',
  'tp1_hit', 'tp2_hit', 'tp3_hit', 'sl_hit',
  'rug_detected', 'rug_reserve_drop_pct', 'bot_version'
];

console.log('\nColumn Completeness:');
console.log('  Column'.padEnd(30) + 'Non-NULL'.padStart(10) + 'NULL'.padStart(10) + 'Fill %'.padStart(10));

columns.forEach(col => {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      COUNT(${col}) as non_null
    FROM shadow_positions
  `).get();

  const nullCount = stats.total - stats.non_null;
  const fillPct = ((stats.non_null / stats.total) * 100).toFixed(1);

  console.log(`  ${col.padEnd(30)}${stats.non_null.toString().padStart(10)}${nullCount.toString().padStart(10)}${fillPct.padStart(9)}%`);

  results.feature_completeness[col] = {
    non_null: stats.non_null,
    null: nullCount,
    fill_pct: parseFloat(fillPct)
  };
});

console.log();

// 3. SCORE DISTRIBUTION & RUG RATES
console.log('3. SCORE DISTRIBUTION & RUG RATES');
console.log('-'.repeat(80));

const scoreBuckets = [
  { label: '0-20', min: 0, max: 20 },
  { label: '21-40', min: 21, max: 40 },
  { label: '41-60', min: 41, max: 60 },
  { label: '61-80', min: 61, max: 80 },
  { label: '81-100', min: 81, max: 100 }
];

console.log('\nScore Distribution:');
console.log('  Score Range'.padEnd(15) + 'Count'.padStart(8) + 'Pct'.padStart(8));

const scoreDistribution = scoreBuckets.map(bucket => {
  const count = db.prepare(`
    SELECT COUNT(*) as count
    FROM shadow_positions
    WHERE security_score >= ? AND security_score <= ?
  `).get(bucket.min, bucket.max);

  const pct = ((count.count / totalPositions) * 100).toFixed(1);
  console.log(`  ${bucket.label.padEnd(15)}${count.count.toString().padStart(8)}${pct.padStart(7)}%`);

  return {
    range: bucket.label,
    count: count.count,
    pct: parseFloat(pct)
  };
});

results.score_distribution = scoreDistribution;

console.log('\nRug Rate by Score (closed positions only):');
console.log('  Score Range'.padEnd(15) + 'Total'.padStart(8) + 'Rugged'.padStart(8) + 'Rug %'.padStart(8));

const rugRates = scoreBuckets.map(bucket => {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN rug_detected = 1 THEN 1 ELSE 0 END) as rugged
    FROM shadow_positions
    WHERE status = 'closed'
      AND security_score >= ?
      AND security_score <= ?
  `).get(bucket.min, bucket.max);

  const rugged = stats.rugged || 0;
  const rugPct = stats.total > 0 ? ((rugged / stats.total) * 100).toFixed(1) : '0.0';
  console.log(`  ${bucket.label.padEnd(15)}${stats.total.toString().padStart(8)}${rugged.toString().padStart(8)}${rugPct.padStart(7)}%`);

  return {
    range: bucket.label,
    total: stats.total,
    rugged: rugged,
    rug_pct: parseFloat(rugPct)
  };
});

results.rug_rates_by_score = rugRates;

console.log();

// 4. TAKE PROFIT HIT RATES
console.log('4. TAKE PROFIT HIT RATES');
console.log('-'.repeat(80));

const overallTpStats = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(tp1_hit) as tp1_hits,
    SUM(tp2_hit) as tp2_hits,
    SUM(tp3_hit) as tp3_hits,
    AVG(CASE WHEN tp1_hit = 1 THEN tp1_time_ms END) as avg_tp1_time_ms
  FROM shadow_positions
`).get();

console.log('\nOverall TP Hit Rates:');
console.log(`  Total positions: ${overallTpStats.total}`);
console.log(`  TP1 (1.2x) hits: ${overallTpStats.tp1_hits} (${((overallTpStats.tp1_hits / overallTpStats.total) * 100).toFixed(1)}%)`);
console.log(`  TP2 (2.0x) hits: ${overallTpStats.tp2_hits} (${((overallTpStats.tp2_hits / overallTpStats.total) * 100).toFixed(1)}%)`);
console.log(`  TP3 (4.0x) hits: ${overallTpStats.tp3_hits} (${((overallTpStats.tp3_hits / overallTpStats.total) * 100).toFixed(1)}%)`);

if (overallTpStats.avg_tp1_time_ms) {
  const avgMinutes = (overallTpStats.avg_tp1_time_ms / 1000 / 60).toFixed(1);
  console.log(`  Avg time to TP1: ${avgMinutes} min`);
}

results.tp_hit_rates.overall = {
  total: overallTpStats.total,
  tp1_hits: overallTpStats.tp1_hits,
  tp1_pct: parseFloat(((overallTpStats.tp1_hits / overallTpStats.total) * 100).toFixed(1)),
  tp2_hits: overallTpStats.tp2_hits,
  tp2_pct: parseFloat(((overallTpStats.tp2_hits / overallTpStats.total) * 100).toFixed(1)),
  tp3_hits: overallTpStats.tp3_hits,
  tp3_pct: parseFloat(((overallTpStats.tp3_hits / overallTpStats.total) * 100).toFixed(1)),
  avg_tp1_time_ms: overallTpStats.avg_tp1_time_ms
};

console.log('\nTP Hit Rates by Score Bucket:');
console.log('  Score Range'.padEnd(15) + 'Total'.padStart(8) + 'TP1%'.padStart(8) + 'TP2%'.padStart(8) + 'TP3%'.padStart(8));

const tpByScore = scoreBuckets.map(bucket => {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(tp1_hit) as tp1_hits,
      SUM(tp2_hit) as tp2_hits,
      SUM(tp3_hit) as tp3_hits
    FROM shadow_positions
    WHERE security_score >= ? AND security_score <= ?
  `).get(bucket.min, bucket.max);

  if (stats.total === 0) {
    console.log(`  ${bucket.label.padEnd(15)}${stats.total.toString().padStart(8)}${'0.0'.padStart(7)}%${'0.0'.padStart(7)}%${'0.0'.padStart(7)}%`);
    return {
      range: bucket.label,
      total: 0,
      tp1_pct: 0,
      tp2_pct: 0,
      tp3_pct: 0
    };
  }

  const tp1Pct = ((stats.tp1_hits / stats.total) * 100).toFixed(1);
  const tp2Pct = ((stats.tp2_hits / stats.total) * 100).toFixed(1);
  const tp3Pct = ((stats.tp3_hits / stats.total) * 100).toFixed(1);

  console.log(`  ${bucket.label.padEnd(15)}${stats.total.toString().padStart(8)}${tp1Pct.padStart(7)}%${tp2Pct.padStart(7)}%${tp3Pct.padStart(7)}%`);

  return {
    range: bucket.label,
    total: stats.total,
    tp1_pct: parseFloat(tp1Pct),
    tp2_pct: parseFloat(tp2Pct),
    tp3_pct: parseFloat(tp3Pct)
  };
});

results.tp_hit_rates.by_score = tpByScore;

console.log();

// 5. PEAK MULTIPLIER DISTRIBUTION
console.log('5. PEAK MULTIPLIER DISTRIBUTION');
console.log('-'.repeat(80));

const multiplierBuckets = [
  { label: '<1x', min: 0, max: 1 },
  { label: '1-1.5x', min: 1, max: 1.5 },
  { label: '1.5-2x', min: 1.5, max: 2 },
  { label: '2-3x', min: 2, max: 3 },
  { label: '3-5x', min: 3, max: 5 },
  { label: '5x+', min: 5, max: 999 }
];

console.log('\nPeak Multiplier Distribution:');
console.log('  Range'.padEnd(15) + 'Count'.padStart(8) + 'Pct'.padStart(8) + 'Avg Score'.padStart(12));

const peakDist = multiplierBuckets.map(bucket => {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as count,
      AVG(security_score) as avg_score
    FROM shadow_positions
    WHERE peak_multiplier >= ? AND peak_multiplier < ?
  `).get(bucket.min, bucket.max);

  const pct = ((stats.count / totalPositions) * 100).toFixed(1);
  const avgScore = stats.count > 0 ? stats.avg_score.toFixed(1) : 'N/A';

  console.log(`  ${bucket.label.padEnd(15)}${stats.count.toString().padStart(8)}${pct.padStart(7)}%${avgScore.toString().padStart(12)}`);

  return {
    range: bucket.label,
    count: stats.count,
    pct: parseFloat(pct),
    avg_score: stats.count > 0 ? parseFloat(stats.avg_score.toFixed(1)) : null
  };
});

results.peak_multiplier_dist = peakDist;

console.log();

// 6. TIMING ANALYSIS
console.log('6. TIMING ANALYSIS');
console.log('-'.repeat(80));

const timingStats = db.prepare(`
  SELECT
    COUNT(time_to_peak_ms) as count,
    AVG(time_to_peak_ms) as avg_ms,
    MIN(time_to_peak_ms) as min_ms,
    MAX(time_to_peak_ms) as max_ms,
    AVG(CASE WHEN tp1_hit = 1 THEN time_to_peak_ms END) as avg_ms_tp1_hit
  FROM shadow_positions
  WHERE status = 'closed' AND time_to_peak_ms > 0
`).get();

if (timingStats.count > 0) {
  console.log('\nTime to Peak (closed positions with time_to_peak_ms > 0):');
  console.log(`  Count: ${timingStats.count}`);
  console.log(`  Min: ${(timingStats.min_ms / 1000 / 60).toFixed(1)} min`);
  console.log(`  Avg: ${(timingStats.avg_ms / 1000 / 60).toFixed(1)} min`);
  console.log(`  Max: ${(timingStats.max_ms / 1000 / 60).toFixed(1)} min`);

  if (timingStats.avg_ms_tp1_hit) {
    console.log(`  Avg for TP1 hits: ${(timingStats.avg_ms_tp1_hit / 1000 / 60).toFixed(1)} min`);
  }

  results.timing_analysis.time_to_peak = {
    count: timingStats.count,
    avg_ms: timingStats.avg_ms,
    min_ms: timingStats.min_ms,
    max_ms: timingStats.max_ms,
    avg_ms_tp1_hit: timingStats.avg_ms_tp1_hit
  };
}

// Quartiles
const quartiles = db.prepare(`
  WITH ranked AS (
    SELECT
      time_to_peak_ms,
      ROW_NUMBER() OVER (ORDER BY time_to_peak_ms) as rn,
      COUNT(*) OVER () as total
    FROM shadow_positions
    WHERE status = 'closed' AND time_to_peak_ms > 0
  )
  SELECT
    MAX(CASE WHEN rn = CAST(total * 0.25 AS INTEGER) THEN time_to_peak_ms END) as q1,
    MAX(CASE WHEN rn = CAST(total * 0.50 AS INTEGER) THEN time_to_peak_ms END) as median,
    MAX(CASE WHEN rn = CAST(total * 0.75 AS INTEGER) THEN time_to_peak_ms END) as q3
  FROM ranked
`).get();

if (quartiles && quartiles.median) {
  console.log(`  Q1 (25%): ${(quartiles.q1 / 1000 / 60).toFixed(1)} min`);
  console.log(`  Median: ${(quartiles.median / 1000 / 60).toFixed(1)} min`);
  console.log(`  Q3 (75%): ${(quartiles.q3 / 1000 / 60).toFixed(1)} min`);

  results.timing_analysis.quartiles = quartiles;
}

console.log();

// 7. DETECTED_POOLS FEATURE COMPLETENESS
console.log('7. DETECTED_POOLS FEATURE COMPLETENESS (v9a)');
console.log('-'.repeat(80));

const dpFeatures = [
  'dp_liquidity_usd', 'dp_holder_count', 'dp_top_holder_pct',
  'dp_honeypot_verified', 'dp_mint_auth_revoked', 'dp_freeze_auth_revoked',
  'dp_rugcheck_score', 'dp_lp_burned', 'dp_graduation_time_s',
  'dp_bundle_penalty', 'dp_insiders_count', 'dp_observation_stable',
  'dp_observation_drop_pct', 'dp_wash_concentration', 'dp_wash_same_amount_ratio',
  'dp_wash_penalty', 'dp_creator_reputation', 'dp_creator_funding',
  'dp_early_tx_count', 'dp_tx_velocity', 'dp_unique_slots',
  'dp_insider_wallets', 'dp_hidden_whale_count'
];

const dpTotal = db.prepare(`SELECT COUNT(*) as count FROM detected_pools WHERE bot_version = 'v9a'`).get();

if (dpTotal.count > 0) {
  console.log(`\nTotal detected_pools with v9a: ${dpTotal.count}`);
  console.log('\nFeature Fill Rates:');
  console.log('  Feature'.padEnd(35) + 'Non-NULL'.padStart(10) + 'Fill %'.padStart(10));

  dpFeatures.forEach(feature => {
    const stats = db.prepare(`
      SELECT COUNT(${feature}) as non_null
      FROM detected_pools
      WHERE bot_version = 'v9a'
    `).get();

    const fillPct = ((stats.non_null / dpTotal.count) * 100).toFixed(1);
    console.log(`  ${feature.padEnd(35)}${stats.non_null.toString().padStart(10)}${fillPct.padStart(9)}%`);

    results.detected_pools_features[feature] = {
      non_null: stats.non_null,
      fill_pct: parseFloat(fillPct)
    };
  });
} else {
  console.log('\nNo detected_pools entries with bot_version = v9a found.');
  results.detected_pools_features.note = 'No v9a entries found';
}

console.log();

// 8. PRICE LOG STATS
console.log('8. PRICE LOG STATISTICS');
console.log('-'.repeat(80));

const priceLogStats = db.prepare(`
  SELECT
    COUNT(DISTINCT shadow_id) as positions_with_logs,
    COUNT(*) as total_logs,
    AVG(log_count) as avg_logs_per_position
  FROM (
    SELECT shadow_id, COUNT(*) as log_count
    FROM shadow_price_log
    GROUP BY shadow_id
  )
`).get();

console.log('\nPrice Log Overview:');
console.log(`  Total logs: ${priceLogStats.total_logs}`);
console.log(`  Positions with logs: ${priceLogStats.positions_with_logs}`);
console.log(`  Avg logs per position: ${priceLogStats.avg_logs_per_position.toFixed(1)}`);

results.price_log_stats.overview = priceLogStats;

// Log count distribution
const logCountDist = db.prepare(`
  SELECT
    CASE
      WHEN log_count = 0 THEN '0 logs'
      WHEN log_count BETWEEN 1 AND 5 THEN '1-5 logs'
      WHEN log_count BETWEEN 6 AND 10 THEN '6-10 logs'
      WHEN log_count BETWEEN 11 AND 20 THEN '11-20 logs'
      ELSE '21+ logs'
    END as bucket,
    COUNT(*) as count
  FROM (
    SELECT sp.id, COALESCE(COUNT(spl.id), 0) as log_count
    FROM shadow_positions sp
    LEFT JOIN shadow_price_log spl ON sp.id = spl.shadow_id
    GROUP BY sp.id
  )
  GROUP BY bucket
  ORDER BY bucket
`).all();

console.log('\nLog Count Distribution:');
logCountDist.forEach(row => {
  console.log(`  ${row.bucket.padEnd(15)}: ${row.count}`);
});

results.price_log_stats.distribution = logCountDist;

// Average interval between logs
const avgInterval = db.prepare(`
  SELECT AVG(interval_ms) as avg_interval_ms
  FROM (
    SELECT
      shadow_id,
      created_at - LAG(created_at) OVER (PARTITION BY shadow_id ORDER BY created_at) as interval_ms
    FROM shadow_price_log
  )
  WHERE interval_ms IS NOT NULL
`).get();

if (avgInterval.avg_interval_ms) {
  console.log(`\nAvg interval between logs: ${(avgInterval.avg_interval_ms / 1000).toFixed(1)}s`);
  results.price_log_stats.avg_interval_ms = avgInterval.avg_interval_ms;
}

console.log();

// 9. POOL OUTCOME CHECKS
console.log('9. POOL OUTCOME CHECKS');
console.log('-'.repeat(80));

const outcomeCheckCounts = db.prepare(`
  SELECT delay_minutes, COUNT(*) as count
  FROM pool_outcome_checks
  GROUP BY delay_minutes
  ORDER BY delay_minutes
`).all();

console.log('\nCheck Counts by Delay:');
outcomeCheckCounts.forEach(row => {
  console.log(`  ${row.delay_minutes} min: ${row.count}`);
});

results.pool_outcome_checks.counts_by_delay = outcomeCheckCounts;

// Outcome distribution (using is_alive as proxy for survived/rugged)
const outcomeDistribution = db.prepare(`
  SELECT
    delay_minutes,
    SUM(CASE WHEN is_alive = 1 THEN 1 ELSE 0 END) as survived,
    SUM(CASE WHEN is_alive = 0 THEN 1 ELSE 0 END) as rugged,
    COUNT(*) as total
  FROM pool_outcome_checks
  GROUP BY delay_minutes
  ORDER BY delay_minutes
`).all();

console.log('\nOutcome Distribution by Delay:');
console.log('  Delay'.padEnd(10) + 'Total'.padStart(8) + 'Survived'.padStart(10) + 'Rugged'.padStart(10));

outcomeDistribution.forEach(row => {
  console.log(`  ${row.delay_minutes.toString().padEnd(10)}${row.total.toString().padStart(8)}${row.survived.toString().padStart(10)}${row.rugged.toString().padStart(10)}`);
});

results.pool_outcome_checks.outcome_distribution = outcomeDistribution;

console.log();

// 10. RECOMMENDATIONS
console.log('10. ML PIPELINE RECOMMENDATIONS');
console.log('-'.repeat(80));

const recommendations = [];

// Check sample size
if (totalPositions < 100) {
  recommendations.push({
    priority: 'HIGH',
    category: 'Data Collection',
    recommendation: `Only ${totalPositions} shadow positions collected. Need 500+ for robust ML training. Continue shadow mode for 1-2 more weeks.`
  });
} else {
  recommendations.push({
    priority: 'MEDIUM',
    category: 'Data Collection',
    recommendation: `${totalPositions} positions collected. Sufficient for initial training, but more data will improve model.`
  });
}

// Check feature completeness
const lowFillFeatures = Object.entries(results.feature_completeness)
  .filter(([_, stats]) => stats.fill_pct < 80)
  .map(([col, _]) => col);

if (lowFillFeatures.length > 0) {
  recommendations.push({
    priority: 'MEDIUM',
    category: 'Feature Engineering',
    recommendation: `Features with <80% fill rate: ${lowFillFeatures.join(', ')}. Consider imputation or exclusion from model.`
  });
}

// Check TP hit rates for label creation
const tp1HitRate = results.tp_hit_rates.overall.tp1_pct;
if (tp1HitRate < 20) {
  recommendations.push({
    priority: 'HIGH',
    category: 'Label Definition',
    recommendation: `TP1 hit rate is only ${tp1HitRate}%. Consider lowering TP1 threshold or using peak_multiplier as continuous target instead of binary classification.`
  });
} else {
  recommendations.push({
    priority: 'LOW',
    category: 'Label Definition',
    recommendation: `TP1 hit rate is ${tp1HitRate}%. Sufficient for binary classification (hit TP1 vs not). Consider multi-class: rug/loss/small_win/big_win.`
  });
}

// Check class imbalance for rug detection
const avgRugRate = rugRates.reduce((sum, r) => sum + r.rug_pct, 0) / rugRates.length;
if (avgRugRate > 30 || avgRugRate < 10) {
  recommendations.push({
    priority: 'MEDIUM',
    category: 'Class Imbalance',
    recommendation: `Avg rug rate: ${avgRugRate.toFixed(1)}%. May need SMOTE, class weights, or stratified sampling for balanced training.`
  });
}

// Check detected_pools features
if (dpTotal.count === 0) {
  recommendations.push({
    priority: 'CRITICAL',
    category: 'Feature Availability',
    recommendation: 'No detected_pools entries with v9a found. ML model will only have shadow_positions features. Consider joining historical detected_pools by pool_id.'
  });
} else {
  const highFillDpFeatures = Object.entries(results.detected_pools_features)
    .filter(([_, stats]) => stats && stats.fill_pct && stats.fill_pct > 80)
    .map(([col, _]) => col);

  if (highFillDpFeatures.length > 0) {
    recommendations.push({
      priority: 'LOW',
      category: 'Feature Availability',
      recommendation: `${highFillDpFeatures.length} detected_pools features have >80% fill rate. These can be joined to shadow_positions for richer feature set.`
    });
  }
}

// Check price log availability
if (priceLogStats.positions_with_logs < totalPositions * 0.5) {
  recommendations.push({
    priority: 'MEDIUM',
    category: 'Time-Series Features',
    recommendation: `Only ${((priceLogStats.positions_with_logs / totalPositions) * 100).toFixed(1)}% of positions have price logs. Consider engineering features from logs (volatility, momentum, price path) for positions that have them.`
  });
} else {
  recommendations.push({
    priority: 'LOW',
    category: 'Time-Series Features',
    recommendation: `${((priceLogStats.positions_with_logs / totalPositions) * 100).toFixed(1)}% of positions have price logs. Good coverage for time-series feature engineering.`
  });
}

// Check pool outcome checks
const totalChecks = outcomeCheckCounts.reduce((sum, row) => sum + row.count, 0);
if (totalChecks === 0) {
  recommendations.push({
    priority: 'LOW',
    category: 'Long-Term Labels',
    recommendation: 'No pool_outcome_checks found. These are optional but useful for training "did pool survive 1h?" classifier.'
  });
}

console.log('\nRecommendations:');
recommendations.forEach((rec, idx) => {
  console.log(`\n${idx + 1}. [${rec.priority}] ${rec.category}`);
  console.log(`   ${rec.recommendation}`);
});

results.recommendations = recommendations;

console.log();
console.log('='.repeat(80));

// Write JSON output
fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2));
console.log(`\nAnalysis saved to: ${OUTPUT_PATH}`);

db.close();
