#!/usr/bin/env node
/**
 * Simulates: TP1=15% (sell 100%) + dual filter (score + ML-like) + 0.1 SOL trades
 * Uses REAL trade data with peak_multiplier to determine if TP1 would trigger
 */
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'), { readonly: true });

const TRADE_SIZE = 0.1; // SOL per trade
const FEE_OVERHEAD = 0.0024; // ATA rent + TX fees per trade
const TP1_TARGET = 1.15; // 15% gain

// Get all closed trades with full data
const trades = db.prepare(`
  SELECT
    p.token_mint,
    p.security_score,
    p.pnl_pct,
    p.pnl_sol,
    p.exit_reason,
    p.peak_multiplier,
    p.sol_invested,
    d.dp_liquidity_usd,
    d.dp_top_holder_pct,
    d.dp_holder_count,
    d.dp_graduation_time_s,
    tc.wallet_age_seconds
  FROM positions p
  LEFT JOIN detected_pools d ON p.pool_address = d.pool_address
  LEFT JOIN token_creators tc ON p.token_mint = tc.token_mint
  WHERE p.closed_at IS NOT NULL
  ORDER BY p.opened_at ASC
`).all();

console.log(`SIMULACION: TP1=15% + filtro dual + 0.1 SOL/trade`);
console.log(`Trades historicos: ${trades.length}\n`);

function simulate(label, filterFn) {
  const passed = trades.filter(filterFn);
  let totalPnl = 0;
  let wins = 0;
  let losses = 0;
  let rugs = 0;
  let tp1Hits = 0;
  let details = [];

  for (const t of passed) {
    const isRug = (t.exit_reason || '').includes('rug') || (t.exit_reason || '').includes('honeypot');
    const peak = t.peak_multiplier || 0;

    let tradePnl;

    if (peak >= TP1_TARGET) {
      // TP1 would have triggered at 15% gain
      tradePnl = TRADE_SIZE * (TP1_TARGET - 1) - FEE_OVERHEAD;
      tp1Hits++;
      wins++;
    } else if (isRug) {
      // Rug before reaching TP1 — lose everything (or close to it)
      // Some rugs have partial sells, use actual pnl_pct if available
      const lossRatio = Math.min(1.0, Math.abs(t.pnl_pct || 100) / 100);
      tradePnl = -TRADE_SIZE * lossRatio - FEE_OVERHEAD;
      rugs++;
      losses++;
    } else {
      // Didn't reach TP1, not a rug — exited at SL/timeout/etc
      // Use actual pnl_pct to estimate
      const pnlRatio = (t.pnl_pct || 0) / 100;
      tradePnl = TRADE_SIZE * pnlRatio - FEE_OVERHEAD;
      if (tradePnl > 0) wins++;
      else losses++;
    }

    totalPnl += tradePnl;
    details.push({
      token: t.token_mint.substring(0, 8),
      score: t.security_score,
      liq: t.dp_liquidity_usd || 0,
      peak,
      isRug,
      tradePnl,
    });
  }

  const winRate = passed.length > 0 ? (wins / passed.length * 100).toFixed(1) : 0;
  const avgWin = wins > 0 ? (details.filter(d => d.tradePnl > 0).reduce((s, d) => s + d.tradePnl, 0) / wins).toFixed(4) : 0;
  const avgLoss = losses > 0 ? (details.filter(d => d.tradePnl <= 0).reduce((s, d) => s + d.tradePnl, 0) / losses).toFixed(4) : 0;

  console.log(`\n${'='.repeat(90)}`);
  console.log(`  ${label}`);
  console.log(`${'='.repeat(90)}`);
  console.log(`  Trades: ${passed.length}/${trades.length} (filtrados: ${trades.length - passed.length})`);
  console.log(`  TP1 hits (peak >= ${TP1_TARGET}x): ${tp1Hits}/${passed.length} (${(tp1Hits/Math.max(passed.length,1)*100).toFixed(1)}%)`);
  console.log(`  Rugs que pasaron filtro: ${rugs}`);
  console.log(`  Win rate: ${winRate}%`);
  console.log(`  Avg win: +${avgWin} SOL | Avg loss: ${avgLoss} SOL`);
  console.log(`  -------`);
  console.log(`  TOTAL PnL: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} SOL ($${(totalPnl * 200).toFixed(2)} USD aprox)`);
  console.log(`  Per trade: ${(totalPnl / Math.max(passed.length, 1)).toFixed(5)} SOL`);
  console.log(`  Capital needed: ${TRADE_SIZE} SOL + reserve = ~0.15 SOL`);
  console.log(`  ROI: ${(totalPnl / TRADE_SIZE * 100).toFixed(1)}% sobre capital base`);

  // Show worst trades
  const sortedByPnl = [...details].sort((a, b) => a.tradePnl - b.tradePnl);
  console.log(`\n  5 peores trades:`);
  for (const d of sortedByPnl.slice(0, 5)) {
    console.log(`    ${d.token}.. s=${d.score} liq=$${d.liq.toFixed(0)} peak=${d.peak.toFixed(2)}x ${d.isRug ? 'RUG' : ''} → ${d.tradePnl.toFixed(4)} SOL`);
  }
  console.log(`  5 mejores trades:`);
  for (const d of sortedByPnl.slice(-5)) {
    console.log(`    ${d.token}.. s=${d.score} liq=$${d.liq.toFixed(0)} peak=${d.peak.toFixed(2)}x → +${d.tradePnl.toFixed(4)} SOL`);
  }

  return { totalPnl, trades: passed.length, wins, losses, rugs, tp1Hits, winRate };
}

