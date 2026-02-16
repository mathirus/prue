#!/usr/bin/env node
/**
 * Exhaustive Rug Pull Analysis
 * Queries BOTH databases, deduplicates, and analyzes every available feature
 * for rugs vs winners to find optimal pre-buy and post-buy filters.
 */

const Database = require('better-sqlite3');
const path = require('path');

const MAIN_DB = path.join(__dirname, '..', 'data', 'bot.db');
const BACKUP_DB = path.join(__dirname, '..', 'data', 'backups', 'pre-v11o-20260215', 'bot.db');

const mainDb = new Database(MAIN_DB, { readonly: true });
const backupDb = new Database(BACKUP_DB, { readonly: true });

// ============================================================================
// SECTION 1: Extract ALL positions from both DBs with full feature join
// ============================================================================

function extractPositions(db, dbName) {
  // Check which columns exist in detected_pools for this DB
  const dpCols = db.prepare("PRAGMA table_info(detected_pools)").all().map(c => c.name);
  const hasFunderFanOut = dpCols.includes('dp_funder_fan_out');
  const hasFastScore = dpCols.includes('dp_fast_score');
  const hasDeferredDelta = dpCols.includes('dp_deferred_delta');
  const hasFinalScore = dpCols.includes('dp_final_score');

  // Check positions columns
  const pCols = db.prepare("PRAGMA table_info(positions)").all().map(c => c.name);
  const hasEntryReserve = pCols.includes('entry_reserve_lamports');
  const hasCurrentReserve = pCols.includes('current_reserve_lamports');

  const query = `
    SELECT
      p.id,
      p.token_mint,
      p.pool_address,
      p.entry_price,
      p.current_price,
      p.peak_price,
      p.token_amount,
      p.sol_invested,
      p.sol_returned,
      p.pnl_sol,
      p.pnl_pct,
      p.status,
      p.exit_reason,
      p.security_score as p_score,
      p.opened_at,
      p.closed_at,
      p.holder_count as p_holder_count,
      p.liquidity_usd as p_liquidity_usd,
      p.peak_multiplier,
      p.time_to_peak_ms,
      p.sell_attempts,
      p.sell_successes,
      p.bot_version,
      p.entry_latency_ms,
      p.sell_burst_count,
      p.total_sell_events,
      p.max_sell_burst,
      p.hhi_entry,
      p.holder_count_60s,
      p.concentrated_entry,
      ${hasEntryReserve ? 'p.entry_reserve_lamports,' : ''}
      ${hasCurrentReserve ? 'p.current_reserve_lamports,' : ''}
      -- detected_pools
      dp.security_score as dp_score,
      dp.dp_liquidity_usd,
      dp.dp_holder_count,
      dp.dp_top_holder_pct,
      dp.dp_honeypot_verified,
      dp.dp_mint_auth_revoked,
      dp.dp_freeze_auth_revoked,
      dp.dp_rugcheck_score,
      dp.dp_lp_burned,
      dp.dp_graduation_time_s,
      dp.dp_bundle_penalty,
      dp.dp_insiders_count,
      dp.dp_observation_stable,
      dp.dp_observation_drop_pct,
      dp.dp_observation_initial_sol,
      dp.dp_observation_final_sol,
      dp.dp_wash_penalty,
      dp.dp_creator_reputation,
      dp.dp_hhi_value,
      dp.dp_hhi_penalty,
      dp.dp_concentrated_value,
      dp.dp_concentrated_penalty,
      dp.dp_holder_penalty,
      dp.dp_graduation_bonus,
      dp.dp_obs_bonus,
      dp.dp_organic_bonus,
      dp.dp_smart_wallet_bonus,
      dp.dp_creator_age_penalty,
      dp.dp_rugcheck_penalty,
      dp.dp_velocity_penalty,
      dp.dp_insider_penalty,
      dp.dp_whale_penalty,
      dp.dp_timing_cv_penalty,
      ${hasFastScore ? 'dp.dp_fast_score,' : ''}
      ${hasDeferredDelta ? 'dp.dp_deferred_delta,' : ''}
      ${hasFinalScore ? 'dp.dp_final_score,' : ''}
      ${hasFunderFanOut ? 'dp.dp_funder_fan_out,' : ''}
      dp.pool_outcome,
      dp.dp_observation_initial_sol as obs_initial_sol,
      -- token_analysis
      ta.score as ta_score,
      ta.mint_authority_revoked as ta_mint_revoked,
      ta.freeze_authority_revoked as ta_freeze_revoked,
      ta.honeypot_safe as ta_honeypot_safe,
      ta.liquidity_usd as ta_liquidity_usd,
      ta.top_holder_pct as ta_top_holder_pct,
      ta.holder_count as ta_holder_count,
      ta.lp_burned as ta_lp_burned,
      ta.rugcheck_score as ta_rugcheck_score,
      -- token_creators
      tc.creator_wallet,
      tc.outcome as tc_outcome,
      tc.funding_source,
      tc.funding_source_hop2,
      tc.wallet_age_seconds,
      tc.tx_count as tc_tx_count,
      tc.sol_balance_lamports,
      tc.reputation_score
    FROM positions p
    LEFT JOIN detected_pools dp ON dp.pool_address = p.pool_address
    LEFT JOIN token_analysis ta ON ta.token_mint = p.token_mint
    LEFT JOIN token_creators tc ON tc.token_mint = p.token_mint
    WHERE p.status IN ('closed', 'stopped')
    ORDER BY p.opened_at
  `;

  const rows = db.prepare(query).all();
  return rows.map(r => ({ ...r, _db: dbName }));
}

function extractTp1Snapshots(db) {
  return db.prepare(`SELECT * FROM tp1_snapshots`).all();
}

function extractPriceLogs(db) {
  return db.prepare(`
    SELECT position_id, price, multiplier, pnl_pct, sol_reserve, elapsed_ms, sell_count, buy_count
    FROM position_price_log
    ORDER BY position_id, elapsed_ms
  `).all();
}

// ============================================================================
// SECTION 2: Classify positions
// ============================================================================

function classify(p) {
  const rugReasons = ['rug_pull', 'liq_removal', 'sell_burst_detected', 'creator_sell_detected', 'emergency_rug'];
  if (rugReasons.includes(p.exit_reason)) return 'RUG';
  if (p.pnl_pct !== null && p.pnl_pct < -60) return 'WIPEOUT'; // severe loss even without rug exit
  if (p.pnl_sol > 0) return 'WINNER';
  if (p.exit_reason === 'tp_complete') return 'WINNER';
  return 'LOSER';
}

// ============================================================================
// MAIN
// ============================================================================

console.log('='.repeat(100));
console.log('EXHAUSTIVE RUG PULL ANALYSIS — BOTH DATABASES');
console.log('='.repeat(100));

