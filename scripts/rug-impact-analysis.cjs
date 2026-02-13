const db = require('better-sqlite3')('data/bot.db');

console.log('=== RUG IMPACT ANALYSIS ===\n');

// v8o trades
const trades = db.prepare(`
  SELECT pnl_sol, exit_reason, ROUND(liquidity_usd,0) as liq
  FROM positions WHERE bot_version = 'v8o' AND status IN ('closed','stopped')
`).all();

const wins = trades.filter(t => t.pnl_sol > 0);
const avgWin = wins.length > 0 ? wins.reduce((s,t) => s + t.pnl_sol, 0) / wins.length : 0;
const totalPnl = trades.reduce((s,t) => s + t.pnl_sol, 0);
const rugCost = 0.003; // full position loss

console.log('--- v8o CURRENT ---');
console.log(`Trades: ${trades.length} | Wins: ${wins.length} | PnL: ${totalPnl.toFixed(6)} SOL`);
console.log(`Avg win: +${avgWin.toFixed(6)} SOL`);
console.log(`Rug cost: -${rugCost} SOL (full position)`);
console.log(`Wins needed to recover 1 rug: ${Math.ceil(rugCost / avgWin)}`);
console.log('');

// Scenarios
console.log('--- SCENARIOS ---');
console.log(`Current PnL: +${totalPnl.toFixed(6)} SOL`);
console.log(`After 1 rug:  ${(totalPnl - rugCost).toFixed(6)} SOL`);
console.log(`After 2 rugs: ${(totalPnl - rugCost*2).toFixed(6)} SOL`);
console.log('');

// Break-even calculation
const beWinRate = (rugCost / (rugCost + avgWin) * 100);
console.log(`Break-even win rate needed: ${beWinRate.toFixed(1)}%`);
console.log(`(At avg win +${avgWin.toFixed(4)} SOL vs rug -${rugCost} SOL)`);
console.log('');

// Historical $30K+ rug rate
const hist = db.prepare(`
  SELECT COUNT(*) as n,
    SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN exit_reason IN ('rug_pull','pool_drained','max_retries','max_retries_429') THEN 1 ELSE 0 END) as rugs,
    ROUND(AVG(CASE WHEN pnl_sol > 0 THEN pnl_sol END), 6) as hist_avg_win,
    ROUND(AVG(CASE WHEN exit_reason IN ('rug_pull','pool_drained','max_retries','max_retries_429') THEN pnl_sol END), 6) as hist_avg_rug_loss,
    ROUND(SUM(pnl_sol),6) as hist_pnl
  FROM positions
  WHERE status IN ('closed','stopped') AND liquidity_usd >= 30000
`).get();

console.log('--- HISTORICAL $30K+ TOKENS (all versions) ---');
console.log(`N=${hist.n} | Wins: ${hist.wins} (${Math.round(100*hist.wins/hist.n)}%) | Rugs: ${hist.rugs} (${Math.round(100*hist.rugs/hist.n)}%)`);
console.log(`Hist avg win: ${hist.hist_avg_win} SOL | Hist avg rug loss: ${hist.hist_avg_rug_loss} SOL`);
console.log(`Hist total PnL ($30K+): ${hist.hist_pnl} SOL`);

if (hist.rugs > 0 && hist.wins > 0) {
  const winsPerRug = hist.wins / hist.rugs;
  console.log(`Win-to-rug ratio: ${winsPerRug.toFixed(1)}:1 (need ~${Math.ceil(rugCost / (hist.hist_avg_win || avgWin))}:1 to break even)`);
}
console.log('');

// Simulate expected outcome per 20 trades at different rug rates
console.log('--- SIMULATION: Expected PnL per 20 trades ---');
const simAvgWin = hist.hist_avg_win || avgWin;
const simRugLoss = hist.hist_avg_rug_loss || -rugCost;

for (const rugPct of [0, 5, 10, 15, 20, 25]) {
  const rugCount = Math.round(20 * rugPct / 100);
  const lossCount = Math.round(20 * 0.1); // ~10% normal losses (timeout at loss)
  const winCount = 20 - rugCount - lossCount;
  const pnl = winCount * simAvgWin + rugCount * simRugLoss + lossCount * (-0.0005);
  const emoji = pnl > 0 ? 'PROFIT' : 'LOSS';
  console.log(`  ${rugPct}% rugs (${rugCount}/20): ${winCount} wins + ${rugCount} rugs + ${lossCount} losses = ${pnl.toFixed(4)} SOL [${emoji}]`);
}

console.log('');

// Historical $30K+ breakdown by exit reason
console.log('--- $30K+ EXIT REASONS ---');
const exits = db.prepare(`
  SELECT exit_reason, COUNT(*) as n, ROUND(AVG(pnl_sol),6) as avg_pnl, ROUND(SUM(pnl_sol),6) as total_pnl
  FROM positions
  WHERE status IN ('closed','stopped') AND liquidity_usd >= 30000 AND exit_reason IS NOT NULL
  GROUP BY exit_reason ORDER BY n DESC
`).all();
exits.forEach(r => {
  console.log(`  ${(r.exit_reason||'unknown').padEnd(20)} N=${String(r.n).padEnd(3)} avg=${r.avg_pnl} SOL  total=${r.total_pnl} SOL`);
});

db.close();
