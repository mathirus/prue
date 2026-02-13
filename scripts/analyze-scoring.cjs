#!/usr/bin/env node
/**
 * Comprehensive Scoring Analysis Script
 * Analyzes scoring effectiveness, penalidades, filtros, and outcomes
 */
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'), { readonly: true });

function section(title) {
  console.log('\n' + '='.repeat(80));
  console.log(`  ${title}`);
  console.log('='.repeat(80));
}

function subsection(title) {
  console.log(`\n--- ${title} ---`);
}

// ============================================================
// 1. SCORE DISTRIBUTION (ALL DETECTED POOLS)
// ============================================================
section('1. SCORE DISTRIBUTION — ALL DETECTED POOLS (N=' +
  db.prepare('SELECT COUNT(*) as n FROM detected_pools WHERE security_score IS NOT NULL').get().n + ')');

const scoreHist = db.prepare(`
  SELECT
    CASE
      WHEN security_score < 0 THEN '<0'
      WHEN security_score BETWEEN 0 AND 9 THEN '0-9'
      WHEN security_score BETWEEN 10 AND 19 THEN '10-19'
      WHEN security_score BETWEEN 20 AND 29 THEN '20-29'
      WHEN security_score BETWEEN 30 AND 39 THEN '30-39'
      WHEN security_score BETWEEN 40 AND 49 THEN '40-49'
      WHEN security_score BETWEEN 50 AND 59 THEN '50-59'
      WHEN security_score BETWEEN 60 AND 69 THEN '60-69'
      WHEN security_score BETWEEN 70 AND 79 THEN '70-79'
      WHEN security_score BETWEEN 80 AND 89 THEN '80-89'
      WHEN security_score BETWEEN 90 AND 100 THEN '90-100'
      ELSE '>100'
    END as range,
    COUNT(*) as count,
    ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM detected_pools WHERE security_score IS NOT NULL), 1) as pct
  FROM detected_pools
  WHERE security_score IS NOT NULL
  GROUP BY range
  ORDER BY MIN(security_score)
`).all();
console.log('\nScore Range | Count  | %');
console.log('-'.repeat(40));
scoreHist.forEach(r => console.log(`${r.range.padEnd(11)} | ${String(r.count).padStart(6)} | ${r.pct}%`));

// Score distribution for BOUGHT tokens
subsection('Score Distribution — BOUGHT TOKENS (positions)');
const boughtScoreHist = db.prepare(`
  SELECT
    CASE
      WHEN security_score BETWEEN 60 AND 64 THEN '60-64'
      WHEN security_score BETWEEN 65 AND 69 THEN '65-69'
      WHEN security_score BETWEEN 70 AND 74 THEN '70-74'
      WHEN security_score BETWEEN 75 AND 79 THEN '75-79'
      WHEN security_score BETWEEN 80 AND 84 THEN '80-84'
      WHEN security_score BETWEEN 85 AND 89 THEN '85-89'
      WHEN security_score BETWEEN 90 AND 100 THEN '90-100'
      ELSE 'other'
    END as range,
    COUNT(*) as count,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN pnl_sol <= 0 THEN 1 ELSE 0 END) as losses,
    SUM(CASE WHEN exit_reason LIKE '%rug%' OR exit_reason LIKE '%honeypot%' THEN 1 ELSE 0 END) as rugs,
    ROUND(SUM(CASE WHEN pnl_sol > 0 THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 1) as win_rate,
    ROUND(SUM(pnl_sol), 4) as total_pnl,
    ROUND(AVG(pnl_sol), 5) as avg_pnl,
    ROUND(AVG(peak_multiplier), 2) as avg_peak
  FROM positions
  WHERE status = 'closed' AND security_score IS NOT NULL
  GROUP BY range
  ORDER BY MIN(security_score)
`).all();
console.log('\nRange  | N    | Wins | Loss | Rugs | WinRate | TotalPnL  | AvgPnL    | AvgPeak');
console.log('-'.repeat(95));
boughtScoreHist.forEach(r =>
  console.log(`${r.range.padEnd(6)} | ${String(r.count).padStart(4)} | ${String(r.wins).padStart(4)} | ${String(r.losses).padStart(4)} | ${String(r.rugs).padStart(4)} | ${String(r.win_rate).padStart(5)}%  | ${String(r.total_pnl).padStart(9)} | ${String(r.avg_pnl).padStart(9)} | ${r.avg_peak}x`)
);

// ============================================================
// 2. PENALTY/BONUS FREQUENCY AND IMPACT
// ============================================================
section('2. PENALTY & BONUS FREQUENCY — ALL DETECTED POOLS');

