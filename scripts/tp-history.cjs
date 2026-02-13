const db = require('better-sqlite3')('data/bot.db');

// ALL trades that hit TP2 or TP3
console.log('=== TRADES QUE LLEGARON A TP2+ ===\n');
const tpTrades = db.prepare(`
  SELECT token_mint, pnl_pct, peak_multiplier, exit_reason, tp_levels_hit,
    bot_version, opened_at, security_score, sol_invested, sol_returned, status
  FROM positions
  WHERE tp_levels_hit LIKE '%1%' OR tp_levels_hit LIKE '%2%'
  ORDER BY opened_at ASC
`).all();

tpTrades.forEach((t, i) => {
  const date = new Date(t.opened_at);
  const d = date.toISOString().slice(0, 10);
  const h = date.getHours() + ':' + String(date.getMinutes()).padStart(2, '0');
  const tp = t.tp_levels_hit || '[]';
  const peak = t.peak_multiplier ? t.peak_multiplier.toFixed(2) + 'x' : '?';
  console.log(`${i+1}. ${d} ${h} | ${(t.bot_version||'old').padEnd(4)} | ${t.token_mint.slice(0,8)} | peak=${peak} | pnl=${t.pnl_pct.toFixed(1)}% | exit=${t.exit_reason||'?'} | tp=${tp} | status=${t.status}`);
});

console.log(`\nTotal con TP2+: ${tpTrades.length}`);

// Now show TP config history - what were the TP levels before?
console.log('\n=== TODOS LOS TP LEVELS HIT (breakdown) ===\n');
const allTp = db.prepare(`
  SELECT tp_levels_hit, COUNT(*) as n, bot_version
  FROM positions
  WHERE tp_levels_hit IS NOT NULL AND tp_levels_hit != '[]'
  GROUP BY tp_levels_hit, bot_version
  ORDER BY bot_version, tp_levels_hit
`).all();
allTp.forEach(r => console.log(`  ${(r.bot_version||'old').padEnd(4)} | tp=${r.tp_levels_hit} | count=${r.n}`));

// Peak multiplier distribution for ALL trades
console.log('\n=== DISTRIBUCION DE PEAK MULTIPLIERS (todas las versiones) ===\n');
const peaks = db.prepare(`
  SELECT
    CASE
      WHEN peak_multiplier IS NULL THEN 'no_data'
      WHEN peak_multiplier < 1.0 THEN '<1x (loss)'
      WHEN peak_multiplier < 1.3 THEN '1.0-1.3x'
      WHEN peak_multiplier < 1.5 THEN '1.3-1.5x'
      WHEN peak_multiplier < 2.0 THEN '1.5-2.0x'
      WHEN peak_multiplier < 3.0 THEN '2.0-3.0x'
      WHEN peak_multiplier < 5.0 THEN '3.0-5.0x'
      ELSE '5x+'
    END as bracket,
    COUNT(*) as n,
    ROUND(AVG(pnl_pct), 1) as avg_pnl
  FROM positions
  GROUP BY bracket
  ORDER BY MIN(peak_multiplier)
`).all();
peaks.forEach(r => console.log(`  ${r.bracket.padEnd(15)} | ${r.n} trades | avg_pnl=${r.avg_pnl}%`));

// Check old TP config - what were the levels in old versions?
console.log('\n=== EXIT REASONS BREAKDOWN POR VERSION ===\n');
const exits = db.prepare(`
  SELECT bot_version, exit_reason, COUNT(*) as n, ROUND(AVG(pnl_pct),1) as avg_pnl
  FROM positions
  WHERE exit_reason IS NOT NULL
  GROUP BY bot_version, exit_reason
  ORDER BY bot_version, n DESC
`).all();
exits.forEach(r => console.log(`  ${(r.bot_version||'old').padEnd(4)} | ${(r.exit_reason||'?').padEnd(25)} | ${r.n} trades | avg_pnl=${r.avg_pnl}%`));

// The old version trades that had multiple TPs - what was the config then?
console.log('\n=== OLD VERSION: trades con mejores peaks ===\n');
const oldBest = db.prepare(`
  SELECT token_mint, pnl_pct, peak_multiplier, exit_reason, tp_levels_hit, opened_at, status
  FROM positions
  WHERE (bot_version IS NULL OR bot_version = '')
    AND peak_multiplier IS NOT NULL
  ORDER BY peak_multiplier DESC
  LIMIT 15
`).all();
oldBest.forEach((t, i) => {
  const date = new Date(t.opened_at);
  const d = date.toISOString().slice(0, 10);
  console.log(`${i+1}. ${d} | ${t.token_mint.slice(0,8)} | peak=${t.peak_multiplier.toFixed(2)}x | pnl=${t.pnl_pct.toFixed(1)}% | exit=${t.exit_reason||'?'} | tp=${t.tp_levels_hit} | ${t.status}`);
});

db.close();
