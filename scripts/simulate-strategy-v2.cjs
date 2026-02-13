#!/usr/bin/env node
/**
 * CORRECTED simulation: uses pnl_pct as fallback when peak_multiplier=0
 * If pnl_pct >= 15%, token clearly hit 1.15x at some point → count as TP1
 */
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'), { readonly: true });

const TRADE_SIZE = 0.1;
const FEE = 0.0024;
const TP1 = 1.15; // sell 100% at 15%
const TP_GAIN = TRADE_SIZE * (TP1 - 1) - FEE; // net gain per TP1 hit

const trades = db.prepare(`
  SELECT p.token_mint, p.security_score, p.pnl_pct, p.pnl_sol,
    p.exit_reason, p.peak_multiplier, p.sol_invested,
    d.dp_liquidity_usd, d.dp_top_holder_pct, d.dp_holder_count,
    d.dp_graduation_time_s, tc.wallet_age_seconds
  FROM positions p
  LEFT JOIN detected_pools d ON p.pool_address = d.pool_address
  LEFT JOIN token_creators tc ON p.token_mint = tc.token_mint
  WHERE p.closed_at IS NOT NULL
  ORDER BY p.opened_at ASC
`).all();

// Data quality check
const withPeak = trades.filter(t => (t.peak_multiplier || 0) > 0);
const noPeak = trades.filter(t => !t.peak_multiplier || t.peak_multiplier === 0);
console.log(`Total trades: ${trades.length}`);
console.log(`Con peak_multiplier real: ${withPeak.length} (${(withPeak.length/trades.length*100).toFixed(0)}%)`);
console.log(`Sin peak (=0 o null): ${noPeak.length} (${(noPeak.length/trades.length*100).toFixed(0)}%)`);
console.log(`  De esos sin peak, con pnl >= 15%: ${noPeak.filter(t => (t.pnl_pct||0) >= 15).length}`);
console.log(`  De esos sin peak, con pnl >= 0%: ${noPeak.filter(t => (t.pnl_pct||0) >= 0).length}\n`);

function wouldHitTP1(t) {
  const peak = t.peak_multiplier || 0;
  const pnl = t.pnl_pct || 0;
  // If peak tracked and >= 1.15, yes
  if (peak >= TP1) return true;
  // If peak not tracked but final pnl >= 15%, token clearly passed 1.15x
  if (peak === 0 && pnl >= 15) return true;
  return false;
}

function simulate(label, filterFn) {
  const passed = trades.filter(filterFn);
  let totalPnl = 0;
  let wins = 0, losses = 0, rugs = 0, tp1Hits = 0;

  for (const t of passed) {
    const isRug = (t.exit_reason || '').includes('rug') || (t.exit_reason || '').includes('honeypot');
    let tradePnl;

    if (wouldHitTP1(t)) {
      // TP1 triggers at +15%, sell everything
      tradePnl = TP_GAIN;
      tp1Hits++;
      wins++;
    } else if (isRug) {
      // Partial rugs: some return partial amount
      const lossPct = Math.abs(t.pnl_pct || 100) / 100;
      tradePnl = -TRADE_SIZE * Math.min(1, lossPct) - FEE;
      rugs++;
      losses++;
    } else {
      // Normal loss/small win — use actual pnl ratio
      const pnlRatio = (t.pnl_pct || 0) / 100;
      tradePnl = TRADE_SIZE * pnlRatio - FEE;
      if (tradePnl > 0) wins++;
      else losses++;
    }

    totalPnl += tradePnl;
  }

  return { label, total: passed.length, tp1Hits, rugs, wins, losses, totalPnl };
}

