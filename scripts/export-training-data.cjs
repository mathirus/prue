/**
 * Export training data from SQLite for ML classifier training.
 *
 * Exports TWO datasets:
 *   1. data/training-data-full.csv     - Detailed features from positions+token_analysis (~216 samples)
 *   2. data/training-data-enriched.csv - ALL detected_pools with outcomes (~3000+ samples)
 *
 * The enriched dataset parses rejection_reasons into binary feature columns and uses
 * pool_outcome (rug/survivor) from the enrich-pool-outcomes.cjs script.
 *
 * For pools that have token_analysis records, individual features (liquidity_usd,
 * holder_count, top_holder_pct, etc.) are joined in as well.
 *
 * Usage: node scripts/export-training-data.cjs
 */

const Database = require('better-sqlite3');
const { writeFileSync } = require('fs');
const path = require('path');

const DB_PATH = path.resolve(process.cwd(), 'data', 'bot.db');
const OUTPUT_FULL = path.resolve(process.cwd(), 'data', 'training-data-full.csv');
const OUTPUT_ENRICHED = path.resolve(process.cwd(), 'data', 'training-data-enriched.csv');

// ── Helpers ─────────────────────────────────────────────────────────

function pct(n, total) {
  return total > 0 ? ((n / total) * 100).toFixed(1) : '0.0';
}

