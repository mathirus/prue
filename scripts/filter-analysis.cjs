#!/usr/bin/env node
/**
 * Filter Analysis: Evalúa TODOS los 9,200+ pools históricos con outcome conocido.
 * NO simula PnL (no tenemos price logs de estos), pero muestra:
 * - Qué % de rugs bloquea cada filtro
 * - Qué % de survivors deja pasar
 * - Tasa de rug de los que pasan
 * - Volume estimado (pools/hora)
 */
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'), { readonly: true });

const pools = db.prepare(`
  SELECT security_score, dp_liquidity_usd, dp_holder_count, dp_top_holder_pct,
         dp_graduation_time_s, dp_creator_reputation, pool_outcome, source, detected_at
  FROM detected_pools
  WHERE pool_outcome IN ('rug','survivor')
    AND security_score IS NOT NULL
    AND dp_liquidity_usd IS NOT NULL
`).all();

const totalRugs = pools.filter(p => p.pool_outcome === 'rug').length;
const totalSurv = pools.filter(p => p.pool_outcome === 'survivor').length;

// Estimate hours from first to last pool
const minT = Math.min(...pools.map(p => p.detected_at));
const maxT = Math.max(...pools.map(p => p.detected_at));
const hours = (maxT - minT) / 3600000;

console.log(`FILTER ANALYSIS — ${pools.length} pools con outcome conocido`);
console.log(`Periodo: ${new Date(minT).toLocaleString()} — ${new Date(maxT).toLocaleString()} (${hours.toFixed(0)}h)`);
console.log(`Total: ${totalSurv} survivors + ${totalRugs} rugs (${(totalRugs/pools.length*100).toFixed(2)}% rug rate)`);
console.log('='.repeat(115));

const filters = [
  { name: 'ALL (sin filtro)', fn: () => true },
  { name: 'score>=40', fn: p => p.security_score >= 40 },
  { name: 'score>=50', fn: p => p.security_score >= 50 },
  { name: 'score>=55', fn: p => p.security_score >= 55 },
  { name: 'score>=60', fn: p => p.security_score >= 60 },
  { name: 'score>=65', fn: p => p.security_score >= 65 },
  { name: 'score>=70', fn: p => p.security_score >= 70 },
  { name: 'score>=75', fn: p => p.security_score >= 75 },
  { name: 'score>=80', fn: p => p.security_score >= 80 },
  { name: '---', fn: null },
  { name: 'liq>=5K', fn: p => p.dp_liquidity_usd >= 5000 },
  { name: 'liq>=7K', fn: p => p.dp_liquidity_usd >= 7000 },
  { name: 'liq>=8K', fn: p => p.dp_liquidity_usd >= 8000 },
  { name: 'liq>=10K', fn: p => p.dp_liquidity_usd >= 10000 },
  { name: 'liq>=15K', fn: p => p.dp_liquidity_usd >= 15000 },
  { name: 'liq>=20K', fn: p => p.dp_liquidity_usd >= 20000 },
  { name: '---', fn: null },
  { name: 'score>=50 liq>=5K', fn: p => p.security_score >= 50 && p.dp_liquidity_usd >= 5000 },
  { name: 'score>=50 liq>=7K', fn: p => p.security_score >= 50 && p.dp_liquidity_usd >= 7000 },
  { name: 'score>=50 liq>=10K', fn: p => p.security_score >= 50 && p.dp_liquidity_usd >= 10000 },
  { name: 'score>=55 liq>=7K', fn: p => p.security_score >= 55 && p.dp_liquidity_usd >= 7000 },
  { name: 'score>=55 liq>=10K', fn: p => p.security_score >= 55 && p.dp_liquidity_usd >= 10000 },
  { name: 'score>=60 liq>=5K', fn: p => p.security_score >= 60 && p.dp_liquidity_usd >= 5000 },
  { name: 'score>=60 liq>=7K', fn: p => p.security_score >= 60 && p.dp_liquidity_usd >= 7000 },
  { name: 'score>=60 liq>=10K', fn: p => p.security_score >= 60 && p.dp_liquidity_usd >= 10000 },
  { name: 'score>=60 liq>=15K', fn: p => p.security_score >= 60 && p.dp_liquidity_usd >= 15000 },
  { name: 'score>=65 liq>=7K', fn: p => p.security_score >= 65 && p.dp_liquidity_usd >= 7000 },
  { name: 'score>=65 liq>=10K', fn: p => p.security_score >= 65 && p.dp_liquidity_usd >= 10000 },
  { name: 'score>=70 liq>=10K', fn: p => p.security_score >= 70 && p.dp_liquidity_usd >= 10000 },
  { name: 'score>=75 liq>=8K', fn: p => p.security_score >= 75 && p.dp_liquidity_usd >= 8000 },
  { name: 'score>=75 liq>=10K [v9d]', fn: p => p.security_score >= 75 && p.dp_liquidity_usd >= 10000 },
  { name: 'score>=75 liq>=15K', fn: p => p.security_score >= 75 && p.dp_liquidity_usd >= 15000 },
];

