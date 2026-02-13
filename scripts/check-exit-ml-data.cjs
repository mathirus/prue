const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'), { readonly: true });

// Stats
const stats = db.prepare(`
  SELECT
    COUNT(DISTINCT shadow_id) as positions,
    COUNT(*) as total_logs
  FROM shadow_price_log
`).get();
console.log(`=== DATA DISPONIBLE PARA ML DE EXIT ===\n`);
console.log(`Positions con price logs: ${stats.positions}`);
console.log(`Total data points: ${stats.total_logs}`);
console.log(`Promedio: ${(stats.total_logs / stats.positions).toFixed(0)} logs/position`);
console.log(`Intervalo: ~5 segundos entre cada log`);

// Rug example
const rugPos = db.prepare(`
  SELECT sp.id, sp.token_mint, sp.security_score, sp.peak_multiplier,
         sp.rug_reserve_drop_pct, dp.dp_liquidity_usd
  FROM shadow_positions sp
  LEFT JOIN detected_pools dp ON sp.pool_address = dp.pool_address
  WHERE sp.rug_detected = 1 AND sp.security_score >= 60 AND dp.dp_liquidity_usd >= 10000
  ORDER BY sp.opened_at DESC LIMIT 1
`).get();

if (rugPos) {
  console.log(`\n=== EJEMPLO: RUG (${rugPos.token_mint.slice(0,8)}, score=${rugPos.security_score}, liq=$${Math.round(rugPos.dp_liquidity_usd)}) ===`);
  const logs = db.prepare(`
    SELECT * FROM shadow_price_log WHERE shadow_id = ? ORDER BY elapsed_ms
  `).all(rugPos.id);

  console.log('segundo | mult   | reserva SOL  | cambio reserva');
  console.log('-'.repeat(55));
  let prevRes = null;
  for (const r of logs.slice(0, 25)) {
    const resDelta = prevRes ? ((r.sol_reserve - prevRes) / prevRes * 100).toFixed(1) + '%' : '-';
    console.log(
      (r.elapsed_ms/1000).toFixed(0).padStart(5) + 's  | ' +
      r.multiplier.toFixed(4).padStart(6) + ' | ' +
      r.sol_reserve.toFixed(2).padStart(12) + ' | ' +
      resDelta
    );
    prevRes = r.sol_reserve;
  }
}

// Good token example
const goodPos = db.prepare(`
  SELECT sp.id, sp.token_mint, sp.security_score, sp.peak_multiplier, dp.dp_liquidity_usd
  FROM shadow_positions sp
  LEFT JOIN detected_pools dp ON sp.pool_address = dp.pool_address
  WHERE sp.rug_detected = 0 AND sp.tp2_hit = 1 AND sp.security_score >= 60 AND dp.dp_liquidity_usd >= 10000
  ORDER BY sp.peak_multiplier DESC LIMIT 1
`).get();

if (goodPos) {
  console.log(`\n=== EJEMPLO: WINNER (${goodPos.token_mint.slice(0,8)}, score=${goodPos.security_score}, peak=${goodPos.peak_multiplier.toFixed(2)}x) ===`);
  const logs = db.prepare(`
    SELECT * FROM shadow_price_log WHERE shadow_id = ? ORDER BY elapsed_ms
  `).all(goodPos.id);

  console.log('segundo | mult   | reserva SOL  | cambio reserva');
  console.log('-'.repeat(55));
  let prevRes = null;
  for (const r of logs.slice(0, 25)) {
    const resDelta = prevRes ? ((r.sol_reserve - prevRes) / prevRes * 100).toFixed(1) + '%' : '-';
    console.log(
      (r.elapsed_ms/1000).toFixed(0).padStart(5) + 's  | ' +
      r.multiplier.toFixed(4).padStart(6) + ' | ' +
      r.sol_reserve.toFixed(2).padStart(12) + ' | ' +
      resDelta
    );
    prevRes = r.sol_reserve;
  }
}

// What features could we derive for each 5s window?
console.log(`\n=== FEATURES QUE PODEMOS CALCULAR CADA 5 SEGUNDOS ===`);
console.log(`YA TENEMOS:`);
console.log(`  - price / multiplier (precio actual vs entrada)`);
console.log(`  - sol_reserve (liquidez SOL en el pool)`);
console.log(`  - elapsed_ms (tiempo desde entrada)`);
console.log(`\nPODEMOS DERIVAR:`);
console.log(`  - price_velocity: cambio de precio en ultimos 15s/30s/60s`);
console.log(`  - reserve_velocity: cambio de reserva en ultimos 15s/30s/60s`);
console.log(`  - reserve_vs_entry: reserva actual / reserva inicial`);
console.log(`  - peak_mult: maximo precio alcanzado hasta ahora`);
console.log(`  - drop_from_peak: caida desde el maximo`);
console.log(`  - time_above_entry: % del tiempo que estuvo en ganancia`);
console.log(`  - volatility_30s: desviacion estandar de precio en 30s`);
console.log(`\nFALTA AGREGAR AL TRACKING:`);
console.log(`  - sell_count: ventas recientes en el pool (burst indicator)`);
console.log(`  - buy_count: compras recientes`);
console.log(`  - holder_count_delta: cambio en holders desde entrada`);
console.log(`  - volume_sol: volumen en SOL reciente`);

db.close();
