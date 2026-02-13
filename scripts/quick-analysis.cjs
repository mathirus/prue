const Database = require('better-sqlite3');
const db = new Database('data/bot.db');

// 1. Total stats
const total = db.prepare('SELECT COUNT(*) as n FROM shadow_positions').get();
const active = db.prepare('SELECT COUNT(*) as n FROM shadow_positions WHERE closed_at IS NULL').get();
const closed = db.prepare('SELECT COUNT(*) as n FROM shadow_positions WHERE closed_at IS NOT NULL').get();
console.log('=== SHADOW POSITIONS ===');
console.log('Total:', total.n, '| Activas:', active.n, '| Cerradas:', closed.n);

// 2. Exit reasons
const exits = db.prepare('SELECT exit_reason, COUNT(*) as n, ROUND(AVG(peak_multiplier),2) as avg_peak FROM shadow_positions WHERE closed_at IS NOT NULL GROUP BY exit_reason ORDER BY n DESC').all();
console.log('\n=== EXIT REASONS ===');
exits.forEach(r => console.log(`  ${r.exit_reason}: N=${r.n} peak=${r.avg_peak}x`));

// 3. By score range
const allClosed = db.prepare('SELECT * FROM shadow_positions WHERE closed_at IS NOT NULL').all();
const ranges = { '<50': [], '50-59': [], '60-74': [], '75+': [] };
allClosed.forEach(r => {
  if (r.security_score >= 75) ranges['75+'].push(r);
  else if (r.security_score >= 60) ranges['60-74'].push(r);
  else if (r.security_score >= 50) ranges['50-59'].push(r);
  else ranges['<50'].push(r);
});
console.log('\n=== POR SCORE (cerradas) ===');
for (const [range, rows] of Object.entries(ranges)) {
  const rugs = rows.filter(r => r.rug_detected).length;
  const tp1 = rows.filter(r => r.tp1_hit).length;
  const tp2 = rows.filter(r => r.tp2_hit).length;
  console.log(`  score ${range}: N=${rows.length} rugs=${rugs}(${rows.length?(rugs/rows.length*100).toFixed(0):0}%) TP1=${tp1} TP2=${tp2}`);
}

// 4. Filtered: score>=60 + liq>=10K
const filtered = db.prepare(`
  SELECT sp.*, dp.dp_liquidity_usd
  FROM shadow_positions sp
  LEFT JOIN detected_pools dp ON sp.pool_address = dp.pool_address
  WHERE sp.closed_at IS NOT NULL AND sp.security_score >= 60
`).all();

const liq10k = filtered.filter(r => (r.dp_liquidity_usd || 0) >= 10000);
const liq10k_rugs = liq10k.filter(r => r.rug_detected);
const liq10k_tp1 = liq10k.filter(r => r.tp1_hit);
const liq10k_tp2 = liq10k.filter(r => r.tp2_hit);

console.log('\n=== FILTRO score>=60 + liq>=10K (CERRADAS) ===');
console.log(`N: ${liq10k.length} | Rugs: ${liq10k_rugs.length} (${liq10k.length?(liq10k_rugs.length/liq10k.length*100).toFixed(1):0}%) | TP1: ${liq10k_tp1.length} | TP2: ${liq10k_tp2.length}`);
console.log('\nDetalle:');
liq10k.forEach(r => {
  console.log(`  score=${r.security_score} liq=$${Math.round(r.dp_liquidity_usd||0)} rug=${r.rug_detected?'RUG':'ok'} tp1=${r.tp1_hit?'Y':'n'} tp2=${r.tp2_hit?'Y':'n'} peak=${(r.peak_multiplier||0).toFixed(2)}x exit=${r.exit_reason} version=${r.bot_version}`);
});

// 5. Same but score>=75 + liq>=10K
const liq10k_75 = filtered.filter(r => (r.dp_liquidity_usd || 0) >= 10000 && r.security_score >= 75);
console.log(`\n=== FILTRO score>=75 + liq>=10K ===`);
console.log(`N: ${liq10k_75.length} | Rugs: ${liq10k_75.filter(r=>r.rug_detected).length} | TP1: ${liq10k_75.filter(r=>r.tp1_hit).length} | TP2: ${liq10k_75.filter(r=>r.tp2_hit).length}`);

// 6. Price logs
const plCols = db.prepare('PRAGMA table_info(shadow_price_log)').all();
console.log('\nPrice log columns:', plCols.map(c=>c.name).join(', '));
const logCount = db.prepare('SELECT COUNT(*) as n FROM shadow_price_log').get();
console.log(`Price log entries: ${logCount.n}`);

// 8. By version
const byVer = db.prepare('SELECT bot_version, COUNT(*) as n, SUM(CASE WHEN rug_detected=1 THEN 1 ELSE 0 END) as rugs, SUM(CASE WHEN closed_at IS NULL THEN 1 ELSE 0 END) as active FROM shadow_positions GROUP BY bot_version ORDER BY bot_version').all();
console.log('\n=== POR VERSION ===');
byVer.forEach(r => console.log(`  ${r.bot_version}: total=${r.n} rugs=${r.rugs} activas=${r.active}`));

// 9. PnL simulation simple for score>=60+liq>=10K
console.log('\n=== SIMULACION PnL SIMPLE (score>=60+liq>=10K) ===');
for (const size of [0.02, 0.03, 0.05]) {
  const overhead = 0.0028;
  let totalPnl = 0;
  let wins = 0;
  let losses = 0;
  liq10k.forEach(r => {
    let pnl;
    if (r.rug_detected) {
      pnl = -size * 0.6 - overhead; // lose 60% + overhead
    } else if (r.tp1_hit) {
      // Simplified: TP1 at 1.2x, sell 50%, rest at final_multiplier
      const tp1_gain = (size * 0.5) * (1.2 - 1) * 0.98; // 2% slippage
      const rest_gain = (size * 0.5) * ((r.final_multiplier || 1) - 1) * 0.98;
      pnl = tp1_gain + rest_gain - overhead;
    } else {
      pnl = size * ((r.final_multiplier || 1) - 1) * 0.98 - overhead;
    }
    totalPnl += pnl;
    if (pnl > 0) wins++; else losses++;
  });
  console.log(`  ${size} SOL: W=${wins} L=${losses} WR=${(wins/(wins+losses)*100).toFixed(0)}% PnL=${totalPnl.toFixed(4)} SOL (avg=${(totalPnl/Math.max(liq10k.length,1)).toFixed(4)}/trade)`);
}

db.close();
