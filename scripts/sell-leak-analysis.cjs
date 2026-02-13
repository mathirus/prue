const db = require('better-sqlite3')('data/bot.db');

// Analyze positions with excessive sell attempts (the bug we just fixed)
console.log('=== POSITIONS WITH EXCESSIVE SELL ATTEMPTS ===');
const excessive = db.prepare(`
  SELECT id, substr(token_mint,1,12) as tok,
    sell_attempts, sell_successes,
    ROUND(pnl_sol, 6) as pnl, ROUND(pnl_pct, 1) as pct,
    exit_reason, ROUND((closed_at - opened_at)/1000.0, 0) as hold_sec,
    ROUND(sol_invested, 6) as invested, ROUND(sol_returned, 6) as returned,
    ROUND(peak_multiplier, 3) as peak,
    datetime(opened_at/1000, 'unixepoch', 'localtime') as opened
  FROM positions
  WHERE sell_attempts > 10
  ORDER BY sell_attempts DESC
`).all();
console.log(`Found ${excessive.length} positions with >10 sell attempts:`);
excessive.forEach(r => {
  const wastedAttempts = r.sell_attempts - r.sell_successes;
  // Each failed attempt that passes simulation costs ~0.0003 SOL (priority fee + network fee)
  // Simulation failures cost 0. Assume ~50% pass sim and fail on-chain.
  const estWastedFees = wastedAttempts * 0.00015; // conservative estimate
  console.log(`  ${r.opened} | ${r.tok} | ${r.sell_attempts} attempts, ${r.sell_successes} success | ${r.hold_sec}s | peak=${r.peak}x | ${r.exit_reason} | est wasted: ${estWastedFees.toFixed(4)} SOL`);
});

// Total estimated wasted fees
const totalWasted = excessive.reduce((sum, r) => {
  return sum + (r.sell_attempts - r.sell_successes) * 0.00015;
}, 0);
console.log(`\nTotal estimated wasted fees: ${totalWasted.toFixed(4)} SOL`);

// Now check: what was the actual fee drain?
// Compare: invested SOL vs returned SOL vs balance change
console.log('\n=== ACCOUNTING RECONCILIATION ===');
const accounting = db.prepare(`
  SELECT
    SUM(sol_invested) as total_invested,
    SUM(sol_returned) as total_returned,
    SUM(pnl_sol) as total_pnl_db,
    COUNT(*) as total_trades,
    SUM(sell_attempts) as total_sell_attempts,
    SUM(sell_successes) as total_sell_successes
  FROM positions WHERE status IN ('closed', 'stopped')
`).get();
console.log(JSON.stringify(accounting, null, 2));
console.log(`\nFailed sell attempts: ${accounting.total_sell_attempts - accounting.total_sell_successes}`);

// Check today's trades specifically
console.log('\n=== TODAY SELL ATTEMPT DISTRIBUTION ===');
const today = db.prepare(`
  SELECT sell_attempts, COUNT(*) as n
  FROM positions
  WHERE status IN ('closed','stopped') AND opened_at > ?
  GROUP BY sell_attempts ORDER BY sell_attempts
`).all(Date.now() - 24 * 3600000);
today.forEach(r => console.log(`  ${r.sell_attempts} attempts: ${r.n} positions`));

// Check for positions that were never sold (no sell attempts or 0 successes)
console.log('\n=== UNSOLD POSITIONS (0 sell successes, stopped/closed) ===');
const unsold = db.prepare(`
  SELECT id, substr(token_mint,1,12) as tok, sell_attempts, sell_successes,
    ROUND(sol_invested,6) as invested, ROUND(sol_returned,6) as returned,
    exit_reason, datetime(opened_at/1000, 'unixepoch', 'localtime') as opened
  FROM positions
  WHERE status IN ('closed','stopped') AND sell_successes = 0 AND sol_invested > 0
  ORDER BY opened_at DESC LIMIT 20
`).all();
unsold.forEach(r => console.log(`  ${r.opened} | ${r.tok} | ${r.sell_attempts} attempts, 0 success | invested=${r.invested} | returned=${r.returned} | ${r.exit_reason}`));
console.log(`Total unsold: ${unsold.length} (showing last 20)`);

db.close();