// Extract from both
const mainPositions = extractPositions(mainDb, 'main');
const backupPositions = extractPositions(backupDb, 'backup');

// Deduplicate: main DB takes priority for overlapping IDs
const mainIds = new Set(mainPositions.map(p => p.id));
const uniqueBackup = backupPositions.filter(p => !mainIds.has(p.id));

const allPositions = [...mainPositions, ...uniqueBackup];
console.log(`\nTotal positions: ${allPositions.length} (main: ${mainPositions.length}, backup unique: ${uniqueBackup.length})`);

// Classify
allPositions.forEach(p => { p._category = classify(p); });

const rugs = allPositions.filter(p => p._category === 'RUG');
const winners = allPositions.filter(p => p._category === 'WINNER');
const losers = allPositions.filter(p => p._category === 'LOSER');
const wipeouts = allPositions.filter(p => p._category === 'WIPEOUT');

console.log(`\nCategories:`);
console.log(`  RUG:     ${rugs.length} trades, PnL: ${rugs.reduce((s,p) => s+p.pnl_sol,0).toFixed(4)} SOL`);
console.log(`  WIPEOUT: ${wipeouts.length} trades (pnl_pct < -60 but not rug exit)`);
console.log(`  WINNER:  ${winners.length} trades, PnL: ${winners.reduce((s,p) => s+p.pnl_sol,0).toFixed(4)} SOL`);
console.log(`  LOSER:   ${losers.length} trades, PnL: ${losers.reduce((s,p) => s+p.pnl_sol,0).toFixed(4)} SOL`);

// Combine rugs + wipeouts as "bad outcomes"
const bads = [...rugs, ...wipeouts];

// ============================================================================
// SECTION 3: DETAILED RUG TABLE
// ============================================================================

console.log('\n' + '='.repeat(100));
console.log('SECTION 1: ALL RUGS — DETAILED TABLE');
console.log('='.repeat(100));

console.log(`\n${'Mint'.padEnd(12)} ${'Ver'.padEnd(6)} ${'Exit Reason'.padEnd(28)} ${'PnL SOL'.padStart(10)} ${'PnL%'.padStart(8)} ${'Peak'.padStart(6)} ${'Score'.padStart(6)} ${'Holders'.padStart(8)} ${'Top%'.padStart(6)} ${'OBS Sol'.padStart(10)} ${'Duration'.padStart(10)} ${'Creator Age'.padStart(12)} ${'TxCnt'.padStart(6)} ${'FundSrc'.padStart(10)} ${'Rep'.padStart(4)}`);
console.log('-'.repeat(160));

bads.forEach(p => {
  const mint = (p.token_mint || '').slice(0, 10);
  const ver = p.bot_version || '?';
  const exit = (p.exit_reason || '?').slice(0, 26);
  const pnl = (p.pnl_sol || 0).toFixed(5);
  const pnlPct = (p.pnl_pct || 0).toFixed(1);
  const peak = (p.peak_multiplier || 0).toFixed(2);
  const score = p.dp_score || p.p_score || p.ta_score || '?';
  const holders = p.dp_holder_count || p.ta_holder_count || p.p_holder_count || '?';
  const topPct = p.dp_top_holder_pct || p.ta_top_holder_pct || '?';
  const obsSol = p.obs_initial_sol ? p.obs_initial_sol.toFixed(1) : '?';
  const duration = (p.closed_at && p.opened_at) ? ((p.closed_at - p.opened_at) / 1000).toFixed(0) + 's' : '?';
  const creatorAge = p.wallet_age_seconds !== null ? p.wallet_age_seconds + 's' : 'NULL';
  const txCnt = p.tc_tx_count !== null ? p.tc_tx_count : 'NULL';
  const fundSrc = p.funding_source ? p.funding_source.slice(0, 8) : 'NULL';
  const rep = p.reputation_score !== null ? p.reputation_score : 'NULL';

  console.log(`${mint.padEnd(12)} ${ver.padEnd(6)} ${exit.padEnd(28)} ${pnl.padStart(10)} ${pnlPct.padStart(8)} ${peak.padStart(6)} ${String(score).padStart(6)} ${String(holders).padStart(8)} ${String(topPct !== '?' ? Number(topPct).toFixed(1) : topPct).padStart(6)} ${obsSol.padStart(10)} ${duration.padStart(10)} ${creatorAge.padStart(12)} ${String(txCnt).padStart(6)} ${fundSrc.padStart(10)} ${String(rep).padStart(4)}`);
});

// ============================================================================
// SECTION 4: SCORE BREAKDOWN FOR RUGS vs WINNERS
// ============================================================================

console.log('\n' + '='.repeat(100));
console.log('SECTION 2: SCORE BREAKDOWN COMPONENTS — RUGS vs WINNERS');
console.log('='.repeat(100));

const breakdownFields = [
  'dp_holder_penalty', 'dp_graduation_bonus', 'dp_obs_bonus', 'dp_organic_bonus',
  'dp_smart_wallet_bonus', 'dp_creator_age_penalty', 'dp_rugcheck_penalty',
  'dp_velocity_penalty', 'dp_insider_penalty', 'dp_whale_penalty',
  'dp_timing_cv_penalty', 'dp_hhi_penalty', 'dp_concentrated_penalty',
  'dp_bundle_penalty', 'dp_wash_penalty'
];

function stats(arr) {
  if (arr.length === 0) return { n: 0, avg: NaN, median: NaN, min: NaN, max: NaN };
  const sorted = [...arr].sort((a, b) => a - b);
  return {
    n: arr.length,
    avg: arr.reduce((s, v) => s + v, 0) / arr.length,
    median: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0],
    max: sorted[sorted.length - 1]
  };
}

console.log(`\n${'Field'.padEnd(28)} ${'Rug N'.padStart(6)} ${'Rug Avg'.padStart(8)} ${'Win N'.padStart(6)} ${'Win Avg'.padStart(8)} ${'Diff'.padStart(8)} ${'Direction'.padStart(12)}`);
console.log('-'.repeat(82));

breakdownFields.forEach(field => {
  const rugVals = bads.map(p => p[field]).filter(v => v !== null && v !== undefined);
  const winVals = winners.map(p => p[field]).filter(v => v !== null && v !== undefined);

  const rugS = stats(rugVals);
  const winS = stats(winVals);
  const diff = rugS.avg - winS.avg;
  const direction = isNaN(diff) ? 'N/A' : (diff < -0.3 ? 'RUG lower' : diff > 0.3 ? 'RUG higher' : 'similar');

  console.log(`${field.padEnd(28)} ${String(rugS.n).padStart(6)} ${isNaN(rugS.avg) ? 'N/A'.padStart(8) : rugS.avg.toFixed(2).padStart(8)} ${String(winS.n).padStart(6)} ${isNaN(winS.avg) ? 'N/A'.padStart(8) : winS.avg.toFixed(2).padStart(8)} ${isNaN(diff) ? 'N/A'.padStart(8) : diff.toFixed(2).padStart(8)} ${direction.padStart(12)}`);
});

