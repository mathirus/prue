const db = require('better-sqlite3')('data/bot.db');

// Fix PnL for 5EVqtNaT - actual on-chain data
// Buy cost: 0.003051 (wallet change)
// Jupiter sell: +0.000144 (wallet change)
// PumpSwap sell: +0.002632 (wallet change, includes ATA recovery)
// Total return: 0.002776
// Net PnL: -0.000275 (-9.0%)
const solReturned = 0.002776;
const pnl = -0.000275;
const pnlPct = -9.0;

db.prepare(`UPDATE positions SET
  sol_returned = ?,
  pnl_sol = ?,
  pnl_pct = ?
  WHERE id = 'mljzjcfu-ctvn2y'`).run(solReturned, pnl, pnlPct);

const v = db.prepare("SELECT sol_invested, sol_returned, pnl_sol, pnl_pct, exit_reason FROM positions WHERE id = 'mljzjcfu-ctvn2y'").get();
console.log('Updated 5EVqtNaT:', JSON.stringify(v));
db.close();