// Analyze individual penalty fields
const penaltyAnalysis = db.prepare(`
  SELECT
    'mint_NOT_revoked' as filter,
    SUM(CASE WHEN dp_mint_auth_revoked = 0 OR dp_mint_auth_revoked IS NULL THEN 1 ELSE 0 END) as active_count,
    COUNT(*) as total,
    ROUND(SUM(CASE WHEN dp_mint_auth_revoked = 0 OR dp_mint_auth_revoked IS NULL THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 1) as pct
  FROM detected_pools WHERE security_score IS NOT NULL
  UNION ALL
  SELECT 'freeze_NOT_revoked',
    SUM(CASE WHEN dp_freeze_auth_revoked = 0 OR dp_freeze_auth_revoked IS NULL THEN 1 ELSE 0 END),
    COUNT(*),
    ROUND(SUM(CASE WHEN dp_freeze_auth_revoked = 0 OR dp_freeze_auth_revoked IS NULL THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 1)
  FROM detected_pools WHERE security_score IS NOT NULL
  UNION ALL
  SELECT 'honeypot_NOT_verified',
    SUM(CASE WHEN dp_honeypot_verified = 0 OR dp_honeypot_verified IS NULL THEN 1 ELSE 0 END),
    COUNT(*),
    ROUND(SUM(CASE WHEN dp_honeypot_verified = 0 OR dp_honeypot_verified IS NULL THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 1)
  FROM detected_pools WHERE security_score IS NOT NULL
  UNION ALL
  SELECT 'lp_NOT_burned',
    SUM(CASE WHEN dp_lp_burned = 0 OR dp_lp_burned IS NULL THEN 1 ELSE 0 END),
    COUNT(*),
    ROUND(SUM(CASE WHEN dp_lp_burned = 0 OR dp_lp_burned IS NULL THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 1)
  FROM detected_pools WHERE security_score IS NOT NULL
  UNION ALL
  SELECT 'bundle_penalty_active',
    SUM(CASE WHEN dp_bundle_penalty > 0 THEN 1 ELSE 0 END),
    COUNT(*),
    ROUND(SUM(CASE WHEN dp_bundle_penalty > 0 THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 1)
  FROM detected_pools WHERE security_score IS NOT NULL
  UNION ALL
  SELECT 'wash_penalty_active',
    SUM(CASE WHEN dp_wash_penalty > 0 THEN 1 ELSE 0 END),
    COUNT(*),
    ROUND(SUM(CASE WHEN dp_wash_penalty > 0 THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 1)
  FROM detected_pools WHERE security_score IS NOT NULL
  UNION ALL
  SELECT 'insiders_present',
    SUM(CASE WHEN dp_insiders_count > 0 THEN 1 ELSE 0 END),
    COUNT(*),
    ROUND(SUM(CASE WHEN dp_insiders_count > 0 THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 1)
  FROM detected_pools WHERE security_score IS NOT NULL
  UNION ALL
  SELECT 'hidden_whales',
    SUM(CASE WHEN dp_hidden_whale_count > 0 THEN 1 ELSE 0 END),
    COUNT(*),
    ROUND(SUM(CASE WHEN dp_hidden_whale_count > 0 THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 1)
  FROM detected_pools WHERE security_score IS NOT NULL
  UNION ALL
  SELECT 'creator_rep_negative',
    SUM(CASE WHEN dp_creator_reputation < 0 THEN 1 ELSE 0 END),
    COUNT(*),
    ROUND(SUM(CASE WHEN dp_creator_reputation < 0 THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 1)
  FROM detected_pools WHERE security_score IS NOT NULL
  UNION ALL
  SELECT 'observation_unstable',
    SUM(CASE WHEN dp_observation_stable = 0 THEN 1 ELSE 0 END),
    COUNT(*),
    ROUND(SUM(CASE WHEN dp_observation_stable = 0 THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 1)
  FROM detected_pools WHERE security_score IS NOT NULL
  UNION ALL
  SELECT 'graduation_fast(<300s)',
    SUM(CASE WHEN dp_graduation_time_s IS NOT NULL AND dp_graduation_time_s < 300 THEN 1 ELSE 0 END),
    COUNT(*),
    ROUND(SUM(CASE WHEN dp_graduation_time_s IS NOT NULL AND dp_graduation_time_s < 300 THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 1)
  FROM detected_pools WHERE security_score IS NOT NULL
  UNION ALL
  SELECT 'low_liquidity(<5K)',
    SUM(CASE WHEN dp_liquidity_usd < 5000 THEN 1 ELSE 0 END),
    COUNT(*),
    ROUND(SUM(CASE WHEN dp_liquidity_usd < 5000 THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 1)
  FROM detected_pools WHERE security_score IS NOT NULL
  UNION ALL
  SELECT 'high_top_holder(>50%)',
    SUM(CASE WHEN dp_top_holder_pct > 50 THEN 1 ELSE 0 END),
    COUNT(*),
    ROUND(SUM(CASE WHEN dp_top_holder_pct > 50 THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 1)
  FROM detected_pools WHERE security_score IS NOT NULL
`).all();

