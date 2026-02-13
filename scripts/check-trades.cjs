const Database = require('better-sqlite3');
const db = new Database('./data/bot.db');

// Recent positions
const positions = db.prepare('SELECT * FROM positions ORDER BY opened_at DESC LIMIT 15').all();
console.log('=== Recent Positions ===');
positions.forEach(p => {
  const mint = (p.token_mint || 'unknown').slice(0, 8);
  const buySol = p.sol_invested ? p.sol_invested.toFixed(6) : '?';
  const sellSol = p.sol_returned ? p.sol_returned.toFixed(6) : '0';
  const pnl = p.pnl_sol ? p.pnl_sol.toFixed(6) : '?';
  const pnlPct = p.pnl_pct != null ? p.pnl_pct.toFixed(1) + '%' : '?';
  console.log(`  ${p.status.padEnd(12)} ${mint}... buy:${buySol} ret:${sellSol} pnl:${pnl} (${pnlPct}) score:${p.security_score} src:${p.source}`);
});

// Recent trades
const trades = db.prepare('SELECT * FROM trades ORDER BY created_at DESC LIMIT 15').all();
console.log('\n=== Recent Trades ===');
trades.forEach(t => {
  const sol = t.output_mint === 'So11111111111111111111111111111111111111112' ? t.output_amount : t.input_amount;
  console.log(`  ${t.type.padEnd(4)} in:${t.input_amount ? t.input_amount.toFixed(6) : '?'} out:${t.output_amount ? t.output_amount.toFixed(6) : '?'} tx:${(t.tx_signature || 'none').slice(0,12)}... ${t.status}`);
});

// Aggregate PnL
const agg = db.prepare('SELECT count(*) as cnt, sum(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins, sum(CASE WHEN pnl_sol <= 0 THEN 1 ELSE 0 END) as losses, sum(pnl_sol) as total_pnl FROM positions WHERE status IN (\"stopped\",\"closed\")').get();
console.log('\n=== Aggregate ===');
console.log(`  Closed: ${agg.cnt} | Wins: ${agg.wins || 0} | Losses: ${agg.losses || 0} | Total PnL: ${agg.total_pnl ? agg.total_pnl.toFixed(6) : 0} SOL`);

// Balance check
const {Connection, PublicKey} = require('@solana/web3.js');
require('dotenv').config();
const conn = new Connection(process.env.RPC_URL);
conn.getBalance(new PublicKey('Ezhv8MhtjdfRRh7xqxvXfaatqjRzDuLMfAUwgjnAvQA8'))
  .then(b => {
    console.log(`  Balance: ${(b/1e9).toFixed(4)} SOL`);
    db.close();
  });
