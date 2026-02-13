const db = require('better-sqlite3')('data/bot.db');
const now = Date.now();

console.log('=== TIMELINE DE BALANCE (últimas 24h) ===\n');

// All positions in chronological order
const all = db.prepare(`
  SELECT substr(token_mint, 1, 8) as tok, status, sol_invested, sol_returned,
    ROUND(pnl_sol, 6) as pnl, bot_version, opened_at, closed_at
  FROM positions
  WHERE opened_at > ?
  ORDER BY opened_at ASC
`).all(now - 24 * 60 * 60 * 1000);

// Simulate wallet balance changes
let walletDelta = 0; // running total of SOL in/out
let feesEstimate = 0;

all.forEach((t, i) => {
  const ver = t.bot_version || 'old';
  const openTime = new Date(t.opened_at);
  const h = openTime.getHours().toString().padStart(2, '0');
  const m = openTime.getMinutes().toString().padStart(2, '0');

  // When position opens: -sol_invested (SOL leaves wallet)
  // When position closes: +sol_returned (SOL comes back)
  // Fees per trade: ~0.00017 SOL (buy + 2 sells)
  const fees = 0.00017;
  feesEstimate += fees;

  let netFlow;
  if (t.status === 'open' || t.status === 'partial_close') {
    // Still open: invested left wallet, partial return came back
    netFlow = t.sol_returned - t.sol_invested;
  } else {
    netFlow = t.sol_returned - t.sol_invested;
  }

  walletDelta += netFlow - fees;

  const arrow = netFlow >= 0 ? '↑' : '↓';
  console.log(`  ${h}:${m} | ${ver.padEnd(4)} | ${tok(t)} | ${t.status.padEnd(13)} | flow=${fmt(netFlow)} | fees=-${fees.toFixed(5)} | running=${fmt(walletDelta)}`);
});

function tok(t) { return t.tok; }
function fmt(n) { return (n >= 0 ? '+' : '') + n.toFixed(6); }

console.log(`\n  NET wallet delta: ${fmt(walletDelta)}`);
console.log(`  Of which fees: -${feesEstimate.toFixed(5)} SOL`);
console.log(`  Without fees: ${fmt(walletDelta + feesEstimate)}`);

// Now show ONLY the last 10 trades (what the user cares about)
console.log('\n=== ÚLTIMOS 10 TRADES ===\n');
const last10 = all.slice(-10);
let recent = 0;
last10.forEach(t => {
  const ver = t.bot_version || 'old';
  const openTime = new Date(t.opened_at);
  const h = openTime.getHours().toString().padStart(2, '0');
  const m = openTime.getMinutes().toString().padStart(2, '0');
  const netFlow = t.sol_returned - t.sol_invested;
  recent += netFlow - 0.00017;
  console.log(`  ${h}:${m} | ${ver.padEnd(4)} | ${t.tok} | ${t.status.padEnd(13)} | pnl=${t.pnl} | net_flow=${fmt(netFlow)} | fees=-0.00017 | running=${fmt(recent)}`);
});

db.close();
