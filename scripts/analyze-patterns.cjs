/**
 * Analyze token performance patterns to optimize scoring.
 * Run: node scripts/analyze-patterns.cjs
 */
const Database = require('better-sqlite3');
const db = new Database('./data/bot.db');

// 1. Performance by security score
console.log('=== Performance by Security Score ===');
const byScore = db.prepare(`
  SELECT
    CASE
      WHEN security_score >= 80 THEN '80-100 (high)'
      WHEN security_score >= 70 THEN '70-79 (medium)'
      WHEN security_score >= 60 THEN '60-69 (low)'
      ELSE '< 60 (very low)'
    END as score_range,
    count(*) as total,
    sum(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) as wins,
    sum(CASE WHEN pnl_pct <= 0 THEN 1 ELSE 0 END) as losses,
    avg(pnl_pct) as avg_pnl,
    min(pnl_pct) as worst,
    max(pnl_pct) as best,
    sum(sol_invested) as total_invested,
    sum(sol_returned) as total_returned
  FROM positions
  WHERE status IN ('stopped', 'closed')
  GROUP BY score_range
  ORDER BY score_range DESC
`).all();

byScore.forEach(r => {
  const winRate = r.total > 0 ? ((r.wins / r.total) * 100).toFixed(0) : '0';
  const netPnl = ((r.total_returned || 0) - (r.total_invested || 0));
  console.log(`  ${r.score_range}: ${r.total} trades | Win: ${winRate}% | Avg PnL: ${(r.avg_pnl || 0).toFixed(1)}% | Net: ${netPnl.toFixed(4)} SOL | Best: ${(r.best || 0).toFixed(1)}% | Worst: ${(r.worst || 0).toFixed(1)}%`);
});

// 2. Win rate over time
console.log('\n=== Recent Win Rate (last 20 positions) ===');
const recent = db.prepare(`
  SELECT token_mint, security_score, pnl_pct, sol_invested, sol_returned, status
  FROM positions
  WHERE status IN ('stopped', 'closed')
  ORDER BY opened_at DESC
  LIMIT 20
`).all();

let wins = 0, losses = 0, totalInvested = 0, totalReturned = 0;
recent.forEach(r => {
  if (r.pnl_pct > 0) wins++;
  else losses++;
  totalInvested += r.sol_invested || 0;
  totalReturned += r.sol_returned || 0;
});
console.log(`  ${wins}W / ${losses}L (${((wins/(wins+losses))*100).toFixed(0)}% win rate)`);
console.log(`  Invested: ${totalInvested.toFixed(4)} SOL | Returned: ${totalReturned.toFixed(4)} SOL | Net: ${(totalReturned - totalInvested).toFixed(4)} SOL`);

// 3. Failed sells (tokens stuck in wallet)
console.log('\n=== Failed Sells (ret=0, tokens stuck) ===');
const stuck = db.prepare(`
  SELECT token_mint, security_score, sol_invested, pnl_pct, status
  FROM positions
  WHERE sol_returned = 0 AND status = 'stopped' AND sol_invested > 0
  ORDER BY opened_at DESC
  LIMIT 10
`).all();
stuck.forEach(r => {
  console.log(`  ${(r.token_mint || '?').slice(0,12)}... score=${r.security_score} invested=${(r.sol_invested||0).toFixed(4)} pnl=${(r.pnl_pct||0).toFixed(1)}%`);
});
console.log(`  Total stuck positions: ${stuck.length}`);

// 4. Token analysis patterns (if table exists)
try {
  const analysis = db.prepare(`
    SELECT count(*) as cnt FROM token_analysis
  `).get();
  if (analysis.cnt > 0) {
    console.log('\n=== Token Analysis Patterns ===');
    const patterns = db.prepare(`
      SELECT
        CASE WHEN buy_succeeded = 1 THEN 'bought' ELSE 'skipped' END as action,
        avg(score) as avg_score,
        avg(liquidity_usd) as avg_liq,
        avg(top_holder_pct) as avg_holder,
        avg(final_pnl_pct) as avg_pnl,
        count(*) as cnt
      FROM token_analysis
      GROUP BY action
    `).all();
    patterns.forEach(p => {
      console.log(`  ${p.action}: ${p.cnt} tokens | Avg Score: ${(p.avg_score||0).toFixed(0)} | Avg Liq: $${(p.avg_liq||0).toFixed(0)} | Avg PnL: ${(p.avg_pnl||0).toFixed(1)}%`);
    });
  }
} catch { /* table may not exist yet */ }

// 5. Current balance check
const {Connection, PublicKey} = require('@solana/web3.js');
require('dotenv').config();
const conn = new Connection(process.env.RPC_URL);
conn.getBalance(new PublicKey('Ezhv8MhtjdfRRh7xqxvXfaatqjRzDuLMfAUwgjnAvQA8'))
  .then(b => {
    console.log('\n=== Current Balance ===');
    console.log(`  ${(b/1e9).toFixed(6)} SOL (~$${(b/1e9*88).toFixed(2)})`);
    db.close();
  });