// ============================================================================
// SECTION 5: KEY FEATURE DISTRIBUTIONS — RUGS vs WINNERS
// ============================================================================

console.log('\n' + '='.repeat(100));
console.log('SECTION 3: KEY FEATURE DISTRIBUTIONS');
console.log('='.repeat(100));

const features = [
  { name: 'security_score', get: p => p.dp_score || p.p_score || p.ta_score },
  { name: 'holder_count', get: p => p.dp_holder_count || p.ta_holder_count || p.p_holder_count },
  { name: 'top_holder_pct', get: p => p.dp_top_holder_pct || p.ta_top_holder_pct },
  { name: 'obs_initial_sol', get: p => p.obs_initial_sol },
  { name: 'graduation_time_s', get: p => p.dp_graduation_time_s },
  { name: 'rugcheck_score', get: p => p.dp_rugcheck_score || p.ta_rugcheck_score },
  { name: 'creator_wallet_age_s', get: p => p.wallet_age_seconds },
  { name: 'creator_tx_count', get: p => p.tc_tx_count },
  { name: 'creator_sol_balance', get: p => p.sol_balance_lamports ? p.sol_balance_lamports / 1e9 : null },
  { name: 'creator_reputation', get: p => p.reputation_score },
  { name: 'entry_latency_ms', get: p => p.entry_latency_ms },
  { name: 'peak_multiplier', get: p => p.peak_multiplier },
  { name: 'sell_burst_count', get: p => p.sell_burst_count },
  { name: 'obs_drop_pct', get: p => p.dp_observation_drop_pct },
  { name: 'lp_burned', get: p => p.dp_lp_burned || p.ta_lp_burned },
  { name: 'honeypot_verified', get: p => p.dp_honeypot_verified || p.ta_honeypot_safe },
  { name: 'sol_invested', get: p => p.sol_invested },
];

features.forEach(f => {
  const rugVals = bads.map(p => f.get(p)).filter(v => v !== null && v !== undefined && !isNaN(v));
  const winVals = winners.map(p => f.get(p)).filter(v => v !== null && v !== undefined && !isNaN(v));
  const loseVals = losers.map(p => f.get(p)).filter(v => v !== null && v !== undefined && !isNaN(v));

  const rugS = stats(rugVals);
  const winS = stats(winVals);
  const loseS = stats(loseVals);

  console.log(`\n--- ${f.name} ---`);
  console.log(`  RUG    (N=${rugS.n}): avg=${rugS.avg?.toFixed(2)} median=${rugS.median?.toFixed(2)} min=${rugS.min?.toFixed(2)} max=${rugS.max?.toFixed(2)}`);
  console.log(`  WINNER (N=${winS.n}): avg=${winS.avg?.toFixed(2)} median=${winS.median?.toFixed(2)} min=${winS.min?.toFixed(2)} max=${winS.max?.toFixed(2)}`);
  console.log(`  LOSER  (N=${loseS.n}): avg=${loseS.avg?.toFixed(2)} median=${loseS.median?.toFixed(2)} min=${loseS.min?.toFixed(2)} max=${loseS.max?.toFixed(2)}`);

  // Non-null rate
  const rugTotal = bads.length;
  const winTotal = winners.length;
  console.log(`  Fill rate: RUG=${rugS.n}/${rugTotal} (${(100*rugS.n/rugTotal).toFixed(0)}%), WIN=${winS.n}/${winTotal} (${(100*winS.n/winTotal).toFixed(0)}%)`);
});

// ============================================================================
// SECTION 6: FILTER ANALYSIS — INDIVIDUAL FEATURES
// ============================================================================

console.log('\n' + '='.repeat(100));
console.log('SECTION 4: INDIVIDUAL FILTER ANALYSIS');
console.log('='.repeat(100));
console.log('For each threshold: how many RUGS blocked, how many WINNERS blocked (false positives)');

