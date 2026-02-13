const Database = require('better-sqlite3');
const db = new Database('C:/Users/mathi/proyectos/botplatita/solana-sniper-bot/data/bot.db');

console.log('\n=== PRICE TRAJECTORIES DETALLADAS ===\n');

// Get all v8r/v8s positions
const positions = db.prepare(`
  SELECT token_mint, SUBSTR(token_mint, 1, 8) as mint_short, pnl_pct, opened_at, closed_at
  FROM positions
  WHERE bot_version IN ('v8r', 'v8s')
    AND status IN ('closed', 'stopped')
  ORDER BY pnl_pct DESC
`).all();

positions.forEach(pos => {
  const outcome = pos.pnl_pct > 5 ? '✓ WIN' : (pos.pnl_pct <= -80 ? '✗ RUG' : '~ LOSS');
  console.log(`${outcome} ${pos.mint_short}... (${pos.pnl_pct}%)`);

  // Get all price snapshots for this position
  const snapshots = db.prepare(`
    SELECT
      ROUND(elapsed_ms / 60000.0, 1) as minutes,
      ROUND(multiplier, 3) as mult,
      ROUND(pnl_pct, 1) as pnl_pct,
      price
    FROM position_price_log
    WHERE position_id = ?
    ORDER BY elapsed_ms ASC
  `).all(pos.token_mint);

  if (snapshots.length > 0) {
    console.log('  Timeline:');
    snapshots.forEach(s => {
      console.log(`    ${s.minutes}min: ${s.mult}x (${s.pnl_pct}%)`);
    });
  } else {
    console.log('  No price snapshots (feature not enabled for this trade)');
  }
  console.log();
});

console.log('\n=== ANÁLISIS PATRONES: RUGS VS WINNERS ===\n');

console.log('¿Cuándo ocurren los rugs típicamente?\n');

const rugTimings = db.prepare(`
  SELECT
    SUBSTR(token_mint, 1, 12) as mint,
    ROUND((closed_at - opened_at) / 60000.0, 1) as duration_min,
    ROUND(peak_multiplier, 2) as peak_mult,
    security_score,
    holder_count,
    ROUND(liquidity_usd, 0) as liq_usd,
    exit_reason
  FROM positions
  WHERE bot_version IN ('v8r', 'v8s')
    AND pnl_pct <= -80
  ORDER BY duration_min ASC
`).all();

rugTimings.forEach(r => {
  console.log(`${r.mint}...`);
  console.log(`  Rug en ${r.duration_min} min | Peak: ${r.peak_mult}x antes del rug`);
  console.log(`  Score: ${r.security_score} | Holders: ${r.holder_count} | Liq: $${r.liq_usd}`);
  console.log(`  Exit reason: ${r.exit_reason}`);
  console.log();
});

console.log('\n¿Qué diferencia a los winners de los losers?\n');

const winnerStats = db.prepare(`
  SELECT
    AVG(security_score) as avg_score,
    AVG(holder_count) as avg_holders,
    AVG(liquidity_usd) as avg_liq,
    AVG(peak_multiplier) as avg_peak,
    COUNT(*) as count
  FROM positions
  WHERE bot_version IN ('v8r', 'v8s')
    AND pnl_pct > 5
`).get();

const loserStats = db.prepare(`
  SELECT
    AVG(security_score) as avg_score,
    AVG(holder_count) as avg_holders,
    AVG(liquidity_usd) as avg_liq,
    AVG(peak_multiplier) as avg_peak,
    COUNT(*) as count
  FROM positions
  WHERE bot_version IN ('v8r', 'v8s')
    AND pnl_pct <= 5
`).get();

console.log('Winners (>5%):');
console.log(`  N=${winnerStats.count} | Avg Score: ${winnerStats.avg_score.toFixed(1)}`);
console.log(`  Avg Holders: ${winnerStats.avg_holders.toFixed(1)} | Avg Liq: $${winnerStats.avg_liq.toFixed(0)}`);
console.log(`  Avg Peak: ${winnerStats.avg_peak.toFixed(2)}x`);
console.log();

console.log('Losers (≤5%):');
console.log(`  N=${loserStats.count} | Avg Score: ${loserStats.avg_score.toFixed(1)}`);
console.log(`  Avg Holders: ${loserStats.avg_holders.toFixed(1)} | Avg Liq: $${loserStats.avg_liq.toFixed(0)}`);
console.log(`  Avg Peak: ${loserStats.avg_peak.toFixed(2)}x`);
console.log();

console.log('\n=== BUENOS TOKENS QUE SE NOS ESCAPARON ===\n');