console.log('\nFilter/Penalty         | Active | Total  | %');
console.log('-'.repeat(55));
penaltyAnalysis.forEach(r =>
  console.log(`${r.filter.padEnd(23)}| ${String(r.active_count).padStart(6)} | ${String(r.total).padStart(6)} | ${r.pct}%`)
);

// Bundle penalty distribution
subsection('Bundle Penalty Distribution');
const bundleDist = db.prepare(`
  SELECT dp_bundle_penalty as penalty, COUNT(*) as n
  FROM detected_pools
  WHERE dp_bundle_penalty IS NOT NULL AND dp_bundle_penalty != 0
  GROUP BY dp_bundle_penalty ORDER BY dp_bundle_penalty
`).all();
bundleDist.forEach(r => console.log(`  Bundle penalty ${r.penalty}: ${r.n} tokens`));

// Wash penalty distribution
subsection('Wash Penalty Distribution');
const washDist = db.prepare(`
  SELECT dp_wash_penalty as penalty, COUNT(*) as n
  FROM detected_pools
  WHERE dp_wash_penalty IS NOT NULL AND dp_wash_penalty != 0
  GROUP BY dp_wash_penalty ORDER BY dp_wash_penalty
`).all();
washDist.forEach(r => console.log(`  Wash penalty ${r.penalty}: ${r.n} tokens`));

// Creator reputation distribution
subsection('Creator Reputation Distribution');
const repDist = db.prepare(`
  SELECT dp_creator_reputation as rep, COUNT(*) as n
  FROM detected_pools
  WHERE dp_creator_reputation IS NOT NULL
  GROUP BY dp_creator_reputation ORDER BY dp_creator_reputation
`).all();
repDist.forEach(r => console.log(`  Creator rep ${r.rep}: ${r.n} tokens`));

// ============================================================
// 3. REJECTION STAGE ANALYSIS
// ============================================================
section('3. REJECTION STAGES');
const rejStages = db.prepare(`
  SELECT
    COALESCE(dp_rejection_stage, 'PASSED') as stage,
    COUNT(*) as n,
    ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM detected_pools), 1) as pct,
    ROUND(AVG(security_score), 1) as avg_score
  FROM detected_pools
  GROUP BY stage
  ORDER BY n DESC
`).all();
console.log('\nStage           | Count  | %     | Avg Score');
console.log('-'.repeat(50));
rejStages.forEach(r =>
  console.log(`${r.stage.padEnd(16)}| ${String(r.n).padStart(6)} | ${String(r.pct).padStart(5)}% | ${r.avg_score}`)
);

// ============================================================
// 4. FILTER EFFECTIVENESS — LIFT ANALYSIS (BOUGHT TOKENS ONLY)
// ============================================================
section('4. FILTER EFFECTIVENESS — LIFT ANALYSIS (Bought Tokens)');

const closedPositions = db.prepare(`SELECT COUNT(*) as n FROM positions WHERE status='closed'`).get().n;
console.log(`\nTotal closed positions: ${closedPositions}`);

// Join positions with detected_pools for penalty data
const liftQuery = (filterName, condition) => {
  try {
    const result = db.prepare(`
      SELECT
        '${filterName}' as filter,
        SUM(CASE WHEN (${condition}) AND (p.exit_reason LIKE '%rug%' OR p.exit_reason LIKE '%honeypot%') THEN 1 ELSE 0 END) as rugs_with,
        SUM(CASE WHEN (${condition}) AND p.pnl_sol > 0 THEN 1 ELSE 0 END) as wins_with,
        SUM(CASE WHEN (${condition}) THEN 1 ELSE 0 END) as total_with,
        SUM(CASE WHEN NOT (${condition}) AND (p.exit_reason LIKE '%rug%' OR p.exit_reason LIKE '%honeypot%') THEN 1 ELSE 0 END) as rugs_without,
        SUM(CASE WHEN NOT (${condition}) AND p.pnl_sol > 0 THEN 1 ELSE 0 END) as wins_without,
        SUM(CASE WHEN NOT (${condition}) THEN 1 ELSE 0 END) as total_without,
        COUNT(*) as total
      FROM positions p
      LEFT JOIN detected_pools d ON p.pool_address = d.pool_address
      WHERE p.status = 'closed'
    `).get();
    return result;
  } catch(e) {
    return null;
  }
};

