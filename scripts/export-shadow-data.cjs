#!/usr/bin/env node
/**
 * v9b: Export shadow mode data + all detected pools for ML training.
 *
 * Generates three CSV files:
 * 1. shadow-features.csv — All detected pools with features + outcomes (shadow + dex)
 * 2. shadow-timeseries.csv — Price time series per shadow position
 * 3. shadow-timeseries-features.csv — Derived time series features per shadow position
 *
 * Usage: node scripts/export-shadow-data.cjs [--version v9a] [--min-polls 3] [--min-samples 100]
 */

const Database = require('better-sqlite3');
const { resolve, join } = require('path');
const { writeFileSync } = require('fs');

const DB_PATH = resolve(__dirname, '..', 'data', 'bot.db');
const OUTPUT_DIR = resolve(__dirname, '..', 'data');

// Parse args
const args = process.argv.slice(2);
const versionFilter = args.includes('--version') ? args[args.indexOf('--version') + 1] : null;
const minPolls = args.includes('--min-polls') ? parseInt(args[args.indexOf('--min-polls') + 1]) : 3;
const minSamples = args.includes('--min-samples') ? parseInt(args[args.indexOf('--min-samples') + 1]) : 0;

const db = new Database(DB_PATH, { readonly: true });

// ── Helpers ─────────────────────────────────────────────────────────────

