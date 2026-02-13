#!/usr/bin/env node
/**
 * Filter Analysis CORRECTED: Uses shadow-validated rug labels.
 * Focus: TODAY's data only (what we collected ourselves).
 */
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'), { readonly: true });

const todayStart = new Date('2026-02-10T00:00:00Z').getTime();

// === PART 1: Pool outcome analysis (TODAY only) ===
const pools = db.prepare(`
  SELECT security_score, dp_liquidity_usd, dp_holder_count, dp_top_holder_pct,
         pool_outcome, source
  FROM detected_pools
  WHERE pool_outcome IN ('rug','survivor')
    AND detected_at >= ?
    AND security_score IS NOT NULL
    AND dp_liquidity_usd IS NOT NULL
`).all(todayStart);

const totalRugs = pools.filter(p => p.pool_outcome === 'rug').length;
const totalSurv = pools.filter(p => p.pool_outcome === 'survivor').length;

console.log(`FILTER ANALYSIS — SOLO HOY (Feb 10) — Datos Propios + Shadow Corrected`);
console.log(`Total: ${totalSurv} survivors + ${totalRugs} rugs (${(totalRugs/(totalRugs+totalSurv)*100).toFixed(2)}% rug rate)`);
console.log(`CAVEAT: Solo tenemos shadow rug data de ~3h. Rug rate real es probablemente MAYOR.`);
console.log('='.repeat(115));

const filters = [
  { name: 'ALL (sin filtro)', fn: () => true },
  { name: 'score>=40', fn: p => p.security_score >= 40 },
  { name: 'score>=50', fn: p => p.security_score >= 50 },
  { name: 'score>=60', fn: p => p.security_score >= 60 },
  { name: 'score>=65', fn: p => p.security_score >= 65 },
  { name: 'score>=70', fn: p => p.security_score >= 70 },
  { name: 'score>=75', fn: p => p.security_score >= 75 },
  { name: '---', fn: null },
  { name: 'liq>=5K', fn: p => p.dp_liquidity_usd >= 5000 },
  { name: 'liq>=7K', fn: p => p.dp_liquidity_usd >= 7000 },
  { name: 'liq>=10K', fn: p => p.dp_liquidity_usd >= 10000 },
  { name: 'liq>=15K', fn: p => p.dp_liquidity_usd >= 15000 },
  { name: '---', fn: null },
  { name: 'score>=50 liq>=5K', fn: p => p.security_score >= 50 && p.dp_liquidity_usd >= 5000 },
  { name: 'score>=50 liq>=7K', fn: p => p.security_score >= 50 && p.dp_liquidity_usd >= 7000 },
  { name: 'score>=50 liq>=10K', fn: p => p.security_score >= 50 && p.dp_liquidity_usd >= 10000 },
  { name: 'score>=55 liq>=7K', fn: p => p.security_score >= 55 && p.dp_liquidity_usd >= 7000 },
  { name: 'score>=55 liq>=10K', fn: p => p.security_score >= 55 && p.dp_liquidity_usd >= 10000 },
  { name: 'score>=60 liq>=7K', fn: p => p.security_score >= 60 && p.dp_liquidity_usd >= 7000 },
  { name: 'score>=60 liq>=10K', fn: p => p.security_score >= 60 && p.dp_liquidity_usd >= 10000 },
  { name: 'score>=65 liq>=10K', fn: p => p.security_score >= 65 && p.dp_liquidity_usd >= 10000 },
  { name: 'score>=70 liq>=10K', fn: p => p.security_score >= 70 && p.dp_liquidity_usd >= 10000 },
  { name: 'score>=75 liq>=10K [v9d]', fn: p => p.security_score >= 75 && p.dp_liquidity_usd >= 10000 },
  { name: 'score>=75 liq>=15K', fn: p => p.security_score >= 75 && p.dp_liquidity_usd >= 15000 },
];

console.log('');
const hdr = 'Filter'.padEnd(28) + '| ' + 'Pass'.padStart(6) + ' | ' +
  'Surv'.padStart(6) + ' | ' + 'Rugs'.padStart(5) + ' | ' + 'Rug%'.padStart(7) + ' | ' +
  'Surv kept'.padStart(9) + ' | ' + 'Rugs blocked'.padStart(12);
console.log(hdr);
console.log('-'.repeat(hdr.length));

