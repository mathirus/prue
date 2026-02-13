/**
 * Audit shadow mode data quality — verify all tables are clean for ML training.
 */
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'), { readonly: true });

console.log('========== SHADOW DATA AUDIT ==========\n');

// 1. Pool Outcome Checks
console.log('--- POOL OUTCOME CHECKS ---');
const checks = db.prepare('SELECT * FROM pool_outcome_checks ORDER BY checked_at ASC').all();
console.log('Total checks:', checks.length);

let checkIssues = [];
for (const c of checks) {
  if (c.pool_id == null) checkIssues.push('no pool_id');
  if (c.token_mint == null) checkIssues.push('no token_mint');
  if (c.check_label == null) checkIssues.push('no check_label');
  if (c.delay_minutes == null) checkIssues.push('no delay_minutes');
  if (c.price_native == null && c.is_alive === 1) {
    checkIssues.push(`alive but no price: ${c.pool_id} @${c.delay_minutes}min`);
  }
}
console.log(checkIssues.length === 0 ? '  OK: No issues' : `  Issues: ${checkIssues.length}`);
checkIssues.forEach(i => console.log(`    - ${i}`));

const byDelay = db.prepare('SELECT delay_minutes, COUNT(*) as c, SUM(is_alive) as alive FROM pool_outcome_checks GROUP BY delay_minutes ORDER BY delay_minutes').all();
byDelay.forEach(d => console.log(`  ${d.delay_minutes}min: ${d.c} checks, ${d.alive} alive`));

console.log('\n  Sample:');
checks.slice(0, 10).forEach(c => {
  const p = c.price_native !== null ? c.price_native.toExponential(3) : 'null';
  const l = c.liquidity_usd !== null ? Math.round(c.liquidity_usd) : 'null';
  const m = c.market_cap !== null ? Math.round(c.market_cap) : 'null';
  console.log(`  ${c.pool_id.slice(0,16)} @${c.delay_minutes}min | price=${p} | liq=$${l} | mcap=$${m} | alive=${c.is_alive}`);
});

// 2. Cross-table: shadow positions vs detected_pools
console.log('\n--- CROSS-TABLE CONSISTENCY ---');
const shadowPools = db.prepare('SELECT pool_id FROM shadow_positions').all().map(r => r.pool_id);
const detectedIds = db.prepare("SELECT id FROM detected_pools WHERE bot_version = 'v9a'").all().map(r => r.id);
const missingInDetected = shadowPools.filter(p => !detectedIds.includes(p));
console.log(`  Shadow→Detected missing: ${missingInDetected.length}${missingInDetected.length > 0 ? ' ' + JSON.stringify(missingInDetected) : ''}`);
console.log(`  v9a detected_pools: ${detectedIds.length}`);
console.log(`  v9a shadow_positions: ${shadowPools.length}`);
console.log(`  Shadow capture rate: ${(shadowPools.length / detectedIds.length * 100).toFixed(0)}%`);

// Check outcome checks reference valid pools
const outcomePoolIds = db.prepare('SELECT DISTINCT pool_id FROM pool_outcome_checks').all().map(r => r.pool_id);
const missingOutcome = outcomePoolIds.filter(p => !detectedIds.includes(p));
console.log(`  Outcome→Detected missing: ${missingOutcome.length}`);

// 3. entry_sol_reserve fill rate
console.log('\n--- ENTRY_SOL_RESERVE ---');
const totalShadow = db.prepare('SELECT COUNT(*) as c FROM shadow_positions').get().c;
const withReserve = db.prepare('SELECT COUNT(*) as c FROM shadow_positions WHERE entry_sol_reserve IS NOT NULL AND entry_sol_reserve > 0').get().c;
console.log(`  Filled: ${withReserve}/${totalShadow} (${(withReserve/totalShadow*100).toFixed(0)}%)`);

// 4. Price log reserve completeness
console.log('\n--- PRICE LOG SOL_RESERVE ---');
const totalLogs = db.prepare('SELECT COUNT(*) as c FROM shadow_price_log').get().c;
const withLogReserve = db.prepare('SELECT COUNT(*) as c FROM shadow_price_log WHERE sol_reserve IS NOT NULL AND sol_reserve > 0').get().c;
console.log(`  With reserve: ${withLogReserve}/${totalLogs} (${(withLogReserve/totalLogs*100).toFixed(0)}%)`);