// Test various thresholds
const filters = [
  // Score thresholds
  { name: 'score < 65', test: p => { const s = p.dp_score || p.p_score || p.ta_score; return s !== null && s < 65; }},
  { name: 'score < 68', test: p => { const s = p.dp_score || p.p_score || p.ta_score; return s !== null && s < 68; }},
  { name: 'score < 70', test: p => { const s = p.dp_score || p.p_score || p.ta_score; return s !== null && s < 70; }},
  { name: 'score < 72', test: p => { const s = p.dp_score || p.p_score || p.ta_score; return s !== null && s < 72; }},
  { name: 'score < 75', test: p => { const s = p.dp_score || p.p_score || p.ta_score; return s !== null && s < 75; }},

  // Holder count
  { name: 'holders < 5', test: p => { const h = p.dp_holder_count || p.ta_holder_count; return h !== null && h < 5; }},
  { name: 'holders < 8', test: p => { const h = p.dp_holder_count || p.ta_holder_count; return h !== null && h < 8; }},
  { name: 'holders < 10', test: p => { const h = p.dp_holder_count || p.ta_holder_count; return h !== null && h < 10; }},
  { name: 'holders < 15', test: p => { const h = p.dp_holder_count || p.ta_holder_count; return h !== null && h < 15; }},
  { name: 'holders < 20', test: p => { const h = p.dp_holder_count || p.ta_holder_count; return h !== null && h < 20; }},

  // Top holder
  { name: 'top_holder > 30%', test: p => { const t = p.dp_top_holder_pct || p.ta_top_holder_pct; return t !== null && t > 30; }},
  { name: 'top_holder > 40%', test: p => { const t = p.dp_top_holder_pct || p.ta_top_holder_pct; return t !== null && t > 40; }},
  { name: 'top_holder > 50%', test: p => { const t = p.dp_top_holder_pct || p.ta_top_holder_pct; return t !== null && t > 50; }},
  { name: 'top_holder > 60%', test: p => { const t = p.dp_top_holder_pct || p.ta_top_holder_pct; return t !== null && t > 60; }},

  // Observation SOL (pool size)
  { name: 'obs_sol > 100', test: p => p.obs_initial_sol !== null && p.obs_initial_sol > 100 },
  { name: 'obs_sol > 150', test: p => p.obs_initial_sol !== null && p.obs_initial_sol > 150 },
  { name: 'obs_sol > 185', test: p => p.obs_initial_sol !== null && p.obs_initial_sol > 185 },
  { name: 'obs_sol > 200', test: p => p.obs_initial_sol !== null && p.obs_initial_sol > 200 },
  { name: 'obs_sol < 50', test: p => p.obs_initial_sol !== null && p.obs_initial_sol < 50 },

  // Creator features
  { name: 'wallet_age < 60s', test: p => p.wallet_age_seconds !== null && p.wallet_age_seconds < 60 },
  { name: 'wallet_age < 120s', test: p => p.wallet_age_seconds !== null && p.wallet_age_seconds < 120 },
  { name: 'wallet_age < 300s', test: p => p.wallet_age_seconds !== null && p.wallet_age_seconds < 300 },
  { name: 'wallet_age < 600s', test: p => p.wallet_age_seconds !== null && p.wallet_age_seconds < 600 },
  { name: 'tx_count >= 50', test: p => p.tc_tx_count !== null && p.tc_tx_count >= 50 },
  { name: 'tx_count >= 30', test: p => p.tc_tx_count !== null && p.tc_tx_count >= 30 },
  { name: 'tx_count < 5', test: p => p.tc_tx_count !== null && p.tc_tx_count < 5 },
  { name: 'reputation < 0', test: p => p.reputation_score !== null && p.reputation_score < 0 },
  { name: 'reputation < -5', test: p => p.reputation_score !== null && p.reputation_score < -5 },
  { name: 'funding_source NULL', test: p => p.funding_source === null },
  { name: 'funding_source NOT NULL', test: p => p.funding_source !== null },
  { name: 'sol_balance < 1 SOL', test: p => p.sol_balance_lamports !== null && p.sol_balance_lamports < 1e9 },
  { name: 'sol_balance < 5 SOL', test: p => p.sol_balance_lamports !== null && p.sol_balance_lamports < 5e9 },

  // Observation
  { name: 'obs_drop > 5%', test: p => p.dp_observation_drop_pct !== null && p.dp_observation_drop_pct > 5 },
  { name: 'obs_drop > 10%', test: p => p.dp_observation_drop_pct !== null && p.dp_observation_drop_pct > 10 },
  { name: 'obs_stable = 0', test: p => p.dp_observation_stable !== null && p.dp_observation_stable === 0 },

  // Organic bonus
  { name: 'organic_bonus = 0', test: p => p.dp_organic_bonus !== null && p.dp_organic_bonus === 0 },

  // Graduation
  { name: 'graduation_time < 10s', test: p => p.dp_graduation_time_s !== null && p.dp_graduation_time_s < 10 },
  { name: 'graduation_time < 30s', test: p => p.dp_graduation_time_s !== null && p.dp_graduation_time_s < 30 },

  // RugCheck
  { name: 'rugcheck_score < 500', test: p => { const r = p.dp_rugcheck_score || p.ta_rugcheck_score; return r !== null && r < 500; }},
  { name: 'rugcheck_penalty != 0', test: p => p.dp_rugcheck_penalty !== null && p.dp_rugcheck_penalty !== 0 },

  // LP burned
  { name: 'lp_burned = 0', test: p => { const lp = p.dp_lp_burned !== null ? p.dp_lp_burned : p.ta_lp_burned; return lp !== null && lp === 0; }},

  // Holder penalty from scoring
  { name: 'holder_penalty <= -5', test: p => p.dp_holder_penalty !== null && p.dp_holder_penalty <= -5 },
  { name: 'holder_penalty <= -8', test: p => p.dp_holder_penalty !== null && p.dp_holder_penalty <= -8 },
  { name: 'holder_penalty = 0', test: p => p.dp_holder_penalty !== null && p.dp_holder_penalty === 0 },

  // Bundle
  { name: 'bundle_penalty != 0', test: p => p.dp_bundle_penalty !== null && p.dp_bundle_penalty !== 0 },

  // Funder fan-out
  { name: 'funder_fanout != null', test: p => p.dp_funder_fan_out !== null && p.dp_funder_fan_out !== '' },

  // Entry latency
  { name: 'entry_latency > 10000ms', test: p => p.entry_latency_ms !== null && p.entry_latency_ms > 10000 },
  { name: 'entry_latency > 15000ms', test: p => p.entry_latency_ms !== null && p.entry_latency_ms > 15000 },
  { name: 'entry_latency > 20000ms', test: p => p.entry_latency_ms !== null && p.entry_latency_ms > 20000 },
];

console.log(`\n${'Filter'.padEnd(30)} ${'Rug Hit'.padStart(8)} ${'Rug%'.padStart(6)} ${'Win Hit'.padStart(8)} ${'Win%'.padStart(6)} ${'Lose Hit'.padStart(9)} ${'Precision'.padStart(10)} ${'Net PnL'.padStart(10)} ${'Rating'.padStart(8)}`);
console.log('-'.repeat(100));

const filterResults = [];

filters.forEach(f => {
  const rugHit = bads.filter(p => f.test(p)).length;
  const winHit = winners.filter(p => f.test(p)).length;
  const loseHit = losers.filter(p => f.test(p)).length;

  const rugPct = (100 * rugHit / bads.length).toFixed(0);
  const winPct = (100 * winHit / winners.length).toFixed(0);
  const precision = rugHit + winHit + loseHit > 0 ? (100 * rugHit / (rugHit + winHit + loseHit)).toFixed(0) : 'N/A';

  // Net PnL impact: sum PnL of blocked rugs (saved) - sum PnL of blocked winners (lost)
  const savedPnl = -bads.filter(p => f.test(p)).reduce((s, p) => s + (p.pnl_sol || 0), 0); // negative PnL saved = positive
  const lostPnl = winners.filter(p => f.test(p)).reduce((s, p) => s + (p.pnl_sol || 0), 0); // positive PnL lost
  const netPnl = savedPnl - lostPnl;

  // Rating: high precision + many rugs caught + few winners lost = good
  const rating = rugHit > 0 && winHit === 0 ? 'PERFECT' :
                 rugHit > 0 && winHit <= 2 ? 'GOOD' :
                 rugHit > 3 && winHit <= rugHit * 0.5 ? 'OK' : 'POOR';

  filterResults.push({ name: f.name, rugHit, winHit, loseHit, rugPct, winPct, precision, netPnl, rating, test: f.test });

  console.log(`${f.name.padEnd(30)} ${String(rugHit).padStart(8)} ${(rugPct + '%').padStart(6)} ${String(winHit).padStart(8)} ${(winPct + '%').padStart(6)} ${String(loseHit).padStart(9)} ${(precision + '%').padStart(10)} ${netPnl.toFixed(4).padStart(10)} ${rating.padStart(8)}`);
});

// ============================================================================
// SECTION 7: COMBINATION FILTERS
// ============================================================================

console.log('\n' + '='.repeat(100));
console.log('SECTION 5: COMBINATION FILTERS (OR logic — block if ANY condition true)');
console.log('='.repeat(100));