const configs = [
  ['Score>=65 Liq>=$5K (ACTUAL)', t => (t.security_score||0)>=65 && (t.dp_liquidity_usd||0)>=5000],
  ['Score>=65 Liq>=$10K', t => (t.security_score||0)>=65 && (t.dp_liquidity_usd||0)>=10000],
  ['Score>=65 Liq>=$15K', t => (t.security_score||0)>=65 && (t.dp_liquidity_usd||0)>=15000],
  ['Score>=65 Liq>=$20K', t => (t.security_score||0)>=65 && (t.dp_liquidity_usd||0)>=20000],
  ['Score>=75 Liq>=$15K', t => (t.security_score||0)>=75 && (t.dp_liquidity_usd||0)>=15000],
  ['Score>=80 Liq>=$15K', t => (t.security_score||0)>=80 && (t.dp_liquidity_usd||0)>=15000],
  ['Score>=80 Liq>=$20K', t => (t.security_score||0)>=80 && (t.dp_liquidity_usd||0)>=20000],
  ['Score>=85 Liq>=$15K', t => (t.security_score||0)>=85 && (t.dp_liquidity_usd||0)>=15000],
  ['Score>=85 Liq>=$20K', t => (t.security_score||0)>=85 && (t.dp_liquidity_usd||0)>=20000],
];

console.log('='.repeat(110));
console.log(`  SIMULACION CORREGIDA: TP1=15% sell 100%, trade=0.1 SOL, fees=0.0024`);
console.log(`  Win = +${TP_GAIN.toFixed(4)} SOL | Rug = -${(TRADE_SIZE + FEE).toFixed(4)} SOL`);
console.log(`  → 1 rug necesita ${Math.ceil((TRADE_SIZE + FEE) / TP_GAIN)} wins para recuperarse`);
console.log('='.repeat(110));

console.log(
  'Config'.padEnd(35) + '| ' +
  'N'.padStart(4) + ' | ' +
  'TP1'.padStart(5) + ' | ' +
  'TP1%'.padStart(5) + ' | ' +
  'Rugs'.padStart(4) + ' | ' +
  'Rug%'.padStart(5) + ' | ' +
  'Win%'.padStart(5) + ' | ' +
  'PnL SOL'.padStart(10) + ' | ' +
  '$/trade'.padStart(9)
);
console.log('-'.repeat(110));

for (const [label, fn] of configs) {
  const r = simulate(label, fn);
  const tp1Pct = (r.tp1Hits / Math.max(r.total, 1) * 100).toFixed(0);
  const rugPct = (r.rugs / Math.max(r.total, 1) * 100).toFixed(0);
  const winPct = (r.wins / Math.max(r.total, 1) * 100).toFixed(0);
  const perTrade = (r.totalPnl / Math.max(r.total, 1)).toFixed(5);

  console.log(
    label.padEnd(35) + '| ' +
    String(r.total).padStart(4) + ' | ' +
    String(r.tp1Hits).padStart(5) + ' | ' +
    (tp1Pct + '%').padStart(5) + ' | ' +
    String(r.rugs).padStart(4) + ' | ' +
    (rugPct + '%').padStart(5) + ' | ' +
    (winPct + '%').padStart(5) + ' | ' +
    ((r.totalPnl >= 0 ? '+' : '') + r.totalPnl.toFixed(4)).padStart(10) + ' | ' +
    perTrade.padStart(9)
  );
}

// MATH BREAKDOWN for best config
console.log('\n' + '='.repeat(110));
console.log('  MATEMATICA PURA: ¿Por que pierde?');
console.log('='.repeat(110));

const best = simulate('Score>=80 Liq>=$20K', t =>
  (t.security_score||0)>=80 && (t.dp_liquidity_usd||0)>=20000
);

