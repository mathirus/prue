const Database = require('better-sqlite3');
const db = new Database('data/bot.db');

// 4KA36RAf final result
const p = db.prepare("SELECT * FROM positions WHERE token_mint LIKE '4KA36RAf%'").get();
if (p) {
  console.log('=== 4KA36RAf FINAL ===');
  console.log('Status:', p.status);
  console.log('PnL:', (p.pnl_pct || 0).toFixed(1) + '%', (p.pnl_sol || 0).toFixed(6) + ' SOL');
  console.log('TP levels:', p.tp_levels_hit);
  console.log('Invested:', p.sol_invested, 'Returned:', p.sol_returned);
}

// Updated v8e total
console.log('\n=== UPDATED V8E TOTAL ===');
const v8eSince = new Date('2026-02-08T16:07:00').getTime();
const v8e = db.prepare(`
  SELECT COUNT(*) as total,
    ROUND(SUM(pnl_sol),6) as total_pnl,
    SUM(CASE WHEN pnl_pct > 5 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN pnl_pct <= -80 THEN 1 ELSE 0 END) as rugs,
    SUM(CASE WHEN status IN ('open','partial_close') THEN 1 ELSE 0 END) as active,
    ROUND(100.0*SUM(CASE WHEN pnl_pct > 5 THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) as win_rate
  FROM positions WHERE opened_at > ?
`).get(v8eSince);
console.log(v8e);

// All v8e trades detailed
const details = db.prepare(`
  SELECT token_mint, ROUND(pnl_pct,1) as pnl, ROUND(pnl_sol,6) as sol,
    status, tp_levels_hit, security_score
  FROM positions WHERE opened_at > ? ORDER BY opened_at
`).all(v8eSince);
console.log('\n=== ALL V8E TRADES ===');
details.forEach(d => console.log(
  (d.token_mint || '').slice(0,8), d.pnl+'%', d.sol+' SOL', d.status, 'tp:'+d.tp_levels_hit, 'score:'+d.security_score
));

// Real current balance (from most recent position state)
console.log('\n=== BALANCE ANALYSIS ===');
const total = db.prepare(`
  SELECT ROUND(SUM(sol_invested),6) as invested,
    ROUND(SUM(sol_returned),6) as returned,
    ROUND(SUM(pnl_sol),6) as pnl
  FROM positions WHERE status IN ('closed','stopped')
`).get();
console.log('Total invested (closed):', total.invested);
console.log('Total returned:', total.returned);
console.log('Net PnL:', total.pnl);

// Fees estimated
const txCount = db.prepare(`SELECT COUNT(*) as n FROM positions`).get().n;
console.log('Estimated total fees:', (txCount * 3 * 0.00005).toFixed(4), 'SOL (~3 txs per trade)');

db.close();
