const Database = require('better-sqlite3');
const db = new Database('C:/Users/mathi/proyectos/botplatita/solana-sniper-bot/data/bot.db');

console.log('\n=== CADA TRADE INDIVIDUAL ===\n');

const trades = db.prepare(`
  SELECT
    SUBSTR(token_mint, 1, 8) as mint_short,
    ROUND(entry_price, 9) as entry_price,
    ROUND(peak_price, 9) as peak_price,
    ROUND(pnl_sol, 6) as pnl_sol,
    ROUND(pnl_pct, 1) as pnl_pct,
    exit_reason,
    ROUND((closed_at - opened_at) / 60000.0, 1) as duration_min,
    security_score,
    ROUND(peak_multiplier, 2) as peak_mult,
    tp_levels_hit,
    bot_version,
    datetime(opened_at/1000, 'unixepoch') as opened_time
  FROM positions
  WHERE bot_version IN ('v8r', 'v8s')
    AND status IN ('closed', 'stopped')
  ORDER BY opened_at DESC
`).all();

trades.forEach((t, i) => {
  console.log(`[${i+1}] ${t.mint_short}... | Score: ${t.security_score} | v${t.bot_version}`);
  console.log(`    Entry: ${t.entry_price} | Peak: ${t.peak_price} (x${t.peak_mult})`);
  console.log(`    PnL: ${t.pnl_sol} SOL (${t.pnl_pct}%)`);
  console.log(`    Duration: ${t.duration_min} min | Exit: ${t.exit_reason || 'unknown'}`);
  console.log(`    TP hits: ${t.tp_levels_hit || 'none'}`);
  console.log(`    Opened: ${t.opened_time}`);
  console.log();
});

console.log('\n=== RUGS ESPECÍFICOS ===\n');

const rugs = db.prepare(`
  SELECT
    SUBSTR(token_mint, 1, 12) as mint_short,
    ROUND(pnl_sol, 6) as pnl_sol,
    ROUND(pnl_pct, 1) as pnl_pct,
    security_score,
    ROUND((closed_at - opened_at) / 60000.0, 1) as duration_min,
    exit_reason,
    ROUND(peak_multiplier, 2) as peak_mult,
    holder_count,
    ROUND(liquidity_usd, 0) as liquidity_usd
  FROM positions
  WHERE bot_version IN ('v8r', 'v8s')
    AND status IN ('closed', 'stopped')
    AND pnl_pct <= -80
  ORDER BY pnl_sol ASC
`).all();

if (rugs.length === 0) {
  console.log('No rugs in this period! 🎉');
} else {
  rugs.forEach((r, i) => {
    console.log(`Rug ${i+1}: ${r.mint_short}...`);
    console.log(`  Loss: ${r.pnl_sol} SOL (${r.pnl_pct}%)`);
    console.log(`  Duration: ${r.duration_min} min`);
    console.log(`  Score: ${r.security_score} | Holders: ${r.holder_count} | Liq: $${r.liquidity_usd}`);
    console.log(`  Peak mult: ${r.peak_mult}x | Exit: ${r.exit_reason || 'unknown'}`);
    console.log();
  });
}

console.log('\n=== WINNERS ESPECÍFICOS ===\n');

const winners = db.prepare(`
  SELECT
    SUBSTR(token_mint, 1, 12) as mint_short,
    ROUND(pnl_sol, 6) as pnl_sol,
    ROUND(pnl_pct, 1) as pnl_pct,
    ROUND(peak_multiplier, 2) as peak_mult,
    tp_levels_hit,
    ROUND((closed_at - opened_at) / 60000.0, 1) as duration_min,
    security_score
  FROM positions
  WHERE bot_version IN ('v8r', 'v8s')
    AND status IN ('closed', 'stopped')
    AND pnl_pct > 5
  ORDER BY pnl_sol DESC
`).all();