console.log('');
const hdr =
  'Filter'.padEnd(28) + '| ' +
  'Pass'.padStart(6) + ' | ' +
  'Surv'.padStart(6) + ' | ' +
  'Rugs'.padStart(5) + ' | ' +
  'Rug%'.padStart(7) + ' | ' +
  'Surv kept'.padStart(9) + ' | ' +
  'Rugs blocked'.padStart(12) + ' | ' +
  '/hora'.padStart(6);
console.log(hdr);
console.log('-'.repeat(hdr.length));

for (const f of filters) {
  if (f.fn === null) {
    console.log('-'.repeat(hdr.length));
    continue;
  }
  const passed = pools.filter(f.fn);
  const passRugs = passed.filter(p => p.pool_outcome === 'rug').length;
  const passSurv = passed.filter(p => p.pool_outcome === 'survivor').length;
  const rugPct = passed.length > 0 ? passRugs / passed.length * 100 : 0;
  const survKept = totalSurv > 0 ? passSurv / totalSurv * 100 : 0;
  const rugsBlocked = totalRugs > 0 ? (totalRugs - passRugs) / totalRugs * 100 : 0;
  const perHour = hours > 0 ? passed.length / hours : 0;

  console.log(
    f.name.padEnd(28) + '| ' +
    String(passed.length).padStart(6) + ' | ' +
    String(passSurv).padStart(6) + ' | ' +
    String(passRugs).padStart(5) + ' | ' +
    rugPct.toFixed(2).padStart(6) + '% | ' +
    survKept.toFixed(1).padStart(8) + '% | ' +
    rugsBlocked.toFixed(1).padStart(11) + '% | ' +
    perHour.toFixed(1).padStart(6)
  );
}

// Now the money question: using shadow data to estimate profitability
console.log('\n' + '='.repeat(115));
console.log('ESTIMACION DE RENTABILIDAD (basada en shadow TP hit rates)');
console.log('='.repeat(115));

// Get shadow TP hit rates by score range
const shadowData = db.prepare(`
  SELECT sp.security_score, sp.tp1_hit, sp.tp2_hit, sp.tp3_hit,
         sp.exit_reason, sp.peak_multiplier, dp.dp_liquidity_usd
  FROM shadow_positions sp
  LEFT JOIN detected_pools dp ON (sp.token_mint = dp.base_mint OR sp.token_mint = dp.quote_mint)
    AND dp.base_mint != 'So11111111111111111111111111111111111111112'
  WHERE sp.status = 'closed' AND sp.peak_multiplier > 0 AND sp.entry_price > 0
`).all();

console.log(`\nUsando ${shadowData.length} shadow positions para estimar TP rates:`);