// 5. Export test (dry run)
console.log('\n--- EXPORT DRY RUN ---');
const exportQuery = `
SELECT
  dp.id, dp.source, dp.security_score, dp.security_passed,
  dp.dp_liquidity_usd, dp.dp_holder_count, dp.dp_top_holder_pct,
  dp.dp_honeypot_verified, dp.dp_mint_auth_revoked, dp.dp_freeze_auth_revoked,
  dp.dp_rugcheck_score, dp.dp_lp_burned, dp.dp_graduation_time_s,
  dp.dp_bundle_penalty, dp.dp_insiders_count,
  dp.dp_creator_reputation, dp.dp_observation_stable, dp.dp_observation_drop_pct,
  dp.rejection_reasons, dp.dp_rejection_stage,
  sp.peak_multiplier, sp.time_to_peak_ms, sp.final_multiplier,
  sp.tp1_hit, sp.tp1_time_ms, sp.tp2_hit, sp.tp2_time_ms,
  sp.tp3_hit, sp.tp3_time_ms, sp.sl_hit, sp.sl_time_ms,
  sp.rug_detected, sp.rug_reserve_drop_pct, sp.exit_reason,
  sp.entry_sol_reserve, sp.total_polls,
  poc5.price_native as dex_5m_price, poc5.liquidity_usd as dex_5m_liq,
  poc15.price_native as dex_15m_price, poc15.liquidity_usd as dex_15m_liq,
  poc30.price_native as dex_30m_price, poc60.price_native as dex_60m_price,
  poc60.is_alive as alive_60m
FROM detected_pools dp
LEFT JOIN shadow_positions sp ON dp.id = sp.pool_id
LEFT JOIN pool_outcome_checks poc5  ON dp.id = poc5.pool_id  AND poc5.delay_minutes = 5
LEFT JOIN pool_outcome_checks poc15 ON dp.id = poc15.pool_id AND poc15.delay_minutes = 15
LEFT JOIN pool_outcome_checks poc30 ON dp.id = poc30.pool_id AND poc30.delay_minutes = 30
LEFT JOIN pool_outcome_checks poc60 ON dp.id = poc60.pool_id AND poc60.delay_minutes = 60
WHERE dp.bot_version = 'v9a'
ORDER BY dp.detected_at ASC`;

try {
  const rows = db.prepare(exportQuery).all();
  console.log(`  Export query: ${rows.length} rows`);

  // Count how many have shadow data
  const withShadow = rows.filter(r => r.peak_multiplier !== null).length;
  const withDex5 = rows.filter(r => r.dex_5m_price !== null).length;
  const withDex15 = rows.filter(r => r.dex_15m_price !== null).length;
  const withDex30 = rows.filter(r => r.dex_30m_price !== null).length;
  const withDex60 = rows.filter(r => r.dex_60m_price !== null).length;

  console.log(`  With shadow data: ${withShadow}/${rows.length}`);
  console.log(`  With DexScreener 5m: ${withDex5}/${rows.length}`);
  console.log(`  With DexScreener 15m: ${withDex15}/${rows.length}`);
  console.log(`  With DexScreener 30m: ${withDex30}/${rows.length}`);
  console.log(`  With DexScreener 60m: ${withDex60}/${rows.length}`);

  // Timeseries export test
  const tsRows = db.prepare(`
    SELECT COUNT(*) as c FROM shadow_positions sp
    JOIN shadow_price_log spl ON sp.id = spl.shadow_id
    WHERE sp.entry_price > 0
  `).get();
  console.log(`  Timeseries rows: ${tsRows.c}`);

} catch (e) {
  console.log(`  EXPORT FAILED: ${e.message}`);
}

// 6. Summary
console.log('\n========== SUMMARY ==========');
const allIssues = [];

if (checkIssues.length > 0) allIssues.push(`Outcome checks: ${checkIssues.length} issues`);
if (missingInDetected.length > 0) allIssues.push(`Shadow→Detected: ${missingInDetected.length} missing`);
if (missingOutcome.length > 0) allIssues.push(`Outcome→Detected: ${missingOutcome.length} missing`);
if (withReserve / totalShadow < 0.5) allIssues.push(`entry_sol_reserve: only ${(withReserve/totalShadow*100).toFixed(0)}% filled`);

if (allIssues.length === 0) {
  console.log('ALL CHECKS PASSED - Data is clean for ML training');
} else {
  console.log(`${allIssues.length} issues to address:`);
  allIssues.forEach(i => console.log(`  - ${i}`));
}

db.close();