// Top individual filters sorted by rating
const goodFilters = filterResults.filter(f => f.rating === 'PERFECT' || f.rating === 'GOOD').sort((a, b) => b.rugHit - a.rugHit);

console.log('\nTop individual filters:');
goodFilters.forEach(f => {
  console.log(`  ${f.name}: ${f.rugHit}/${bads.length} rugs, ${f.winHit}/${winners.length} winners, net PnL: ${f.netPnl.toFixed(4)}`);
});

// Test combinations of top filters
const comboTests = [
  // Combo 1: obs_sol > 185 OR tx_count >= 50
  { name: 'obs_sol>185 OR tx>=50', tests: [
    p => p.obs_initial_sol !== null && p.obs_initial_sol > 185,
    p => p.tc_tx_count !== null && p.tc_tx_count >= 50
  ]},
  // Combo 2: holders < 5 OR top_holder > 60%
  { name: 'holders<5 OR top>60%', tests: [
    p => { const h = p.dp_holder_count || p.ta_holder_count; return h !== null && h < 5; },
    p => { const t = p.dp_top_holder_pct || p.ta_top_holder_pct; return t !== null && t > 60; }
  ]},
  // Combo 3: obs_sol>185 OR tx>=50 OR organic=0
  { name: 'obs>185 OR tx>=50 OR org=0', tests: [
    p => p.obs_initial_sol !== null && p.obs_initial_sol > 185,
    p => p.tc_tx_count !== null && p.tc_tx_count >= 50,
    p => p.dp_organic_bonus !== null && p.dp_organic_bonus === 0
  ]},
  // Combo 4: obs_sol>200 OR holders<5
  { name: 'obs>200 OR holders<5', tests: [
    p => p.obs_initial_sol !== null && p.obs_initial_sol > 200,
    p => { const h = p.dp_holder_count || p.ta_holder_count; return h !== null && h < 5; }
  ]},
  // Combo 5: wallet_age<120 OR obs>185
  { name: 'age<120s OR obs>185', tests: [
    p => p.wallet_age_seconds !== null && p.wallet_age_seconds < 120,
    p => p.obs_initial_sol !== null && p.obs_initial_sol > 185
  ]},
  // Combo 6: Score<68 OR holders<8
  { name: 'score<68 OR holders<8', tests: [
    p => { const s = p.dp_score || p.p_score || p.ta_score; return s !== null && s < 68; },
    p => { const h = p.dp_holder_count || p.ta_holder_count; return h !== null && h < 8; }
  ]},
  // Combo 7: obs>185 OR tx>=50 OR holders<5 OR top>60%
  { name: 'obs>185|tx>=50|hold<5|top>60', tests: [
    p => p.obs_initial_sol !== null && p.obs_initial_sol > 185,
    p => p.tc_tx_count !== null && p.tc_tx_count >= 50,
    p => { const h = p.dp_holder_count || p.ta_holder_count; return h !== null && h < 5; },
    p => { const t = p.dp_top_holder_pct || p.ta_top_holder_pct; return t !== null && t > 60; }
  ]},
  // Combo 8: sol_balance<5 AND wallet_age<120
  { name: 'sol<5 AND age<120s', tests: [
    p => (p.sol_balance_lamports !== null && p.sol_balance_lamports < 5e9) && (p.wallet_age_seconds !== null && p.wallet_age_seconds < 120)
  ]},
  // Combo 9: obs>185 OR (tx>=50 AND funding=NULL)
  { name: 'obs>185 OR (tx>=50&fund=NULL)', tests: [
    p => p.obs_initial_sol !== null && p.obs_initial_sol > 185,
    p => (p.tc_tx_count !== null && p.tc_tx_count >= 50) && p.funding_source === null
  ]},
  // Combo 10: obs>185 OR holder_penalty=0
  { name: 'obs>185 OR hold_pen=0', tests: [
    p => p.obs_initial_sol !== null && p.obs_initial_sol > 185,
    p => p.dp_holder_penalty !== null && p.dp_holder_penalty === 0
  ]},
  // Combo 11: holders<10 OR obs>185
  { name: 'holders<10 OR obs>185', tests: [
    p => { const h = p.dp_holder_count || p.ta_holder_count; return h !== null && h < 10; },
    p => p.obs_initial_sol !== null && p.obs_initial_sol > 185
  ]},
  // Combo 12: obs>150 OR holders<8
  { name: 'obs>150 OR holders<8', tests: [
    p => p.obs_initial_sol !== null && p.obs_initial_sol > 150,
    p => { const h = p.dp_holder_count || p.ta_holder_count; return h !== null && h < 8; }
  ]},
  // Combo 13: score<70 OR obs>185 OR holders<5
  { name: 'score<70|obs>185|hold<5', tests: [
    p => { const s = p.dp_score || p.p_score || p.ta_score; return s !== null && s < 70; },
    p => p.obs_initial_sol !== null && p.obs_initial_sol > 185,
    p => { const h = p.dp_holder_count || p.ta_holder_count; return h !== null && h < 5; }
  ]},
  // Combo 14: funding_source=NULL AND tx>=30
  { name: 'fund=NULL AND tx>=30', tests: [
    p => p.funding_source === null && (p.tc_tx_count !== null && p.tc_tx_count >= 30)
  ]},
  // Combo 15: obs_drop>5% OR holders<5
  { name: 'obs_drop>5% OR holders<5', tests: [
    p => p.dp_observation_drop_pct !== null && p.dp_observation_drop_pct > 5,
    p => { const h = p.dp_holder_count || p.ta_holder_count; return h !== null && h < 5; }
  ]},
  // Combo 16: obs>100 AND holders<15
  { name: 'obs>100 AND holders<15', tests: [
    p => (p.obs_initial_sol !== null && p.obs_initial_sol > 100) && (() => { const h = p.dp_holder_count || p.ta_holder_count; return h !== null && h < 15; })()
  ]},
  // Combo 17: reputation<0 OR obs>185
  { name: 'rep<0 OR obs>185', tests: [
    p => p.reputation_score !== null && p.reputation_score < 0,
    p => p.obs_initial_sol !== null && p.obs_initial_sol > 185
  ]},
];

console.log(`\n${'Combo'.padEnd(35)} ${'Rug Hit'.padStart(8)} ${'Rug%'.padStart(6)} ${'Win Hit'.padStart(8)} ${'Win%'.padStart(6)} ${'Precision'.padStart(10)} ${'Net PnL'.padStart(10)} ${'Rating'.padStart(8)}`);
console.log('-'.repeat(95));