const filters = [
  ['bundle_penalty>0', 'd.dp_bundle_penalty > 0'],
  ['wash_penalty>0', 'd.dp_wash_penalty > 0'],
  ['insiders>0', 'd.dp_insiders_count > 0'],
  ['hidden_whales>0', 'd.dp_hidden_whale_count > 0'],
  ['creator_rep<0', 'd.dp_creator_reputation < 0'],
  ['obs_unstable', 'd.dp_observation_stable = 0'],
  ['grad_fast(<300s)', 'd.dp_graduation_time_s IS NOT NULL AND d.dp_graduation_time_s < 300'],
  ['grad_instant(<60s)', 'd.dp_graduation_time_s IS NOT NULL AND d.dp_graduation_time_s < 60'],
  ['top_holder>30%', 'd.dp_top_holder_pct > 30'],
  ['top_holder>50%', 'd.dp_top_holder_pct > 50'],
  ['liq<10K', 'd.dp_liquidity_usd < 10000'],
  ['liq<5K', 'd.dp_liquidity_usd < 5000'],
  ['rugcheck<50', 'd.dp_rugcheck_score IS NOT NULL AND d.dp_rugcheck_score < 50'],
  ['obs_drop>10%', 'd.dp_observation_drop_pct > 10'],
  ['obs_drop>20%', 'd.dp_observation_drop_pct > 20'],
  ['velocity>10', 'd.dp_tx_velocity > 10'],
  ['wash_conc>0.5', 'd.dp_wash_concentration > 0.5'],
];

console.log('\nFilter               | With: Rugs/Wins/N | Without: Rugs/Wins/N | Rug%↑ Win%↓ | LIFT');
console.log('-'.repeat(95));

filters.forEach(([name, cond]) => {
  const r = liftQuery(name, cond);
  if (!r || r.total_with === 0) {
    console.log(`${name.padEnd(21)}| NO DATA`);
    return;
  }
  const rugPctWith = r.total_with > 0 ? (r.rugs_with / r.total_with * 100) : 0;
  const winPctWith = r.total_with > 0 ? (r.wins_with / r.total_with * 100) : 0;
  const rugPctWithout = r.total_without > 0 ? (r.rugs_without / r.total_without * 100) : 0;
  const winPctWithout = r.total_without > 0 ? (r.wins_without / r.total_without * 100) : 0;
  const lift = winPctWith > 0 ? (rugPctWith / Math.max(winPctWith, 0.1)).toFixed(2) : 'INF';
  const liftVsBase = rugPctWithout > 0 ? (rugPctWith / rugPctWithout).toFixed(2) : 'N/A';

  console.log(
    `${name.padEnd(21)}| ${r.rugs_with}/${r.wins_with}/${r.total_with}`.padEnd(35) +
    `| ${r.rugs_without}/${r.wins_without}/${r.total_without}`.padEnd(25) +
    `| ${rugPctWith.toFixed(0)}%/${winPctWith.toFixed(0)}%`.padEnd(14) +
    `| ${liftVsBase}`
  );
});

// ============================================================
// 5. EXIT REASON ANALYSIS
// ============================================================
section('5. EXIT REASON BREAKDOWN');
const exitReasons = db.prepare(`
  SELECT
    exit_reason,
    COUNT(*) as n,
    ROUND(AVG(pnl_sol), 5) as avg_pnl,
    ROUND(SUM(pnl_sol), 4) as total_pnl,
    ROUND(AVG(peak_multiplier), 2) as avg_peak,
    ROUND(AVG(security_score), 1) as avg_score,
    ROUND(AVG(sell_attempts), 1) as avg_sell_attempts,
    ROUND(AVG(sell_successes), 1) as avg_sell_successes
  FROM positions
  WHERE status = 'closed'
  GROUP BY exit_reason
  ORDER BY n DESC
`).all();
console.log('\nExit Reason              | N    | Avg PnL   | Total PnL | AvgPeak | AvgScore | SellAttempts/Success');
console.log('-'.repeat(100));
exitReasons.forEach(r =>
  console.log(
    `${(r.exit_reason || 'null').padEnd(25)}| ${String(r.n).padStart(4)} | ${String(r.avg_pnl).padStart(9)} | ${String(r.total_pnl).padStart(9)} | ${String(r.avg_peak).padStart(5)}x  | ${String(r.avg_score).padStart(6)}   | ${r.avg_sell_attempts}/${r.avg_sell_successes}`
  )
);

// ============================================================
// 6. POOL OUTCOME vs SCORE (REJECTED TOKENS)
// ============================================================
section('6. REJECTED TOKENS — MISSED OPPORTUNITIES');

const rejectedOutcomes = db.prepare(`
  SELECT
    pool_outcome,
    COUNT(*) as n,
    ROUND(AVG(security_score), 1) as avg_score,
    dp_rejection_stage as stage
  FROM detected_pools
  WHERE security_passed = 0 AND pool_outcome IS NOT NULL AND pool_outcome != ''
  GROUP BY pool_outcome, dp_rejection_stage
  ORDER BY n DESC
  LIMIT 30
`).all();

