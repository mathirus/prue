#!/usr/bin/env node
/**
 * Compares what ML would do vs what security_score did on ACTUAL trades
 * Key question: Would ML have filtered rugs without killing winners?
 */
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'), { readonly: true });

// Get all closed positions with pool data
const trades = db.prepare(`
  SELECT
    p.token_mint,
    p.security_score,
    p.pnl_sol,
    p.pnl_pct,
    p.exit_reason,
    p.peak_multiplier,
    p.sol_invested,
    d.dp_liquidity_usd,
    d.dp_top_holder_pct,
    d.dp_holder_count,
    d.dp_observation_stable,
    d.dp_observation_drop_pct,
    d.dp_graduation_time_s,
    d.dp_creator_reputation,
    tc.wallet_age_seconds,
    tc.tx_count as creator_tx_count
  FROM positions p
  LEFT JOIN detected_pools d ON p.pool_address = d.pool_address
  LEFT JOIN token_creators tc ON p.token_mint = tc.token_mint
  WHERE p.closed_at IS NOT NULL
  ORDER BY p.opened_at DESC
`).all();

console.log(`TOTAL TRADES CERRADOS: ${trades.length}\n`);

// Classify
const rugs = trades.filter(t => (t.exit_reason || '').includes('rug') || (t.exit_reason || '').includes('honeypot'));
const winners = trades.filter(t => (t.pnl_sol || 0) > 0);
const losers = trades.filter(t => (t.pnl_sol || 0) <= 0 && !(t.exit_reason || '').includes('rug') && !(t.exit_reason || '').includes('honeypot'));

console.log(`Rugs/honeypots: ${rugs.length}`);
console.log(`Winners (pnl>0): ${winners.length}`);
console.log(`Losers (no rug): ${losers.length}`);

// Show each trade
console.log('\n' + '='.repeat(130));
console.log('  TODOS LOS TRADES — ¿Qué diferencia a rugs de winners?');
console.log('='.repeat(130));
console.log(
  'Token'.padEnd(12) + '| ' +
  'Score'.padStart(5) + ' | ' +
  'Liq$'.padStart(7) + ' | ' +
  'TopH%'.padStart(6) + ' | ' +
  'Holdr'.padStart(5) + ' | ' +
  'Obs'.padStart(3) + ' | ' +
  'GradS'.padStart(5) + ' | ' +
  'CrAge'.padStart(6) + ' | ' +
  'CrRep'.padStart(5) + ' | ' +
  'Exit'.padEnd(20) + '| ' +
  'PnL%'.padStart(7) + ' | ' +
  'Peak'.padStart(5)
);
console.log('-'.repeat(130));

for (const t of trades) {
  const isRug = (t.exit_reason || '').includes('rug') || (t.exit_reason || '').includes('honeypot');
  const isWin = (t.pnl_sol || 0) > 0;
  const marker = isRug ? ' *** RUG' : isWin ? '' : ' loss';
  const liq = t.dp_liquidity_usd || 0;
  const pnl = t.pnl_pct || 0;

  console.log(
    t.token_mint.substring(0, 10).padEnd(12) + '| ' +
    String(t.security_score || '?').padStart(5) + ' | ' +
    ('$' + liq.toFixed(0)).padStart(7) + ' | ' +
    ((t.dp_top_holder_pct || 0).toFixed(1) + '%').padStart(6) + ' | ' +
    String(t.dp_holder_count || '?').padStart(5) + ' | ' +
    (t.dp_observation_stable === 1 ? 'Y' : 'N').padStart(3) + ' | ' +
    String(t.dp_graduation_time_s || '?').padStart(5) + ' | ' +
    (t.wallet_age_seconds ? t.wallet_age_seconds + 's' : '?').padStart(6) + ' | ' +
    String(t.dp_creator_reputation || '?').padStart(5) + ' | ' +
    (t.exit_reason || '?').substring(0, 18).padEnd(20) + '| ' +
    ((pnl > 0 ? '+' : '') + pnl.toFixed(0) + '%').padStart(7) + ' | ' +
    ((t.peak_multiplier || 0).toFixed(2) + 'x').padStart(5) +
    marker
  );
}

// ANALYSIS: Can ANY single feature separate rugs from winners?
console.log('\n' + '='.repeat(100));
console.log('  FEATURE COMPARISON: Rugs vs Winners');
console.log('='.repeat(100));

