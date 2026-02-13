const db = require('better-sqlite3')('data/bot.db');
const now = Date.now();

console.log('=== FEE DRAIN ANALYSIS ===\n');

// All positions today grouped by version + status
const byVer = db.prepare(`
  SELECT bot_version as ver,
    COUNT(*) as n,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN pnl_sol < 0 THEN 1 ELSE 0 END) as losses,
    SUM(CASE WHEN pnl_sol = 0 THEN 1 ELSE 0 END) as breakeven,
    ROUND(SUM(pnl_sol), 6) as pnl,
    ROUND(SUM(sol_invested), 6) as invested,
    ROUND(SUM(sol_returned), 6) as returned
  FROM positions
  WHERE status IN ('closed', 'stopped')
  AND opened_at > ?
  GROUP BY bot_version
`).all(now - 24 * 60 * 60 * 1000);

console.log('Today by version:');
byVer.forEach(v => {
  console.log(`  ${v.ver || 'old'}: ${v.n} trades (${v.wins}W/${v.losses}L) | invested=${v.invested} | returned=${v.returned} | pnl=${v.pnl}`);
});

// Token analysis: buy_attempted but not buy_succeeded (bought but position never opened)
const phantomBuys = db.prepare(`
  SELECT COUNT(*) as n
  FROM token_analysis
  WHERE buy_attempted = 1 AND buy_succeeded = 0
  AND created_at > ?
`).get(now - 24 * 60 * 60 * 1000);
console.log(`\nPhantom buy failures (buy sent, didn't confirm): ${phantomBuys.n}`);

// Check for stuck token ATAs (tokens in wallet that aren't being managed)
// This would be tokens from failed buys that actually landed
console.log('\n=== BALANCE TRAJECTORY ===');

// Reconstruct balance from positions
let runningPnl = 0;
const trajectory = db.prepare(`
  SELECT bot_version, token_mint, pnl_sol, sol_invested, sol_returned,
    opened_at, closed_at
  FROM positions
  WHERE status IN ('closed', 'stopped')
  AND opened_at > ?
  ORDER BY closed_at ASC
`).all(now - 24 * 60 * 60 * 1000);

trajectory.forEach(t => {
  runningPnl += t.pnl_sol;
});

console.log(`Sum of all PnL today: ${runningPnl.toFixed(6)} SOL`);
console.log(`Sum of invested: ${trajectory.reduce((s, t) => s + t.sol_invested, 0).toFixed(6)} SOL`);
console.log(`Sum of returned: ${trajectory.reduce((s, t) => s + t.sol_returned, 0).toFixed(6)} SOL`);

// Now specifically for v8o+v8p period
console.log('\n=== v8o + v8p ONLY ===');
const v8opTrajectory = trajectory.filter(t => t.bot_version === 'v8o' || t.bot_version === 'v8p');
const v8opPnl = v8opTrajectory.reduce((s, t) => s + t.pnl_sol, 0);
const v8opInvested = v8opTrajectory.reduce((s, t) => s + t.sol_invested, 0);
const v8opReturned = v8opTrajectory.reduce((s, t) => s + t.sol_returned, 0);
console.log(`Trades: ${v8opTrajectory.length}`);
console.log(`Invested: ${v8opInvested.toFixed(6)} SOL`);
console.log(`Returned: ${v8opReturned.toFixed(6)} SOL`);
console.log(`PnL: ${v8opPnl.toFixed(6)} SOL`);
console.log(`Each trade invests 0.003 SOL, returns ${(v8opReturned / v8opTrajectory.length).toFixed(6)} SOL avg`);

// What ELSE could drain balance?
// - Failed buy TXs that LANDED on chain (SOL spent, tokens received but bot doesn't know)
// - ATA creation costs (~0.002 SOL each)
// - Sell TX fees
console.log('\n=== POTENTIAL HIDDEN COSTS ===');

// Check recent token_analysis for buy failures
const buyAttempts = db.prepare(`
  SELECT
    SUM(CASE WHEN buy_attempted = 1 THEN 1 ELSE 0 END) as attempted,
    SUM(CASE WHEN buy_succeeded = 1 THEN 1 ELSE 0 END) as succeeded,
    SUM(CASE WHEN buy_attempted = 1 AND buy_succeeded = 0 THEN 1 ELSE 0 END) as failed,
    SUM(CASE WHEN buy_error IS NOT NULL THEN 1 ELSE 0 END) as with_error
  FROM token_analysis WHERE created_at > ?
`).get(now - 24 * 60 * 60 * 1000);
console.log(`Buy attempts tracked in DB: ${JSON.stringify(buyAttempts)}`);
console.log('Note: buy_attempted tracking only started with v8p code');
console.log('Pre-v8p buy failures are NOT tracked in DB, only in log files');

// Estimate: each failed confirmation timeout could cost:
// - If TX landed: ~0.00006 SOL (priority fee) - but tokens would be in ATA
// - If TX didn't land: 0 SOL
// - Jito tip: ~0.00003 SOL if bundle included
console.log('\nEstimate: If 50% of confirmation timeouts actually landed:');
console.log('  26 timeouts × 50% × 0.00006 SOL = ~0.00078 SOL in fees');
console.log('  Plus potential stuck tokens in ATAs');

db.close();
