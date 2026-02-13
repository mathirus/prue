const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'), { readonly: true });

// Recent data (last 5 hours)
const cutoff = Date.now() - 5 * 3600000;

const stats = db.prepare(`
  SELECT COUNT(*) as total, MIN(detected_at) as first, MAX(detected_at) as last
  FROM detected_pools WHERE detected_at > ?
`).get(cutoff);
const hours = (stats.last - stats.first) / 3600000;

const shadow = db.prepare(`
  SELECT COUNT(*) as n FROM shadow_positions WHERE opened_at > ?
`).get(cutoff);

const active = db.prepare(`
  SELECT COUNT(*) as n FROM shadow_positions WHERE closed_at IS NULL
`).get();

console.log(`=== EMBUDO COMPLETO (ultimas ${hours.toFixed(1)}h) ===\n`);
console.log(`1. Pools DETECTADOS en blockchain:  ${stats.total}  (${(stats.total/hours).toFixed(0)}/hora)`);
console.log(`2. Shadow positions ABIERTAS:       ${shadow.n}  (${(shadow.n/hours).toFixed(0)}/hora)`);
console.log(`3. Shadow ACTIVAS ahora:            ${active.n}`);

// Rejection stages
const byStage = db.prepare(`
  SELECT dp_rejection_stage, COUNT(*) as n
  FROM detected_pools WHERE detected_at > ?
  GROUP BY dp_rejection_stage ORDER BY n DESC
`).all(cutoff);

console.log('\nPor que se rechazan:');
for (const r of byStage) {
  const pct = (r.n / stats.total * 100).toFixed(0);
  console.log(`  ${(r.dp_rejection_stage || 'APROBADO (shadow)').padEnd(30)}: ${String(r.n).padStart(5)} (${pct}%)`);
}

// Filtered counts
const filt10 = db.prepare(`
  SELECT COUNT(*) as n FROM shadow_positions sp
  LEFT JOIN detected_pools dp ON sp.pool_address = dp.pool_address
  WHERE sp.opened_at > ? AND sp.security_score >= 60 AND dp.dp_liquidity_usd >= 10000
`).get(cutoff);

const filt15 = db.prepare(`
  SELECT COUNT(*) as n FROM shadow_positions sp
  LEFT JOIN detected_pools dp ON sp.pool_address = dp.pool_address
  WHERE sp.opened_at > ? AND sp.security_score >= 60 AND dp.dp_liquidity_usd >= 15000
`).get(cutoff);

console.log(`\n=== FILTRADOS (los que COMPRARIAMOS) ===`);
console.log(`score>=60 + liq>=$10K: ${filt10.n} en ${hours.toFixed(1)}h = ${(filt10.n/hours).toFixed(1)}/hora = ~${(filt10.n/hours*24).toFixed(0)}/dia`);
console.log(`score>=60 + liq>=$15K: ${filt15.n} en ${hours.toFixed(1)}h = ${(filt15.n/hours).toFixed(1)}/hora = ~${(filt15.n/hours*24).toFixed(0)}/dia`);

console.log(`\n=== EXPLICACION SIMPLE ===`);
console.log(`De ${(stats.total/hours).toFixed(0)} tokens NUEVOS por hora en Solana:`);
console.log(`  - La mayoria son basura (liq baja, scams obvios, sin auth revocada)`);
console.log(`  - ${(shadow.n/hours).toFixed(0)}/hora pasan analisis basico → shadow tracking`);
console.log(`  - ${(filt15.n/hours).toFixed(1)}/hora pasan TODOS los filtros → estos comprariamos`);
console.log(`  - Esos ${(filt15.n/hours).toFixed(1)}/hora son los BUENOS con ~88% win rate`);

db.close();
