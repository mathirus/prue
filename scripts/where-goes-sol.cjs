const db = require('better-sqlite3')('data/bot.db');
const now = Date.now();

console.log('=== DÓNDE SE VA EL SOL? ===\n');

// Only v8o + v8p trades
const trades = db.prepare(`
  SELECT token_mint, status, sol_invested, sol_returned, pnl_sol, pnl_pct,
    bot_version, opened_at, closed_at, exit_reason
  FROM positions
  WHERE bot_version IN ('v8o', 'v8p')
  ORDER BY opened_at ASC
`).all();

let totalInvested = 0, totalReturned = 0;
console.log('v8o+v8p trades:');
trades.forEach((t, i) => {
  totalInvested += t.sol_invested;
  totalReturned += t.sol_returned;
  const net = t.sol_returned - t.sol_invested;
  console.log(`  ${i + 1}. ${t.token_mint.slice(0, 8)} | ${t.bot_version} | ${t.status.padEnd(8)} | invested=${t.sol_invested.toFixed(4)} | returned=${t.sol_returned.toFixed(6)} | net=${net >= 0 ? '+' : ''}${net.toFixed(6)} | pnl_db=${t.pnl_sol.toFixed(6)}`);
});

console.log(`\n  TOTAL: invested=${totalInvested.toFixed(6)} | returned=${totalReturned.toFixed(6)} | net=${(totalReturned - totalInvested).toFixed(6)}`);

// Now check: are there trades WITHOUT bot_version that happened DURING v8o/v8p period?
if (trades.length > 0) {
  const firstV8o = trades[0].opened_at;
  const overlapping = db.prepare(`
    SELECT substr(token_mint, 1, 8) as tok, status, sol_invested, sol_returned,
      ROUND(pnl_sol, 6) as pnl, bot_version, exit_reason
    FROM positions
    WHERE bot_version IS NULL AND opened_at >= ?
    ORDER BY opened_at ASC
  `).all(firstV8o);

  if (overlapping.length > 0) {
    console.log(`\n⚠️ OLD VERSION trades that ran DURING v8o/v8p period:`);
    let oldPnl = 0;
    overlapping.forEach(t => {
      oldPnl += t.pnl;
      console.log(`  ${t.tok} | ${t.status} | pnl=${t.pnl} | exit=${t.exit_reason || '-'} | ver=${t.bot_version || 'NULL'}`);
    });
    console.log(`  Old version PnL during this period: ${oldPnl.toFixed(6)} SOL`);
  }
}

// Check ALL positions in the last 24h
console.log('\n=== RESUMEN ÚLTIMAS 24H ===');
const summary = db.prepare(`
  SELECT
    bot_version,
    COUNT(*) as n,
    SUM(sol_invested) as invested,
    SUM(sol_returned) as returned,
    ROUND(SUM(pnl_sol), 6) as pnl,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN pnl_sol <= 0 AND status IN ('closed','stopped') THEN 1 ELSE 0 END) as losses
  FROM positions
  WHERE opened_at > ?
  GROUP BY bot_version
  ORDER BY MIN(opened_at)
`).all(now - 24 * 60 * 60 * 1000);

summary.forEach(s => {
  const net = (s.returned - s.invested).toFixed(6);
  console.log(`  ${(s.bot_version || 'old').padEnd(5)} | ${s.n} trades (${s.wins}W/${s.losses}L) | invested=${s.invested.toFixed(4)} | returned=${s.returned.toFixed(6)} | net_flow=${net} | pnl_db=${s.pnl}`);
});

// KEY QUESTION: TX fees not captured in PnL
// Each buy TX: ~0.00006 SOL priority + 0.000005 base = ~0.000065
// Each sell TX: ~0.000045 + 0.000005 = ~0.00005
// ATA creation: ~0.00203 SOL rent per new ATA
// ATA recovery: ~0.00203 SOL when closed
console.log('\n=== COSTOS OCULTOS (TX FEES) ===');

// Count all buy attempts (both success and failure)
const allTrades = db.prepare(`
  SELECT COUNT(*) as buy_txs FROM trades WHERE type = 'buy' AND created_at > ?
`).get(now - 24 * 60 * 60 * 1000);
const allSells = db.prepare(`
  SELECT COUNT(*) as sell_txs FROM trades WHERE type = 'sell' AND created_at > ?
`).get(now - 24 * 60 * 60 * 1000);
console.log(`Buy TXs recorded: ${allTrades.buy_txs}`);
console.log(`Sell TXs recorded: ${allSells.sell_txs}`);

// Estimated fees
const buyFee = 0.000065; // priority + base
const sellFee = 0.00005;
const totalFees = allTrades.buy_txs * buyFee + allSells.sell_txs * sellFee;
console.log(`Estimated TX fees: ${allTrades.buy_txs} buys × ${buyFee} + ${allSells.sell_txs} sells × ${sellFee} = ${totalFees.toFixed(6)} SOL`);

// Check for FAILED buys that cost fees (confirmation timeouts that might have landed)
const failedBuys = db.prepare(`
  SELECT COUNT(*) as n FROM trades WHERE type = 'buy' AND status = 'failed' AND created_at > ?
`).get(now - 24 * 60 * 60 * 1000);
console.log(`Failed buy TXs (might have cost fees): ${failedBuys.n}`);
console.log(`Estimated wasted: ${(failedBuys.n * buyFee).toFixed(6)} SOL`);

// ATA costs - check for token accounts created today
// Each new ATA costs 0.00203 SOL in rent
// v8o+v8p: 8 positions = 8 ATAs created = 0.01624 SOL in ATA rent
// But ATAs are recovered when tokens are sold (rent returned)
// Moon bags = ATA NOT recovered
console.log(`\nATA rent per position: 0.00203 SOL`);
console.log(`v8o+v8p positions: ${trades.length} × 0.00203 = ${(trades.length * 0.00203).toFixed(5)} SOL in ATA rent`);

const moonBags = trades.filter(t => t.status === 'partial_close');
const stuckATAs = trades.filter(t => t.status === 'open' || t.status === 'partial_close');
console.log(`Active/moon bag positions (ATA rent NOT recovered): ${stuckATAs.length}`);
console.log(`Estimated unrecovered ATA rent: ${(stuckATAs.length * 0.00203).toFixed(5)} SOL`);

// REAL balance check: what SHOULD the balance be?
const allClosed = db.prepare(`
  SELECT SUM(pnl_sol) as pnl, SUM(sol_invested) as invested, SUM(sol_returned) as returned
  FROM positions WHERE status IN ('closed', 'stopped')
`).get();
const allOpen = db.prepare(`
  SELECT COUNT(*) as n, SUM(sol_invested) as locked
  FROM positions WHERE status IN ('open', 'partial_close')
`).get();

console.log('\n=== BALANCE TEÓRICO ===');
console.log(`All-time closed PnL: ${allClosed.pnl.toFixed(6)} SOL`);
console.log(`Currently locked in positions: ${(allOpen.locked || 0).toFixed(6)} SOL in ${allOpen.n} positions`);
console.log(`Note: PnL does NOT include TX fees (~${totalFees.toFixed(4)} SOL today) or ATA rent`);

db.close();