// 1. BASELINE: como esta ahora (score >= 65, liq >= $5K)
simulate('BASELINE: Score >= 65, Liq >= $5K (config actual)', t =>
  (t.security_score || 0) >= 65 && (t.dp_liquidity_usd || 0) >= 5000
);

// 2. Score + liq más alto (simula ML que es 80% liquidez)
simulate('SCORE >= 65 + Liq >= $10K', t =>
  (t.security_score || 0) >= 65 && (t.dp_liquidity_usd || 0) >= 10000
);

simulate('SCORE >= 65 + Liq >= $15K', t =>
  (t.security_score || 0) >= 65 && (t.dp_liquidity_usd || 0) >= 15000
);

simulate('SCORE >= 65 + Liq >= $20K', t =>
  (t.security_score || 0) >= 65 && (t.dp_liquidity_usd || 0) >= 20000
);

// 3. Score alto + liq
simulate('SCORE >= 75 + Liq >= $15K', t =>
  (t.security_score || 0) >= 75 && (t.dp_liquidity_usd || 0) >= 15000
);

simulate('SCORE >= 80 + Liq >= $15K', t =>
  (t.security_score || 0) >= 80 && (t.dp_liquidity_usd || 0) >= 15000
);

simulate('SCORE >= 80 + Liq >= $20K', t =>
  (t.security_score || 0) >= 80 && (t.dp_liquidity_usd || 0) >= 20000
);

// 4. Aggressive: score + liq + top holder + creator age
simulate('AGGRESSIVE: Score >= 75 + Liq >= $15K + TopH < 95% + CreatorAge > 60s', t =>
  (t.security_score || 0) >= 75 &&
  (t.dp_liquidity_usd || 0) >= 15000 &&
  (t.dp_top_holder_pct || 100) < 95 &&
  (t.wallet_age_seconds || 0) > 60
);

simulate('AGGRESSIVE: Score >= 75 + Liq >= $20K + TopH < 95%', t =>
  (t.security_score || 0) >= 75 &&
  (t.dp_liquidity_usd || 0) >= 20000 &&
  (t.dp_top_holder_pct || 100) < 95
);

// 5. Ultra selective
simulate('ULTRA: Score >= 80 + Liq >= $20K + TopH < 90%', t =>
  (t.security_score || 0) >= 80 &&
  (t.dp_liquidity_usd || 0) >= 20000 &&
  (t.dp_top_holder_pct || 100) < 90
);

// FINAL SUMMARY
console.log('\n' + '='.repeat(90));
console.log('  TABLA RESUMEN');
console.log('='.repeat(90));
console.log('Config'.padEnd(55) + '| Trades | TP1% | Rugs | PnL SOL');
console.log('-'.repeat(90));

const configs = [
  ['Score>=65 Liq>=$5K (actual)', t => (t.security_score||0)>=65 && (t.dp_liquidity_usd||0)>=5000],
  ['Score>=65 Liq>=$10K', t => (t.security_score||0)>=65 && (t.dp_liquidity_usd||0)>=10000],
  ['Score>=65 Liq>=$15K', t => (t.security_score||0)>=65 && (t.dp_liquidity_usd||0)>=15000],
  ['Score>=65 Liq>=$20K', t => (t.security_score||0)>=65 && (t.dp_liquidity_usd||0)>=20000],
  ['Score>=75 Liq>=$15K', t => (t.security_score||0)>=75 && (t.dp_liquidity_usd||0)>=15000],
  ['Score>=80 Liq>=$15K', t => (t.security_score||0)>=80 && (t.dp_liquidity_usd||0)>=15000],
  ['Score>=80 Liq>=$20K', t => (t.security_score||0)>=80 && (t.dp_liquidity_usd||0)>=20000],
  ['Score>=80 Liq>=$20K TopH<90%', t => (t.security_score||0)>=80 && (t.dp_liquidity_usd||0)>=20000 && (t.dp_top_holder_pct||100)<90],
];

for (const [label, fn] of configs) {
  const p = trades.filter(fn);
  let pnl = 0;
  let tp1 = 0;
  let rg = 0;
  for (const t of p) {
    const isRug = (t.exit_reason||'').includes('rug') || (t.exit_reason||'').includes('honeypot');
    const peak = t.peak_multiplier || 0;
    if (peak >= TP1_TARGET) {
      pnl += TRADE_SIZE * (TP1_TARGET - 1) - FEE_OVERHEAD;
      tp1++;
    } else if (isRug) {
      pnl += -TRADE_SIZE * Math.min(1, Math.abs(t.pnl_pct||100)/100) - FEE_OVERHEAD;
      rg++;
    } else {
      pnl += TRADE_SIZE * (t.pnl_pct||0)/100 - FEE_OVERHEAD;
    }
  }
  const tp1Pct = (tp1/Math.max(p.length,1)*100).toFixed(0);
  console.log(
    label.padEnd(55) + '| ' +
    String(p.length).padStart(6) + ' | ' +
    (tp1Pct + '%').padStart(4) + ' | ' +
    String(rg).padStart(4) + ' | ' +
    (pnl >= 0 ? '+' : '') + pnl.toFixed(4)
  );
}

db.close();
console.log('\nDone.');
