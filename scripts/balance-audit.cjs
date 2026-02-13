const db = require('better-sqlite3')('data/bot.db');

// All trades today
console.log('=== ALL TRADES TODAY (Feb 9) ===');
const cutoff = new Date('2026-02-09T00:00:00').getTime();
const trades = db.prepare(`
  SELECT substr(token_mint,1,8) as tok, status, ROUND(pnl_sol,6) as pnl,
    ROUND(pnl_pct,1) as pct, exit_reason, ROUND(liquidity_usd,0) as liq,
    security_score as score, COALESCE(bot_version,'old') as ver,
    sell_attempts, sell_successes,
    datetime(opened_at/1000, 'unixepoch', 'localtime') as opened
  FROM positions WHERE opened_at > ? AND status IN ('closed','stopped')
  ORDER BY opened_at ASC
`).all(cutoff);

let totalPnl = 0;
let wins = 0;
let losses = 0;
let rugs = 0;
let fees_est = 0;

trades.forEach((r, i) => {
  totalPnl += r.pnl;
  if (r.pnl > 0) wins++;
  else losses++;
  if (r.exit_reason && (r.exit_reason.includes('rug') || r.exit_reason.includes('pool_drained') || r.exit_reason.includes('max_retries'))) rugs++;

  // Estimate fees: buy TX + sell TXs
  const sellTxs = r.sell_attempts || 1;
  const estFee = 0.000065 + (sellTxs * 0.00005); // buy + sells
  fees_est += estFee;

  console.log(`${i+1}. ${r.opened} | ${r.ver} | ${r.tok} | ${r.pnl > 0 ? 'WIN ' : 'LOSS'} ${r.pnl} SOL (${r.pct}%) | ${r.exit_reason} | sells=${r.sell_successes||0}/${r.sell_attempts||0} | $${r.liq}`);
});

console.log(`\n=== SUMMARY ===`);
console.log(`Total trades: ${trades.length}`);
console.log(`Wins: ${wins}, Losses: ${losses}, Rugs: ${rugs}`);
console.log(`PnL from trades: ${totalPnl.toFixed(6)} SOL`);
console.log(`Est. TX fees: ~${fees_est.toFixed(6)} SOL`);
console.log(`Net (trades + fees): ~${(totalPnl - fees_est).toFixed(6)} SOL`);

// Still open positions?
const open = db.prepare(`
  SELECT substr(token_mint,1,8) as tok, status, ROUND(pnl_sol,6) as pnl,
    datetime(opened_at/1000, 'unixepoch', 'localtime') as opened
  FROM positions WHERE status = 'open'
`).all();
if (open.length > 0) {
  console.log(`\nOPEN positions: ${open.length}`);
  open.forEach(r => console.log(`  ${r.opened} | ${r.tok} | ${r.status} | ${r.pnl} SOL`));
}

// ATA cleanup recoveries
console.log('\n=== WHERE DOES SOL GO? ===');
console.log('1. Trade PnL (above)');
console.log('2. TX fees (priority fees + base fees per TX)');
console.log('3. ATA creation (0.002 SOL per new token account - recovered on cleanup)');
console.log('4. Failed TX fees (simulation catches most, but some slip through)');

// Count total sell attempts vs successes
const sellStats = db.prepare(`
  SELECT SUM(sell_attempts) as attempts, SUM(sell_successes) as successes
  FROM positions WHERE opened_at > ? AND status IN ('closed','stopped')
`).get(cutoff);
console.log(`\nSell stats today: ${sellStats.successes}/${sellStats.attempts} succeeded`);
const failedSells = (sellStats.attempts || 0) - (sellStats.successes || 0);
console.log(`Failed sell TXs: ${failedSells} (each costs ~0.00005 SOL = ${(failedSells * 0.00005).toFixed(6)} SOL wasted)`);

// Count total buy attempts (from token_analysis)
const buyStats = db.prepare(`
  SELECT SUM(buy_attempted) as attempted, SUM(buy_succeeded) as succeeded
  FROM token_analysis WHERE created_at > ?
`).get(cutoff);
console.log(`Buy stats today: ${buyStats.succeeded}/${buyStats.attempted} succeeded`);
const failedBuys = (buyStats.attempted || 0) - (buyStats.succeeded || 0);
console.log(`Failed buy TXs: ${failedBuys} (each costs ~0.00006 SOL = ${(failedBuys * 0.00006).toFixed(6)} SOL wasted)`);

console.log(`\n=== ESTIMATED TOTAL DRAIN ===`);
const totalDrain = -totalPnl + fees_est + (failedSells * 0.00005) + (failedBuys * 0.00006);
console.log(`Trade losses: ${(-totalPnl).toFixed(6)} SOL`);
console.log(`TX fees (success): ~${fees_est.toFixed(6)} SOL`);
console.log(`Failed sell fees: ~${(failedSells * 0.00005).toFixed(6)} SOL`);
console.log(`Failed buy fees: ~${(failedBuys * 0.00006).toFixed(6)} SOL`);
console.log(`TOTAL estimated drain today: ~${totalDrain.toFixed(6)} SOL`);

db.close();
