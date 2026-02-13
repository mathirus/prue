const Database = require('better-sqlite3');
const db = new Database('data/bot.db');

// Investigate all trades that hit TP1 but ended negative
console.log('=== TP1-HIT TRADES THAT ENDED NEGATIVE (ALL TIME) ===\n');

const tp1bleeds = db.prepare(`
  SELECT token_mint, security_score,
    ROUND(pnl_pct,1) as pnl_pct, ROUND(pnl_sol,6) as pnl_sol,
    ROUND(entry_price, 12) as entry,
    ROUND(peak_price/NULLIF(entry_price,0),2) as peak_x,
    ROUND((closed_at - opened_at)/60000.0,1) as dur_min,
    ROUND(sol_invested,6) as invested, ROUND(sol_returned,6) as returned,
    tp_levels_hit, opened_at
  FROM positions
  WHERE status IN ('closed','stopped')
    AND tp_levels_hit LIKE '%0%'
    AND pnl_pct < 0
  ORDER BY opened_at DESC
`).all();

console.log('Total TP1-hit negative trades:', tp1bleeds.length);
let totalLost = 0;
tp1bleeds.forEach(t => {
  // TP1 sells 65% at 1.25x, so returned from TP1 = 0.65 * invested * 1.25
  const tp1Return = 0.65 * t.invested * 1.25;
  const remainingInvested = 0.35 * t.invested;
  // If pnl is negative, the remaining 35% lost more than TP1 gained
  const remainingLoss = t.pnl_sol - (tp1Return - t.invested * 0.65);

  console.log(
    (t.token_mint || '').slice(0,8),
    'score:', t.security_score,
    'pnl:', t.pnl_pct + '%', t.pnl_sol + ' SOL',
    'peak:', t.peak_x + 'x',
    'dur:', t.dur_min + 'min',
    'tp:', t.tp_levels_hit,
    '| TP1 returned:', tp1Return.toFixed(6),
    'remaining lost:', (t.returned - tp1Return).toFixed(6)
  );
  totalLost += t.pnl_sol;
});

console.log('\nTotal PnL from TP1-bleed trades:', totalLost.toFixed(6), 'SOL');

// What if we sold ALL at TP1 (no trailing, no moon bag)?
console.log('\n=== WHAT-IF: SELL 100% AT TP1 (no trailing) ===');
const allTP1 = db.prepare(`
  SELECT token_mint,
    ROUND(pnl_pct,1) as actual_pnl,
    ROUND(pnl_sol,6) as actual_sol,
    ROUND(sol_invested,6) as invested,
    ROUND(sol_returned,6) as returned,
    ROUND(peak_price/NULLIF(entry_price,0),2) as peak_x,
    tp_levels_hit
  FROM positions
  WHERE status IN ('closed','stopped')
    AND tp_levels_hit LIKE '%0%'
    AND sol_invested >= 0.002
  ORDER BY opened_at DESC LIMIT 30
`).all();

let actualTotal = 0;
let whatIfTotal = 0;
allTP1.forEach(t => {
  const whatIfReturn = t.invested * 1.25; // sell 100% at 1.25x
  const whatIfPnl = whatIfReturn - t.invested;
  const diff = whatIfPnl - t.actual_sol;
  actualTotal += t.actual_sol;
  whatIfTotal += whatIfPnl;

  const better = diff > 0 ? 'WORSE (TP2/trailing lost money)' : 'BETTER (TP2/trailing gained)';
  console.log(
    (t.token_mint || '').slice(0,8),
    'actual:', t.actual_pnl + '%', t.actual_sol + ' SOL',
    'peak:', t.peak_x + 'x',
    'tp:', t.tp_levels_hit,
    '| 100%@TP1:', whatIfPnl.toFixed(6), 'SOL',
    '|', better
  );
});

console.log('\n--- SUMMARY ---');
console.log('Actual total PnL:', actualTotal.toFixed(6), 'SOL');
console.log('What-if 100%@TP1:', whatIfTotal.toFixed(6), 'SOL');
console.log('Difference:', (whatIfTotal - actualTotal).toFixed(6), 'SOL');
console.log(whatIfTotal > actualTotal ? 'SELLING 100% AT TP1 WOULD BE BETTER' : 'CURRENT STRATEGY IS BETTER (TP2/TP3 add value)');

db.close();