console.log('\nOutcome               | Stage          | N    | Avg Score');
console.log('-'.repeat(65));
rejectedOutcomes.forEach(r =>
  console.log(`${(r.pool_outcome || 'null').padEnd(22)}| ${(r.stage || 'none').padEnd(15)}| ${String(r.n).padStart(4)} | ${r.avg_score}`)
);

// Specifically: rejected tokens that survived (didn't rug)
subsection('Rejected tokens with GOOD outcomes');
const goodRejected = db.prepare(`
  SELECT
    COUNT(*) as total_rejected,
    SUM(CASE WHEN pool_outcome IN ('survived', 'growing', 'moon') THEN 1 ELSE 0 END) as good_outcomes,
    SUM(CASE WHEN pool_outcome IN ('rugged', 'dead', 'honeypot') THEN 1 ELSE 0 END) as bad_outcomes,
    SUM(CASE WHEN pool_outcome IS NULL OR pool_outcome = '' THEN 1 ELSE 0 END) as unknown
  FROM detected_pools
  WHERE security_passed = 0
`).get();
console.log(`Total rejected: ${goodRejected.total_rejected}`);
console.log(`Good outcomes (survived/growing/moon): ${goodRejected.good_outcomes} (${(goodRejected.good_outcomes/goodRejected.total_rejected*100).toFixed(1)}%)`);
console.log(`Bad outcomes (rugged/dead/honeypot): ${goodRejected.bad_outcomes} (${(goodRejected.bad_outcomes/goodRejected.total_rejected*100).toFixed(1)}%)`);
console.log(`Unknown outcome: ${goodRejected.unknown} (${(goodRejected.unknown/goodRejected.total_rejected*100).toFixed(1)}%)`);

// Good rejected tokens by score range
subsection('Good rejected tokens by score range');
const goodRejByScore = db.prepare(`
  SELECT
    CASE
      WHEN security_score BETWEEN 50 AND 59 THEN '50-59'
      WHEN security_score BETWEEN 60 AND 64 THEN '60-64'
      WHEN security_score BETWEEN 65 AND 69 THEN '65-69'
      WHEN security_score BETWEEN 70 AND 74 THEN '70-74'
      WHEN security_score BETWEEN 75 AND 79 THEN '75-79'
      WHEN security_score < 50 THEN '<50'
      ELSE '80+'
    END as range,
    COUNT(*) as total,
    SUM(CASE WHEN pool_outcome IN ('survived', 'growing', 'moon') THEN 1 ELSE 0 END) as good,
    ROUND(SUM(CASE WHEN pool_outcome IN ('survived', 'growing', 'moon') THEN 1.0 ELSE 0 END) / NULLIF(COUNT(*), 0) * 100, 1) as good_pct
  FROM detected_pools
  WHERE security_passed = 0 AND pool_outcome IS NOT NULL AND pool_outcome != ''
  GROUP BY range
  ORDER BY MIN(security_score)
`).all();
console.log('\nScore Range | Total Rej | Good | Good%');
console.log('-'.repeat(45));
goodRejByScore.forEach(r =>
  console.log(`${r.range.padEnd(12)}| ${String(r.total).padStart(9)} | ${String(r.good).padStart(4)} | ${r.good_pct}%`)
);

// ============================================================
// 7. CREATOR ANALYSIS
// ============================================================
section('7. CREATOR WALLET ANALYSIS');

const creatorOutcome = db.prepare(`
  SELECT
    outcome,
    COUNT(*) as n,
    ROUND(AVG(wallet_age_seconds), 0) as avg_age_s,
    ROUND(AVG(tx_count), 0) as avg_txs,
    ROUND(AVG(reputation_score), 1) as avg_rep
  FROM token_creators
  WHERE outcome IS NOT NULL AND outcome != 'unknown'
  GROUP BY outcome
  ORDER BY n DESC
`).all();
console.log('\nOutcome | N    | Avg Age(s) | Avg TXs | Avg Rep');
console.log('-'.repeat(55));
creatorOutcome.forEach(r =>
  console.log(`${r.outcome.padEnd(8)}| ${String(r.n).padStart(4)} | ${String(r.avg_age_s).padStart(10)} | ${String(r.avg_txs).padStart(7)} | ${r.avg_rep}`)
);

