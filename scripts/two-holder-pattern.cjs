const db = require('better-sqlite3')('data/bot.db');

// Pattern: All high-liq ($30K+) tokens have 2 holders
// Is there any signal to distinguish winners from rugs among these?

console.log('=== 2-HOLDER HIGH-LIQ PATTERN (Feb 8-9) ===');
const cutoff = new Date('2026-02-08T00:00:00').getTime();

const twoHolderTrades = db.prepare(`
  SELECT substr(p.token_mint,1,8) as tok,
    ROUND(p.pnl_sol, 6) as pnl, ROUND(p.pnl_pct, 1) as pct,
    p.exit_reason, p.security_score as score,
    ROUND(p.liquidity_usd, 0) as liq,
    p.holder_count as holders,
    ROUND(p.peak_multiplier, 3) as peak,
    ROUND((p.closed_at - p.opened_at)/1000.0, 0) as hold_sec,
    p.sell_attempts, p.sell_successes,
    datetime(p.opened_at/1000, 'unixepoch', 'localtime') as opened,
    dp.dp_graduation_time_s as grad
  FROM positions p
  LEFT JOIN detected_pools dp ON p.pool_address = dp.pool_address
  WHERE p.status IN ('closed','stopped') AND p.holder_count = 2 AND p.opened_at > ?
  ORDER BY p.opened_at DESC
`).all(cutoff);

console.log(`Total 2-holder trades: ${twoHolderTrades.length}`);
const wins2h = twoHolderTrades.filter(r => r.pnl > 0);
const rugs2h = twoHolderTrades.filter(r => r.exit_reason && (r.exit_reason.includes('rug') || r.exit_reason.includes('pool_drained')));
console.log(`Wins: ${wins2h.length}, Rugs: ${rugs2h.length}`);
console.log(`Win rate: ${(100 * wins2h.length / twoHolderTrades.length).toFixed(1)}%`);
console.log(`Rug rate: ${(100 * rugs2h.length / twoHolderTrades.length).toFixed(1)}%`);

console.log('\nDetailed trades:');
twoHolderTrades.forEach(r => {
  const gradStr = r.grad != null && r.grad >= 0 ? `${Math.round(r.grad/60)}min` : 'N/A';
  const outcome = r.pnl > 0 ? 'WIN ' : 'LOSS';
  console.log(`  ${r.opened} | ${outcome} | ${r.tok} | liq=$${r.liq} | grad=${gradStr} | peak=${r.peak}x | hold=${r.hold_sec}s | ${r.exit_reason} | ${r.pnl} SOL`);
});

// Compare: winners vs rugs - what signals differ?
console.log('\n=== WINNERS vs RUGS (2-holder, $30K+) ===');
if (wins2h.length > 0) {
  const avgWinLiq = wins2h.reduce((s,r) => s + r.liq, 0) / wins2h.length;
  const avgWinPeak = wins2h.filter(r => r.peak).reduce((s,r) => s + r.peak, 0) / wins2h.filter(r => r.peak).length;
  const avgWinHold = wins2h.reduce((s,r) => s + (r.hold_sec||0), 0) / wins2h.length;
  console.log(`Winners (${wins2h.length}): avg liq=$${Math.round(avgWinLiq)}, avg peak=${avgWinPeak.toFixed(2)}x, avg hold=${Math.round(avgWinHold)}s`);
}
if (rugs2h.length > 0) {
  const avgRugLiq = rugs2h.reduce((s,r) => s + r.liq, 0) / rugs2h.length;
  const avgRugPeak = rugs2h.filter(r => r.peak).reduce((s,r) => s + r.peak, 0) / rugs2h.filter(r => r.peak).length;
  const avgRugHold = rugs2h.reduce((s,r) => s + (r.hold_sec||0), 0) / rugs2h.length;
  console.log(`Rugs (${rugs2h.length}): avg liq=$${Math.round(avgRugLiq)}, avg peak=${avgRugPeak.toFixed(2)}x, avg hold=${Math.round(avgRugHold)}s`);
}

// All non-2-holder trades for comparison
console.log('\n=== NON-2-HOLDER COMPARISON (Feb 8-9) ===');
const non2h = db.prepare(`
  SELECT
    COUNT(*) as n,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN exit_reason IN ('rug_pull','pool_drained','max_retries','max_retries_429') THEN 1 ELSE 0 END) as rugs,
    ROUND(SUM(pnl_sol), 6) as pnl,
    ROUND(AVG(pnl_sol), 6) as avg_pnl,
    ROUND(AVG(liquidity_usd), 0) as avg_liq,
    ROUND(AVG(peak_multiplier), 3) as avg_peak
  FROM positions
  WHERE status IN ('closed','stopped') AND holder_count != 2 AND holder_count IS NOT NULL AND opened_at > ?
`).get(cutoff);
const h2 = db.prepare(`
  SELECT
    COUNT(*) as n,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN exit_reason IN ('rug_pull','pool_drained','max_retries','max_retries_429') THEN 1 ELSE 0 END) as rugs,
    ROUND(SUM(pnl_sol), 6) as pnl,
    ROUND(AVG(pnl_sol), 6) as avg_pnl,
    ROUND(AVG(liquidity_usd), 0) as avg_liq,
    ROUND(AVG(peak_multiplier), 3) as avg_peak
  FROM positions
  WHERE status IN ('closed','stopped') AND holder_count = 2 AND opened_at > ?
`).get(cutoff);

console.log(`2 holders:   ${h2.n} trades, ${h2.wins} wins (${h2.n>0?Math.round(100*h2.wins/h2.n):0}%), ${h2.rugs} rugs (${h2.n>0?Math.round(100*h2.rugs/h2.n):0}%), ${h2.pnl} SOL (avg ${h2.avg_pnl}), avg liq=$${h2.avg_liq}`);
console.log(`Non-2 hold:  ${non2h.n} trades, ${non2h.wins} wins (${non2h.n>0?Math.round(100*non2h.wins/non2h.n):0}%), ${non2h.rugs} rugs (${non2h.n>0?Math.round(100*non2h.rugs/non2h.n):0}%), ${non2h.pnl} SOL (avg ${non2h.avg_pnl}), avg liq=$${non2h.avg_liq}`);

// Time to rug for 2-holder rugs (how fast do they drain?)
console.log('\n=== RUG TIMING: 2-holder rugs ===');
const rug2hTrades = db.prepare(`
  SELECT substr(token_mint,1,8) as tok,
    ROUND((closed_at - opened_at)/1000.0, 0) as hold_sec,
    ROUND(peak_multiplier, 3) as peak,
    ROUND(liquidity_usd, 0) as liq,
    datetime(opened_at/1000, 'unixepoch', 'localtime') as opened
  FROM positions
  WHERE status IN ('closed','stopped') AND holder_count = 2
    AND exit_reason IN ('rug_pull','pool_drained','max_retries','max_retries_429')
    AND opened_at > ?
  ORDER BY (closed_at - opened_at)
`).all(cutoff);
rug2hTrades.forEach(r => {
  console.log(`  ${r.opened} | ${r.tok} | liq=$${r.liq} | peak=${r.peak}x | rug after ${r.hold_sec}s`);
});

db.close();
