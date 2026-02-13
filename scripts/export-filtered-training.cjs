/**
 * Export FILTERED training data for ML retraining.
 * Only tokens with liq >= $5K (the hard cases).
 * Compatible with train-shadow-classifier.py (needs is_rug, is_labeled columns).
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'), { readonly: true });

const MIN_LIQ = 5000;

// Also join shadow_positions for shadow-specific data
const rows = db.prepare(`
  SELECT
    dp.id AS pool_id,
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
    dp.source,
    dp.pool_outcome,
    sp.entry_sol_reserve,
    sp.peak_multiplier AS shadow_peak_mult,
    sp.rug_detected AS shadow_rug,
    sp.rug_reserve_drop_pct AS shadow_rug_drop_pct,
    sp.exit_reason AS shadow_exit_reason,
    sp.id AS shadow_id
  FROM detected_pools dp
  LEFT JOIN shadow_positions sp ON dp.id = sp.pool_id
  WHERE dp.dp_liquidity_usd >= ?
    AND dp.pool_outcome IS NOT NULL
    AND dp.pool_outcome IN ('rug', 'survivor')
`).all(MIN_LIQ);

console.log(`Rows exported: ${rows.length}`);
const rugs = rows.filter(r => r.pool_outcome === 'rug').length;
const safe = rows.filter(r => r.pool_outcome === 'survivor').length;
console.log(`Rugs: ${rugs} (${(rugs/rows.length*100).toFixed(1)}%)`);
console.log(`Safe: ${safe} (${(safe/rows.length*100).toFixed(1)}%)`);

// Build CSV — headers must match what train-shadow-classifier.py expects
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
  // Shadow outcome
  'shadow_peak_mult', 'shadow_rug', 'shadow_rug_drop_pct',
  // Labels (required by training script)
  'is_rug',
  'has_shadow_data', 'has_dex_data', 'is_labeled',
];

const csvRows = [header.join(',')];

for (const r of rows) {
  const holders = Math.max(r.dp_holder_count || 1, 1);
  const liq = r.dp_liquidity_usd || 0;
  const liqPerHolder = liq / holders;
  const isPumpswap = r.source === 'pumpswap' ? 1 : 0;
  const hasFunding = r.dp_creator_funding ? 1 : 0;
  const isRug = r.pool_outcome === 'rug' ? 1 : 0;
  const hasShadow = r.shadow_id != null ? 1 : 0;

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
    isRug,
    hasShadow,
    1, // has_dex_data = 1 for all (they have pool_outcome from DexScreener)
    1, // is_labeled = 1 for all
  ].join(','));
}

const outPath = path.join(__dirname, '..', 'data', 'training-data-filtered.csv');
fs.writeFileSync(outPath, csvRows.join('\n'));
console.log(`\nSaved to: ${outPath}`);

db.close();