// Shadow TP rates by filter
const shadowFilters = [
  { name: 'score>=50', fn: p => (p.security_score||0) >= 50 },
  { name: 'score>=55', fn: p => (p.security_score||0) >= 55 },
  { name: 'score>=60', fn: p => (p.security_score||0) >= 60 },
  { name: 'score>=65', fn: p => (p.security_score||0) >= 65 },
  { name: 'score>=60 liq>=10K', fn: p => (p.security_score||0) >= 60 && (p.dp_liquidity_usd||0) >= 10000 },
  { name: 'score>=65 liq>=10K', fn: p => (p.security_score||0) >= 65 && (p.dp_liquidity_usd||0) >= 10000 },
  { name: 'score>=75 liq>=10K', fn: p => (p.security_score||0) >= 75 && (p.dp_liquidity_usd||0) >= 10000 },
];

console.log('');
console.log(
  'Filter'.padEnd(24) + '| ' +
  'N'.padStart(3) + ' | ' +
  'TP1%'.padStart(6) + ' | ' +
  'TP2%'.padStart(6) + ' | ' +
  'Rug%'.padStart(6) + ' | ' +
  'AvgPeak'.padStart(8) + ' | ' +
  'Est PnL/trade @0.02'.padStart(20) + ' | ' +
  'Est PnL/trade @0.05'.padStart(20)
);
console.log('-'.repeat(105));

for (const f of shadowFilters) {
  const s = shadowData.filter(f.fn);
  if (s.length === 0) continue;
  const n = s.length;
  const tp1 = s.filter(p => p.tp1_hit).length / n * 100;
  const tp2 = s.filter(p => p.tp2_hit).length / n * 100;
  const rugPct = s.filter(p => p.exit_reason === 'rug_pull_detected').length / n * 100;
  const avgPeak = s.reduce((a,b) => a + b.peak_multiplier, 0) / n;

  // Estimate PnL per trade (simplified)
  // TP1 hit: gain ~0.002 SOL on 50% position
  // TP2 hit: gain ~0.003 SOL on 30% position
  // Rug: lose ~0.01 SOL on remaining
  // Non-rug non-TP: small loss from overhead
  const tp1Rate = tp1 / 100;
  const tp2Rate = tp2 / 100;
  const rugRate = rugPct / 100;

  // At 0.02 SOL
  const gain02 = tp1Rate * 0.02 * 0.50 * 0.18 + tp2Rate * 0.02 * 0.30 * 0.47; // 1.2x-1 adj, 1.5x-1 adj
  const loss02 = rugRate * 0.02 * 0.50 + 0.0028; // 50% lost on rug + overhead
  const pnl02 = gain02 - loss02;

  // At 0.05 SOL
  const gain05 = tp1Rate * 0.05 * 0.50 * 0.18 + tp2Rate * 0.05 * 0.30 * 0.47;
  const loss05 = rugRate * 0.05 * 0.50 + 0.0028;
  const pnl05 = gain05 - loss05;

  console.log(
    f.name.padEnd(24) + '| ' +
    String(n).padStart(3) + ' | ' +
    tp1.toFixed(1).padStart(5) + '% | ' +
    tp2.toFixed(1).padStart(5) + '% | ' +
    rugPct.toFixed(1).padStart(5) + '% | ' +
    avgPeak.toFixed(2).padStart(7) + 'x | ' +
    ((pnl02>=0?'+':'')+pnl02.toFixed(5)+' SOL').padStart(20) + ' | ' +
    ((pnl05>=0?'+':'')+pnl05.toFixed(5)+' SOL').padStart(20)
  );
}

console.log('\nNOTA: La estimación de PnL es MUY simplificada. Shadow TP rates son ~2x más optimistas que realidad.');
console.log('Dividir PnL estimado por 2-3 para un estimado más realista.');
console.log('Lo VALIOSO de esta tabla es la comparación RELATIVA entre filtros, no los números absolutos.');

db.close();
