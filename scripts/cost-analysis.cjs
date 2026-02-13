const db = require('better-sqlite3')('data/bot.db');

// v8o+v8p closed trades
const trades = db.prepare(`
  SELECT sol_invested, sol_returned, pnl_sol, pnl_pct, status, bot_version
  FROM positions
  WHERE status IN ('closed', 'stopped') AND bot_version IN ('v8o','v8p')
`).all();

console.log('=== v8o+v8p TRADES ===');
trades.forEach(t => {
  console.log('inv:', t.sol_invested.toFixed(4), '| ret:', t.sol_returned.toFixed(6), '| pnl:', t.pnl_sol.toFixed(6), '| pnl%:', t.pnl_pct.toFixed(1) + '%');
});

const winners = trades.filter(t => t.pnl_sol > 0);
const avgWinPct = winners.length > 0
  ? winners.reduce((s, t) => s + t.pnl_pct, 0) / winners.length
  : 20;

console.log('\nWinners:', winners.length, '/', trades.length);
console.log('Avg win%:', avgWinPct.toFixed(1) + '%');

// Fixed costs
const txFees = 0.0005; // buy + sell priority fees (permanent)
console.log('\n=== COSTOS FIJOS POR TRADE (permanentes) ===');
console.log('TX fees (buy+sell): ~0.0003-0.0005 SOL');
console.log('ATA rent: ~0.002 SOL (temporal, se recupera al cerrar)');

console.log('\n=== COSTO COMO % DEL TRADE ===');
[0.003, 0.005, 0.01, 0.015, 0.02, 0.03, 0.05].forEach(size => {
  const winProfit = size * (avgWinPct / 100);
  const costPct = (txFees / size * 100).toFixed(1);
  const ataCostPct = (0.0025 / size * 100).toFixed(1);
  const netAfterFees = winProfit - txFees;
  const netAfterAll = winProfit - 0.0025;
  console.log(
    size.toFixed(3), 'SOL |',
    'win=+' + winProfit.toFixed(4), '|',
    'fees=' + costPct + '%', '|',
    'net=' + netAfterFees.toFixed(4), '|',
    'con ATA delay:', ataCostPct + '% → net=' + netAfterAll.toFixed(4)
  );
});

// What's the minimum to keep fees < 5% of trade
console.log('\n=== MINIMO PARA QUE FEES SEAN <X% DEL TRADE ===');
console.log('Fees <10%:', (txFees / 0.10).toFixed(3), 'SOL');
console.log('Fees < 5%:', (txFees / 0.05).toFixed(3), 'SOL');
console.log('Fees < 2%:', (txFees / 0.02).toFixed(3), 'SOL');

db.close();