function csvEscape(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ── Dataset 1: Full features (positions + token_analysis) ───────────

function exportFullDataset(db) {
  console.log('\n=== DATASET 1: Full Features (positions + token_analysis) ===');

  // Check if deep creator columns exist
  const tcCols = db.prepare("PRAGMA table_info(token_creators)").all().map(c => c.name);
  const hasDeepCols = tcCols.includes('wallet_age_seconds');

  const deepSelect = hasDeepCols
    ? 'tc.wallet_age_seconds, tc.tx_count, tc.reputation_score, tc.funding_source,'
    : 'NULL as wallet_age_seconds, NULL as tx_count, NULL as reputation_score, NULL as funding_source,';

  // Check if v8l columns exist on detected_pools
  const dpCols = db.prepare('PRAGMA table_info(detected_pools)').all().map(c => c.name);
  const hasV8lCols = dpCols.includes('dp_graduation_time_s');
  const v8lSelect = hasV8lCols
    ? 'dp.dp_graduation_time_s, dp.dp_bundle_penalty, dp.dp_insiders_count,'
    : 'NULL as dp_graduation_time_s, NULL as dp_bundle_penalty, NULL as dp_insiders_count,';

  const rows = db.prepare(`
    SELECT
      ta.liquidity_usd,
      ta.top_holder_pct,
      ta.holder_count,
      ta.rugcheck_score,
      ta.honeypot_verified,
      ta.honeypot_safe,
      ta.lp_burned,
      ta.mint_authority_revoked,
      ta.freeze_authority_revoked,
      ta.score as security_score,
      ta.detection_latency_ms,
      ta.source,
      ${deepSelect}
      ${v8lSelect}
      p.pnl_pct,
      p.pnl_sol,
      p.status,
      p.token_mint,
      p.sol_invested
    FROM token_analysis ta
    INNER JOIN positions p ON ta.token_mint = p.token_mint
    LEFT JOIN token_creators tc ON ta.token_mint = tc.token_mint
    LEFT JOIN detected_pools dp ON dp.base_mint = p.token_mint
    WHERE p.status IN ('stopped', 'closed')
    ORDER BY p.opened_at ASC
  `).all();

  if (rows.length === 0) {
    console.log('  No position data found. Skipping full dataset.');
    return;
  }

  const headers = [
    'token_mint', 'source', 'liquidity_usd', 'top_holder_pct', 'holder_count',
    'rugcheck_score', 'honeypot_verified', 'honeypot_safe', 'lp_burned',
    'mint_authority_revoked', 'freeze_authority_revoked', 'security_score',
    'detection_latency_ms', 'wallet_age_seconds', 'tx_count',
    'reputation_score', 'has_funding_source',
    // v8l: new features
    'graduation_time_s', 'bundle_penalty', 'insiders_count',
    'pnl_pct', 'pnl_sol', 'sol_invested', 'status', 'is_rug',
  ];

  const csvRows = [headers.join(',')];

  let rugs = 0, wins = 0, losses = 0;
  for (const r of rows) {
    const isRug = (r.pnl_pct ?? 0) <= -80 ? 1 : 0;
    if (isRug) rugs++;
    else if ((r.pnl_pct ?? 0) > 5) wins++;
    else losses++;

    csvRows.push([
      csvEscape(r.token_mint?.slice(0, 8) ?? ''),
      csvEscape(r.source ?? ''),
      r.liquidity_usd ?? '',
      r.top_holder_pct ?? '',
      r.holder_count ?? '',
      r.rugcheck_score ?? '',
      r.honeypot_verified ?? '',
      r.honeypot_safe ?? '',
      r.lp_burned ?? '',
      r.mint_authority_revoked ?? '',
      r.freeze_authority_revoked ?? '',
      r.security_score ?? '',
      r.detection_latency_ms ?? '',
      r.wallet_age_seconds ?? '',
      r.tx_count ?? '',
      r.reputation_score ?? '',
      r.funding_source ? 1 : 0,
      // v8l features
      r.dp_graduation_time_s ?? '',
      r.dp_bundle_penalty ?? '',
      r.dp_insiders_count ?? '',
      r.pnl_pct ?? '',
      r.pnl_sol ?? '',
      r.sol_invested ?? '',
      csvEscape(r.status ?? ''),
      isRug,
    ].join(','));
  }

  writeFileSync(OUTPUT_FULL, csvRows.join('\n'));

  console.log(`  Exported ${rows.length} trades to ${OUTPUT_FULL}`);
  console.log(`  Rugs:      ${rugs} (${pct(rugs, rows.length)}%)`);
  console.log(`  Wins:      ${wins} (${pct(wins, rows.length)}%)`);
  console.log(`  Losses/BE: ${losses} (${pct(losses, rows.length)}%)`);
}

// ── Dataset 2: Enriched detected_pools (all pools with outcomes) ────

function exportEnrichedDataset(db) {
  console.log('\n=== DATASET 2: Enriched Detected Pools (all pools with outcomes) ===');

  // Check which columns exist on detected_pools
  const dpCols = db.prepare('PRAGMA table_info(detected_pools)').all().map(c => c.name);
  const hasOutcome = dpCols.includes('pool_outcome');
  const hasFeatureCols = dpCols.includes('dp_liquidity_usd'); // new feature columns

  if (!hasOutcome) {
    console.log('  pool_outcome column not found. Run enrich-pool-outcomes.cjs first.');
    return;
  }

  // Build SELECT - join with token_analysis for individual features when available
  // detected_pools has: security_score, security_passed, rejection_reasons, pool_outcome, current_sol_reserves
  // token_analysis has: liquidity_usd, top_holder_pct, holder_count, rugcheck_score, honeypot_verified, etc.
  // New dp_ columns (if exist): dp_liquidity_usd, dp_holder_count, dp_top_holder_pct, etc.
  const featureSelect = hasFeatureCols
    ? `dp.dp_liquidity_usd,
       dp.dp_holder_count,
       dp.dp_top_holder_pct,
       dp.dp_honeypot_verified,
       dp.dp_mint_auth_revoked,
       dp.dp_freeze_auth_revoked,
       dp.dp_rugcheck_score,
       dp.dp_lp_burned,`
    : `NULL as dp_liquidity_usd,
       NULL as dp_holder_count,
       NULL as dp_top_holder_pct,
       NULL as dp_honeypot_verified,
       NULL as dp_mint_auth_revoked,
       NULL as dp_freeze_auth_revoked,
       NULL as dp_rugcheck_score,
       NULL as dp_lp_burned,`;

  // v8l columns
  const hasV8lColsEnriched = dpCols.includes('dp_graduation_time_s');
  const v8lSelectEnriched = hasV8lColsEnriched
    ? `dp.dp_graduation_time_s, dp.dp_bundle_penalty, dp.dp_insiders_count,`
    : `NULL as dp_graduation_time_s, NULL as dp_bundle_penalty, NULL as dp_insiders_count,`;

  // v11t: Penalty breakdown columns (available from v11o+, NULL for older pools)
  const PENALTY_BREAKDOWN_COLS = [
    'dp_holder_penalty', 'dp_rugcheck_penalty', 'dp_graduation_bonus',
    'dp_obs_bonus', 'dp_organic_bonus', 'dp_smart_wallet_bonus',
    'dp_creator_age_penalty', 'dp_velocity_penalty', 'dp_insider_penalty',
    'dp_whale_penalty', 'dp_timing_cv_penalty', 'dp_hhi_penalty',
    'dp_concentrated_penalty', 'dp_funder_fan_out', 'dp_creator_reputation',
  ];
  const hasPenaltyCols = dpCols.includes('dp_holder_penalty');
  const penaltySelect = hasPenaltyCols
    ? PENALTY_BREAKDOWN_COLS.map(c => `dp.${c}`).join(', ') + ','
    : PENALTY_BREAKDOWN_COLS.map(c => `NULL as ${c}`).join(', ') + ',';

  const rows = db.prepare(`
    SELECT
      dp.id,
      dp.source,
      dp.base_mint,
      dp.security_score,
      dp.security_passed,
      dp.rejection_reasons,
      dp.pool_outcome,
      dp.current_sol_reserves,
      dp.detected_at,
      ${featureSelect}
      ${v8lSelectEnriched}
      ${penaltySelect}
      ta.liquidity_usd as ta_liquidity_usd,
      ta.top_holder_pct as ta_top_holder_pct,
      ta.holder_count as ta_holder_count,
      ta.rugcheck_score as ta_rugcheck_score,
      ta.honeypot_verified as ta_honeypot_verified,
      ta.honeypot_safe as ta_honeypot_safe,
      ta.lp_burned as ta_lp_burned,
      ta.mint_authority_revoked as ta_mint_auth_revoked,
      ta.freeze_authority_revoked as ta_freeze_auth_revoked,
      ta.detection_latency_ms
    FROM detected_pools dp
    LEFT JOIN token_analysis ta ON dp.base_mint = ta.token_mint
    WHERE dp.pool_outcome IN ('rug', 'survivor')
    ORDER BY dp.detected_at ASC
  `).all();

  if (rows.length === 0) {
    console.log('  No enriched data found. Run enrich-pool-outcomes.cjs first.');
    return;
  }

  // Parse rejection_reasons into binary features
  // Known reasons from index.ts: mint_auth, freeze_auth, honeypot, low_liq, low_holders,
  //   dangerous_ext, rugcheck, scammer_network, scam_cluster
  const REJECTION_FEATURES = [
    'has_mint_auth',      // rejection_reasons contains 'mint_auth'
    'has_freeze_auth',    // rejection_reasons contains 'freeze_auth'
    'has_honeypot',       // rejection_reasons contains 'honeypot'
    'has_low_liq',        // rejection_reasons contains 'low_liq'
    'has_low_holders',    // rejection_reasons contains 'low_holders'
    'has_dangerous_ext',  // rejection_reasons contains 'dangerous_ext'
    'has_rugcheck',       // rejection_reasons contains 'rugcheck'
    'has_scammer_network',// rejection_reasons contains 'scammer_network'
    'has_scam_cluster',   // rejection_reasons contains 'scam_cluster'
  ];

  function parseRejectionReasons(reasonsStr) {
    const reasons = (reasonsStr || '').split(',').map(r => r.trim()).filter(Boolean);
    return {
      has_mint_auth: reasons.includes('mint_auth') ? 1 : 0,
      has_freeze_auth: reasons.includes('freeze_auth') ? 1 : 0,
      has_honeypot: reasons.includes('honeypot') ? 1 : 0,
      has_low_liq: reasons.includes('low_liq') ? 1 : 0,
      has_low_holders: reasons.includes('low_holders') ? 1 : 0,
      has_dangerous_ext: reasons.includes('dangerous_ext') ? 1 : 0,
      has_rugcheck: reasons.includes('rugcheck') ? 1 : 0,
      has_scammer_network: reasons.includes('scammer_network') ? 1 : 0,
      has_scam_cluster: reasons.includes('scam_cluster') ? 1 : 0,
    };
  }

  const headers = [
    'pool_id', 'source', 'base_mint', 'security_score', 'security_passed',
    // Parsed rejection reason flags
    ...REJECTION_FEATURES,
    // Individual features (from token_analysis or dp_ columns, whichever available)
    'liquidity_usd', 'holder_count', 'top_holder_pct',
    'rugcheck_score', 'honeypot_verified', 'mint_auth_revoked', 'freeze_auth_revoked',
    'lp_burned',
    // v8l features
    'graduation_time_s', 'bundle_penalty', 'insiders_count',
    // v11t: Penalty breakdown features (NULL for pre-v11o pools)
    ...PENALTY_BREAKDOWN_COLS,
    // Pool state
    'current_sol_reserves', 'detection_latency_ms',
    // Label
    'pool_outcome', 'is_rug',
  ];

  const csvRows = [headers.join(',')];

  let rugs = 0, survivors = 0;
  let withFeatures = 0;

  for (const r of rows) {
    const isRug = r.pool_outcome === 'rug' ? 1 : 0;
    if (isRug) rugs++;
    else survivors++;

    const reasons = parseRejectionReasons(r.rejection_reasons);

    // Prefer dp_ columns (saved at detection time) > token_analysis (only for bought tokens)
    const liquidityUsd = r.dp_liquidity_usd ?? r.ta_liquidity_usd ?? '';
    const holderCount = r.dp_holder_count ?? r.ta_holder_count ?? '';
    const topHolderPct = r.dp_top_holder_pct ?? r.ta_top_holder_pct ?? '';
    const rugcheckScore = r.dp_rugcheck_score ?? r.ta_rugcheck_score ?? '';
    const honeypotVerified = r.dp_honeypot_verified ?? r.ta_honeypot_verified ?? '';
    const mintAuthRevoked = r.dp_mint_auth_revoked ?? r.ta_mint_auth_revoked ?? '';
    const freezeAuthRevoked = r.dp_freeze_auth_revoked ?? r.ta_freeze_auth_revoked ?? '';
    const lpBurned = r.dp_lp_burned ?? r.ta_lp_burned ?? '';

    if (liquidityUsd !== '') withFeatures++;

    csvRows.push([
      csvEscape(r.id?.slice(0, 12) ?? ''),
      csvEscape(r.source ?? ''),
      csvEscape(r.base_mint?.slice(0, 8) ?? ''),
      r.security_score ?? '',
      r.security_passed ?? '',
      reasons.has_mint_auth,
      reasons.has_freeze_auth,
      reasons.has_honeypot,
      reasons.has_low_liq,
      reasons.has_low_holders,
      reasons.has_dangerous_ext,
      reasons.has_rugcheck,
      reasons.has_scammer_network,
      reasons.has_scam_cluster,
      liquidityUsd,
      holderCount,
      topHolderPct,
      rugcheckScore,
      honeypotVerified,
      mintAuthRevoked,
      freezeAuthRevoked,
      lpBurned,
      // v8l features
      r.dp_graduation_time_s ?? '',
      r.dp_bundle_penalty ?? '',
      r.dp_insiders_count ?? '',
      // v11t: Penalty breakdown features
      ...PENALTY_BREAKDOWN_COLS.map(col => {
        const val = r[col];
        return val != null ? csvEscape(val) : '';
      }),
      r.current_sol_reserves ?? '',
      r.detection_latency_ms ?? '',
      csvEscape(r.pool_outcome ?? ''),
      isRug,
    ].join(','));
  }

  writeFileSync(OUTPUT_ENRICHED, csvRows.join('\n'));

  console.log(`  Exported ${rows.length} pools to ${OUTPUT_ENRICHED}`);
  console.log(`  Rugs:        ${rugs} (${pct(rugs, rows.length)}%)`);
  console.log(`  Survivors:   ${survivors} (${pct(survivors, rows.length)}%)`);
  console.log(`  With features: ${withFeatures} (${pct(withFeatures, rows.length)}%) - rest are score+rejection_reasons only`);

  // Additional stats
  console.log('\n  --- Score Distribution by Outcome ---');
  const scoreBuckets = db.prepare(`
    SELECT
      CASE
        WHEN security_score IS NULL THEN 'null'
        WHEN security_score < 30 THEN '0-29'
        WHEN security_score < 50 THEN '30-49'
        WHEN security_score < 60 THEN '50-59'
        WHEN security_score < 70 THEN '60-69'
        WHEN security_score < 80 THEN '70-79'
        WHEN security_score < 90 THEN '80-89'
        ELSE '90-100'
      END as score_range,
      pool_outcome,
      COUNT(*) as count
    FROM detected_pools
    WHERE pool_outcome IN ('rug', 'survivor')
    GROUP BY score_range, pool_outcome
    ORDER BY score_range, pool_outcome
  `).all();

  const bucketMap = {};
  for (const row of scoreBuckets) {
    if (!bucketMap[row.score_range]) bucketMap[row.score_range] = { rug: 0, survivor: 0 };
    bucketMap[row.score_range][row.pool_outcome] = row.count;
  }

  console.log('  Score    | Rugs    | Survivors | Rug Rate');
  console.log('  ---------|---------|-----------|--------');
  for (const range of ['null', '0-29', '30-49', '50-59', '60-69', '70-79', '80-89', '90-100']) {
    const b = bucketMap[range];
    if (!b) continue;
    const total = b.rug + b.survivor;
    const rugRate = total > 0 ? ((b.rug / total) * 100).toFixed(1) : '0.0';
    console.log(`  ${range.padEnd(9)}| ${String(b.rug).padEnd(8)}| ${String(b.survivor).padEnd(10)}| ${rugRate}%`);
  }

  // Rejection reason frequency
  console.log('\n  --- Rejection Reasons Frequency ---');
  const reasonCounts = {};
  for (const r of rows) {
    const reasons = (r.rejection_reasons || '').split(',').filter(Boolean);
    for (const reason of reasons) {
      if (!reasonCounts[reason]) reasonCounts[reason] = { total: 0, rug: 0, survivor: 0 };
      reasonCounts[reason].total++;
      if (r.pool_outcome === 'rug') reasonCounts[reason].rug++;
      else reasonCounts[reason].survivor++;
    }
  }

  const sortedReasons = Object.entries(reasonCounts).sort((a, b) => b[1].total - a[1].total);
  console.log('  Reason           | Total | Rugs  | Survivors | Rug%');
  console.log('  -----------------|-------|-------|-----------|------');
  for (const [reason, counts] of sortedReasons) {
    const rugPct = counts.total > 0 ? ((counts.rug / counts.total) * 100).toFixed(0) : '0';
    console.log(`  ${reason.padEnd(18)}| ${String(counts.total).padEnd(6)}| ${String(counts.rug).padEnd(6)}| ${String(counts.survivor).padEnd(10)}| ${rugPct}%`);
  }
}

// ── Main ────────────────────────────────────────────────────────────

function main() {
  const db = new Database(DB_PATH, { readonly: true });

  exportFullDataset(db);
  exportEnrichedDataset(db);

  console.log('\nDone.');
  db.close();
}

main();