comboTests.forEach(combo => {
  const hit = p => combo.tests.some(t => t(p));

  const rugHit = bads.filter(hit).length;
  const winHit = winners.filter(hit).length;
  const loseHit = losers.filter(hit).length;

  const rugPct = (100 * rugHit / bads.length).toFixed(0);
  const winPct = (100 * winHit / winners.length).toFixed(0);
  const precision = rugHit + winHit + loseHit > 0 ? (100 * rugHit / (rugHit + winHit + loseHit)).toFixed(0) : 'N/A';

  const savedPnl = -bads.filter(hit).reduce((s, p) => s + (p.pnl_sol || 0), 0);
  const lostPnl = winners.filter(hit).reduce((s, p) => s + (p.pnl_sol || 0), 0);
  const netPnl = savedPnl - lostPnl;

  const rating = rugHit > 0 && winHit === 0 ? 'PERFECT' :
                 rugHit > 0 && winHit <= 2 ? 'GOOD' :
                 rugHit > bads.length * 0.5 && winHit <= winners.length * 0.1 ? 'OK' : 'MIXED';

  console.log(`${combo.name.padEnd(35)} ${String(rugHit).padStart(8)} ${(rugPct + '%').padStart(6)} ${String(winHit).padStart(8)} ${(winPct + '%').padStart(6)} ${(precision + '%').padStart(10)} ${netPnl.toFixed(4).padStart(10)} ${rating.padStart(8)}`);
});

// ============================================================================
// SECTION 8: POST-BUY SIGNALS
// ============================================================================

console.log('\n' + '='.repeat(100));
console.log('SECTION 6: POST-BUY SIGNALS — TIME TO RUG & EARLY WARNING');
console.log('='.repeat(100));

// Time to rug (from buy to sell)
console.log('\n--- Time between buy and rug exit ---');
bads.forEach(p => {
  if (p.opened_at && p.closed_at) {
    const duration_s = (p.closed_at - p.opened_at) / 1000;
    const mint = (p.token_mint || '').slice(0, 10);
    const peak = (p.peak_multiplier || 0).toFixed(3);
    console.log(`  ${mint} (${p.bot_version}): ${duration_s.toFixed(0)}s, peak ${peak}x, exit: ${p.exit_reason}, PnL: ${(p.pnl_sol||0).toFixed(5)}`);
  }
});

// Duration buckets
const rugDurations = bads
  .filter(p => p.opened_at && p.closed_at)
  .map(p => ({ ...p, duration_s: (p.closed_at - p.opened_at) / 1000 }));

const buckets = [
  { name: '< 15s', min: 0, max: 15 },
  { name: '15-30s', min: 15, max: 30 },
  { name: '30-60s', min: 30, max: 60 },
  { name: '1-2min', min: 60, max: 120 },
  { name: '2-5min', min: 120, max: 300 },
  { name: '5-10min', min: 300, max: 600 },
  { name: '10min+', min: 600, max: Infinity },
];

console.log('\n--- Rug duration distribution ---');
console.log(`${'Bucket'.padEnd(12)} ${'Count'.padStart(6)} ${'Pct'.padStart(6)} ${'Avg PnL'.padStart(10)} ${'Avg Peak'.padStart(10)}`);
buckets.forEach(b => {
  const inBucket = rugDurations.filter(p => p.duration_s >= b.min && p.duration_s < b.max);
  const pct = (100 * inBucket.length / rugDurations.length).toFixed(0);
  const avgPnl = inBucket.length > 0 ? (inBucket.reduce((s,p) => s + p.pnl_sol, 0) / inBucket.length).toFixed(5) : 'N/A';
  const avgPeak = inBucket.length > 0 ? (inBucket.reduce((s,p) => s + (p.peak_multiplier||0), 0) / inBucket.length).toFixed(3) : 'N/A';
  console.log(`${b.name.padEnd(12)} ${String(inBucket.length).padStart(6)} ${(pct+'%').padStart(6)} ${avgPnl.padStart(10)} ${avgPeak.padStart(10)}`);
});

// Peak multiplier before rug
console.log('\n--- Peak multiplier before rug (did it reach TP1?) ---');
const tp1Threshold = 1.08;
const rugReachTP1 = bads.filter(p => p.peak_multiplier && p.peak_multiplier >= tp1Threshold).length;
console.log(`  Rugs reaching ${tp1Threshold}x: ${rugReachTP1}/${bads.length} (${(100*rugReachTP1/bads.length).toFixed(0)}%)`);
console.log(`  Peak distribution:`);
const peakBuckets = [
  { name: '< 1.0x (instant)', max: 1.0 },
  { name: '1.0-1.05x', max: 1.05 },
  { name: '1.05-1.08x', max: 1.08 },
  { name: '1.08-1.15x', max: 1.15 },
  { name: '1.15-1.3x', max: 1.3 },
  { name: '1.3-2.0x', max: 2.0 },
  { name: '2.0x+', max: Infinity },
];
let prevMax = 0;
peakBuckets.forEach(b => {
  const inBucket = bads.filter(p => p.peak_multiplier && p.peak_multiplier >= prevMax && p.peak_multiplier < b.max);
  console.log(`    ${b.name.padEnd(20)}: ${inBucket.length} (${(100*inBucket.length/bads.length).toFixed(0)}%)`);
  prevMax = b.max;
});

// ============================================================================
// SECTION 9: TP1 SNAPSHOTS ANALYSIS
// ============================================================================

console.log('\n' + '='.repeat(100));
console.log('SECTION 7: TP1 SNAPSHOTS — RUGS THAT HIT TP1');
console.log('='.repeat(100));

const tp1Data = extractTp1Snapshots(mainDb);
console.log(`\nTotal tp1_snapshots: ${tp1Data.length}`);

tp1Data.forEach(snap => {
  const pos = allPositions.find(p => p.id === snap.position_id || p.token_mint === snap.token_mint);
  const cat = pos ? pos._category : '?';
  console.log(`  ${snap.token_mint.slice(0,10)} [${cat}]: time_to_tp1=${snap.time_to_tp1_ms}ms, reserve_change=${snap.reserve_change_pct?.toFixed(1)}%, buy_30s=${snap.buy_count_30s}, sell_15s=${snap.sell_count_15s}, ratio=${snap.buy_sell_ratio?.toFixed(2)}, decision=${snap.smart_tp_decision}, peak_after=${snap.post_tp1_peak?.toFixed(3)}, exit_after=${snap.post_tp1_exit_reason}`);
});

// ============================================================================
// SECTION 10: PRICE LOG ANALYSIS FOR RUGS
// ============================================================================

console.log('\n' + '='.repeat(100));
console.log('SECTION 8: PRICE LOG — RESERVE TRAJECTORY FOR RUGS');
console.log('='.repeat(100));

const priceLogs = extractPriceLogs(mainDb);
const priceLogMap = {};
priceLogs.forEach(log => {
  if (!priceLogMap[log.position_id]) priceLogMap[log.position_id] = [];
  priceLogMap[log.position_id].push(log);
});