function csvEscape(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function pct(n, total) {
  return total > 0 ? ((n / total) * 100).toFixed(1) : '0.0';
}

// ── Dataset 1: Features + Outcome ──────────────────────────────────────

console.log('=== DATASET 1: Shadow Features (all detected pools) ===\n');

const featureQuery = `
SELECT
  dp.id AS pool_id,
  dp.source,
  dp.security_score,
  dp.security_passed,
  -- Core features (from dp_ columns)
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
  -- Wash trading features
  dp.dp_wash_concentration,
  dp.dp_wash_same_amount_ratio,
  dp.dp_wash_penalty,
  -- Creator features
  dp.dp_creator_reputation,
  dp.dp_creator_funding,
  -- Activity features (v8q+)
  dp.dp_early_tx_count,
  dp.dp_tx_velocity,
  dp.dp_unique_slots,
  dp.dp_hidden_whale_count,
  -- Observation window
  dp.dp_observation_stable,
  dp.dp_observation_drop_pct,
  dp.dp_observation_initial_sol,
  dp.dp_observation_final_sol,
  -- Rejection info
  dp.rejection_reasons,
  dp.dp_rejection_stage,
  dp.bot_version,
  -- Shadow position outcome (NULL if pool was rejected before shadow)
  sp.id AS shadow_id,
  sp.entry_price AS shadow_entry_price,
  sp.peak_price AS shadow_peak_price,
  sp.min_price AS shadow_min_price,
  sp.peak_multiplier AS shadow_peak_mult,
  sp.time_to_peak_ms AS shadow_time_to_peak_ms,
  sp.final_multiplier AS shadow_final_mult,
  sp.tp1_hit, sp.tp1_time_ms,
  sp.tp2_hit, sp.tp2_time_ms,
  sp.tp3_hit, sp.tp3_time_ms,
  sp.sl_hit, sp.sl_time_ms,
  sp.rug_detected AS shadow_rug,
  sp.rug_reserve_drop_pct AS shadow_rug_drop_pct,
  sp.exit_reason AS shadow_exit_reason,
  sp.total_polls AS shadow_total_polls,
  sp.entry_sol_reserve AS shadow_entry_reserve,
  -- DexScreener outcome for ALL pools (even rejected)
  poc5.price_native AS dex_5m_price,
  poc5.liquidity_usd AS dex_5m_liq,
  poc5.market_cap AS dex_5m_mcap,
  poc5.is_alive AS dex_5m_alive,
  poc15.price_native AS dex_15m_price,
  poc15.liquidity_usd AS dex_15m_liq,
  poc15.market_cap AS dex_15m_mcap,
  poc30.price_native AS dex_30m_price,
  poc30.liquidity_usd AS dex_30m_liq,
  poc60.price_native AS dex_60m_price,
  poc60.liquidity_usd AS dex_60m_liq,
  poc60.is_alive AS dex_60m_alive,
  dp.pool_outcome
FROM detected_pools dp
LEFT JOIN shadow_positions sp ON dp.id = sp.pool_id
LEFT JOIN pool_outcome_checks poc5  ON dp.id = poc5.pool_id  AND poc5.delay_minutes = 5
LEFT JOIN pool_outcome_checks poc15 ON dp.id = poc15.pool_id AND poc15.delay_minutes = 15
LEFT JOIN pool_outcome_checks poc30 ON dp.id = poc30.pool_id AND poc30.delay_minutes = 30
LEFT JOIN pool_outcome_checks poc60 ON dp.id = poc60.pool_id AND poc60.delay_minutes = 60
WHERE dp.dp_liquidity_usd IS NOT NULL
${versionFilter ? `AND dp.bot_version = ?` : ''}
ORDER BY dp.detected_at ASC
`;

const featureRows = versionFilter
  ? db.prepare(featureQuery).all(versionFilter)
  : db.prepare(featureQuery).all();

if (featureRows.length === 0) {
  console.log('No data found. Run bot in shadow mode first.');
  process.exit(0);
}

if (minSamples > 0 && featureRows.length < minSamples) {
  console.log(`Only ${featureRows.length} samples (need ${minSamples}). Keep collecting.`);
  process.exit(1);
}

// Get first price log reserve for each shadow position (backup for entry_sol_reserve)
const firstLogReserves = new Map();
try {
  const logRows = db.prepare(`
    SELECT shadow_id, sol_reserve FROM shadow_price_log
    WHERE id IN (
      SELECT MIN(id) FROM shadow_price_log GROUP BY shadow_id
    )
  `).all();
  for (const r of logRows) {
    firstLogReserves.set(r.shadow_id, r.sol_reserve);
  }
} catch { /* table may not exist */ }

// Build derived features and output CSV
const outputHeaders = [
  // IDs
  'pool_id', 'source', 'bot_version',
  // Core features
  'dp_liquidity_usd', 'dp_holder_count', 'dp_top_holder_pct',
  'dp_honeypot_verified', 'dp_mint_auth_revoked', 'dp_freeze_auth_revoked',
  'dp_rugcheck_score', 'dp_lp_burned',
  'dp_graduation_time_s', 'dp_bundle_penalty', 'dp_insiders_count',
  // Wash trading
  'dp_wash_concentration', 'dp_wash_same_amount_ratio', 'dp_wash_penalty',
  // Creator
  'dp_creator_reputation',
  // Activity
  'dp_early_tx_count', 'dp_tx_velocity', 'dp_unique_slots', 'dp_hidden_whale_count',
  // Observation
  'dp_observation_stable', 'dp_observation_drop_pct',
  // Derived features
  'liq_per_holder', 'is_pumpswap', 'has_creator_funding',
  'entry_sol_reserve', 'security_score',
  // Shadow outcome
  'shadow_peak_mult', 'shadow_final_mult',
  'shadow_time_to_peak_ms', 'shadow_total_polls',
  'tp1_hit', 'tp1_time_ms', 'tp2_hit', 'tp2_time_ms', 'tp3_hit',
  'sl_hit', 'shadow_rug', 'shadow_rug_drop_pct', 'shadow_exit_reason',
  // DexScreener
  'dex_5m_price', 'dex_5m_liq', 'dex_5m_mcap', 'dex_5m_alive',
  'dex_15m_liq', 'dex_30m_liq', 'dex_60m_liq', 'dex_60m_alive',
  // Labels
  'pool_outcome', 'is_rug', 'tp1_reached',
  'has_shadow_data', 'has_dex_data', 'has_pool_outcome', 'is_labeled',
];

const csvRows = [outputHeaders.join(',')];
let stats = { total: 0, rugs: 0, safe: 0, withShadow: 0, withDex: 0, outliers: 0 };

for (const r of featureRows) {
  // Filter outliers: DexScreener mcap > $1B is likely corrupted data
  if (r.dex_5m_mcap && r.dex_5m_mcap > 1e9) {
    stats.outliers++;
    continue;
  }

  stats.total++;

  // Derived features
  const holderCount = r.dp_holder_count || 1;
  const liqPerHolder = (r.dp_liquidity_usd || 0) / Math.max(holderCount, 1);
  const isPumpswap = r.source === 'pumpswap' ? 1 : 0;
  const hasCreatorFunding = r.dp_creator_funding ? 1 : 0;

  // Entry reserve: prefer shadow data, fallback to first price log
  const shadowId = r.shadow_id;
  let entryReserve = r.shadow_entry_reserve;
  if (!entryReserve && shadowId) {
    entryReserve = firstLogReserves.get(shadowId) || null;
  }

  // Has shadow data?
  const hasShadowData = r.shadow_peak_mult != null ? 1 : 0;
  const hasDexData = r.dex_5m_price != null ? 1 : 0;

  // Has pool_outcome label from enrich-pool-outcomes?
  const hasPoolOutcome = r.pool_outcome === 'rug' || r.pool_outcome === 'survivor' ? 1 : 0;

  // Labels - use multiple sources for is_rug
  let isRug = 0;
  if (r.shadow_rug) {
    isRug = 1;
  } else if (hasShadowData && r.shadow_exit_reason === 'stop_loss') {
    isRug = 1; // hit -30% stop loss
  } else if (r.pool_outcome === 'rug') {
    isRug = 1; // enriched pool outcome
  } else if (hasDexData && r.dex_5m_liq !== null && r.dex_5m_liq < 100 && r.dex_5m_price === null) {
    isRug = 1; // dead at 5 min
  }

  const tp1Reached = r.tp1_hit ? 1 : (r.shadow_peak_mult >= 1.2 ? 1 : 0);

  // is_labeled: has any outcome source
  const isLabeled = hasShadowData || hasDexData || hasPoolOutcome ? 1 : 0;

  if (isRug) stats.rugs++;
  else stats.safe++;
  if (hasShadowData) stats.withShadow++;
  if (hasDexData) stats.withDex++;

  csvRows.push([
    csvEscape(r.pool_id),
    csvEscape(r.source),
    csvEscape(r.bot_version),
    r.dp_liquidity_usd ?? '',
    r.dp_holder_count ?? '',
    r.dp_top_holder_pct ?? '',
    r.dp_honeypot_verified ?? '',
    r.dp_mint_auth_revoked ?? '',
    r.dp_freeze_auth_revoked ?? '',
    r.dp_rugcheck_score ?? '',
    r.dp_lp_burned ?? '',
    r.dp_graduation_time_s ?? '',
    r.dp_bundle_penalty ?? '',
    r.dp_insiders_count ?? '',
    r.dp_wash_concentration ?? '',
    r.dp_wash_same_amount_ratio ?? '',
    r.dp_wash_penalty ?? '',
    r.dp_creator_reputation ?? '',
    r.dp_early_tx_count ?? '',
    r.dp_tx_velocity ?? '',
    r.dp_unique_slots ?? '',
    r.dp_hidden_whale_count ?? '',
    r.dp_observation_stable ?? '',
    r.dp_observation_drop_pct ?? '',
    liqPerHolder.toFixed(2),
    isPumpswap,
    hasCreatorFunding,
    entryReserve ?? '',
    r.security_score ?? '',
    r.shadow_peak_mult ?? '',
    r.shadow_final_mult ?? '',
    r.shadow_time_to_peak_ms ?? '',
    r.shadow_total_polls ?? '',
    r.tp1_hit ?? '',
    r.tp1_time_ms ?? '',
    r.tp2_hit ?? '',
    r.tp2_time_ms ?? '',
    r.tp3_hit ?? '',
    r.sl_hit ?? '',
    r.shadow_rug ?? '',
    r.shadow_rug_drop_pct ?? '',
    csvEscape(r.shadow_exit_reason),
    r.dex_5m_price ?? '',
    r.dex_5m_liq ?? '',
    r.dex_5m_mcap ?? '',
    r.dex_5m_alive ?? '',
    r.dex_15m_liq ?? '',
    r.dex_30m_liq ?? '',
    r.dex_60m_liq ?? '',
    r.dex_60m_alive ?? '',
    csvEscape(r.pool_outcome),
    isRug,
    tp1Reached,
    hasShadowData,
    hasDexData,
    hasPoolOutcome,
    isLabeled,
  ].join(','));
}

const featuresPath = join(OUTPUT_DIR, 'shadow-features.csv');
writeFileSync(featuresPath, csvRows.join('\n'));

console.log(`Exported: ${featuresPath}`);
console.log(`  Total rows: ${stats.total} (filtered ${stats.outliers} outliers)`);
console.log(`  Rugs: ${stats.rugs} (${pct(stats.rugs, stats.total)}%)`);
console.log(`  Safe: ${stats.safe} (${pct(stats.safe, stats.total)}%)`);
console.log(`  With shadow data: ${stats.withShadow} (${pct(stats.withShadow, stats.total)}%)`);
console.log(`  With DexScreener data: ${stats.withDex} (${pct(stats.withDex, stats.total)}%)`);

// ── Dataset 2: Time Series ─────────────────────────────────────────────

console.log('\n=== DATASET 2: Shadow Time Series ===\n');

const tsQuery = `
SELECT
  sp.id AS shadow_id,
  sp.token_mint,
  sp.security_score,
  sp.entry_price,
  sp.peak_multiplier,
  sp.rug_detected,
  sp.exit_reason,
  spl.price,
  spl.multiplier,
  spl.sol_reserve,
  spl.elapsed_ms
FROM shadow_positions sp
JOIN shadow_price_log spl ON sp.id = spl.shadow_id
WHERE sp.total_polls >= ?
${versionFilter ? `AND sp.bot_version = ?` : ''}
ORDER BY sp.opened_at ASC, spl.elapsed_ms ASC
`;

const tsRows = versionFilter
  ? db.prepare(tsQuery).all(minPolls, versionFilter)
  : db.prepare(tsQuery).all(minPolls);

if (tsRows.length > 0) {
  const tsHeaders = Object.keys(tsRows[0]);
  const tsCsv = [
    tsHeaders.join(','),
    ...tsRows.map(row =>
      tsHeaders.map(h => {
        const val = row[h];
        if (val === null || val === undefined) return '';
        return val;
      }).join(',')
    ),
  ].join('\n');

  const tsPath = join(OUTPUT_DIR, 'shadow-timeseries.csv');
  writeFileSync(tsPath, tsCsv);

  const uniquePositions = new Set(tsRows.map(r => r.shadow_id));
  console.log(`Exported: ${tsPath} (${tsRows.length} rows)`);
  console.log(`  Unique positions: ${uniquePositions.size}`);
  console.log(`  Avg polls/position: ${(tsRows.length / uniquePositions.size).toFixed(0)}`);
} else {
  console.log(`No time series data (need shadow positions with >= ${minPolls} polls)`);
}

// ── Dataset 3: Time Series Derived Features ────────────────────────────

console.log('\n=== DATASET 3: Time Series Derived Features ===\n');

if (tsRows.length > 0) {
  // Group by shadow_id
  const grouped = new Map();
  for (const r of tsRows) {
    if (!grouped.has(r.shadow_id)) {
      grouped.set(r.shadow_id, {
        meta: { shadow_id: r.shadow_id, peak_mult: r.peak_multiplier, rug: r.rug_detected, exit: r.exit_reason },
        ticks: [],
      });
    }
    grouped.get(r.shadow_id).ticks.push(r);
  }

  const tsFeatureHeaders = [
    'shadow_id', 'peak_multiplier', 'rug_detected', 'exit_reason',
    'early_momentum_30s', 'early_volatility_30s',
    'price_velocity_2m', 'max_drawdown_2m', 'reserve_trend_2m',
    'total_volatility', 'time_above_entry_pct',
    'reserve_min_ratio', 'reserve_max_ratio',
    'num_polls',
  ];

  const tsFeatureRows = [tsFeatureHeaders.join(',')];

  for (const [sid, data] of grouped) {
    const ticks = data.ticks;
    const mults = ticks.map(t => t.multiplier);
    const reserves = ticks.map(t => t.sol_reserve).filter(r => r != null && r > 0);
    const entryReserve = reserves.length > 0 ? reserves[0] : 1;

    // Early momentum (first 30s = ~6 polls at 5s interval)
    const early = mults.slice(0, 6);
    const earlyMomentum = early.length >= 2 ? early[early.length - 1] - 1 : 0;
    const earlyVol = stdDev(early);

    // 2min features (~24 polls)
    const first2m = mults.slice(0, 24);
    const velocity2m = first2m.length >= 2 ? linearSlope(first2m) : 0;
    const maxDrawdown2m = maxDrawdown(first2m);
    const reserves2m = reserves.slice(0, 24);
    const reserveTrend2m = reserves2m.length >= 2
      ? (reserves2m[reserves2m.length - 1] - reserves2m[0]) / reserves2m[0]
      : 0;

    // Global
    const totalVol = stdDev(mults);
    const timeAboveEntry = mults.filter(m => m > 1).length / Math.max(mults.length, 1);
    const reserveMinRatio = reserves.length > 0 ? Math.min(...reserves) / entryReserve : 1;
    const reserveMaxRatio = reserves.length > 0 ? Math.max(...reserves) / entryReserve : 1;

    tsFeatureRows.push([
      csvEscape(sid),
      data.meta.peak_mult ?? '',
      data.meta.rug ?? '',
      csvEscape(data.meta.exit),
      earlyMomentum.toFixed(4),
      earlyVol.toFixed(4),
      velocity2m.toFixed(6),
      maxDrawdown2m.toFixed(4),
      reserveTrend2m.toFixed(4),
      totalVol.toFixed(4),
      timeAboveEntry.toFixed(4),
      reserveMinRatio.toFixed(4),
      reserveMaxRatio.toFixed(4),
      ticks.length,
    ].join(','));
  }

  const tsFeaturesPath = join(OUTPUT_DIR, 'shadow-timeseries-features.csv');
  writeFileSync(tsFeaturesPath, tsFeatureRows.join('\n'));
  console.log(`Exported: ${tsFeaturesPath} (${grouped.size} positions)`);
} else {
  console.log('No time series features to compute.');
}

db.close();
console.log('\nDone!');

// ── Math helpers ────────────────────────────────────────────────────────

function stdDev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function linearSlope(arr) {
  if (arr.length < 2) return 0;
  const n = arr.length;
  const xMean = (n - 1) / 2;
  const yMean = arr.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (arr[i] - yMean);
    den += (i - xMean) ** 2;
  }
  return den > 0 ? num / den : 0;
}

function maxDrawdown(arr) {
  if (arr.length < 2) return 0;
  let peak = arr[0];
  let maxDD = 0;
  for (const val of arr) {
    if (val > peak) peak = val;
    const dd = (peak - val) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}