// Creator age buckets vs outcome
subsection('Creator Age Buckets vs Outcome');
const ageBuckets = db.prepare(`
  SELECT
    CASE
      WHEN wallet_age_seconds < 60 THEN '<1min'
      WHEN wallet_age_seconds < 300 THEN '1-5min'
      WHEN wallet_age_seconds < 3600 THEN '5-60min'
      WHEN wallet_age_seconds < 86400 THEN '1-24hr'
      ELSE '>24hr'
    END as age_bucket,
    COUNT(*) as total,
    SUM(CASE WHEN outcome = 'rug' THEN 1 ELSE 0 END) as rugs,
    SUM(CASE WHEN outcome = 'safe' THEN 1 ELSE 0 END) as safe,
    ROUND(SUM(CASE WHEN outcome = 'rug' THEN 1.0 ELSE 0 END) / NULLIF(SUM(CASE WHEN outcome IN ('rug','safe') THEN 1 ELSE 0 END), 0) * 100, 1) as rug_rate
  FROM token_creators
  WHERE wallet_age_seconds IS NOT NULL AND outcome IN ('rug', 'safe')
  GROUP BY age_bucket
  ORDER BY MIN(wallet_age_seconds)
`).all();
console.log('\nAge Bucket | Total | Rugs | Safe | Rug Rate');
console.log('-'.repeat(50));
ageBuckets.forEach(r =>
  console.log(`${r.age_bucket.padEnd(11)}| ${String(r.total).padStart(5)} | ${String(r.rugs).padStart(4)} | ${String(r.safe).padStart(4)} | ${r.rug_rate}%`)
);

// Reputation score vs outcome
subsection('Reputation Score vs Outcome');
const repOutcome = db.prepare(`
  SELECT
    reputation_score as rep,
    COUNT(*) as total,
    SUM(CASE WHEN outcome = 'rug' THEN 1 ELSE 0 END) as rugs,
    SUM(CASE WHEN outcome = 'safe' THEN 1 ELSE 0 END) as safe,
    ROUND(SUM(CASE WHEN outcome = 'rug' THEN 1.0 ELSE 0 END) / NULLIF(SUM(CASE WHEN outcome IN ('rug','safe') THEN 1 ELSE 0 END), 0) * 100, 1) as rug_rate
  FROM token_creators
  WHERE reputation_score IS NOT NULL AND outcome IN ('rug', 'safe')
  GROUP BY reputation_score
  ORDER BY reputation_score
`).all();
console.log('\nRep Score | Total | Rugs | Safe | Rug Rate');
console.log('-'.repeat(50));
repOutcome.forEach(r =>
  console.log(`${String(r.rep).padStart(9)} | ${String(r.total).padStart(5)} | ${String(r.rugs).padStart(4)} | ${String(r.safe).padStart(4)} | ${r.rug_rate}%`)
);

// ============================================================
// 8. BOT VERSION COMPARISON
// ============================================================
section('8. BOT VERSION COMPARISON');
const versionStats = db.prepare(`
  SELECT
    bot_version,
    COUNT(*) as n,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    ROUND(SUM(CASE WHEN pnl_sol > 0 THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 1) as win_rate,
    ROUND(SUM(pnl_sol), 4) as total_pnl,
    ROUND(AVG(pnl_sol), 5) as avg_pnl,
    ROUND(AVG(peak_multiplier), 2) as avg_peak,
    ROUND(AVG(security_score), 1) as avg_score,
    SUM(CASE WHEN exit_reason LIKE '%rug%' OR exit_reason LIKE '%honeypot%' THEN 1 ELSE 0 END) as rugs
  FROM positions
  WHERE status = 'closed' AND bot_version IS NOT NULL
  GROUP BY bot_version
  ORDER BY MIN(opened_at) DESC
`).all();
console.log('\nVersion    | N    | Wins | WinR  | Rugs | TotalPnL  | AvgPnL    | AvgPeak | AvgScore');
console.log('-'.repeat(100));
versionStats.forEach(r =>
  console.log(
    `${(r.bot_version || '?').padEnd(11)}| ${String(r.n).padStart(4)} | ${String(r.wins).padStart(4)} | ${String(r.win_rate).padStart(5)}% | ${String(r.rugs).padStart(4)} | ${String(r.total_pnl).padStart(9)} | ${String(r.avg_pnl).padStart(9)} | ${String(r.avg_peak).padStart(5)}x  | ${r.avg_score}`)
);

// ============================================================
// 9. OBSERVATION PHASE ANALYSIS
// ============================================================
section('9. OBSERVATION PHASE ANALYSIS');
const obsAnalysis = db.prepare(`
  SELECT
    CASE
      WHEN dp_observation_drop_pct IS NULL THEN 'no_data'
      WHEN dp_observation_drop_pct <= 0 THEN 'growing'
      WHEN dp_observation_drop_pct <= 5 THEN 'stable(0-5%)'
      WHEN dp_observation_drop_pct <= 10 THEN 'minor_drop(5-10%)'
      WHEN dp_observation_drop_pct <= 20 THEN 'drop(10-20%)'
      ELSE 'big_drop(>20%)'
    END as obs_bucket,
    COUNT(*) as n,
    SUM(CASE WHEN p.pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    ROUND(SUM(CASE WHEN p.pnl_sol > 0 THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 1) as win_rate,
    ROUND(SUM(p.pnl_sol), 4) as total_pnl,
    SUM(CASE WHEN p.exit_reason LIKE '%rug%' OR p.exit_reason LIKE '%honeypot%' THEN 1 ELSE 0 END) as rugs
  FROM positions p
  LEFT JOIN detected_pools d ON p.pool_address = d.pool_address
  WHERE p.status = 'closed'
  GROUP BY obs_bucket
  ORDER BY MIN(dp_observation_drop_pct)
`).all();
console.log('\nObs Bucket        | N    | Wins | WinRate | TotalPnL  | Rugs');
console.log('-'.repeat(70));
obsAnalysis.forEach(r =>
  console.log(`${r.obs_bucket.padEnd(18)}| ${String(r.n).padStart(4)} | ${String(r.wins).padStart(4)} | ${String(r.win_rate).padStart(5)}%  | ${String(r.total_pnl).padStart(9)} | ${r.rugs}`)
);

