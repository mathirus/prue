const db = require('better-sqlite3')('data/bot.db');

// All trades with peak multiplier data, grouped by version
console.log('=== PEAK MULTIPLIERS POR VERSION ===\n');

const all = db.prepare(`
  SELECT token_mint, pnl_pct, peak_multiplier, exit_reason, bot_version,
    opened_at, status, security_score
  FROM positions
  WHERE status IN ('closed', 'stopped', 'partial_close')
  ORDER BY opened_at ASC
`).all();

// Group by version
const byVersion = {};
all.forEach(t => {
  const v = t.bot_version || 'old';
  if (!byVersion[v]) byVersion[v] = [];
  byVersion[v].push(t);
});

Object.entries(byVersion).forEach(([ver, trades]) => {
  const peaks = trades.filter(t => t.peak_multiplier).map(t => t.peak_multiplier);
  const over2x = peaks.filter(p => p >= 2.0).length;
  const over3x = peaks.filter(p => p >= 3.0).length;
  const over4x = peaks.filter(p => p >= 4.0).length;
  const avgPeak = peaks.length > 0 ? (peaks.reduce((a,b) => a+b, 0) / peaks.length).toFixed(3) : '?';
  const maxPeak = peaks.length > 0 ? Math.max(...peaks).toFixed(2) : '?';

  console.log(`${ver}: ${trades.length} trades | peaks tracked: ${peaks.length}`);
  console.log(`  Avg peak: ${avgPeak}x | Max peak: ${maxPeak}x`);
  console.log(`  >=2x: ${over2x} | >=3x: ${over3x} | >=4x: ${over4x}`);
  console.log();
});

// Show ALL trades that ever reached 2x+
console.log('=== TODOS LOS QUE LLEGARON A 2x+ (peak) ===\n');
const big = all.filter(t => t.peak_multiplier >= 2.0);
if (big.length === 0) {
  console.log('(ninguno con peak_multiplier >= 2x registrado)');
} else {
  big.forEach(t => {
    const date = new Date(t.opened_at);
    const d = date.toISOString().slice(0, 10);
    const h = date.getHours() + ':' + String(date.getMinutes()).padStart(2, '0');
    console.log(`  ${d} ${h} | ${(t.bot_version||'old').padEnd(4)} | ${t.token_mint.slice(0,8)} | peak=${t.peak_multiplier.toFixed(2)}x | pnl=${t.pnl_pct.toFixed(1)}% | exit=${t.exit_reason||'?'} | score=${t.security_score}`);
  });
}

// Check post-sell data: tokens that went 2x+ AFTER we sold
console.log('\n=== TOKENS QUE SUBIERON 2x+ DESPUES DE VENDER ===\n');
const postSell = db.prepare(`
  SELECT token_mint, pnl_pct, peak_multiplier, post_sell_max_multiplier,
    post_sell_dex_change_24h, bot_version, opened_at, security_score, exit_reason
  FROM positions
  WHERE post_sell_max_multiplier >= 2.0
  ORDER BY opened_at DESC
  LIMIT 20
`).all();

if (postSell.length === 0) {
  console.log('(ninguno con post_sell >= 2x)');
} else {
  postSell.forEach(t => {
    const date = new Date(t.opened_at);
    const d = date.toISOString().slice(0, 10);
    console.log(`  ${d} | ${(t.bot_version||'old').padEnd(4)} | ${t.token_mint.slice(0,8)} | our_exit=${t.pnl_pct.toFixed(1)}% | post_sell=${t.post_sell_max_multiplier.toFixed(1)}x | dex24h=${t.post_sell_dex_change_24h ? t.post_sell_dex_change_24h.toFixed(0)+'%' : '?'} | score=${t.security_score}`);
  });
}

// Check: what score did the big winners have vs what we filter now (min_score 80)
console.log('\n=== TOKENS RECHAZADOS QUE DESPUES SUBIERON (detected_pools con outcome) ===\n');
const rejected = db.prepare(`
  SELECT base_mint, security_score, security_passed, pool_outcome, dp_liquidity_usd,
    dp_rejection_stage, bot_version, detected_at
  FROM detected_pools
  WHERE pool_outcome = 'alive' AND security_passed = 0
  ORDER BY detected_at DESC
  LIMIT 15
`).all();

if (rejected.length === 0) {
  console.log('(sin datos de pool_outcome en rechazados)');
} else {
  rejected.forEach(t => {
    const date = new Date(t.detected_at);
    console.log(`  ${date.toISOString().slice(0,10)} | ${t.base_mint.slice(0,8)} | score=${t.security_score} | liq=$${t.dp_liquidity_usd ? Math.round(t.dp_liquidity_usd) : '?'} | rejected_at=${t.dp_rejection_stage||'?'} | ver=${t.bot_version||'?'}`);
  });
}

// Score distribution of what passes vs what doesn't now
console.log('\n=== SCORE DISTRIBUTION (ultimas 24h) ===\n');
const now = Date.now();
const recent = db.prepare(`
  SELECT score, passed, COUNT(*) as n
  FROM token_analysis
  WHERE created_at > ?
  GROUP BY score, passed
  ORDER BY score DESC
`).all(now - 24 * 60 * 60 * 1000);

recent.forEach(r => {
  console.log(`  Score ${r.score}: ${r.n} tokens | passed=${r.passed}`);
});

// Liquidity of what we're buying vs rejecting
console.log('\n=== LIQUIDEZ: aprobados vs rechazados (ultimas 24h) ===\n');
const liqApproved = db.prepare(`
  SELECT AVG(liquidity_usd) as avg_liq, MIN(liquidity_usd) as min_liq, MAX(liquidity_usd) as max_liq, COUNT(*) as n
  FROM token_analysis WHERE passed = 1 AND created_at > ?
`).get(now - 24 * 60 * 60 * 1000);
const liqRejected = db.prepare(`
  SELECT AVG(liquidity_usd) as avg_liq, MIN(liquidity_usd) as min_liq, MAX(liquidity_usd) as max_liq, COUNT(*) as n
  FROM token_analysis WHERE passed = 0 AND created_at > ?
`).get(now - 24 * 60 * 60 * 1000);

console.log(`  Aprobados (${liqApproved.n}): avg=$${Math.round(liqApproved.avg_liq||0)} | min=$${Math.round(liqApproved.min_liq||0)} | max=$${Math.round(liqApproved.max_liq||0)}`);
console.log(`  Rechazados (${liqRejected.n}): avg=$${Math.round(liqRejected.avg_liq||0)} | min=$${Math.round(liqRejected.min_liq||0)} | max=$${Math.round(liqRejected.max_liq||0)}`);

db.close();
