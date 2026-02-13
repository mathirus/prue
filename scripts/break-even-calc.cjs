/**
 * Break-even analysis: simulates PnL using shadow data + TP/SL strategy.
 * Answers: how many trades/day and at what size to not lose money?
 */
const Database = require('better-sqlite3');
const db = new Database('data/bot.db');

const all = db.prepare(`
  SELECT tp1_hit, tp2_hit, tp3_hit, sl_hit, rug_detected,
         final_multiplier, peak_multiplier, security_score
  FROM shadow_positions
  WHERE final_multiplier IS NOT NULL
`).all();

// Simulate PnL for a single trade using our TP/SL strategy
function simulatePnl(t) {
  let returned = 0;   // fraction of invested returned
  let remaining = 1.0; // fraction still held

  // TP levels (sell in order if hit)
  if (t.tp1_hit) {
    returned += 0.5 * 1.2; // sell 50% at 1.2x
    remaining -= 0.5;
  }
  if (t.tp2_hit) {
    returned += 0.3 * 1.5; // sell 30% at 1.5x
    remaining -= 0.3;
  }
  if (t.tp3_hit) {
    returned += 0.2 * 3.0; // sell 20% at 3.0x
    remaining -= 0.2;
  }

  // If rug detected: remaining portion lost
  if (t.rug_detected) {
    remaining = 0;
  }
  // If SL hit and no TP: exit at -30%
  else if (t.sl_hit && !t.tp1_hit) {
    returned += remaining * 0.7;
    remaining = 0;
  }

  // Remaining: exit at final multiplier (timeout/trailing)
  if (remaining > 0) {
    const exitMult = Math.max(0, Math.min(t.final_multiplier || 0, 10));
    returned += remaining * exitMult;
    remaining = 0;
  }

  return returned - 1.0; // PnL as fraction (-1 = -100%, 0 = breakeven, +0.5 = +50%)
}

// Run simulation
let totalPnl = 0;
let winners = 0;
let losers = 0;
const byScore = {};

for (const t of all) {
  const pnl = simulatePnl(t);
  totalPnl += pnl;
  if (pnl > 0) winners++; else losers++;

  const bucket = t.security_score >= 75 ? '75+'
    : t.security_score >= 70 ? '70-74'
    : '60-69';

  if (!byScore[bucket]) byScore[bucket] = { sum: 0, n: 0, wins: 0 };
  byScore[bucket].sum += pnl;
  byScore[bucket].n++;
  if (pnl > 0) byScore[bucket].wins++;
}

const avgPnlFrac = totalPnl / all.length;

console.log(`=== BREAK-EVEN SIMULATION (N=${all.length} shadow trades) ===`);
console.log(`Winners: ${winners} (${(winners / all.length * 100).toFixed(1)}%)`);
console.log(`Losers: ${losers} (${(losers / all.length * 100).toFixed(1)}%)`);
console.log(`Avg PnL per trade: ${(avgPnlFrac * 100).toFixed(2)}%`);
console.log();

// By score bracket
console.log('=== BY SCORE ===');
for (const [k, v] of Object.entries(byScore).sort()) {
  const avgF = v.sum / v.n;
  console.log(`${k}: N=${v.n}, WR=${(v.wins / v.n * 100).toFixed(0)}%, avg=${(avgF * 100).toFixed(2)}%`);
}
console.log();

// Break-even at different trade sizes
const FEE_OVERHEAD = 0.0026; // SOL per trade (TX fees + ATA rent)
const HELIUS_DAILY = 0.0204; // SOL/day ($49/mo / 30 / SOL@$80)

console.log('=== BREAK-EVEN BY TRADE SIZE ===');
console.log(`Fee overhead per trade: ${FEE_OVERHEAD} SOL`);
console.log(`Helius daily cost: ${HELIUS_DAILY.toFixed(4)} SOL/day ($49/mo at SOL=$80)`);
console.log();

for (const size of [0.03, 0.05, 0.10, 0.15, 0.20]) {
  const evBeforeFees = avgPnlFrac * size;
  const netPerTrade = evBeforeFees - FEE_OVERHEAD;
  const overheadPct = (FEE_OVERHEAD / size * 100).toFixed(1);

  console.log(`--- ${size} SOL/trade (fee overhead: ${overheadPct}%) ---`);
  console.log(`  EV before fees: ${(evBeforeFees * 1000).toFixed(3)} mSOL/trade`);
  console.log(`  Net per trade: ${(netPerTrade * 1000).toFixed(3)} mSOL/trade`);

  if (netPerTrade > 0) {
    const tradesToCoverHelius = Math.ceil(HELIUS_DAILY / netPerTrade);
    console.log(`  Trades to cover Helius: ${tradesToCoverHelius}/day`);
    console.log(`  Capital needed (max_concurrent=1): ${(size + 0.01).toFixed(3)} SOL`);
  } else {
    console.log(`  NEGATIVE EV — not profitable at this trade size`);
  }
  console.log();
}

// Score 70+ analysis
console.log('=== SCORE 70+ ONLY ===');
const s70 = all.filter(t => t.security_score >= 70);
let t70 = 0, w70 = 0;
for (const t of s70) {
  const p = simulatePnl(t);
  t70 += p;
  if (p > 0) w70++;
}
const a70 = t70 / s70.length;
console.log(`N=${s70.length}, WR=${(w70 / s70.length * 100).toFixed(0)}%, avg PnL=${(a70 * 100).toFixed(2)}%`);

for (const size of [0.05, 0.10]) {
  const net = a70 * size - FEE_OVERHEAD;
  console.log(`  ${size} SOL: net=${(net * 1000).toFixed(3)} mSOL/trade${net > 0 ? ' → ' + Math.ceil(HELIUS_DAILY / net) + ' trades/day' : ' → NEGATIVE'}`);
}

// Score 75+ analysis
console.log();
console.log('=== SCORE 75+ ONLY ===');
const s75 = all.filter(t => t.security_score >= 75);
let t75 = 0, w75 = 0;
for (const t of s75) {
  const p = simulatePnl(t);
  t75 += p;
  if (p > 0) w75++;
}
const a75 = t75 / s75.length;
console.log(`N=${s75.length}, WR=${(w75 / s75.length * 100).toFixed(0)}%, avg PnL=${(a75 * 100).toFixed(2)}%`);

for (const size of [0.05, 0.10]) {
  const net = a75 * size - FEE_OVERHEAD;
  console.log(`  ${size} SOL: net=${(net * 1000).toFixed(3)} mSOL/trade${net > 0 ? ' → ' + Math.ceil(HELIUS_DAILY / net) + ' trades/day' : ' → NEGATIVE'}`);
}

// How many trades per day happen?
const tradesPerDay = db.prepare(`
  SELECT date(opened_at/1000, 'unixepoch') as day, COUNT(*) as total
  FROM shadow_positions
  GROUP BY day ORDER BY day DESC LIMIT 10
`).all();

console.log();
console.log('=== SHADOW TRADES PER DAY (recent) ===');
for (const d of tradesPerDay) {
  console.log(`${d.day}: ${d.total} trades`);
}

// Real trades per day
const realPerDay = db.prepare(`
  SELECT date(opened_at/1000, 'unixepoch') as day, COUNT(*) as total
  FROM positions
  GROUP BY day ORDER BY day DESC LIMIT 10
`).all();

console.log();
console.log('=== REAL TRADES PER DAY ===');
for (const d of realPerDay) {
  console.log(`${d.day}: ${d.total} trades`);
}