// ============================================================
// 10. OPTIMAL MIN_SCORE SIMULATION
// ============================================================
section('10. OPTIMAL MIN_SCORE SIMULATION');
console.log('\nSimulating different min_score thresholds on historical positions...');

for (let threshold = 55; threshold <= 90; threshold += 5) {
  const sim = db.prepare(`
    SELECT
      COUNT(*) as n,
      SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(CASE WHEN pnl_sol > 0 THEN 1.0 ELSE 0 END) / NULLIF(COUNT(*), 0) * 100, 1) as win_rate,
      ROUND(SUM(pnl_sol), 4) as total_pnl,
      SUM(CASE WHEN exit_reason LIKE '%rug%' OR exit_reason LIKE '%honeypot%' THEN 1 ELSE 0 END) as rugs,
      ROUND(SUM(CASE WHEN exit_reason LIKE '%rug%' OR exit_reason LIKE '%honeypot%' THEN 1.0 ELSE 0 END) / NULLIF(COUNT(*), 0) * 100, 1) as rug_rate
    FROM positions
    WHERE status = 'closed' AND security_score >= ${threshold}
  `).get();
  console.log(
    `  min_score=${threshold}: N=${sim.n}, Wins=${sim.wins} (${sim.win_rate}%), Rugs=${sim.rugs} (${sim.rug_rate}%), PnL=${sim.total_pnl}`
  );
}

// ============================================================
// 11. WASH TRADING ANALYSIS
// ============================================================
section('11. WASH TRADING METRICS');
const washAnalysis = db.prepare(`
  SELECT
    CASE
      WHEN dp_wash_concentration IS NULL THEN 'no_data'
      WHEN dp_wash_concentration <= 0.2 THEN 'low(0-0.2)'
      WHEN dp_wash_concentration <= 0.5 THEN 'med(0.2-0.5)'
      ELSE 'high(>0.5)'
    END as wash_bucket,
    COUNT(*) as n,
    SUM(CASE WHEN p.pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    ROUND(SUM(CASE WHEN p.pnl_sol > 0 THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 1) as win_rate,
    ROUND(SUM(p.pnl_sol), 4) as total_pnl,
    SUM(CASE WHEN p.exit_reason LIKE '%rug%' OR p.exit_reason LIKE '%honeypot%' THEN 1 ELSE 0 END) as rugs
  FROM positions p
  LEFT JOIN detected_pools d ON p.pool_address = d.pool_address
  WHERE p.status = 'closed'
  GROUP BY wash_bucket
`).all();
console.log('\nWash Concentration | N    | Wins | WinRate | TotalPnL  | Rugs');
console.log('-'.repeat(65));
washAnalysis.forEach(r =>
  console.log(`${r.wash_bucket.padEnd(19)}| ${String(r.n).padStart(4)} | ${String(r.wins).padStart(4)} | ${String(r.win_rate).padStart(5)}%  | ${String(r.total_pnl).padStart(9)} | ${r.rugs}`)
);

// ============================================================
// 12. SELL DIFFICULTY ANALYSIS
// ============================================================
section('12. SELL DIFFICULTY ANALYSIS');
const sellDifficulty = db.prepare(`
  SELECT
    CASE
      WHEN sell_attempts <= 1 THEN '1_attempt'
      WHEN sell_attempts <= 3 THEN '2-3_attempts'
      WHEN sell_attempts <= 5 THEN '4-5_attempts'
      ELSE '6+_attempts'
    END as difficulty,
    COUNT(*) as n,
    ROUND(AVG(sell_successes * 1.0 / NULLIF(sell_attempts, 0)), 2) as success_rate,
    ROUND(AVG(pnl_sol), 5) as avg_pnl,
    ROUND(SUM(pnl_sol), 4) as total_pnl,
    SUM(CASE WHEN exit_reason LIKE '%rug%' OR exit_reason LIKE '%honeypot%' THEN 1 ELSE 0 END) as rugs
  FROM positions
  WHERE status = 'closed' AND sell_attempts IS NOT NULL AND sell_attempts > 0
  GROUP BY difficulty
  ORDER BY MIN(sell_attempts)
`).all();
console.log('\nDifficulty    | N    | SuccessRate | AvgPnL    | TotalPnL  | Rugs');
console.log('-'.repeat(70));
sellDifficulty.forEach(r =>
  console.log(`${r.difficulty.padEnd(14)}| ${String(r.n).padStart(4)} | ${String(r.success_rate).padStart(9)}   | ${String(r.avg_pnl).padStart(9)} | ${String(r.total_pnl).padStart(9)} | ${r.rugs}`)
);