function stats(label, arr, getter) {
  const vals = arr.map(getter).filter(v => v !== null && v !== undefined && !isNaN(v));
  if (vals.length === 0) return `${label}: no data`;
  const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
  const sorted = vals.sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  return `${label}: avg=${avg.toFixed(1)}, median=${median.toFixed(1)}, min=${min.toFixed(1)}, max=${max.toFixed(1)}, N=${vals.length}`;
}

console.log('\nRUGS:');
console.log('  ' + stats('Liquidity $', rugs, r => r.dp_liquidity_usd));
console.log('  ' + stats('Top Holder %', rugs, r => r.dp_top_holder_pct));
console.log('  ' + stats('Holders', rugs, r => r.dp_holder_count));
console.log('  ' + stats('Score', rugs, r => r.security_score));
console.log('  ' + stats('Graduation s', rugs, r => r.dp_graduation_time_s));
console.log('  ' + stats('Creator age s', rugs, r => r.wallet_age_seconds));
console.log('  ' + stats('Creator rep', rugs, r => r.dp_creator_reputation));

console.log('\nWINNERS:');
console.log('  ' + stats('Liquidity $', winners, r => r.dp_liquidity_usd));
console.log('  ' + stats('Top Holder %', winners, r => r.dp_top_holder_pct));
console.log('  ' + stats('Holders', winners, r => r.dp_holder_count));
console.log('  ' + stats('Score', winners, r => r.security_score));
console.log('  ' + stats('Graduation s', winners, r => r.dp_graduation_time_s));
console.log('  ' + stats('Creator age s', winners, r => r.wallet_age_seconds));
console.log('  ' + stats('Creator rep', winners, r => r.dp_creator_reputation));

console.log('\nLOSERS (no rug):');
console.log('  ' + stats('Liquidity $', losers, r => r.dp_liquidity_usd));
console.log('  ' + stats('Top Holder %', losers, r => r.dp_top_holder_pct));
console.log('  ' + stats('Score', losers, r => r.security_score));

// SIMULATE: Would a liquidity-only filter help?
console.log('\n' + '='.repeat(100));
console.log('  SIMULATION: ¿Qué pasa si filtramos SOLO por liquidez?');
console.log('='.repeat(100));

for (const threshold of [5000, 8000, 10000, 15000, 20000]) {
  const filteredRugs = rugs.filter(r => (r.dp_liquidity_usd || 0) >= threshold);
  const filteredWinners = winners.filter(r => (r.dp_liquidity_usd || 0) >= threshold);
  const filteredLosers = losers.filter(r => (r.dp_liquidity_usd || 0) >= threshold);
  const totalFiltered = trades.filter(r => (r.dp_liquidity_usd || 0) >= threshold);
  const rugsPrevented = rugs.length - filteredRugs.length;
  const winnersKilled = winners.length - filteredWinners.length;

  console.log(`\n  Liq >= $${threshold}:`);
  console.log(`    Trades left: ${totalFiltered.length}/${trades.length}`);
  console.log(`    Rugs prevented: ${rugsPrevented}/${rugs.length} (${(rugsPrevented/Math.max(rugs.length,1)*100).toFixed(0)}%)`);
  console.log(`    Winners killed: ${winnersKilled}/${winners.length} (${(winnersKilled/Math.max(winners.length,1)*100).toFixed(0)}%)`);
  console.log(`    Remaining: ${filteredRugs.length} rugs, ${filteredWinners.length} wins, ${filteredLosers.length} losses`);

  const totalPnl = totalFiltered.reduce((s, t) => s + (t.pnl_sol || 0), 0);
  console.log(`    Net PnL: ${totalPnl.toFixed(4)} SOL`);
}

// What about score threshold?
console.log('\n' + '='.repeat(100));
console.log('  SIMULATION: ¿Qué pasa con distintos min_score?');
console.log('='.repeat(100));

for (const minScore of [60, 65, 70, 75, 80, 85]) {
  const filtered = trades.filter(r => (r.security_score || 0) >= minScore);
  const fRugs = filtered.filter(t => (t.exit_reason || '').includes('rug') || (t.exit_reason || '').includes('honeypot'));
  const fWins = filtered.filter(t => (t.pnl_sol || 0) > 0);
  const totalPnl = filtered.reduce((s, t) => s + (t.pnl_sol || 0), 0);

  console.log(`  Score >= ${minScore}: ${filtered.length} trades, ${fRugs.length} rugs, ${fWins.length} wins, PnL=${totalPnl.toFixed(4)} SOL`);
}

db.close();
console.log('\nDone.');
