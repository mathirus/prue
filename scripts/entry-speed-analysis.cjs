const db = require('better-sqlite3')('data/bot.db');

console.log('=== ENTRY SPEED ANALYSIS ===\n');

// Compare detection time vs buy time for v8o trades
console.log('--- v8o TRADES: Detection → Buy timing ---');
const v8oTrades = db.prepare(`
  SELECT p.token_mint, substr(p.token_mint,1,8) as tok,
    p.opened_at, p.entry_price, p.security_score,
    ROUND(p.pnl_pct,1) as pnl_pct, ROUND(p.peak_multiplier,4) as peak,
    ROUND(p.liquidity_usd,0) as liq,
    dp.detected_at, dp.pool_address,
    ta.created_at as analysis_at
  FROM positions p
  LEFT JOIN detected_pools dp ON p.pool_address = dp.pool_address
  LEFT JOIN token_analysis ta ON p.token_mint = ta.token_mint
  WHERE p.bot_version = 'v8o' AND p.status IN ('closed','stopped')
  ORDER BY p.opened_at ASC
`).all();

v8oTrades.forEach(r => {
  const detectedMs = r.detected_at || 0;
  const buyMs = r.opened_at || 0;
  const analysisMs = r.analysis_at || 0;

  const detToBuy = detectedMs > 0 ? ((buyMs - detectedMs) / 1000).toFixed(1) : '?';
  const detToAnalysis = detectedMs > 0 && analysisMs > 0 ? ((analysisMs - detectedMs) / 1000).toFixed(1) : '?';
  const analysisToBuy = analysisMs > 0 ? ((buyMs - analysisMs) / 1000).toFixed(1) : '?';

  console.log(`  ${r.tok} | score=${r.security_score} | $${r.liq} | peak=${r.peak}x | pnl=${r.pnl_pct}%`);
  console.log(`    Detection → Buy: ${detToBuy}s total`);
  console.log(`    Detection → Analysis done: ${detToAnalysis}s`);
  console.log(`    Analysis done → Buy: ${analysisToBuy}s`);
  console.log('');
});

// Same for old trades today for comparison
console.log('--- OLD TRADES TODAY: Detection → Buy timing ---');
const cutoff = new Date('2026-02-09T00:00:00').getTime();
const oldTrades = db.prepare(`
  SELECT p.token_mint, substr(p.token_mint,1,8) as tok,
    p.opened_at, p.security_score,
    ROUND(p.pnl_pct,1) as pnl_pct, ROUND(p.peak_multiplier,4) as peak,
    ROUND(p.liquidity_usd,0) as liq, p.exit_reason,
    dp.detected_at,
    ta.created_at as analysis_at
  FROM positions p
  LEFT JOIN detected_pools dp ON p.pool_address = dp.pool_address
  LEFT JOIN token_analysis ta ON p.token_mint = ta.token_mint
  WHERE p.bot_version IS NULL AND p.status IN ('closed','stopped') AND p.opened_at > ?
  ORDER BY p.opened_at ASC
`).all(cutoff);

oldTrades.forEach(r => {
  const detectedMs = r.detected_at || 0;
  const buyMs = r.opened_at || 0;
  const analysisMs = r.analysis_at || 0;

  const detToBuy = detectedMs > 0 ? ((buyMs - detectedMs) / 1000).toFixed(1) : '?';

  const isRug = r.exit_reason && (r.exit_reason.includes('rug') || r.exit_reason.includes('pool_drained'));
  const tag = isRug ? ' [RUG]' : r.pnl_pct > 0 ? ' [WIN]' : ' [LOSS]';

  console.log(`  ${r.tok} | ${detToBuy}s | score=${r.security_score} | $${r.liq} | peak=${r.peak}x | ${r.pnl_pct}%${tag}`);
});

// Observation window timing
console.log('\n--- OBSERVATION WINDOW CONFIG ---');
console.log('  observation_window.duration_ms: 3000 (3s)');
console.log('  observation_window.poll_interval_ms: 1500 (2 polls)');
console.log('  Analysis checks run in parallel (~1-3s)');
console.log('  Observation runs AFTER analysis passes');
console.log('  Total expected: analysis(1-3s) + observation(3s) + buy_tx(1-2s) = 5-8s');

// Check if faster entry = better peak
console.log('\n--- CORRELATION: Entry speed vs Peak multiplier ---');
const allWithTiming = db.prepare(`
  SELECT p.token_mint, substr(p.token_mint,1,8) as tok,
    p.opened_at, ROUND(p.peak_multiplier,4) as peak,
    ROUND(p.pnl_pct,1) as pnl_pct, ROUND(p.liquidity_usd,0) as liq,
    p.exit_reason,
    dp.detected_at
  FROM positions p
  LEFT JOIN detected_pools dp ON p.pool_address = dp.pool_address
  WHERE p.status IN ('closed','stopped') AND p.opened_at > ? AND dp.detected_at IS NOT NULL
    AND p.peak_multiplier IS NOT NULL
  ORDER BY (p.opened_at - dp.detected_at) ASC
`).all(cutoff);

const fast = allWithTiming.filter(r => (r.opened_at - r.detected_at) < 10000);
const slow = allWithTiming.filter(r => (r.opened_at - r.detected_at) >= 10000);

if (fast.length > 0) {
  const fastAvgPeak = fast.reduce((s,r) => s + (r.peak||1), 0) / fast.length;
  const fastWins = fast.filter(r => r.pnl_pct > 0).length;
  console.log(`  Fast (<10s): N=${fast.length} | avg_peak=${fastAvgPeak.toFixed(3)}x | wins=${fastWins} (${Math.round(100*fastWins/fast.length)}%)`);
}
if (slow.length > 0) {
  const slowAvgPeak = slow.reduce((s,r) => s + (r.peak||1), 0) / slow.length;
  const slowWins = slow.filter(r => r.pnl_pct > 0).length;
  console.log(`  Slow (>=10s): N=${slow.length} | avg_peak=${slowAvgPeak.toFixed(3)}x | wins=${slowWins} (${Math.round(100*slowWins/slow.length)}%)`);
}

console.log('\n--- ALL TRADES WITH ENTRY SPEED (sorted fastest first) ---');
allWithTiming.forEach(r => {
  const speed = ((r.opened_at - r.detected_at) / 1000).toFixed(1);
  const isRug = r.exit_reason && (r.exit_reason.includes('rug') || r.exit_reason.includes('pool_drained') || r.exit_reason.includes('max_retries'));
  const tag = isRug ? 'RUG' : r.pnl_pct > 0 ? 'WIN' : 'LOSS';
  console.log(`  ${speed.padStart(6)}s | ${r.tok} | peak=${(r.peak||0).toFixed(3)}x | ${r.pnl_pct}% | $${r.liq} | ${tag}`);
});

db.close();