bads.filter(p => p._db === 'main').forEach(p => {
  const logs = priceLogMap[p.id] || [];
  if (logs.length === 0) {
    console.log(`\n  ${p.token_mint.slice(0,10)} (${p.bot_version}): NO price logs`);
    return;
  }

  console.log(`\n  ${p.token_mint.slice(0,10)} (${p.bot_version}): ${logs.length} ticks, exit: ${p.exit_reason}`);
  logs.forEach((log, i) => {
    const reserve = log.sol_reserve ? (log.sol_reserve / 1e9).toFixed(2) : '?';
    const reserveChg = (i > 0 && logs[i-1].sol_reserve && log.sol_reserve)
      ? ((log.sol_reserve - logs[i-1].sol_reserve) / logs[i-1].sol_reserve * 100).toFixed(1) + '%'
      : '-';
    console.log(`    t=${(log.elapsed_ms/1000).toFixed(1)}s mul=${log.multiplier.toFixed(4)} res=${reserve} SOL (${reserveChg}) sells=${log.sell_count} buys=${log.buy_count}`);
  });
});

// ============================================================================
// SECTION 11: CLUSTER ANALYSIS — SAME CREATOR / FUNDER
// ============================================================================

console.log('\n' + '='.repeat(100));
console.log('SECTION 9: RUG CLUSTERS — SHARED CREATORS & FUNDERS');
console.log('='.repeat(100));

// Creator clusters
const creatorMap = {};
bads.forEach(p => {
  if (p.creator_wallet) {
    if (!creatorMap[p.creator_wallet]) creatorMap[p.creator_wallet] = [];
    creatorMap[p.creator_wallet].push(p);
  }
});

console.log('\n--- Repeat rug creators ---');
Object.entries(creatorMap).filter(([_, arr]) => arr.length > 1).forEach(([creator, positions]) => {
  console.log(`  Creator ${creator.slice(0,10)}: ${positions.length} rugs`);
  positions.forEach(p => console.log(`    ${p.token_mint.slice(0,10)} (${p.bot_version}) PnL: ${(p.pnl_sol||0).toFixed(5)}`));
});

// Funder clusters
const funderMap = {};
bads.forEach(p => {
  if (p.funding_source) {
    if (!funderMap[p.funding_source]) funderMap[p.funding_source] = [];
    funderMap[p.funding_source].push(p);
  }
});

console.log('\n--- Shared funders across rugs ---');
Object.entries(funderMap).filter(([_, arr]) => arr.length > 1).forEach(([funder, positions]) => {
  console.log(`  Funder ${funder.slice(0,10)}: ${positions.length} rugs`);
  positions.forEach(p => console.log(`    ${p.token_mint.slice(0,10)} creator=${p.creator_wallet?.slice(0,10)} (${p.bot_version})`));
});

// Check if any rug funder also funded a winner
const rugFunders = new Set(bads.filter(p => p.funding_source).map(p => p.funding_source));
const winFunders = new Set(winners.filter(p => p.funding_source).map(p => p.funding_source));
const sharedFunders = [...rugFunders].filter(f => winFunders.has(f));
console.log(`\n--- Funders shared between rugs and winners ---`);
console.log(`  Rug funders: ${rugFunders.size}, Winner funders: ${winFunders.size}, Shared: ${sharedFunders.length}`);
if (sharedFunders.length > 0) {
  sharedFunders.forEach(f => console.log(`    ${f}`));
}

// Creator wallets: are any rug creators also winner creators?
const rugCreators = new Set(bads.filter(p => p.creator_wallet).map(p => p.creator_wallet));
const winCreators = new Set(winners.filter(p => p.creator_wallet).map(p => p.creator_wallet));
const sharedCreators = [...rugCreators].filter(c => winCreators.has(c));
console.log(`\n--- Creators shared between rugs and winners ---`);
console.log(`  Rug creators: ${rugCreators.size}, Winner creators: ${winCreators.size}, Shared: ${sharedCreators.length}`);

// ============================================================================
// SECTION 12: VERSION COMPARISON
// ============================================================================

console.log('\n' + '='.repeat(100));
console.log('SECTION 10: RUG RATE BY VERSION');
console.log('='.repeat(100));

const versions = {};
allPositions.forEach(p => {
  const v = p.bot_version || '?';
  if (!versions[v]) versions[v] = { total: 0, rugs: 0, winners: 0, losers: 0, pnl: 0 };
  versions[v].total++;
  versions[v].pnl += p.pnl_sol || 0;
  if (p._category === 'RUG' || p._category === 'WIPEOUT') versions[v].rugs++;
  else if (p._category === 'WINNER') versions[v].winners++;
  else versions[v].losers++;
});

console.log(`\n${'Version'.padEnd(8)} ${'Total'.padStart(6)} ${'Rugs'.padStart(6)} ${'Rug%'.padStart(6)} ${'Wins'.padStart(6)} ${'Win%'.padStart(6)} ${'PnL'.padStart(10)}`);
console.log('-'.repeat(52));
Object.entries(versions).sort().forEach(([v, d]) => {
  console.log(`${v.padEnd(8)} ${String(d.total).padStart(6)} ${String(d.rugs).padStart(6)} ${(100*d.rugs/d.total).toFixed(0).padStart(5)}% ${String(d.winners).padStart(6)} ${(100*d.winners/d.total).toFixed(0).padStart(5)}% ${d.pnl.toFixed(4).padStart(10)}`);
});

// ============================================================================
// SECTION 13: SHADOW POSITIONS — REJECTED POOLS THAT WERE RUGS
// ============================================================================

console.log('\n' + '='.repeat(100));
console.log('SECTION 11: SHADOW DATA — POOLS WE CORRECTLY REJECTED (TRUE NEGATIVES)');
console.log('='.repeat(100));

const shadowRugs = mainDb.prepare(`
  SELECT sp.token_mint, sp.security_score, sp.peak_multiplier, sp.exit_reason,
         sp.rug_detected, sp.rug_reserve_drop_pct, sp.bot_version,
         sp.opened_at, sp.closed_at
  FROM shadow_positions sp
  WHERE sp.rug_detected = 1 OR sp.exit_reason LIKE '%rug%'
  LIMIT 50
`).all();

console.log(`\nShadow positions that turned out to be rugs (correctly rejected): ${shadowRugs.length}`);
shadowRugs.slice(0, 20).forEach(s => {
  const duration = s.closed_at && s.opened_at ? ((s.closed_at - s.opened_at) / 1000).toFixed(0) + 's' : '?';
  console.log(`  ${s.token_mint.slice(0,10)} score=${s.security_score} peak=${(s.peak_multiplier||0).toFixed(2)}x rug_drop=${(s.rug_reserve_drop_pct||0).toFixed(0)}% dur=${duration} (${s.bot_version})`);
});