for (const f of filters) {
  if (f.fn === null) { console.log('-'.repeat(hdr.length)); continue; }
  const passed = pools.filter(f.fn);
  const passRugs = passed.filter(p => p.pool_outcome === 'rug').length;
  const passSurv = passed.filter(p => p.pool_outcome === 'survivor').length;
  const rugPct = passed.length > 0 ? passRugs / passed.length * 100 : 0;
  const survKept = totalSurv > 0 ? passSurv / totalSurv * 100 : 0;
  const rugsBlocked = totalRugs > 0 ? (totalRugs - passRugs) / totalRugs * 100 : 0;

  console.log(
    f.name.padEnd(28) + '| ' +
    String(passed.length).padStart(6) + ' | ' +
    String(passSurv).padStart(6) + ' | ' +
    String(passRugs).padStart(5) + ' | ' +
    rugPct.toFixed(2).padStart(6) + '% | ' +
    survKept.toFixed(1).padStart(8) + '% | ' +
    rugsBlocked.toFixed(1).padStart(11) + '%'
  );
}

// === PART 2: Shadow Positions — The REAL Ground Truth ===
console.log('\n' + '='.repeat(115));
console.log('SHADOW POSITIONS — GROUND TRUTH (datos 100% propios, monitoreados en tiempo real)');
console.log('='.repeat(115));

const shadow = db.prepare(`
  SELECT sp.security_score, sp.peak_multiplier, sp.tp1_hit, sp.tp2_hit, sp.tp3_hit,
         sp.exit_reason, sp.rug_detected, sp.entry_sol_reserve,
         dp.dp_liquidity_usd
  FROM shadow_positions sp
  LEFT JOIN detected_pools dp ON (sp.token_mint = dp.base_mint OR sp.token_mint = dp.quote_mint)
    AND dp.base_mint != 'So11111111111111111111111111111111111111112'
  WHERE sp.status = 'closed' AND sp.peak_multiplier > 0
`).all();

console.log(`Total shadow cerradas: ${shadow.length}`);
console.log(`Rugs shadow: ${shadow.filter(s => s.rug_detected).length} (${(shadow.filter(s => s.rug_detected).length/shadow.length*100).toFixed(1)}%)`);
console.log(`TP1 hit: ${shadow.filter(s => s.tp1_hit).length} (${(shadow.filter(s => s.tp1_hit).length/shadow.length*100).toFixed(1)}%)`);
console.log(`TP2 hit: ${shadow.filter(s => s.tp2_hit).length} (${(shadow.filter(s => s.tp2_hit).length/shadow.length*100).toFixed(1)}%)`);
console.log('');

const sFilters = [
  { name: 'ALL shadow', fn: () => true },
  { name: 'score>=50', fn: p => (p.security_score||0) >= 50 },
  { name: 'score>=60', fn: p => (p.security_score||0) >= 60 },
  { name: 'score>=65', fn: p => (p.security_score||0) >= 65 },
  { name: 'score>=75', fn: p => (p.security_score||0) >= 75 },
  { name: '---', fn: null },
  { name: 'liq>=7K', fn: p => (p.dp_liquidity_usd||0) >= 7000 },
  { name: 'liq>=10K', fn: p => (p.dp_liquidity_usd||0) >= 10000 },
  { name: 'liq>=15K', fn: p => (p.dp_liquidity_usd||0) >= 15000 },
  { name: '---', fn: null },
  { name: 'score>=50 liq>=7K', fn: p => (p.security_score||0) >= 50 && (p.dp_liquidity_usd||0) >= 7000 },
  { name: 'score>=50 liq>=10K', fn: p => (p.security_score||0) >= 50 && (p.dp_liquidity_usd||0) >= 10000 },
  { name: 'score>=60 liq>=7K', fn: p => (p.security_score||0) >= 60 && (p.dp_liquidity_usd||0) >= 7000 },
  { name: 'score>=60 liq>=10K', fn: p => (p.security_score||0) >= 60 && (p.dp_liquidity_usd||0) >= 10000 },
  { name: 'score>=65 liq>=10K', fn: p => (p.security_score||0) >= 65 && (p.dp_liquidity_usd||0) >= 10000 },
  { name: 'score>=75 liq>=10K [v9d]', fn: p => (p.security_score||0) >= 75 && (p.dp_liquidity_usd||0) >= 10000 },
];

const hdr2 = 'Filter'.padEnd(28) + '| ' + 'N'.padStart(4) + ' | ' + 'Rugs'.padStart(5) + ' | ' +
  'Rug%'.padStart(6) + ' | ' + 'TP1%'.padStart(6) + ' | ' + 'TP2%'.padStart(6) + ' | ' +
  'AvgPeak'.padStart(8) + ' | ' + 'Safe AvgPeak'.padStart(13);
console.log(hdr2);
console.log('-'.repeat(hdr2.length));

