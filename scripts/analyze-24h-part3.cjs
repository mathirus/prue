const Database = require('better-sqlite3');
const db = new Database('C:/Users/mathi/proyectos/botplatita/solana-sniper-bot/data/bot.db');

console.log('\n=== ANÁLISIS DE RECHAZOS (últimas 24h) ===\n');

const rejectionStats = db.prepare(`
  SELECT
    rejection_reasons,
    COUNT(*) as count,
    SUM(CASE WHEN pool_outcome = 'rugged' THEN 1 ELSE 0 END) as rugged,
    SUM(CASE WHEN pool_outcome = 'survived' THEN 1 ELSE 0 END) as survived,
    SUM(CASE WHEN pool_outcome IS NULL OR pool_outcome = 'unknown' THEN 1 ELSE 0 END) as unknown
  FROM detected_pools
  WHERE detected_at > (SELECT MIN(opened_at) FROM positions WHERE bot_version IN ('v8r', 'v8s'))
    AND security_passed = 0
  GROUP BY rejection_reasons
  ORDER BY count DESC
  LIMIT 20
`).all();

console.log('Top rejection reasons:\n');
rejectionStats.forEach((r, i) => {
  const total = r.rugged + r.survived + r.unknown;
  const rugPct = total > 0 ? (100 * r.rugged / total).toFixed(1) : 'N/A';
  const survPct = total > 0 ? (100 * r.survived / total).toFixed(1) : 'N/A';

  console.log(`${i+1}. ${r.rejection_reasons}`);
  console.log(`   Count: ${r.count} | Rugged: ${r.rugged} (${rugPct}%) | Survived: ${r.survived} (${survPct}%) | Unknown: ${r.unknown}`);
  console.log();
});

console.log('\n=== SCORING DISTRIBUTION (pools detectados) ===\n');

const scoreDistribution = db.prepare(`
  SELECT
    CASE
      WHEN security_score >= 85 THEN '85+'
      WHEN security_score >= 80 THEN '80-84'
      WHEN security_score >= 70 THEN '70-79'
      WHEN security_score >= 60 THEN '60-69'
      ELSE '<60'
    END as score_range,
    COUNT(*) as count,
    SUM(CASE WHEN security_passed = 1 THEN 1 ELSE 0 END) as passed
  FROM detected_pools
  WHERE detected_at > (SELECT MIN(opened_at) FROM positions WHERE bot_version IN ('v8r', 'v8s'))
  GROUP BY score_range
  ORDER BY score_range DESC
`).all();

console.log('Score distribution:');
scoreDistribution.forEach(sd => {
  const passPct = (100 * sd.passed / sd.count).toFixed(1);
  console.log(`  ${sd.score_range}: ${sd.count} pools | ${sd.passed} passed (${passPct}%)`);
});

console.log('\n=== TIMING: Detection → Purchase ===\n');

const timings = db.prepare(`
  SELECT
    p.token_mint,
    SUBSTR(p.token_mint, 1, 8) as mint_short,
    dp.detected_at,
    p.opened_at,
    ROUND((p.opened_at - dp.detected_at) / 1000.0, 2) as delay_seconds,
    p.pnl_pct
  FROM positions p
  JOIN detected_pools dp ON p.token_mint = dp.base_mint
  WHERE p.bot_version IN ('v8r', 'v8s')
  ORDER BY delay_seconds DESC
`).all();

if (timings.length > 0) {
  console.log('Detection → Purchase delay:\n');
  timings.forEach(t => {
    const outcome = t.pnl_pct > 5 ? '✓' : (t.pnl_pct <= -80 ? '✗' : '~');
    console.log(`${outcome} ${t.mint_short}... | ${t.delay_seconds}s delay | PnL: ${t.pnl_pct.toFixed(1)}%`);
  });

  const avgDelay = timings.reduce((sum, t) => sum + t.delay_seconds, 0) / timings.length;
  const medianDelay = timings.map(t => t.delay_seconds).sort((a, b) => a - b)[Math.floor(timings.length / 2)];
  console.log(`\nAvg delay: ${avgDelay.toFixed(2)}s | Median: ${medianDelay.toFixed(2)}s`);
} else {
  console.log('No timing data available (detected_pools may not have matching records)');
}