// Also check: shadow positions with score >= current threshold that were NOT rugs (missed opportunities)
const shadowWinners = mainDb.prepare(`
  SELECT sp.token_mint, sp.security_score, sp.peak_multiplier, sp.final_multiplier,
         sp.tp1_hit, sp.tp2_hit, sp.tp3_hit, sp.rug_detected, sp.bot_version,
         dp.rejection_reasons, dp.dp_rejection_stage
  FROM shadow_positions sp
  LEFT JOIN detected_pools dp ON dp.pool_address = sp.pool_address
  WHERE sp.peak_multiplier > 1.2 AND sp.rug_detected = 0
  ORDER BY sp.peak_multiplier DESC
  LIMIT 30
`).all();

console.log(`\nShadow positions with peak > 1.2x that were NOT rugs (missed winners): ${shadowWinners.length}`);
shadowWinners.slice(0, 15).forEach(s => {
  console.log(`  ${s.token_mint.slice(0,10)} score=${s.security_score} peak=${(s.peak_multiplier||0).toFixed(2)}x final=${(s.final_multiplier||0).toFixed(2)}x tp1=${s.tp1_hit} tp2=${s.tp2_hit} reject=${s.dp_rejection_stage} reasons=${(s.rejection_reasons||'').slice(0,60)}`);
});

// ============================================================================
// SECTION 14: IRREDUCIBLE RUGS (can't be filtered)
// ============================================================================

console.log('\n' + '='.repeat(100));
console.log('SECTION 12: IRREDUCIBLE RUGS — Features identical to winners');
console.log('='.repeat(100));

// For each rug, find if ANY of the good filters would have caught it
const bestFilters = filterResults.filter(f => f.rating === 'PERFECT' || f.rating === 'GOOD');

bads.forEach(p => {
  const caughtBy = bestFilters.filter(f => f.test(p)).map(f => f.name);
  const status = caughtBy.length > 0 ? 'CATCHABLE' : 'IRREDUCIBLE';
  const mint = (p.token_mint || '').slice(0, 10);
  const score = p.dp_score || p.p_score || p.ta_score || '?';
  const holders = p.dp_holder_count || p.ta_holder_count || '?';
  const pnl = (p.pnl_sol || 0).toFixed(5);

  if (status === 'IRREDUCIBLE') {
    console.log(`\n  IRREDUCIBLE: ${mint} (${p.bot_version}) score=${score} holders=${holders} PnL=${pnl} exit=${p.exit_reason}`);
    console.log(`    obs_sol=${p.obs_initial_sol?.toFixed(1)} top%=${p.dp_top_holder_pct || p.ta_top_holder_pct} age=${p.wallet_age_seconds}s tx=${p.tc_tx_count} fund=${p.funding_source?.slice(0,10)||'NULL'} rep=${p.reputation_score}`);
    console.log(`    peak=${(p.peak_multiplier||0).toFixed(3)}x duration=${p.closed_at && p.opened_at ? ((p.closed_at-p.opened_at)/1000).toFixed(0)+'s' : '?'}`);
  }
});

const irreducible = bads.filter(p => !bestFilters.some(f => f.test(p)));
const catchable = bads.filter(p => bestFilters.some(f => f.test(p)));
console.log(`\nSummary: ${catchable.length}/${bads.length} rugs catchable by good/perfect filters, ${irreducible.length} irreducible`);

// ============================================================================
// SECTION 15: BEST OVERALL FILTER SET
// ============================================================================

console.log('\n' + '='.repeat(100));
console.log('SECTION 13: OPTIMAL FILTER RECOMMENDATION');
console.log('='.repeat(100));

// Brute force: try all pairs and triples of top filters
const topFilters = filterResults
  .filter(f => f.rugHit >= 2 && f.netPnl > 0)
  .sort((a, b) => b.netPnl - a.netPnl)
  .slice(0, 15);

console.log('\nTop 15 filters by net PnL:');
topFilters.forEach(f => {
  console.log(`  ${f.name.padEnd(30)} rugs=${f.rugHit}/${bads.length} wins=${f.winHit}/${winners.length} net=${f.netPnl.toFixed(4)}`);
});

// Test all pairs
console.log('\nBest pairs (OR logic):');
const pairs = [];
for (let i = 0; i < topFilters.length; i++) {
  for (let j = i + 1; j < topFilters.length; j++) {
    const a = topFilters[i], b = topFilters[j];
    const hit = p => a.test(p) || b.test(p);
    const rugHit = bads.filter(hit).length;
    const winHit = winners.filter(hit).length;
    const savedPnl = -bads.filter(hit).reduce((s, p) => s + (p.pnl_sol || 0), 0);
    const lostPnl = winners.filter(hit).reduce((s, p) => s + (p.pnl_sol || 0), 0);
    const netPnl = savedPnl - lostPnl;
    pairs.push({ name: `${a.name} OR ${b.name}`, rugHit, winHit, netPnl });
  }
}

pairs.sort((a, b) => {
  // Sort by: max rugs with min winners, then by net PnL
  const aScore = a.rugHit * 10 - a.winHit * 5 + a.netPnl * 100;
  const bScore = b.rugHit * 10 - b.winHit * 5 + b.netPnl * 100;
  return bScore - aScore;
});

pairs.slice(0, 10).forEach(p => {
  const rugPct = (100 * p.rugHit / bads.length).toFixed(0);
  const winPct = (100 * p.winHit / winners.length).toFixed(0);
  console.log(`  ${p.name.padEnd(55)} rugs=${p.rugHit} (${rugPct}%) wins=${p.winHit} (${winPct}%) net=${p.netPnl.toFixed(4)}`);
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log('\n' + '='.repeat(100));
console.log('FINAL SUMMARY');
console.log('='.repeat(100));

console.log(`\nDataset: ${allPositions.length} total positions (${rugs.length} rugs, ${wipeouts.length} wipeouts, ${winners.length} winners, ${losers.length} losers)`);
console.log(`Total PnL: ${allPositions.reduce((s,p) => s + (p.pnl_sol||0), 0).toFixed(4)} SOL`);
console.log(`Rug PnL: ${bads.reduce((s,p) => s + (p.pnl_sol||0), 0).toFixed(4)} SOL`);
console.log(`Winner PnL: ${winners.reduce((s,p) => s + (p.pnl_sol||0), 0).toFixed(4)} SOL`);
console.log(`Catchable rugs (by good/perfect filters): ${catchable.length}/${bads.length}`);
console.log(`Irreducible rugs: ${irreducible.length}/${bads.length}`);

mainDb.close();
backupDb.close();
