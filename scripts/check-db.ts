import { getDb, closeDb } from '../src/data/database.js';

const db = getDb();

// Show positions
const positions = db.prepare('SELECT * FROM positions ORDER BY opened_at DESC LIMIT 10').all();
console.log(`\n=== POSITIONS (${positions.length}) ===`);
for (const p of positions as any[]) {
  const mint = p.token_mint ? p.token_mint.slice(0, 8) : '??';
  console.log(`  ${p.id}: ${mint} | status=${p.status} | invested=${p.sol_invested} SOL | returned=${p.sol_returned} SOL | entry_price=${p.entry_price} | source=${p.source}`);
}

// Show recent trades
const trades = db.prepare('SELECT * FROM trades ORDER BY timestamp DESC LIMIT 15').all();
console.log(`\n=== RECENT TRADES (${trades.length}) ===`);
for (const t of trades as any[]) {
  const mint = t.output_mint ? t.output_mint.slice(0, 8) : (t.input_mint ? t.input_mint.slice(0, 8) : '??');
  const sig = t.tx_signature ? t.tx_signature.slice(0, 20) : 'none';
  console.log(`  ${t.type}: ${mint} | success=${t.success} | in=${t.input_amount} | out=${t.output_amount} | ${sig}`);
}

closeDb();
