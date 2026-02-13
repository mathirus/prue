const db = require('better-sqlite3')('data/bot.db');
const now = Date.now();

console.log('=== v8o + v8p TRADES DETALLADOS ===\n');

const pos = db.prepare(`
  SELECT token_mint, status, pnl_sol, pnl_pct, sol_invested, sol_returned,
    exit_reason, bot_version, opened_at, closed_at, sell_attempts, sell_successes
  FROM positions WHERE bot_version IN ('v8o', 'v8p')
  ORDER BY opened_at ASC
`).all();

pos.forEach((p, i) => {
  const openTime = new Date(p.opened_at).toLocaleTimeString('es-AR');
  const closeTime = p.closed_at ? new Date(p.closed_at).toLocaleTimeString('es-AR') : 'active';
  const dur = p.closed_at ? ((p.closed_at - p.opened_at) / 1000).toFixed(0) + 's' : '-';
  console.log(`  ${i + 1}. ${p.token_mint.slice(0, 8)} | ${p.bot_version} | invested=${p.sol_invested} | returned=${p.sol_returned.toFixed(6)} | pnl=${p.pnl_sol.toFixed(6)} (${p.pnl_pct.toFixed(1)}%) | ${p.status} | ${openTime}-${closeTime} (${dur})`);
});

// Totals
const invested = pos.reduce((s, p) => s + p.sol_invested, 0);
const returned = pos.reduce((s, p) => s + p.sol_returned, 0);
const pnl = pos.reduce((s, p) => s + p.pnl_sol, 0);
console.log(`\nTotals: invested=${invested.toFixed(6)} returned=${returned.toFixed(6)} pnl=${pnl.toFixed(6)}`);
console.log(`Net flow: ${(returned - invested).toFixed(6)} SOL (this is what actually went in/out of wallet)`);

// v8o timing
const v8oPos = pos.filter(p => p.bot_version === 'v8o');
if (v8oPos.length > 0) {
  const first = v8oPos[0].opened_at;
  const last = v8oPos[v8oPos.length - 1].closed_at || now;
  console.log(`\nv8o: ${v8oPos.length} trades over ${((last - first) / 60000).toFixed(0)} min`);
  console.log(`  ${new Date(first).toLocaleTimeString('es-AR')} → ${new Date(last).toLocaleTimeString('es-AR')}`);
}

// v8p timing
const v8pPos = pos.filter(p => p.bot_version === 'v8p');
if (v8pPos.length > 0) {
  const first = v8pPos[0].opened_at;
  const last = v8pPos[v8pPos.length - 1].closed_at || now;
  console.log(`\nv8p: ${v8pPos.length} trades over ${((last - first) / 60000).toFixed(0)} min`);
  console.log(`  ${new Date(first).toLocaleTimeString('es-AR')} → ${new Date(last).toLocaleTimeString('es-AR')}`);
  // Pools detected during v8p period
  const v8pPools = db.prepare(`SELECT COUNT(*) as n FROM detected_pools WHERE bot_version = 'v8p'`).get();
  console.log(`  Pools detected: ${v8pPools.n}`);
  console.log(`  Pass rate: ${(v8pPos.length / v8pPools.n * 100).toFixed(1)}%`);
  console.log(`  Trade frequency: 1 trade every ${((last - first) / v8pPos.length / 60000).toFixed(0)} min`);
}

// Buy failures (confirmation timeouts cost fees!)
// Each failed TX costs ~0.00006 SOL (priority fee) + 0.000005 SOL (base fee)
// But confirmation timeouts mean the TX WAS sent, might have landed or not
// If it landed, it was a real trade that failed
console.log(`\n=== FEE DRAIN ANALYSIS ===`);

// Count how many pools were detected and analyzed (but didn't result in position)
const v8pDetected = db.prepare(`SELECT COUNT(*) as n FROM detected_pools WHERE bot_version = 'v8p'`).get();
const v8pPassed = db.prepare(`SELECT COUNT(*) as n FROM detected_pools WHERE bot_version = 'v8p' AND dp_rejection_stage IS NULL`).get();
const v8pTraded = v8pPos.length;
console.log(`v8p funnel: ${v8pDetected.n} detected → ${v8pPassed.n} passed security → ${v8pTraded} positions opened`);

// Each buy/sell TX has fees:
// Buy: ~0.00006 SOL (priority) + ~0.000005 SOL (base) = ~0.000065 SOL
// Sell: similar
// Each position: 1 buy + 1-2 sells = ~0.00013-0.0002 SOL in fees
const estimatedFees = v8pTraded * 0.0002; // ~2 sells per position
console.log(`Estimated TX fees for ${v8pTraded} positions: ~${estimatedFees.toFixed(6)} SOL`);
console.log(`Net PnL after fees: ~${(pnl - estimatedFees).toFixed(6)} SOL`);

// Actually: pnl already includes the buy cost (sol_invested includes fees?)
// Let me check: sol_invested = how much SOL we put in, sol_returned = how much we got back
// The PnL should be sol_returned - sol_invested
console.log(`\nPnL check: returned - invested = ${(returned - invested).toFixed(6)} SOL`);
console.log(`PnL from DB: ${pnl.toFixed(6)} SOL`);
console.log(`Difference (unaccounted fees?): ${(pnl - (returned - invested)).toFixed(6)} SOL`);

db.close();