console.log('\n=== FEATURE ANALYSIS: ¿Qué features ayudan? ===\n');

// Analizar correlación entre features y outcome
const featureAnalysis = db.prepare(`
  SELECT
    AVG(CASE WHEN p.pnl_pct > 5 THEN dp.dp_holder_count ELSE NULL END) as win_avg_holders,
    AVG(CASE WHEN p.pnl_pct <= 5 THEN dp.dp_holder_count ELSE NULL END) as lose_avg_holders,
    AVG(CASE WHEN p.pnl_pct > 5 THEN dp.dp_liquidity_usd ELSE NULL END) as win_avg_liq,
    AVG(CASE WHEN p.pnl_pct <= 5 THEN dp.dp_liquidity_usd ELSE NULL END) as lose_avg_liq,
    AVG(CASE WHEN p.pnl_pct > 5 THEN dp.dp_top_holder_pct ELSE NULL END) as win_avg_top_holder,
    AVG(CASE WHEN p.pnl_pct <= 5 THEN dp.dp_top_holder_pct ELSE NULL END) as lose_avg_top_holder,
    AVG(CASE WHEN p.pnl_pct > 5 THEN dp.dp_rugcheck_score ELSE NULL END) as win_avg_rug_score,
    AVG(CASE WHEN p.pnl_pct <= 5 THEN dp.dp_rugcheck_score ELSE NULL END) as lose_avg_rug_score
  FROM positions p
  JOIN detected_pools dp ON p.token_mint = dp.base_mint
  WHERE p.bot_version IN ('v8r', 'v8s')
`).get();

if (featureAnalysis.win_avg_holders !== null) {
  console.log('Winners vs Losers feature comparison:\n');
  console.log(`Holder count:`);
  console.log(`  Winners: ${(featureAnalysis.win_avg_holders || 0).toFixed(1)} avg`);
  console.log(`  Losers: ${(featureAnalysis.lose_avg_holders || 0).toFixed(1)} avg`);
  console.log();

  console.log(`Liquidity USD:`);
  console.log(`  Winners: $${(featureAnalysis.win_avg_liq || 0).toFixed(0)} avg`);
  console.log(`  Losers: $${(featureAnalysis.lose_avg_liq || 0).toFixed(0)} avg`);
  console.log();

  console.log(`Top holder %:`);
  console.log(`  Winners: ${(featureAnalysis.win_avg_top_holder || 0).toFixed(1)}% avg`);
  console.log(`  Losers: ${(featureAnalysis.lose_avg_top_holder || 0).toFixed(1)}% avg`);
  console.log();

  console.log(`RugCheck score:`);
  console.log(`  Winners: ${(featureAnalysis.win_avg_rug_score || 0).toFixed(0)} avg`);
  console.log(`  Losers: ${(featureAnalysis.lose_avg_rug_score || 0).toFixed(0)} avg`);
} else {
  console.log('No feature data available (detected_pools may not have dp_* columns filled)');
}

console.log('\n=== HOURLY ACTIVITY ===\n');

const hourlyActivity = db.prepare(`
  SELECT
    strftime('%H', datetime(opened_at/1000, 'unixepoch')) as hour,
    COUNT(*) as trades,
    SUM(CASE WHEN pnl_pct > 5 THEN 1 ELSE 0 END) as wins,
    ROUND(AVG(pnl_pct), 1) as avg_pnl
  FROM positions
  WHERE bot_version IN ('v8r', 'v8s')
  GROUP BY hour
  ORDER BY hour ASC
`).all();

console.log('Trades by hour (UTC):');
hourlyActivity.forEach(h => {
  const winRate = (100 * h.wins / h.trades).toFixed(0);
  console.log(`  ${h.hour}:00 | ${h.trades} trades | ${h.wins} wins (${winRate}%) | Avg PnL: ${h.avg_pnl}%`);
});

db.close();