let totalLeftOnTable = 0;
winners.forEach((w, i) => {
  const leftOnTable = ((w.peak_mult - 1) * 100) - w.pnl_pct;
  totalLeftOnTable += leftOnTable;

  console.log(`Win ${i+1}: ${w.mint_short}...`);
  console.log(`  Gain: ${w.pnl_sol} SOL (${w.pnl_pct}%)`);
  console.log(`  Peak: ${w.peak_mult}x vs Exit: ${(1 + w.pnl_pct/100).toFixed(2)}x`);
  console.log(`  Left on table: ${leftOnTable.toFixed(1)}%`);
  console.log(`  TP hits: ${w.tp_levels_hit || 'none'} | Duration: ${w.duration_min} min`);
  console.log(`  Score: ${w.security_score}`);
  console.log();
});

console.log(`Total left on table: ${totalLeftOnTable.toFixed(1)}% across all winners`);
console.log(`Average per winner: ${(totalLeftOnTable / winners.length).toFixed(1)}%`);

const tp1_count = winners.filter(w => w.tp_levels_hit && w.tp_levels_hit.includes('TP1')).length;
console.log(`\nTP1 (1.3x) reached: ${tp1_count}/${winners.length} winners (${(100*tp1_count/winners.length).toFixed(0)}%)`);

console.log('\n=== DETECCIONES VS COMPRAS ===\n');

const detected = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN security_passed = 1 THEN 1 ELSE 0 END) as passed
  FROM detected_pools
  WHERE detected_at > (SELECT MIN(opened_at) FROM positions WHERE bot_version IN ('v8r', 'v8s'))
`).get();

console.log(`Pools detected: ${detected.total}`);
console.log(`Passed scoring: ${detected.passed} (${(100*detected.passed/detected.total).toFixed(1)}%)`);
console.log(`Actually bought: ${trades.length}`);
console.log(`Passed but NOT bought: ${detected.passed - trades.length} (likely max_concurrent limit)`);

console.log('\n=== PRICE TRAJECTORIES ===\n');

console.log('(Checking position_price_log table...)');

const priceSnapshots = db.prepare(`
  SELECT
    p.token_mint,
    SUBSTR(p.token_mint, 1, 8) as mint_short,
    p.pnl_pct,
    p.opened_at,
    p.closed_at,
    GROUP_CONCAT(
      ROUND(ppl.elapsed_ms / 60000.0, 1) || 'min:' || ROUND(ppl.multiplier, 3) || 'x',
      ' | '
    ) as price_trajectory
  FROM positions p
  LEFT JOIN position_price_log ppl ON p.token_mint = ppl.position_id
  WHERE p.bot_version IN ('v8r', 'v8s')
    AND p.status IN ('closed', 'stopped')
  GROUP BY p.token_mint
  ORDER BY p.pnl_pct DESC
`).all();

if (priceSnapshots.length > 0 && priceSnapshots[0].price_trajectory) {
  console.log('Price trajectories (time:multiplier):\n');
  priceSnapshots.forEach(ps => {
    const outcome = ps.pnl_pct > 5 ? '✓ WIN' : (ps.pnl_pct <= -80 ? '✗ RUG' : '~ LOSS');
    console.log(`${outcome} ${ps.mint_short}... (${ps.pnl_pct}%)`);
    console.log(`  ${ps.price_trajectory || 'no snapshots'}`);
    console.log();
  });
} else {
  console.log('No price snapshots available (feature may not be enabled)');
}

console.log('\n=== PnL REAL (CON OVERHEAD) ===\n');

const pnl_raw = trades.reduce((sum, t) => sum + t.pnl_sol, 0);
const num_trades = trades.length;

// Estimaciones conservadoras
const ata_overhead = num_trades * 0.002;  // ATA creation/cleanup
const tx_fees = num_trades * 0.00036;     // Buy + sell TXs

console.log(`PnL from positions: ${pnl_raw.toFixed(6)} SOL`);
console.log(`ATA overhead (${num_trades} × 0.002): -${ata_overhead.toFixed(6)} SOL`);
console.log(`TX fees (${num_trades} × 0.00036): -${tx_fees.toFixed(6)} SOL`);
console.log(`----------------------------------------`);
console.log(`PnL REAL: ${(pnl_raw - ata_overhead - tx_fees).toFixed(6)} SOL`);

db.close();
