const db = require('better-sqlite3')('data/bot.db');

// Fix PnL - manual sell got 0.001326 SOL from 0.001 invested
const pnl = 0.001326 - 0.001; // +0.000326 SOL
db.prepare(`UPDATE positions SET
  pnl_sol = ?,
  sol_returned = ?,
  pnl_pct = ?,
  exit_reason = 'manual_emergency_sell'
  WHERE id = 'mljyoxax-796uzi'`).run(pnl, 0.001326, 32.6);

console.log(`Updated DhbRDq6u PnL: +${pnl.toFixed(6)} SOL (+32.6%)`);

const v = db.prepare("SELECT pnl_sol, sol_returned, pnl_pct, exit_reason, status FROM positions WHERE id = 'mljyoxax-796uzi'").get();
console.log('Verified:', JSON.stringify(v));

db.close();