console.log(`\nMejor config: ${best.label}`);
console.log(`  ${best.tp1Hits} TP1 wins × +${TP_GAIN.toFixed(4)} = +${(best.tp1Hits * TP_GAIN).toFixed(4)} SOL`);
console.log(`  ${best.rugs} rugs × -${(TRADE_SIZE + FEE).toFixed(4)} = -${(best.rugs * (TRADE_SIZE + FEE)).toFixed(4)} SOL`);
const otherLosses = best.losses - best.rugs;
// Calculate actual other losses
const passedTrades = trades.filter(t => (t.security_score||0)>=80 && (t.dp_liquidity_usd||0)>=20000);
let normalLossTotal = 0;
let normalLossCount = 0;
for (const t of passedTrades) {
  const isRug = (t.exit_reason||'').includes('rug') || (t.exit_reason||'').includes('honeypot');
  if (!wouldHitTP1(t) && !isRug) {
    const pnlRatio = (t.pnl_pct || 0) / 100;
    const tradePnl = TRADE_SIZE * pnlRatio - FEE;
    if (tradePnl <= 0) {
      normalLossTotal += tradePnl;
      normalLossCount++;
    }
  }
}
const otherWins = best.wins - best.tp1Hits;
let normalWinTotal = 0;
for (const t of passedTrades) {
  const isRug = (t.exit_reason||'').includes('rug') || (t.exit_reason||'').includes('honeypot');
  if (!wouldHitTP1(t) && !isRug) {
    const pnlRatio = (t.pnl_pct || 0) / 100;
    const tradePnl = TRADE_SIZE * pnlRatio - FEE;
    if (tradePnl > 0) normalWinTotal += tradePnl;
  }
}

console.log(`  ${normalLossCount} normal losses = ${normalLossTotal.toFixed(4)} SOL`);
console.log(`  ${otherWins} small wins (no TP1) = +${normalWinTotal.toFixed(4)} SOL`);
console.log(`  -------`);
console.log(`  TOTAL: ${best.totalPnl.toFixed(4)} SOL\n`);

console.log(`  RATIO CRITICO:`);
console.log(`  1 rug (−${(TRADE_SIZE+FEE).toFixed(4)}) necesita ${Math.ceil((TRADE_SIZE+FEE)/TP_GAIN)} wins (+${TP_GAIN.toFixed(4)} cada una)`);
console.log(`  Tus rugs: ${best.rugs}/${best.total} = ${(best.rugs/best.total*100).toFixed(1)}%`);
console.log(`  Rug rate máximo para breakeven con TP1=15%: ${(1/(Math.ceil((TRADE_SIZE+FEE)/TP_GAIN)+1)*100).toFixed(1)}%`);
console.log(`  Tu rug rate real: ${(best.rugs/best.total*100).toFixed(1)}%`);

// What TP% would make it profitable?
console.log('\n' + '='.repeat(110));
console.log('  ¿QUE TP% NECESITARIAS para ser profitable? (con Score>=80 Liq>=$20K)');
console.log('='.repeat(110));

for (const tpPct of [10, 15, 20, 25, 30, 40, 50, 75, 100]) {
  const tpTarget = 1 + tpPct / 100;
  const tpGain = TRADE_SIZE * (tpPct / 100) - FEE;
  let pnl = 0;
  let hits = 0;

  for (const t of passedTrades) {
    const isRug = (t.exit_reason||'').includes('rug') || (t.exit_reason||'').includes('honeypot');
    const peak = t.peak_multiplier || 0;
    const pnlPct = t.pnl_pct || 0;
    const wouldHit = peak >= tpTarget || (peak === 0 && pnlPct >= tpPct);

    if (wouldHit) {
      pnl += tpGain;
      hits++;
    } else if (isRug) {
      pnl += -TRADE_SIZE * Math.min(1, Math.abs(pnlPct || 100)/100) - FEE;
    } else {
      pnl += TRADE_SIZE * pnlPct / 100 - FEE;
    }
  }

  const hitRate = (hits / passedTrades.length * 100).toFixed(0);
  console.log(
    `  TP=${(tpPct+'%').padStart(4)} (${tpTarget.toFixed(2)}x): ` +
    `hits=${String(hits).padStart(3)} (${hitRate}%) | ` +
    `gain/hit=+${tpGain.toFixed(4)} | ` +
    `PnL=${(pnl>=0?'+':'') + pnl.toFixed(4)} SOL ` +
    (pnl >= 0 ? ' ← PROFITABLE' : '')
  );
}

db.close();
console.log('\nDone.');
