const db = require('better-sqlite3')('data/bot.db');

// KEY FINDING: The rug C1sQrFF1 is IDENTICAL to winners in every metric
// Score=80, liq=$56K, grad=89s, holders=2, bundles=0, insiders=0, wash=0
// ALL winners in same bracket also have these exact same values
// THIS MEANS: our current scoring CANNOT distinguish rugs from winners

// The ONLY differences:
// 1. Peak multiplier: rug=1.10x, winners=1.20-1.43x (but this is AFTER the fact)
// 2. Hold time: rug=34s, winners=723s (also AFTER the fact)

// QUESTION: Can we look at the first few seconds to tell the difference?
// Rug: 2s→1.00x, 12s→1.09x, 23s→1.10x, then DRAIN
// Winners:
//   7iJLWJP6: 1s→1.02x, 12s→1.03x, 22s→1.06x (slower ramp)
//   DFurJyZn: 1s→1.00x, 11s→1.14x, 22s→1.16x (fast pump)
//   9hdnDQCJ: 1s→1.00x, 12s→1.01x, 22s→1.05x (slow start)

// Conclusion: First 30s trajectories are similar. NO clear early signal.

// NEW ANALYSIS: What about the $60-90K bracket having 18% rug rate?
console.log('=== $60-90K BRACKET RUGS ===');
const highLiqRugs = db.prepare(`
  SELECT p.token_mint, p.pnl_sol, p.exit_reason, p.peak_multiplier,
         p.opened_at, p.closed_at, p.sol_invested, p.bot_version,
         d.dp_liquidity_usd, d.dp_graduation_time_s, d.dp_holder_count,
         d.dp_observation_initial_sol
  FROM positions p
  JOIN detected_pools d ON d.base_mint = p.token_mint
  WHERE d.dp_liquidity_usd BETWEEN 60000 AND 90000
    AND p.exit_reason = 'rug_pull'
  ORDER BY p.opened_at DESC
`).all();
console.log('N=' + highLiqRugs.length);
highLiqRugs.forEach(t => {
  console.log('  ' + t.token_mint.slice(0, 8) + ' v=' + t.bot_version +
    ' liq=$' + Math.round(t.dp_liquidity_usd / 1000) + 'K' +
    ' grad=' + t.dp_graduation_time_s + 's' +
    ' holders=' + t.dp_holder_count +
    ' initSOL=' + t.dp_observation_initial_sol?.toFixed(0) +
    ' inv=' + (t.sol_invested * 1000).toFixed(0) + 'mSOL');
});

// CRITICAL: What is the expected value per trade at each liquidity bracket?
console.log('\n=== EXPECTED VALUE PER TRADE (with trade size context) ===');
const all = db.prepare(`
  SELECT d.dp_liquidity_usd, p.pnl_sol, p.exit_reason, p.sol_invested
  FROM positions p
  JOIN detected_pools d ON d.base_mint = p.token_mint
  WHERE p.status IN ('closed','stopped')
    AND d.dp_liquidity_usd > 0
`).all();

const buckets = [
  { label: '$15-30K', min: 15000, max: 30000 },
  { label: '$30-50K', min: 30000, max: 50000 },
  { label: '$50-80K', min: 50000, max: 80000 },
  { label: '$80K+', min: 80000, max: 9999999 },
];

for (const b of buckets) {
  const trades = all.filter(t => t.dp_liquidity_usd >= b.min && t.dp_liquidity_usd < b.max);
  if (trades.length === 0) continue;
  const wins = trades.filter(t => t.pnl_sol > 0);
  const rugs = trades.filter(t => t.exit_reason === 'rug_pull');
  const totalPnl = trades.reduce((s, t) => s + t.pnl_sol, 0);
  const avgInv = trades.reduce((s, t) => s + t.sol_invested, 0) / trades.length;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl_sol, 0) / wins.length : 0;
  const avgLoss = rugs.length > 0 ? rugs.reduce((s, t) => s + t.pnl_sol, 0) / rugs.length : 0;

  console.log(b.label + ':');
  console.log('  N=' + trades.length + ' wins=' + wins.length + ' (' + Math.round(100 * wins.length / trades.length) + '%) rugs=' + rugs.length + ' (' + Math.round(100 * rugs.length / trades.length) + '%)');
  console.log('  Total PnL: ' + (totalPnl * 1000).toFixed(1) + 'mSOL | EV/trade: ' + (totalPnl * 1000 / trades.length).toFixed(2) + 'mSOL');
  console.log('  Avg invest: ' + (avgInv * 1000).toFixed(1) + 'mSOL | Avg win: +' + (avgWin * 1000).toFixed(2) + 'mSOL | Avg rug: ' + (avgLoss * 1000).toFixed(2) + 'mSOL');
  console.log('');
}

// HOW MANY WINS NEEDED TO RECOVER 1 RUG?
console.log('=== WINS NEEDED TO RECOVER 1 RUG ===');
// At 0.02 SOL: rug = -20 mSOL, avg win = ~3 mSOL → need 7 wins per rug
// At 0.003 SOL: rug = -3 mSOL, avg win = ~0.7 mSOL → need 4.3 wins per rug
const v8qWins = db.prepare(`
  SELECT AVG(pnl_sol) as avg_win FROM positions
  WHERE bot_version = 'v8q' AND pnl_sol > 0 AND status IN ('closed','stopped')
`).get();
const v8qRugs = db.prepare(`
  SELECT AVG(pnl_sol) as avg_rug FROM positions
  WHERE bot_version = 'v8q' AND exit_reason = 'rug_pull'
`).get();

if (v8qWins && v8qRugs) {
  const winsNeeded = Math.abs(v8qRugs.avg_rug / v8qWins.avg_win);
  console.log('v8q avg win: +' + (v8qWins.avg_win * 1000).toFixed(1) + 'mSOL');
  console.log('v8q avg rug: ' + (v8qRugs.avg_rug * 1000).toFixed(1) + 'mSOL');
  console.log('Wins needed per rug: ' + winsNeeded.toFixed(1));
  console.log('Current win rate: 83% (5/6)');
  console.log('Break-even rug rate: ' + (100 / (1 + winsNeeded)).toFixed(1) + '%');
}

// IDEA: What if we reduce position size when scoring is borderline (score=80)?
console.log('\n=== POSITION SIZING IDEA ===');
console.log('Score 80 (minimum): use 50% of max_position (0.01 SOL)');
console.log('Score 85+: use 100% of max_position (0.02 SOL)');
console.log('Impact on this rug: -10 mSOL instead of -20 mSOL');
console.log('Impact on wins: most wins are score 80, so avg win drops to ~1.5 mSOL');
console.log('BUT: wins-per-rug drops from 5.3 to 6.7 (WORSE ratio)');

db.close();
