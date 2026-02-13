/**
 * Export training data with HIGH-QUALITY labels from shadow_positions.
 *
 * Instead of using pool_outcome from DexScreener (41.7% agreement with reality),
 * uses shadow_positions which observed the pool in real-time:
 *
 * CONFIRMED RUG:  shadow rug_detected=1 AND rug_reserve_drop_pct >= 30%
 * CONFIRMED SAFE: shadow rug_detected=0 AND peak_multiplier >= 1.2x (reached TP1)
 * EXCLUDED:       everything else (uncertain outcome)
 *
 * Compatible with train-shadow-classifier.py (needs is_rug, is_labeled columns).
 *
 * Usage: node scripts/export-shadow-labels-training.cjs
 * Output: data/shadow-features.csv
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'), { readonly: true });

// ── Config ──────────────────────────────────────────────────────────

// Label thresholds
const RUG_RESERVE_DROP_MIN = 30;     // reserve dropped >= 30% = confirmed rug
const SAFE_PEAK_MIN = 1.2;          // peak multiplier >= 1.2x = confirmed safe (reached TP1)
const SAFE_PEAK_RELAXED = 1.05;     // relaxed: at least went up 5%

// Use relaxed or strict safe definition
const USE_RELAXED_SAFE = false;
const SAFE_THRESHOLD = USE_RELAXED_SAFE ? SAFE_PEAK_RELAXED : SAFE_PEAK_MIN;

console.log('=== Export Shadow-Labeled Training Data ===\n');
console.log(`Label definitions:`);
console.log(`  RUG:  rug_detected=1 AND reserve_drop >= ${RUG_RESERVE_DROP_MIN}%`);
console.log(`  SAFE: rug_detected=0 AND peak_multiplier >= ${SAFE_THRESHOLD}x`);
console.log(`  Relaxed safe: ${USE_RELAXED_SAFE ? 'YES' : 'NO'}\n`);

// ── Query: Join shadow_positions + detected_pools for features + labels ──

const rows = db.prepare(`
  SELECT
    dp.id AS pool_id,
    dp.source,
    dp.dp_liquidity_usd,
    dp.dp_holder_count,
    dp.dp_top_holder_pct,
    dp.dp_rugcheck_score,
    dp.dp_honeypot_verified,
    dp.dp_mint_auth_revoked,
    dp.dp_freeze_auth_revoked,
    dp.dp_lp_burned,
    dp.dp_graduation_time_s,
    dp.dp_bundle_penalty,
    dp.dp_insiders_count,
    dp.dp_wash_penalty,
    dp.dp_creator_reputation,
    dp.dp_creator_funding,
    dp.dp_early_tx_count,
    dp.dp_tx_velocity,
    dp.dp_unique_slots,
    dp.dp_hidden_whale_count,
    dp.dp_observation_stable,
    dp.dp_observation_drop_pct,
    dp.security_score,
    dp.pool_outcome,
    sp.id AS shadow_id,
    sp.entry_sol_reserve,
    sp.peak_multiplier AS shadow_peak_mult,
    sp.final_multiplier AS shadow_final_mult,
    sp.rug_detected AS shadow_rug,
    sp.rug_reserve_drop_pct AS shadow_rug_drop_pct,
    sp.exit_reason AS shadow_exit_reason,
    sp.total_polls
  FROM shadow_positions sp
  JOIN detected_pools dp ON sp.pool_id = dp.id
  WHERE sp.status = 'closed'
    AND sp.entry_price > 0
    AND sp.total_polls >= 8
    AND dp.dp_holder_count IS NOT NULL
`).all();

console.log(`Total shadow positions with features: ${rows.length}`);

// ── Label assignment ────────────────────────────────────────────────

let confirmedRug = 0;
let confirmedSafe = 0;
let excluded = 0;
let dexAgree = 0;
let dexDisagree = 0;

const labeled = [];

for (const r of rows) {
  let isRug = null;

  // CONFIRMED RUG: shadow detected rug + reserve dropped significantly
  if (r.shadow_rug === 1 && (r.shadow_rug_drop_pct || 0) >= RUG_RESERVE_DROP_MIN) {
    isRug = 1;
    confirmedRug++;
  }
  // CONFIRMED SAFE: shadow didn't detect rug + price reached TP1+
  else if (r.shadow_rug === 0 && (r.shadow_peak_mult || 0) >= SAFE_THRESHOLD) {
    isRug = 0;
    confirmedSafe++;
  }
  // UNCERTAIN: exclude from training
  else {
    excluded++;
    continue;
  }

  // Check DexScreener agreement for stats
  if (r.pool_outcome) {
    const dexIsRug = r.pool_outcome === 'rug' ? 1 : 0;
    if (dexIsRug === isRug) dexAgree++;
    else dexDisagree++;
  }

  labeled.push({ ...r, is_rug: isRug });
}

console.log(`\nLabel distribution:`);
console.log(`  CONFIRMED RUG:  ${confirmedRug} (${(confirmedRug / (confirmedRug + confirmedSafe) * 100).toFixed(1)}%)`);
console.log(`  CONFIRMED SAFE: ${confirmedSafe} (${(confirmedSafe / (confirmedRug + confirmedSafe) * 100).toFixed(1)}%)`);
console.log(`  EXCLUDED:       ${excluded} (uncertain outcome)`);
console.log(`  Ratio:          1:${(confirmedSafe / confirmedRug).toFixed(1)} (rug:safe)`);
console.log(`\nDexScreener agreement: ${dexAgree}/${dexAgree + dexDisagree} (${((dexAgree / (dexAgree + dexDisagree)) * 100).toFixed(1)}%)`);

// ── Build CSV ───────────────────────────────────────────────────────

const header = [
  'pool_id', 'source',
  // Core features (FEATURE_COLS in training script)
  'dp_liquidity_usd', 'dp_holder_count', 'dp_top_holder_pct',
  'dp_rugcheck_score', 'dp_honeypot_verified', 'dp_mint_auth_revoked',
  'dp_freeze_auth_revoked', 'dp_lp_burned', 'dp_graduation_time_s',
  'dp_bundle_penalty', 'dp_insiders_count',
  'dp_wash_penalty',
  'dp_creator_reputation',
  'dp_early_tx_count', 'dp_tx_velocity', 'dp_unique_slots',
  'dp_hidden_whale_count',
  'dp_observation_stable', 'dp_observation_drop_pct',
  // Derived features
  'liq_per_holder', 'is_pumpswap', 'has_creator_funding',
  'entry_sol_reserve', 'security_score',
  // Shadow outcome (for analysis, not training)
  'shadow_peak_mult', 'shadow_rug', 'shadow_rug_drop_pct',
  'shadow_exit_reason', 'pool_outcome_dex',
  // Labels (required by training script)
  'is_rug',
  'has_shadow_data', 'has_dex_data', 'is_labeled',
];

const csvRows = [header.join(',')];

for (const r of labeled) {
  const holders = Math.max(r.dp_holder_count || 1, 1);
  const liq = r.dp_liquidity_usd || 0;
  const liqPerHolder = liq / holders;
  const isPumpswap = r.source === 'pumpswap' ? 1 : 0;
  const hasFunding = r.dp_creator_funding ? 1 : 0;

  csvRows.push([
    r.pool_id,
    r.source || '',
    r.dp_liquidity_usd || 0,
    r.dp_holder_count || 0,
    r.dp_top_holder_pct || 0,
    r.dp_rugcheck_score || 0,
    r.dp_honeypot_verified ? 1 : 0,
    r.dp_mint_auth_revoked ? 1 : 0,
    r.dp_freeze_auth_revoked ? 1 : 0,
    r.dp_lp_burned ? 1 : 0,
    r.dp_graduation_time_s || 0,
    r.dp_bundle_penalty || 0,
    r.dp_insiders_count || 0,
    r.dp_wash_penalty || 0,
    r.dp_creator_reputation || 0,
    r.dp_early_tx_count || 0,
    r.dp_tx_velocity || 0,
    r.dp_unique_slots || 0,
    r.dp_hidden_whale_count || 0,
    r.dp_observation_stable || 0,
    r.dp_observation_drop_pct || 0,
    liqPerHolder.toFixed(2),
    isPumpswap,
    hasFunding,
    r.entry_sol_reserve || 0,
    r.security_score || 0,
    r.shadow_peak_mult || '',
    r.shadow_rug || '',
    r.shadow_rug_drop_pct || '',
    r.shadow_exit_reason || '',
    r.pool_outcome || '',
    r.is_rug,
    1, // has_shadow_data = 1 (all rows come from shadow)
    r.pool_outcome ? 1 : 0, // has_dex_data
    1, // is_labeled = 1
  ].join(','));
}

const outPath = path.join(__dirname, '..', 'data', 'shadow-features.csv');
fs.writeFileSync(outPath, csvRows.join('\n'));

console.log(`\nSaved to: ${outPath}`);
console.log(`Rows: ${labeled.length}`);

// ── Feature coverage stats ──────────────────────────────────────────

console.log('\n=== Feature Coverage ===');
const featureCols = [
  'dp_liquidity_usd', 'dp_holder_count', 'dp_top_holder_pct',
  'dp_rugcheck_score', 'dp_honeypot_verified', 'dp_mint_auth_revoked',
  'dp_freeze_auth_revoked', 'dp_lp_burned', 'dp_graduation_time_s',
  'dp_bundle_penalty', 'dp_insiders_count', 'dp_wash_penalty',
  'dp_creator_reputation', 'dp_early_tx_count', 'dp_tx_velocity',
  'dp_unique_slots', 'dp_hidden_whale_count',
  'dp_observation_stable', 'dp_observation_drop_pct',
];

for (const col of featureCols) {
  const nonNull = labeled.filter(r => r[col] != null && r[col] !== 0).length;
  const pct = (nonNull / labeled.length * 100).toFixed(0);
  console.log(`  ${col.padEnd(30)}: ${pct}% (${nonNull}/${labeled.length})`);
}

// ── Quick analysis: what separates rugs from safe? ──────────────────

console.log('\n=== Feature Means by Label ===');
const rugRows = labeled.filter(r => r.is_rug === 1);
const safeRows = labeled.filter(r => r.is_rug === 0);

function mean(arr, key) {
  const vals = arr.map(r => r[key]).filter(v => v != null && v !== '');
  if (vals.length === 0) return 'N/A';
  return (vals.reduce((a, b) => a + Number(b), 0) / vals.length).toFixed(2);
}

console.log(`Feature                        | RUG mean    | SAFE mean   | Diff`);
console.log(`-------------------------------|-------------|-------------|------`);
for (const col of ['dp_liquidity_usd', 'dp_holder_count', 'dp_top_holder_pct',
  'dp_rugcheck_score', 'dp_observation_drop_pct', 'dp_creator_reputation',
  'dp_hidden_whale_count', 'dp_wash_penalty', 'security_score']) {
  const rugMean = mean(rugRows, col);
  const safeMean = mean(safeRows, col);
  console.log(`${col.padEnd(31)}| ${String(rugMean).padEnd(12)}| ${String(safeMean).padEnd(12)}| ${rugMean !== 'N/A' && safeMean !== 'N/A' ? (Number(safeMean) - Number(rugMean)).toFixed(2) : 'N/A'}`);
}

db.close();
console.log('\nDone.');
