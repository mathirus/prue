const db = require('better-sqlite3')('./data/bot.db');

// Check all open positions
const open = db.prepare("SELECT id, token_mint, status, sol_invested, pnl_pct FROM positions WHERE status IN ('open', 'partial_close')").all();
console.log('=== Open Positions ===');
open.forEach(r => {
  console.log(`  ${r.id} | ${r.token_mint.slice(0,8)}... | ${r.status} | invested=${r.sol_invested} | pnl=${r.pnl_pct}%`);
});

// Group by token to find duplicates
const byToken = {};
open.forEach(r => {
  if (!byToken[r.token_mint]) byToken[r.token_mint] = [];
  byToken[r.token_mint].push(r);
});

// Fix duplicates: keep only the first one, close others
for (const [mint, positions] of Object.entries(byToken)) {
  if (positions.length > 1) {
    console.log(`\nDuplicate found: ${mint.slice(0,12)} (${positions.length} copies)`);
    // Keep first, close rest
    for (let i = 1; i < positions.length; i++) {
      console.log(`  Closing duplicate: ${positions[i].id}`);
      db.prepare("UPDATE positions SET status = 'stopped', closed_at = ? WHERE id = ?")
        .run(Date.now(), positions[i].id);
    }
  }
}

// Check again
const openAfter = db.prepare("SELECT count(*) as cnt FROM positions WHERE status IN ('open', 'partial_close')").get();
console.log(`\nOpen positions after fix: ${openAfter.cnt}`);

db.close();
