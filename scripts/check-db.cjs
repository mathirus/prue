const db = require('better-sqlite3')('./data/bot.db');

// H6U6 position
const h = db.prepare("SELECT * FROM positions WHERE id LIKE '%H6U6%'").all();
console.log('=== H6U6 Position ===');
console.log(JSON.stringify(h, null, 2));

// Position stats
const stats = db.prepare("SELECT status, count(*) as cnt FROM positions GROUP BY status").all();
console.log('\n=== Position Stats ===');
console.log(JSON.stringify(stats));

// Last 20 closed positions
const recent = db.prepare("SELECT id, security_score, pnl_pct, sol_invested, sol_returned, status, source FROM positions WHERE status IN ('stopped','closed') ORDER BY opened_at DESC LIMIT 20").all();
console.log('\n=== Last 20 Closed Positions ===');
recent.forEach(r => {
  console.log(`  ${r.id.slice(0,8)} | score=${r.security_score} | pnl=${(r.pnl_pct||0).toFixed(1)}% | invested=${(r.sol_invested||0).toFixed(4)} | returned=${(r.sol_returned||0).toFixed(4)} | ${r.status} | ${r.source}`);
});

// Successful sells
const sells = db.prepare("SELECT count(*) as cnt FROM trades WHERE type='sell' AND status='confirmed'").get();
console.log('\n=== Trade Stats ===');
console.log('Successful sells:', sells.cnt);
const failedSells = db.prepare("SELECT count(*) as cnt FROM trades WHERE type='sell' AND status='failed'").get();
console.log('Failed sells:', failedSells.cnt);
const buys = db.prepare("SELECT count(*) as cnt FROM trades WHERE type='buy' AND status='confirmed'").get();
console.log('Successful buys:', buys.cnt);
const failedBuys = db.prepare("SELECT count(*) as cnt FROM trades WHERE type='buy' AND status='failed'").get();
console.log('Failed buys:', failedBuys.cnt);

// Winners vs Losers detail
const winners = db.prepare("SELECT id, security_score, pnl_pct, sol_returned FROM positions WHERE pnl_pct > 0 AND status IN ('stopped','closed') ORDER BY pnl_pct DESC LIMIT 10").all();
console.log('\n=== Top Winners ===');
winners.forEach(r => {
  console.log(`  ${r.id.slice(0,8)} | score=${r.security_score} | pnl=+${(r.pnl_pct||0).toFixed(1)}% | returned=${(r.sol_returned||0).toFixed(4)}`);
});

db.close();
