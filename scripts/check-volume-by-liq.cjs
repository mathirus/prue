const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'), { readonly: true });

// Time range
const timeRange = db.prepare(`
  SELECT MIN(opened_at) as first, MAX(opened_at) as last, COUNT(*) as total
  FROM shadow_positions WHERE closed_at IS NOT NULL
`).get();
const hours = (timeRange.last - timeRange.first) / 3600000;
console.log(`=== ${timeRange.total} SHADOW POSITIONS EN ${hours.toFixed(1)} HORAS ===\n`);

// By liq range (ALL)
const allByLiq = db.prepare(`
  SELECT
    CASE
      WHEN dp.dp_liquidity_usd >= 20000 THEN '20K+'
      WHEN dp.dp_liquidity_usd >= 15000 THEN '15-20K'
      WHEN dp.dp_liquidity_usd >= 10000 THEN '10-15K'
      WHEN dp.dp_liquidity_usd >= 7000 THEN '7-10K'
      ELSE '<7K'
    END as rango,
    COUNT(*) as total,
    SUM(CASE WHEN sp.rug_detected = 1 THEN 1 ELSE 0 END) as rugs,
    SUM(CASE WHEN sp.tp1_hit = 1 THEN 1 ELSE 0 END) as tp1
  FROM shadow_positions sp
  LEFT JOIN detected_pools dp ON sp.pool_address = dp.pool_address
  WHERE sp.closed_at IS NOT NULL
  GROUP BY rango
  ORDER BY MIN(dp.dp_liquidity_usd) DESC
`).all();

console.log('TODOS (sin filtro de score):');
console.log('Rango    | Total | /hora | /dia  | Rugs | Rug% | TP1%');
console.log('-'.repeat(62));
for (const r of allByLiq) {
  const perHour = (r.total / hours).toFixed(1);
  const perDay = (r.total / hours * 24).toFixed(0);
  const rugPct = (r.rugs / r.total * 100).toFixed(0);
  const tp1Pct = (r.tp1 / r.total * 100).toFixed(0);
  console.log(`${r.rango.padEnd(8)} | ${String(r.total).padStart(5)} | ${perHour.padStart(5)} | ${perDay.padStart(5)} | ${String(r.rugs).padStart(4)} | ${(rugPct + '%').padStart(4)} | ${(tp1Pct + '%').padStart(4)}`);
}

// By liq range (score >= 60)
const filtByLiq = db.prepare(`
  SELECT
    CASE
      WHEN dp.dp_liquidity_usd >= 20000 THEN '20K+'
      WHEN dp.dp_liquidity_usd >= 15000 THEN '15-20K'
      WHEN dp.dp_liquidity_usd >= 10000 THEN '10-15K'
      WHEN dp.dp_liquidity_usd >= 7000 THEN '7-10K'
      ELSE '<7K'
    END as rango,
    COUNT(*) as total,
    SUM(CASE WHEN sp.rug_detected = 1 THEN 1 ELSE 0 END) as rugs,
    SUM(CASE WHEN sp.tp1_hit = 1 THEN 1 ELSE 0 END) as tp1
  FROM shadow_positions sp
  LEFT JOIN detected_pools dp ON sp.pool_address = dp.pool_address
  WHERE sp.closed_at IS NOT NULL
    AND sp.security_score >= 60
  GROUP BY rango
  ORDER BY MIN(dp.dp_liquidity_usd) DESC
`).all();

console.log('\nCON SCORE >= 60:');
console.log('Rango    | Total | /hora | /dia  | Rugs | Rug% | TP1%');
console.log('-'.repeat(62));
for (const r of filtByLiq) {
  const perHour = (r.total / hours).toFixed(1);
  const perDay = (r.total / hours * 24).toFixed(0);
  const rugPct = (r.rugs / r.total * 100).toFixed(0);
  const tp1Pct = (r.tp1 / r.total * 100).toFixed(0);
  console.log(`${r.rango.padEnd(8)} | ${String(r.total).padStart(5)} | ${perHour.padStart(5)} | ${perDay.padStart(5)} | ${String(r.rugs).padStart(4)} | ${(rugPct + '%').padStart(4)} | ${(tp1Pct + '%').padStart(4)}`);
}

// Summary
const s60_10k = db.prepare(`
  SELECT COUNT(*) as n FROM shadow_positions sp
  LEFT JOIN detected_pools dp ON sp.pool_address = dp.pool_address
  WHERE sp.closed_at IS NOT NULL AND sp.security_score >= 60 AND dp.dp_liquidity_usd >= 10000
`).get();
const s60_15k = db.prepare(`
  SELECT COUNT(*) as n FROM shadow_positions sp
  LEFT JOIN detected_pools dp ON sp.pool_address = dp.pool_address
  WHERE sp.closed_at IS NOT NULL AND sp.security_score >= 60 AND dp.dp_liquidity_usd >= 15000
`).get();

console.log(`\n=== RESUMEN FILTROS ===`);
console.log(`score>=60 + liq>=$10K: ${s60_10k.n} trades en ${hours.toFixed(1)}h = ${(s60_10k.n/hours).toFixed(1)}/hora = ${(s60_10k.n/hours*24).toFixed(0)}/dia`);
console.log(`score>=60 + liq>=$15K: ${s60_15k.n} trades en ${hours.toFixed(1)}h = ${(s60_15k.n/hours).toFixed(1)}/hora = ${(s60_15k.n/hours*24).toFixed(0)}/dia`);
console.log(`\nDiferencia: ${s60_10k.n - s60_15k.n} trades extra con $10K (${((s60_10k.n - s60_15k.n)/s60_10k.n*100).toFixed(0)}% mas volumen)`);

db.close();