for (const f of sFilters) {
  if (f.fn === null) { console.log('-'.repeat(hdr2.length)); continue; }
  const s = shadow.filter(f.fn);
  if (s.length === 0) { console.log(f.name.padEnd(28) + '| (no data)'); continue; }
  const n = s.length;
  const rugs = s.filter(p => p.rug_detected).length;
  const rugPct = (rugs/n*100).toFixed(1);
  const tp1 = (s.filter(p => p.tp1_hit).length/n*100).toFixed(1);
  const tp2 = (s.filter(p => p.tp2_hit).length/n*100).toFixed(1);
  const avgPeak = (s.reduce((a,b) => a+b.peak_multiplier, 0)/n).toFixed(2);
  const nonRug = s.filter(p => !p.rug_detected);
  const nrAvgPeak = nonRug.length > 0 ? (nonRug.reduce((a,b) => a+b.peak_multiplier, 0)/nonRug.length).toFixed(2) : 'N/A';

  console.log(
    f.name.padEnd(28) + '| ' +
    String(n).padStart(4) + ' | ' +
    String(rugs).padStart(5) + ' | ' +
    rugPct.padStart(5) + '% | ' +
    tp1.padStart(5) + '% | ' +
    tp2.padStart(5) + '% | ' +
    (avgPeak + 'x').padStart(8) + ' | ' +
    (nrAvgPeak + 'x').padStart(13)
  );
}

// === PART 3: Key finding - estimated PnL per trade ===
console.log('\n' + '='.repeat(115));
console.log('ESTIMACION PnL POR TRADE (shadow data, escéptico)');
console.log('='.repeat(115));
console.log('');
console.log('Supuestos conservadores:');
console.log('  - Slippage: 2% buy + 2% sell = 4% total');
console.log('  - Overhead: 0.0028 SOL/trade (ATA rent + TX fees)');
console.log('  - Rug loss: 50% de posición (emergency sell rescata algo)');
console.log('  - TP1 gain: (1.2x - 1 - 4% slippage) * 50% = ~8% de posición');
console.log('  - Non-TP non-rug: small loss from slippage + overhead');
console.log('');

for (const f of sFilters) {
  if (f.fn === null) continue;
  const s = shadow.filter(f.fn);
  if (s.length < 5) continue;
  const n = s.length;
  const rugs = s.filter(p => p.rug_detected).length;
  const tp1s = s.filter(p => p.tp1_hit && !p.rug_detected).length;
  const tp2s = s.filter(p => p.tp2_hit && !p.rug_detected).length;
  const neither = n - rugs - tp1s; // non-rug, non-TP1

  const rugRate = rugs / n;
  const tp1Rate = tp1s / n;
  const tp2Rate = tp2s / n;
  const neitherRate = neither / n;

  // At 0.02 SOL per trade
  const size = 0.02;
  const overhead = 0.0028;
  const rugLoss = rugRate * size * 0.50; // lose 50% on rug
  const tp1Gain = tp1Rate * size * 0.50 * 0.16; // 50% sold at 1.2x, net ~16% after slippage
  const tp2Gain = tp2Rate * size * 0.30 * 0.43; // 30% sold at 1.5x, net ~43% after slippage
  const neitherLoss = neitherRate * size * 0.04; // just slippage loss
  const pnl = tp1Gain + tp2Gain - rugLoss - neitherLoss - overhead;

  // At 0.05 SOL per trade
  const size5 = 0.05;
  const rugLoss5 = rugRate * size5 * 0.50;
  const tp1Gain5 = tp1Rate * size5 * 0.50 * 0.16;
  const tp2Gain5 = tp2Rate * size5 * 0.30 * 0.43;
  const neitherLoss5 = neitherRate * size5 * 0.04;
  const pnl5 = tp1Gain5 + tp2Gain5 - rugLoss5 - neitherLoss5 - overhead;

  console.log(
    f.name.padEnd(28) +
    `N=${n}  Rug=${(rugRate*100).toFixed(0)}%  TP1=${(tp1Rate*100).toFixed(0)}%  TP2=${(tp2Rate*100).toFixed(0)}%  ` +
    `PnL@0.02=${(pnl>=0?'+':'') + pnl.toFixed(5)}  PnL@0.05=${(pnl5>=0?'+':'') + pnl5.toFixed(5)}`
  );
}

console.log('\nCAVEAT IMPORTANTE: Estos números son OPTIMISTAS porque:');
console.log('1. Shadow TP rates son ~2x más altos que ejecución real (slippage, timing)');
console.log('2. Solo monitoreamos ~100 pools simultáneos de miles — selection bias');
console.log('3. Solo ~3h de data shadow — muestra chica');
console.log('4. Los rugs que NO shadoweamos no están contados');
console.log('RECOMENDACIÓN: Dividir PnL estimado por 2-3 para realismo.');

db.close();
