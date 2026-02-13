const db = require('better-sqlite3')('./data/bot.db');

// Open positions
const open = db.prepare("SELECT * FROM positions WHERE status IN ('open', 'partial_close')").all();
console.log('=== Open Positions ===');
console.log(JSON.stringify(open, null, 2));

// Positions with sol_returned = 0 (never sold)
const neverSold = db.prepare("SELECT count(*) as cnt FROM positions WHERE sol_returned = 0 AND status = 'stopped'").get();
const totalStopped = db.prepare("SELECT count(*) as cnt FROM positions WHERE status = 'stopped'").get();
console.log('\n=== Sell Success Rate ===');
console.log(`Never sold (returned=0): ${neverSold.cnt} / ${totalStopped.cnt} stopped positions`);
console.log(`Successfully sold: ${totalStopped.cnt - neverSold.cnt} / ${totalStopped.cnt}`);

// How long positions last before stop
const durations = db.prepare("SELECT id, opened_at, closed_at, updated_at, pnl_pct, sol_returned FROM positions WHERE status = 'stopped' ORDER BY opened_at DESC LIMIT 15").all();
console.log('\n=== Position Durations ===');
durations.forEach(r => {
  const closeTime = r.closed_at || r.updated_at;
  const durationSec = closeTime ? Math.round((closeTime - r.opened_at) / 1000) : 'N/A';
  console.log(`  ${r.id.slice(0,8)} | duration=${durationSec}s | pnl=${(r.pnl_pct||0).toFixed(1)}% | returned=${(r.sol_returned||0).toFixed(4)}`);
});

db.close();