const escaped = db.prepare(`
  SELECT
    SUBSTR(base_mint, 1, 12) as mint,
    security_score,
    pool_outcome,
    rejection_reasons,
    dp_holder_count as holders,
    ROUND(dp_liquidity_usd, 0) as liq_usd
  FROM detected_pools
  WHERE detected_at > (SELECT MIN(opened_at) FROM positions WHERE bot_version IN ('v8r', 'v8s'))
    AND security_passed = 1
    AND base_mint NOT IN (SELECT token_mint FROM positions WHERE bot_version IN ('v8r', 'v8s'))
  LIMIT 20
`).all();

if (escaped.length === 0) {
  console.log('No hay tokens que hayan pasado scoring y no hayamos comprado (max_concurrent funcionó perfecto)');
} else {
  console.log(`Encontrados ${escaped.length} tokens que pasaron scoring pero NO compramos:\n`);
  escaped.forEach(e => {
    console.log(`${e.mint}... | Score: ${e.security_score}`);
    console.log(`  Outcome: ${e.pool_outcome || 'unknown'} | Rejection: ${e.rejection_reasons || 'max_concurrent?'}`);
    console.log(`  Holders: ${e.holders || 'N/A'} | Liq: $${e.liq_usd || 'N/A'}`);
    console.log();
  });
}

console.log('\n=== ANÁLISIS DE TP LEVELS ===\n');

const tpAnalysis = db.prepare(`
  SELECT
    tp_levels_hit,
    COUNT(*) as count,
    AVG(pnl_pct) as avg_pnl,
    AVG(peak_multiplier) as avg_peak
  FROM positions
  WHERE bot_version IN ('v8r', 'v8s')
    AND status IN ('closed', 'stopped')
    AND pnl_pct > 5
  GROUP BY tp_levels_hit
  ORDER BY avg_pnl DESC
`).all();

console.log('TP Levels hit vs PnL:');
tpAnalysis.forEach(tp => {
  console.log(`  TP: ${tp.tp_levels_hit || 'none'} | N=${tp.count} | Avg PnL: ${tp.avg_pnl.toFixed(1)}% | Avg Peak: ${tp.avg_peak.toFixed(2)}x`);
});

console.log('\n=== EXIT REASONS ===\n');

const exitReasons = db.prepare(`
  SELECT
    exit_reason,
    COUNT(*) as count,
    AVG(pnl_pct) as avg_pnl,
    MIN(pnl_pct) as min_pnl,
    MAX(pnl_pct) as max_pnl
  FROM positions
  WHERE bot_version IN ('v8r', 'v8s')
    AND status IN ('closed', 'stopped')
  GROUP BY exit_reason
  ORDER BY count DESC
`).all();

exitReasons.forEach(er => {
  console.log(`${er.exit_reason || 'unknown'}: ${er.count} trades`);
  console.log(`  Avg PnL: ${er.avg_pnl.toFixed(1)}% | Range: ${er.min_pnl.toFixed(1)}% to ${er.max_pnl.toFixed(1)}%`);
  console.log();
});

console.log('\n=== SCORE 85 vs SCORE 80 ===\n');

const score85 = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN pnl_pct > 5 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN pnl_pct <= -80 THEN 1 ELSE 0 END) as rugs,
    ROUND(AVG(pnl_pct), 1) as avg_pnl,
    ROUND(SUM(pnl_sol), 6) as total_pnl
  FROM positions
  WHERE bot_version IN ('v8r', 'v8s')
    AND security_score = 85
`).get();

const score80 = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN pnl_pct > 5 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN pnl_pct <= -80 THEN 1 ELSE 0 END) as rugs,
    ROUND(AVG(pnl_pct), 1) as avg_pnl,
    ROUND(SUM(pnl_sol), 6) as total_pnl
  FROM positions
  WHERE bot_version IN ('v8r', 'v8s')
    AND security_score = 80
`).get();

console.log('Score 85:');
console.log(`  Total: ${score85.total} | Wins: ${score85.wins} (${(100*score85.wins/score85.total).toFixed(1)}%)`);
console.log(`  Rugs: ${score85.rugs} (${(100*score85.rugs/score85.total).toFixed(1)}%)`);
console.log(`  Avg PnL: ${score85.avg_pnl}% | Total PnL: ${score85.total_pnl} SOL`);
console.log();

console.log('Score 80:');
console.log(`  Total: ${score80.total} | Wins: ${score80.wins} (${(100*score80.wins/score80.total).toFixed(1)}%)`);
console.log(`  Rugs: ${score80.rugs} (${(100*score80.rugs/score80.total).toFixed(1)}%)`);
console.log(`  Avg PnL: ${score80.avg_pnl}% | Total PnL: ${score80.total_pnl} SOL`);
console.log();

db.close();