// ============================================================
// 13. PEAK MULTIPLIER ANALYSIS
// ============================================================
section('13. PEAK MULTIPLIER vs EXIT');
const peakAnalysis = db.prepare(`
  SELECT
    CASE
      WHEN peak_multiplier < 1.0 THEN '<1x(never_profit)'
      WHEN peak_multiplier < 1.2 THEN '1.0-1.2x'
      WHEN peak_multiplier < 1.5 THEN '1.2-1.5x'
      WHEN peak_multiplier < 2.0 THEN '1.5-2.0x'
      WHEN peak_multiplier < 3.0 THEN '2.0-3.0x'
      ELSE '3x+'
    END as peak_bucket,
    COUNT(*) as n,
    ROUND(AVG(pnl_pct), 1) as avg_pnl_pct,
    ROUND(SUM(pnl_sol), 4) as total_pnl,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as ended_positive,
    SUM(CASE WHEN exit_reason LIKE '%rug%' OR exit_reason LIKE '%honeypot%' THEN 1 ELSE 0 END) as rugs
  FROM positions
  WHERE status = 'closed' AND peak_multiplier IS NOT NULL
  GROUP BY peak_bucket
  ORDER BY MIN(peak_multiplier)
`).all();
console.log('\nPeak Bucket        | N    | Avg PnL% | TotalPnL  | EndedPos | Rugs');
console.log('-'.repeat(75));
peakAnalysis.forEach(r =>
  console.log(`${r.peak_bucket.padEnd(19)}| ${String(r.n).padStart(4)} | ${String(r.avg_pnl_pct).padStart(7)}% | ${String(r.total_pnl).padStart(9)} | ${String(r.ended_positive).padStart(8)} | ${r.rugs}`)
);

// ============================================================
// 14. TIME-BASED ANALYSIS
// ============================================================
section('14. RECENT vs OLD PERFORMANCE');
const timeAnalysis = db.prepare(`
  SELECT
    CASE
      WHEN opened_at > strftime('%s','now') - 86400 THEN 'last_24h'
      WHEN opened_at > strftime('%s','now') - 86400*3 THEN 'last_3d'
      WHEN opened_at > strftime('%s','now') - 86400*7 THEN 'last_7d'
      ELSE 'older'
    END as period,
    COUNT(*) as n,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    ROUND(SUM(CASE WHEN pnl_sol > 0 THEN 1.0 ELSE 0 END) / COUNT(*) * 100, 1) as win_rate,
    ROUND(SUM(pnl_sol), 4) as total_pnl,
    SUM(CASE WHEN exit_reason LIKE '%rug%' OR exit_reason LIKE '%honeypot%' THEN 1 ELSE 0 END) as rugs
  FROM positions
  WHERE status = 'closed'
  GROUP BY period
  ORDER BY MIN(opened_at) DESC
`).all();
console.log('\nPeriod    | N    | Wins | WinRate | TotalPnL  | Rugs');
console.log('-'.repeat(60));
timeAnalysis.forEach(r =>
  console.log(`${r.period.padEnd(10)}| ${String(r.n).padStart(4)} | ${String(r.wins).padStart(4)} | ${String(r.win_rate).padStart(5)}%  | ${String(r.total_pnl).padStart(9)} | ${r.rugs}`)
);

// ============================================================
// SUMMARY
// ============================================================
section('SUMMARY & ACTIONABLE CONCLUSIONS');
console.log(`
Data size:
  - Detected pools: ${db.prepare('SELECT COUNT(*) as n FROM detected_pools').get().n}
  - Positions (closed): ${db.prepare("SELECT COUNT(*) as n FROM positions WHERE status='closed'").get().n}
  - Token creators: ${db.prepare('SELECT COUNT(*) as n FROM token_creators').get().n}
  - Pool outcomes tracked: ${db.prepare("SELECT COUNT(*) as n FROM detected_pools WHERE pool_outcome IS NOT NULL AND pool_outcome != ''").get().n}

NOTE: Review the numbers above to determine:
  1. Which filters have high LIFT (rug% much higher than win%) → make stricter
  2. Which filters have LIFT ~1 or <1 → consider relaxing or removing
  3. What min_score maximizes PnL in the simulation
  4. How many good tokens we're rejecting at the current threshold
  5. Whether creator reputation actually predicts outcomes
`);

db.close();
console.log('\nAnalysis complete.');
